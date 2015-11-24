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

const {TextDecoder, TextEncoder, OS} = Cu.import("resource://gre/modules/osfile.jsm", {});
const homePath = OS.Path.join(OS.Constants.Path.profileDir, "HttpReply");

function HttpObserver() {
	this.observeTopics = this.onRequestTopics.concat(this.onResponseTopics);
	var baseName = Date.now();
	this.basePath = OS.Path.join(homePath, baseName);
	this.catalogPath = OS.Path.join(this.basePath,  "catalog");
}
HttpObserver.prototype = {
	observerService: Cc["@mozilla.org/observer-service;1"].getService(Ci.nsIObserverService),
	onRequestTopics: [
		//"http-on-modify-request"
	],
	onResponseTopics: [
		"http-on-examine-response",
		"http-on-examine-cached-response",
		//"http-on-examine-merged-response",
	],
	catalogFile: null,
	catalogFilePromise: null,
	prevResponseId: null,
	
	start: function(homeCreatedPromise) {
		this.catalogFilePromise = Promise.resolve()
			.then( () => OS.File.makeDir(this.basePath) )
			.then( () => OS.File.open(this.catalogPath, {write: true, truncate: true}) )
			.then( file => {
				this.catalogFile = file;
				this.addObservers();
			});
		this.catalogFilePromise
			.catch( e => {
				repl.print(e);
			});
	},
	
	stop: function() {
		this.catalogFilePromise
			.then( () => {
				if (this.catalogFile) this.removeObservers();
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
		this.observeTopics.forEach( topic => {
			this.observerService.addObserver(this, topic, false);
		});
	},
	
	removeObservers: function() {
		this.observeTopics.forEach( topic => {
			this.observerService.removeObserver(this, topic, false);
		});
	},

	observe: function(subject, topic, data) {
		try {
			if (this.onRequestTopics.indexOf(topic) >= 0) {
				this.onModifyRequest(subject);
			} else if (this.onResponseTopics.indexOf(topic) >= 0) {
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
		
		var httpHeadersPromise = this.saveHttpHeaders(http, respBasePath, respDirPromise);
		httpHeadersPromise
			.catch( e => {
				repl.print(e);
			});
		
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
			var cacheEntryPromise = this.saveCacheEntry(http.URI.asciiSpec, respBasePath, respDirPromise);
			cacheEntryPromise
				.catch( e => {
					repl.print(e);
				});
			this.addCatalogRecord(
				http.URI.asciiSpec,
				responseId,
				Promise.all([
					httpHeadersPromise,
					respDataDonePromise,
					cacheEntryPromise
				])
			);
		});
		newListener.originalListener = http.setNewListener(newListener);
	},
	
	saveHttpHeaders: function(http, respBasePath, respDirPromise) {
		// TODO
		return respDirPromise;
	},
	
	saveCacheEntry: function(url, respBasePath, respDirPromise) {
		// TODO
		return respDirPromise;
	},
	
	addCatalogRecord: function(url, responseId, respAllDonePromise) {
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
					this.filePromise = this.filePromise.then(Promise.reject(aStatusCode));
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

