var EXPORTED_SYMBOLS = ["Recorder"];

Components.utils.import("chrome://httpreplay/content/modules/common.js");
Cu.import("chrome://httpreplay/content/modules/datamodel.js");

function Recorder() {}
Recorder.prototype = {
	running: false,
	start: function() {
		try {
			if (this.running) throw Error("Is running");
			this.dmRoot = new DMRoot();
			this.dmRoot.getOnDonePromise()
				.then(
					() => {console.log("dm: done")},
					e  => {console.error("dm err: " + e)}
				);
			this.httpObserver = new HttpObserver(this.dmRoot.createObservation());
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
			this.dmRoot.finish();
			this.running = false;
		} catch(e) {
			console.error(e);
		}
	},
};

Cu.import("chrome://httpreplay/content/modules/securityinfo.js");

Cu.import("resource://gre/modules/Services.jsm");

const observerService = Services.obs;

const cacheService = Services.cache2;
Cu.import("resource://gre/modules/LoadContextInfo.jsm");

function HttpObserver(dmObservation) {
	this.dmObservation = dmObservation;
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
		this.dmObservation.finish();
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
			
			var dmResponse = this.dmObservation.createResponse();
			respDeferred.promise.catch( () => {
				dmResponse.interrupt();
			});
			
			var respPromise = this.onExamineAnyResponseImpl(http, topic, dmResponse);
			tiePromiseWithDeferred(respPromise, respDeferred);
		} catch(e) {
			respDeferred.reject(e);
		}
	},

	onExamineAnyResponseImpl: function(http, topic, dmResponse) {
		http.QueryInterface(Ci.nsIHttpChannel);
		var httpPromise = Promise.resolve()
			.then( () => {
				let outHttp = HttpObserver.prepareHttp(http, topic);
				dmResponse.saveHttp(outHttp);
			});

		var dmData = dmResponse.createData();
		try {
			http.QueryInterface(Ci.nsITraceableChannel);
			var newListener = new TracingListener( byteArray => {
				dmData.writeByteArray(byteArray);
			});
			newListener.originalListener = http.setNewListener(newListener);
		} catch(e) {
			dmData.close();
			throw e;
		}

		var dataAndCachePromise = newListener.getOnDonePromise()
			.wait( tracingRes => {
				dmData.close();
				let tracingErr = (tracingRes[0] ? tracingRes[1] : null);
				let outHttpStatus = HttpObserver.prepareHttpStatus(http.status, tracingErr);
				dmResponse.saveHttpStatus(outHttpStatus);
			})
			.then( () => HttpObserver.makeCacheEntryPromise(this.cacheStorage, http.URI) )
			.then( aEntry => {
				let outCacheEntry;
				if (aEntry === null) {
					outCacheEntry = null;
				} else {
					outCacheEntry = HttpObserver.prepareCacheEntry(aEntry);
				}
				dmResponse.saveCacheEntry(outCacheEntry);
			});
		
		return promiseWaitAll([httpPromise, dataAndCachePromise]);
	},
};
HttpObserver.prepareHttp = function(http, topic) {
	var httpReqHeads = [];
	http.visitRequestHeaders({
		visitHeader: function(aHeader, aValue) {
			httpReqHeads.push([aHeader, aValue]);
		}
	});
	
	var httpRespHeads = [];
	http.visitResponseHeaders({
		visitHeader: function(aHeader, aValue) {
			httpRespHeads.push([aHeader, aValue]);
		}
	});
	
	var si = HttpObserver.prepareHttpSecurityInfo(http.securityInfo);
	
	var httpDataObj = {
		"topic": topic,
		request: {
			method: http.requestMethod,
			URI: http.URI.spec,
			//originalURI: http.originalURI.spec,
			//name: http.name,
			headers: httpReqHeads,
			referrer: (http.referrer !== null ? http.referrer.spec : null),
		},
		response: {
			statusCode: http.responseStatus,
			statusText: http.responseStatusText,
			//requestSucceeded: http.requestSucceeded,
			headers: httpRespHeads,
			contentLength: http.contentLength,
			contentCharset: http.contentCharset,
			contentType: http.contentType,
		},
	};
	if ("securityInfo" in si) httpDataObj["securityInfo"] = si["securityInfo"];
	
	var out = {"http": httpDataObj};
	if ("certs" in si) out["certs"] = si["certs"];
	if ("securityInfoRaw" in si) out["securityInfoRaw"] = si["securityInfoRaw"];
	
	return out;
};
HttpObserver.prepareHttpSecurityInfo = function(securityInfo) {
	if (securityInfo === null) return {"securityInfo": null};
	try {
		var certCount = 0;
		var certs = [];
		var siDataObj = new SecurityInfoParser( byteArray => {
			certs[certCount] = byteArray;
			return certCount++;
		}).parseSecurityInfo(securityInfo);
		var out = {
			"securityInfo": siDataObj
		};
		if (certs.length > 0) out["certs"] = certs;
		return out;
	} catch(e) {
		console.error("parseSecurityInfo error: " + e);
		var siByteArray = SecurityInfoParser.getSerializedSecurityInfo(securityInfo);
		return {"securityInfoRaw": siByteArray};
	}
};
HttpObserver.prepareHttpStatus = function(httpStatus, dataError) {
	var out = {"httpStatus" : httpStatus};
	if (dataError !== null) {
		var e = dataError;
		var eCode;
		if ((typeof e) === "number") {
			eCode = e;
		} else if ((typeof e) === "object" && ("result" in e)) {
			let resNum = new Number(e.result);
			eCode = (resNum !== Number.NaN ? resNum : e.result);
		} else {
			throw e;
		}
		out["tracingResult"] = eCode;
	}
	return out;
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
HttpObserver.prepareCacheEntry = function(aEntry) {
	var out = {
		key:               aEntry.key,
		expirationTime:    aEntry.expirationTime,
		predictedDataSize: aEntry.predictedDataSize,
		storageDataSize:   aEntry.storageDataSize,
		dataSize:          aEntry.dataSize,
	};
	out["meta"] = HttpObserver.prepareCacheMeta(aEntry);
	return out;
};
HttpObserver.prepareCacheMeta = function(aEntry) {
	var out = {};
	
	var reqHeaders = [];
	aEntry.visitMetaData({
		onMetaDataElement: function(key, value) {
			switch(key) {
				case "security-info": {
					break;
				}
				case "response-head": {
					let parsed = HttpObserver.parseCachedResponseHead(value);
					let statusLine = parsed[0];
					let headers    = parsed[1];
					out["response"] = {
						"statusLine": statusLine,
						"headers": headers,
					};
					break;
				}
				case "request-method": {
					out["request"] = {
						method: value
					};
					break;
				}
				default: {
					if (key.startsWith("request-")) {
						reqHeaders.push([key.substr("request-".length), value]);
					} else {
						out[key] = value;
					}
				}
			}
		}
	});
	if (!("request" in out)) throw Error();
	out["request"]["headers"] = reqHeaders;
	
	return out;
};
HttpObserver.parseCachedResponseHead = function(headStr) {
	var headArr = headStr.split("\r\n");
	if (headArr.length < 2) throw new Error();
	if (headArr[headArr.length - 1] !== "") throw new Error();
	var statusLine = headArr[0];
	if (! new RegExp("^HTTP").test(statusLine)) throw new Error();
	headArr = headArr.slice(1, -1);
	
	var heads = [];
	headArr.forEach(function (element) {
		let res = element.match(/^([^:]+): (.+)$/);
		if (res === null) throw new Error();
		if (res.length != 3) throw new Error();
		var key = res[1];
		var val = res[2];
		heads.push([key, val]);
	});
	
	return [statusLine, heads];
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

