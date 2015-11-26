if (httpReply) {
	httpReply.stop();
	httpReply = null;
}
var httpReply = {httpObserver: null};
httpReply.stop = function() {
	if (this.httpObserver) {
		this.httpObserver.stop();
		this.httpObserver = null;
	}
};
httpReply.start = function() {

Promise.prototype.finally = function (callback) {
	let p = this.constructor;
	return this.then(
		value  => p.resolve(callback()).then(() => value),
		reason => p.resolve(callback()).then(() => { throw reason })
	);
};

var {classes: Cc, interfaces: Ci, results: Cr, Constructor: CC, utils: Cu} = Components;

const saveFormatVersion = "1.0";

const {TextDecoder, TextEncoder, OS} = Cu.import("resource://gre/modules/osfile.jsm", {});
const homePath = OS.Path.join(OS.Constants.Path.profileDir, "HttpReply");

function HttpObserver() {
	var baseName = Date.now();
	this.basePath = OS.Path.join(homePath, baseName);
	this.catalogPath = OS.Path.join(this.basePath,  "catalog");
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
	observerService: Cc["@mozilla.org/observer-service;1"].getService(Ci.nsIObserverService),
	catalogFile: null,
	catalogFilePromise: null,
	observersAdded: false,
	prevResponseId: null,
	
	start: function(homeCreatedPromise) {
		this.catalogFilePromise = Promise.resolve()
			.then( () => OS.File.makeDir(this.basePath) )
			.then( () => OS.File.open(this.catalogPath, {write: true, truncate: true}) )
			.then( file => {this.catalogFile = file})
			.then( () => {
				let encoder = new TextEncoder();
				let array = encoder.encode("#version " + saveFormatVersion + "\n");
				return this.catalogFile.write(array);
			})
			.then( () => this.catalogFile.flush() )
			.then( () => {
				this.addObservers();
				this.observersAdded = true;
			});
		this.catalogFilePromise
			.catch( e => {
				repl.print(e);
			});
	},
	
	stop: function() {
		this.catalogFilePromise
			.then( () => {
				if (this.observersAdded) {
					this.removeObservers();
					this.observersAdded = false;
				}
			})
			.finally( () => {
				if (this.catalogFile) {
					return this.catalogFile.close().catch( e => {
						repl.print(e);
					});
				}
			})
			.catch( e => {
				repl.print(e);
			});
	},
	
	addObservers: function() {
		HttpObserver.observeTopics.forEach( topic => {
			this.observerService.addObserver(this, topic, false);
		});
	},
	
	removeObservers: function() {
		HttpObserver.observeTopics.forEach( topic => {
			this.observerService.removeObserver(this, topic, false);
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
			repl.print(e);
		}
	},
	
	onModifyRequest: function(http) {
		http.QueryInterface(Ci.nsIHttpChannel);
		
		
	},
	
	onExamineAnyResponse: function(http, topic) {
		http.QueryInterface(Ci.nsIHttpChannel);
		repl.print("start " + http.URI.asciiSpec);
		
		var responseId = Date.now();
		if (this.prevResponseId && responseId <= this.prevResponseId) responseId = this.prevResponseId + 1;
		this.prevResponseId = responseId;
		
		var respBasePath = OS.Path.join(this.basePath, responseId);
		var respDirPromise = this.catalogFilePromise
			.then( () => OS.File.makeDir(respBasePath) );
		respDirPromise
			.catch( e => {
				repl.print(e);
			});
		
		var httpHeadersPromise = HttpObserver.saveHttpHeaders(respDirPromise, respBasePath, http, topic);
		httpHeadersPromise
			.catch( e => {
				repl.print(e);
			});
		// TODO: POST request data
		
		var respDataPath = OS.Path.join(respBasePath, "data");
		var respDataPromise = respDirPromise
			.then( () => OS.File.open(respDataPath, {write: true, truncate: true}) );
		respDataPromise
			.catch( e => {
				repl.print(e);
			});
		
		// adding new listener immediately (even maybe before output file creation)
		// otherwise if we add listener in promise then setNewListener will throw NS_ERROR_FAILURE
		http.QueryInterface(Ci.nsITraceableChannel);
		var newListener = new TracingListener(respDataPromise, respDataDonePromise => {
			respDataDonePromise
				.catch( e => {
					repl.print(e);
				});
			var cacheEntryPromise = HttpObserver.saveCacheEntry(respDirPromise, respBasePath, http.URI.asciiSpec);
			cacheEntryPromise
				.catch( e => {
					repl.print(e);
				});
			this.addCatalogRecord(
				Promise.all([
					httpHeadersPromise,
					respDataDonePromise,
					cacheEntryPromise
				]),
				responseId,
				http.URI.asciiSpec
			);
		});
		newListener.originalListener = http.setNewListener(newListener);
	},
	
	addCatalogRecord: function(respAllDonePromise, responseId, url) {
		this.catalogFilePromise = respAllDonePromise
			.then(
				() => {
					return Promise.resolve()
						.then( () => {
							let encoder = new TextEncoder();
							let array = encoder.encode(responseId + " " + url + "\n");
							return this.catalogFile.write(array);
						})
						.then( () => this.catalogFile.flush() );
				},
				e => {
					repl.print(e);
				}
			)
			.then( () => {
				repl.print("done  " + url);
			});
		this.catalogFilePromise
			.catch( e => {
				repl.print(e);
			});
	}
};
HttpObserver.createFileToWrite = function(parentPromise, filePath, writeCallback) {
	return parentPromise
		.then( () => OS.File.open(filePath, {write: true, truncate: true}) )
		.then( file => {
			return Promise.resolve()
				.then( () => writeCallback(file) )
				.finally( () => file.close() );
		});
};
HttpObserver.saveHttpHeaders = function(respDirPromise, respBasePath, http, topic) {
	var httpHeadersPath = OS.Path.join(respBasePath, "http");
	return HttpObserver.createFileToWrite(respDirPromise, httpHeadersPath, function(file) {
		// write http headers into file
		
		let httpReqHeads = [];
		http.visitRequestHeaders({
			visitHeader: function(aHeader, aValue) {
				httpReqHeads.push([aHeader, aValue]);
			}
		});
		
		let httpRespHeads = [];
		http.visitResponseHeaders({
			visitHeader: function(aHeader, aValue) {
				httpRespHeads.push([aHeader, aValue]);
			}
		});
		
		let out = {
			"topic": topic,
			securityInfo: {
				// TODO
			},
			request: {
				method: http.requestMethod,
				URI: http.URI.spec,
				// originalURI: http.originalURI,
				// name: http.name,
				headers: httpReqHeads,
				referrer: http.referrer,
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
		let encoder = new TextEncoder();
		let array = encoder.encode(JSON.stringify(out));
		return file.write(array);
	});
};
HttpObserver.saveCacheEntry = function(respDirPromise, respBasePath, url) {
	var cacheEntryPath = OS.Path.join(respBasePath, "cache");
	return HttpObserver.createFileToWrite(respDirPromise, cacheEntryPath, function(file) {
		// write cache entry int file
		// TODO
		let out = {
			"url": url,
		};
		let encoder = new TextEncoder();
		let array = encoder.encode(JSON.stringify(out));
		return file.write(array);
	});
};

this.run = function() {
	Promise.resolve()
		.then( () => OS.File.makeDir(homePath) )
		.then( () => {
			this.httpObserver = new HttpObserver();
			this.httpObserver.start();
		})
		.catch( e => {
			repl.print(e);
		});
};

// https://developer.mozilla.org/en-US/docs/Mozilla/Tech/XPCOM/Reference/Interface/NsITraceableChannel

var BinaryInputStream = CC('@mozilla.org/binaryinputstream;1', 'nsIBinaryInputStream', 'setInputStream');
var BinaryOutputStream = CC('@mozilla.org/binaryoutputstream;1', 'nsIBinaryOutputStream', 'setOutputStream');
var StorageStream = CC('@mozilla.org/storagestream;1', 'nsIStorageStream', 'init');

function TracingListener(fileOpenPromise, onDone) {
	this.filePromise = fileOpenPromise
		.then( file => {
			this.file = file;
		});
	this.onDone = onDone;
}
TracingListener.prototype = {
	originalListener: null,
	file: null,

	onDataAvailable: function(aRequest, aContext, aInputStream, aOffset, aCount) {
		try {
			var iStream = new BinaryInputStream(aInputStream);
			var sStream = new StorageStream(8192, aCount, null);
			var oStream = new BinaryOutputStream(sStream.getOutputStream(0));

			var data = iStream.readByteArray(aCount);
			oStream.writeByteArray(data, aCount);

			this.filePromise = this.filePromise.then( () => this.file.write(new Uint8Array(data)) );

			this.originalListener.onDataAvailable(aRequest, aContext, sStream.newInputStream(0), aOffset, aCount);
		} catch(e) {
			repl.print(e);
		}
	},
	onStartRequest: function(aRequest, aContext) {
		try {
			this.originalListener.onStartRequest(aRequest, aContext);
		} catch(e) {
			repl.print(e);
		}
	},
	onStopRequest: function(aRequest, aContext, aStatusCode) {
		try {
			this.originalListener.onStopRequest(aRequest, aContext, aStatusCode);
			
			if (aStatusCode !== Cr.NS_OK) {
				if (!(
					aStatusCode === Cr.NS_BINDING_ABORTED ||
					aStatusCode === 0x805303F4 ||				// NS_ERROR_DOM_BAD_URI
					aStatusCode === 0x80540005 ||				// NS_IMAGELIB_ERROR_FAILURE
					aStatusCode === 0x805D0021 ||				// NS_ERROR_PARSED_DATA_CACHED
					aStatusCode === Cr.NS_ERROR_NET_INTERRUPT
				)) {
					this.filePromise = this.filePromise.then( () => Promise.reject(aStatusCode) );
				}
			}
			
			this.filePromise = this.filePromise
				.finally( () => {
					if (this.file) {
						return this.file.close().catch( e => {
							repl.print(e);
						});
					}
				});
		} catch(e) {
			repl.print(e);
		}
		
		try {
			this.onDone(this.filePromise);
		} catch(e) {
			repl.print(e);
		}
	},
};

this.run();
}
httpReply.start();

