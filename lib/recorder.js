const {Promise, promiseWaitAll, Deferred, tiePromiseWithDeferred} = require("./common");
const {BinaryInputStream, BinaryOutputStream, Pipe, PR_UINT32_MAX} = require("./commonStream");
const {prepareHttp, prepareHttpStatus, prepareCacheEntry} = require("./DMHelpers");
const {SDMRoot} = require("./filesystemSDM");
const {Cu, Ci, Cr} = require("chrome");

const {Services} = Cu.import("resource://gre/modules/Services.jsm");
const observerService = Services.obs;
const cacheService = Services.cache2;
const {LoadContextInfo} = Cu.import("resource://gre/modules/LoadContextInfo.jsm");

function Recorder() {}
Recorder.prototype = {
	isRunning: false,
	sdmDeferred: new Deferred(),
	obsDeferred: new Deferred(),
	sdmTied: false,
	obsTied: false,
	
	// public
	getOnDonePromise: function() {
		return this.obsDeferred.promise;
	},
	
	// public
	getOnSDMDonePromise: function() {
		return this.sdmDeferred.promise;
	},
	
	// public
	start: function() {
		if (this.isRunning) throw Error("Is running");
		this.isRunning = true;
		try {
			this.sdmRoot = new SDMRoot();
			try {
				sdmPromise = this.sdmRoot.getOnDonePromise();
				sdmPromise
					.then(
						() => {console.log("sdm: done")},
						e  => {console.error("sdm err: " + e)}
					);
				tiePromiseWithDeferred(sdmPromise, this.sdmDeferred);
				this.sdmTied = true;
				let obsName = String(Date.now()); // TODO
				this.sdmObservation = this.sdmRoot.createObservation(obsName);
				try {
					this.httpObserver = new HttpObserver(this.sdmObservation);
					let obsPromise = this.httpObserver.getOnDonePromise();
					obsPromise
						.then(
							() => {console.log("obs: done")},
							e  => {console.error("obs err: " + e)}
						);
					tiePromiseWithDeferred(obsPromise, this.obsDeferred);
					this.obsTied = true;
					this.httpObserver.start();
				} catch(e) {
					sdmObservation.interrupt();
					throw e;
				}
			} catch(e) {
				this.sdmRoot.interrupt();
				throw e;
			}
		} catch(e) {
			console.error("Recorder start: " + e);
			if (! this.obsTied) this.obsDeferred.reject(e);
			if (! this.sdmTied) this.sdmDeferred.reject("Not started");
		}
	},
	
	// public
	stop: function () {
		if (! this.isRunning) throw Error("Is not running");
		this.isRunning = false;
		
		try {
			this.httpObserver.stop();
		} catch(e) {
			this.httpObserver.interrupt();
			console.error("Recorder stop: httpObserver.stop: " + e);
			if (! this.obsTied) this.obsDeferred.reject(e);
		}
		
		try {
			this.sdmRoot.finish();
			try {
				this.sdmObservation.finish();
			} catch(e) {
				this.sdmObservation.interrupt();
				throw e;
			}
		} catch(e) {
			this.sdmRoot.interrupt();
			console.error("Recorder stop: sdmRoot.finish: " + e);
			if (! this.sdmTied) this.sdmDeferred.reject("Not started");
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
	isStarted: false,
	isStopped: false,
	respDonePromises: [],
	
	// public
	getOnDonePromise: function() {
		return this.deferred.promise;
	},
	
	// public
	start: function() {
		if (this.isStarted || this.isStopped) throw Error();
		this.isStarted = true;
		this.addObservers();
	},
	
	// public
	stop: function() {
		if (! this.isStarted || this.isStopped) throw Error();
		this.isStopped = true;
		this.removeObservers();
		var donePromise = promiseWaitAll(this.respDonePromises);
		tiePromiseWithDeferred(donePromise, this.deferred);
	},
	
	// public
	interrupt: function() {
		this.isStopped = true;
		try {
			this.removeObservers();
			this.deferred.reject("Interrupted");
		} catch(e) {
			this.deferred.reject(e);
		}
	},
	
	// private
	addObservers: function() {
		HttpObserver.observeTopics.forEach( topic => {
			observerService.addObserver(this, topic, false);
		});
	},
	
	// private
	removeObservers: function() {
		HttpObserver.observeTopics.forEach( topic => {
			observerService.removeObserver(this, topic, false);
		});
	},
	
	// private
	observe: function(subject, topic, data) {
		try {
			if (HttpObserver.onRequestTopics.includes(topic)) {
				this.onModifyRequest(subject);
			} else if (HttpObserver.onResponseTopics.includes(topic)) {
				this.onExamineAnyResponse(subject, topic);
			} else {
				throw Error(topic);
			}
		} catch(e) {
			console.error("observe: " + e);
		}
	},
	
	// private
	onModifyRequest: function(http) {
		http.QueryInterface(Ci.nsIHttpChannel);
		
		
		
	},
	
	// private
	onExamineAnyResponse: function(http, topic) {
		let respDeferred = new Deferred();
		this.respDonePromises.push(respDeferred.promise);
		try {
			respDeferred.promise.catch( e => {
				console.error("onExamineAnyResponse: " + e);
			});
			
			let sdmResponse = this.sdmObservation.createResponse();
			respDeferred.promise.catch( () => {
				sdmResponse.interrupt();
			});
			
			let respPromise = this.onExamineAnyResponseImpl(http, topic, sdmResponse);
			tiePromiseWithDeferred(respPromise, respDeferred);
		} catch(e) {
			respDeferred.reject(e);
		}
	},
	
	// private
	onExamineAnyResponseImpl: function(http, topic, sdmResponse) {
		http.QueryInterface(Ci.nsIHttpChannel);
		let httpPromise = Promise.resolve()
			.then( () => {
				sdmResponse.saveHttp(prepareHttp(http, topic));
			});

		let sdmData = sdmResponse.createData();
		try {
			http.QueryInterface(Ci.nsITraceableChannel);
			let newListener = new TracingListener( byteArray => {
				sdmData.writeByteArray(byteArray);
			});
			newListener.originalListener = http.setNewListener(newListener);
			
			let dataAndCachePromise = newListener.getOnDonePromise()
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
		} catch(e) {
			sdmData.interrupt();
			throw e;
		}
	},
};
// private
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

	// public
	getOnDonePromise: function() {
		return this.deferred.promise;
	},
	onDataAvailable: function(aRequest, aContext, aInputStream, aOffset, aCount) {
		var iStream = new BinaryInputStream(aInputStream);
		var pipe = new Pipe(false, false, 0, PR_UINT32_MAX, null);
		var oStream = new BinaryOutputStream(pipe.outputStream);

		var data = iStream.readByteArray(aCount);
		oStream.writeByteArray(data, aCount);
		this.bytesCount += aCount;

		try {
			this.onData(data);
		} catch(e) {
			console.error("onData: " + e);
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

