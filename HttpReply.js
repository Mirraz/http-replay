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
var homePath = OS.Path.join(OS.Constants.Path.profileDir, "HttpReply");

function HttpObserver() {
	this.observeTopics = this.onRequestTopics.concat(this.onResponseTopics);
	this.basePath = homePath;
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
	
	start: function(homeCreatedPromise) {
		this.addObservers();
	},
	
	stop: function() {
		this.removeObservers();
		// TODO: wait all promises
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
		
		var url = http.URI.asciiSpec;
		var fileName = url.replace(/\//g, "#");
		repl.print(fileName);
		var filePath = OS.Path.join(this.basePath, fileName);
		
		http.QueryInterface(Ci.nsITraceableChannel);
		let newListener = new TracingListener(filePath, function(){onResponseDone(http, topic)});
		newListener.originalListener = http.setNewListener(newListener);
	},
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

function TracingListener(filePath, onDone) {
	this.filePath = filePath;
	this.onDone = onDone;
}
TracingListener.prototype = {
	filePromise: null,
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
			
			this.filePromise = Promise.resolve()
				.then( () => OS.File.open(this.filePath, {write: true, truncate: true}) )
				.then( file => {
					this.file = file;
				});
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
					this.filePromise = this.filePromise.then( () => Promise.reject(aStatusCode));
				}
			}
			
			this.filePromise
				.finally( () => {
					if (this.file) {
						return this.file.close().catch( e => {
							repl.print(e);
						});
					}
				})
				.catch( e => {
					repl.print(e);
				});
			
			if (aStatusCode === Cr.NS_OK) this.onDone();
		} catch(e) {
			repl.print(e);
		}
	},
};

function onResponseDone(http, topic) {
	repl.print(http.URI.asciiSpec);
}

this.run();
}
httpReply.start();

