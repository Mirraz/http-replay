const {
	Promise, promiseWaitAll, Deferred, tiePromiseWithDeferred,
	BinaryInputStream, BinaryOutputStream, Pipe, PR_UINT32_MAX
} = require("./common");
const {prepareHttp, prepareHttpStatus, prepareCacheEntry} = require("./DMHelpers");
const {SDMRoot} = require("./sqliteSDM");
const {Cu, Ci, Cr} = require("chrome");

const {Services} = Cu.import("resource://gre/modules/Services.jsm");
const observerService = Services.obs;
const cacheService = Services.cache2;
const {LoadContextInfo} = Cu.import("resource://gre/modules/LoadContextInfo.jsm");

function Recorder() {}
Recorder.prototype = {
	running: false,
	start: function() {
		try {
			if (this.running) throw Error("Is running");
			this.sdmRoot = new SDMRoot();
			this.sdmRoot.getOnDonePromise()
				.then(
					() => {console.log("sdm: done")},
					e  => {console.error("sdm err: " + e)}
				);
			this.httpObserver = new HttpObserver(this.sdmRoot.createObservation());
			this.httpObserver.getOnDonePromise()
				.then(
					() => {console.log("obs: done")},
					e  => {console.error("obs err: " + e)}
				);
			this.httpObserver.start();
			this.running = true;
		} catch(e) {
			console.error(e);
		}
	},
	stop: function () {
		try {
			if (! this.running) throw Error("Is not running");
			this.httpObserver.stop();
			this.sdmRoot.finish();
			this.running = false;
		} catch(e) {
			console.error(e);
		}
	},
};

function HttpObserver(sdmObservation) {
	this.sdmObservation = sdmObservation;
	this.deferred = new Deferred();
}
HttpObserver.onRequestTopics = [
	//"http-on-modify-request"
];
HttpObserver.onResponseTopics = [
	"http-on-examine-response",
	"http-on-examine-cached-response",
	//"http-on-examine-merged-response",
];
HttpObserver.observeTopics = HttpObserver.onRequestTopics.concat(HttpObserver.onResponseTopics);
HttpObserver.prototype = {
	cacheStorage: cacheService.memoryCacheStorage(LoadContextInfo.default),
	observersAdded: false,
	respDonePromises: [],
	
	getOnDonePromise: function() {
		return this.deferred.promise;
	},
	
	start: function() {
		this.addObservers();
		this.observersAdded = true;
	},
	
	stop: function() {
		if (this.observersAdded) {
			this.removeObservers();
			this.observersAdded = false;
		}
		var donePromise = promiseWaitAll(this.respDonePromises);
		tiePromiseWithDeferred(donePromise, this.deferred);
		this.sdmObservation.finish();
	},
	
	addObservers: function() {
		HttpObserver.observeTopics.forEach( topic => {
			observerService.addObserver(this, topic, false);
		});
	},
	
	removeObservers: function() {
		HttpObserver.observeTopics.forEach( topic => {
			observerService.removeObserver(this, topic, false);
		});
	},

	observe: function(subject, topic, data) {
		try {
			if (HttpObserver.onRequestTopics.indexOf(topic) >= 0) {
				this.onModifyRequest(subject);
			} else if (HttpObserver.onResponseTopics.indexOf(topic) >= 0) {
				this.onExamineAnyResponse(subject, topic);
			} else {
				throw Error(topic);
			}
		} catch(e) {
			console.error(e);
		}
	},
	
	onModifyRequest: function(http) {
		http.QueryInterface(Ci.nsIHttpChannel);
		
		
		
	},
	
	onExamineAnyResponse: function(http, topic) {
		var respDeferred = new Deferred();
		try {
			this.respDonePromises.push(respDeferred.promise);
			respDeferred.promise.catch( e => {
				console.error("resp err: " + e);
			});
			
			var sdmResponse = this.sdmObservation.createResponse();
			respDeferred.promise.catch( () => {
				sdmResponse.interrupt();
			});
			
			var respPromise = this.onExamineAnyResponseImpl(http, topic, sdmResponse);
			tiePromiseWithDeferred(respPromise, respDeferred);
		} catch(e) {
			respDeferred.reject(e);
		}
	},

	onExamineAnyResponseImpl: function(http, topic, sdmResponse) {
		http.QueryInterface(Ci.nsIHttpChannel);
		var httpPromise = Promise.resolve()
			.then( () => {
				sdmResponse.saveHttp(prepareHttp(http, topic));
			});

		var sdmData = sdmResponse.createData();
		try {
			http.QueryInterface(Ci.nsITraceableChannel);
			var newListener = new TracingListener( byteArray => {
				sdmData.writeByteArray(byteArray);
			});
			newListener.originalListener = http.setNewListener(newListener);
		} catch(e) {
			sdmData.close();
			throw e;
		}

		var dataAndCachePromise = newListener.getOnDonePromise()
			.wait( tracingRes => {
				sdmData.close();
				let tracingErr = (tracingRes[0] ? tracingRes[1] : Cr.NS_OK);
				sdmResponse.saveHttpStatus(prepareHttpStatus(tracingErr, http.status));
			})
			.then( () => HttpObserver.makeCacheEntryPromise(this.cacheStorage, http.URI) )
			.then( aEntry => {
				sdmResponse.saveCacheEntry(prepareCacheEntry(aEntry));
			});
		
		return promiseWaitAll([httpPromise, dataAndCachePromise]);
	},
};
HttpObserver.makeCacheEntryPromise = function(cacheStorage, URI) {
	return new Promise( (resolve, reject) => {
		cacheStorage.asyncOpenURI(URI, "", Ci.nsICacheStorage.OPEN_READONLY, {
			onCacheEntryCheck: function(aEntry, aApplicationCache) {
			},
			onCacheEntryAvailable: function(aEntry, aNew, aApplicationCache, aResult) {
				if (aResult === Cr.NS_OK) {
					resolve(aEntry);
				} else if (aResult === Cr.NS_ERROR_CACHE_KEY_NOT_FOUND) {
					resolve(null);
				} else {
					reject(aResult);
				}
			},
		});
	});
};

function TracingListener(onData) {
	this.onData = onData;
	this.deferred = new Deferred();
}
TracingListener.prototype = {
	originalListener: null,
	bytesCount: 0,

	getOnDonePromise: function() {
		return this.deferred.promise;
	},
	onDataAvailable: function(aRequest, aContext, aInputStream, aOffset, aCount) {
		var iStream = new BinaryInputStream(aInputStream);
		var pipe = new Pipe(false, false, 0, PR_UINT32_MAX, null);
		var oStream = new BinaryOutputStream(pipe.outputStream);

		var data = iStream.readByteArray(aCount);
		oStream.writeByteArray(data, aCount);

		try {
			this.onData(data);
			this.bytesCount += aCount;
		} catch(e) {
			console.error(e);
		}

		this.originalListener.onDataAvailable(aRequest, aContext, pipe.inputStream, aOffset, aCount);
	},
	onStartRequest: function(aRequest, aContext) {
		this.originalListener.onStartRequest(aRequest, aContext);
	},
	onStopRequest: function(aRequest, aContext, aStatusCode) {
		try {
			this.originalListener.onStopRequest(aRequest, aContext, aStatusCode);
			if (aStatusCode === Cr.NS_OK) {
				this.deferred.resolve(this.bytesCount);
			} else {
				this.deferred.reject(aStatusCode);
			}
		} catch(e) {
			this.deferred.reject(e);
			throw e;
		}
	},
};

exports.Recorder = Recorder;

