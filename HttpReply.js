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
		
		let securityInfoDataObj;
		if (http.securityInfo !== null) {
			securityInfoDataObj = SecurityInfoParser.parseSecurityInfo(http.securityInfo);
		} else {
			securityInfoDataObj = null;
		}
		
		let out = {
			"topic": topic,
			securityInfo: securityInfoDataObj,
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
			// TODO: use Pipe
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

var Pipe = CC('@mozilla.org/pipe;1', 'nsIPipe', 'init');
//var BinaryInputStream = CC('@mozilla.org/binaryinputstream;1', 'nsIBinaryInputStream', 'setInputStream');
var ObjectOutputStream = CC('@mozilla.org/binaryoutputstream;1', 'nsIObjectOutputStream', 'setOutputStream');
const PR_UINT32_MAX = 0xffffffff;

var SecurityInfoParser = {
	TransportSecurityInfoID:    [0x16786594, 0x0296, 0x4471, [0x80, 0x96, 0x8F, 0x84, 0x49, 0x7C, 0xA4, 0x28]],
	nsISupportsID:              [0x00000000, 0x0000, 0x0000, [0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46]],
	TransportSecurityInfoMagic: [0xA9863A23, 0x1FAA, 0x4169, [0xB0, 0xD2, 0x81, 0x29, 0xEC, 0x7C, 0xB1, 0xDE]],
	nsSSLStatusID:              [0xE2F14826, 0x9E70, 0x4647, [0xB2, 0x3F, 0x10, 0x10, 0xF5, 0x12, 0x46, 0x28]],
	nsISSLStatusID:             [0xFA9BA95B, 0xCA3B, 0x498A, [0xB8, 0x89, 0x7C, 0x79, 0xCF, 0x28, 0xFE, 0xE8]],
	nsNSSCertificateID:         [0x660A3226, 0x915C, 0x4FFB, [0xBB, 0x20, 0x89, 0x85, 0xA6, 0x32, 0xDF, 0x05]],
	nsIX509CertID:              [0xF8ED8364, 0xCED9, 0x4C6E, [0x86, 0xBA, 0x48, 0xAF, 0x53, 0xC3, 0x93, 0xE6]],
	nsX509CertListID:           [0x959FB165, 0x6517, 0x487F, [0xAB, 0x9B, 0xD8, 0x91, 0x3B, 0xE5, 0x31, 0x97]],
	nsIX509CertListID:          [0xAE74CDA5, 0xCD2F, 0x473F, [0x96, 0xF5, 0xF0, 0xB7, 0xFF, 0xF6, 0x2C, 0x68]],
};
SecurityInfoParser.parseSecurityInfo = function(securityInfo) {
	securityInfo.QueryInterface(Ci.nsISerializable);
	
	var pipe = new Pipe(false, false, 0, PR_UINT32_MAX, null);
	var objOStream = new ObjectOutputStream(pipe.outputStream);
	objOStream.writeCompoundObject(securityInfo, Ci.nsISupports, true);
	objOStream.close();

	var iStream = new BinaryInputStream(pipe.inputStream);
	var res = {};
	SecurityInfoParser.parseSecurityInfoStream(iStream, res);
	
	var remainderCount;
	try {
		remainderCount = iStream.available();
	} catch(e) {
		remainderCount = 0;
	}
	if (remainderCount > 0) throw Error("remainder");
	iStream.close();
	
	return res;
};
SecurityInfoParser.parseSecurityInfoStream = function(iStream, outObj) {
	var cid = SecurityInfoParser.readID(iStream);
	var iid = SecurityInfoParser.readID(iStream);
	if (! SecurityInfoParser.ID_equal(cid, SecurityInfoParser.TransportSecurityInfoID))
		throw Error("TransportSecurityInfo cid");
	if (! SecurityInfoParser.ID_equal(iid, SecurityInfoParser.nsISupportsID))
		throw Error("nsISupports iid");
	//outObj["cid"] = cid;
	//outObj["iid"] = iid;

	var id = SecurityInfoParser.readID(iStream);
	if (! SecurityInfoParser.ID_equal(id, SecurityInfoParser.TransportSecurityInfoMagic))
		throw Error("TransportSecurityInfoMagic");
	//outObj["magic"] = id;

	outObj["securityState"]             = iStream.read32();
	outObj["subRequestsBrokenSecurity"] = iStream.read32();
	outObj["subRequestsNoSecurity"]     = iStream.read32();
	outObj["errorCode"]                 = iStream.read32();
	outObj["errorMessageCached"]        = iStream.readString();

	var SSLStatus;
	if (iStream.readBoolean()) {
		SSLStatus = {};
		SecurityInfoParser.parseSSLStatusStream(iStream, SSLStatus);
	} else {
		SSLStatus = null;
	}
	outObj["SSLStatus"] = SSLStatus;

	var failedCertChain;
	if (iStream.readBoolean()) {
		failedCertChain = {};
		SecurityInfoParser.parseFailedCertChainStream(iStream, failedCertChain);
	} else {
		failedCertChain = null;
	}
	outObj["failedCertChain"] = failedCertChain;
};
SecurityInfoParser.parseSSLStatusStream = function(iStream, outObj) {
	var cid = SecurityInfoParser.readID(iStream);
	var iid = SecurityInfoParser.readID(iStream);
	if (! SecurityInfoParser.ID_equal(cid, SecurityInfoParser.nsSSLStatusID))
		throw Error("nsSSLStatus cid");
	if (! SecurityInfoParser.ID_equal(iid, SecurityInfoParser.nsISSLStatusID))
		throw Error("nsISSLStatus iid");
	//outObj["cid"] = cid;
	//outObj["iid"] = iid;
	
	outObj["serverCert"] = {};
	SecurityInfoParser.parseCertStream(iStream, outObj["serverCert"]);
	
	outObj["cipherSuite"]                = iStream.read16();
	outObj["protocolVersion"]            = iStream.read16();
	outObj["isDomainMismatch"]           = iStream.readBoolean();
	outObj["isNotValidAtThisTime"]       = iStream.readBoolean();
	outObj["isUntrusted"]                = iStream.readBoolean();
	outObj["isEV"]                       = iStream.readBoolean();
	outObj["hasIsEVStatus"]              = iStream.readBoolean();
	outObj["haveCipherSuiteAndProtocol"] = iStream.readBoolean();
	outObj["haveCertErrorBits"]          = iStream.readBoolean();
};
SecurityInfoParser.parseCertStream = function(iStream, outObj) {
	var cid = SecurityInfoParser.readID(iStream);
	var iid = SecurityInfoParser.readID(iStream);
	if (! SecurityInfoParser.ID_equal(cid, SecurityInfoParser.nsNSSCertificateID))
		throw Error("nsNSSCertificate cid");
	if (! SecurityInfoParser.ID_equal(iid, SecurityInfoParser.nsIX509CertID))
		throw Error("nsIX509Cert iid");
	//outObj["cid"] = cid;
	//outObj["iid"] = iid;
	
	outObj["cachedEVStatus"] = iStream.read32();
	
	var certLen = iStream.read32();
	var certBytes = iStream.readBytes(certLen);
	//outObj["len"] = certLen;
	outObj["cert"] = window.btoa(certBytes);
};
SecurityInfoParser.parseFailedCertChainStream = function(iStream, outObj) {
	var cid = SecurityInfoParser.readID(iStream);
	var iid = SecurityInfoParser.readID(iStream);
	if (! SecurityInfoParser.ID_equal(cid, SecurityInfoParser.nsX509CertListID))
		throw Error("nsX509CertList cid");
	if (! SecurityInfoParser.ID_equal(iid, SecurityInfoParser.nsIX509CertListID))
		throw Error("nsIX509CertList iid");
	//outObj["cid"] = cid;
	//outObj["iid"] = iid;
	
	var certListLen = iStream.read32();
	//outObj["certListLen"] = certListLen;
	var certList = new Array(certListLen);
	for (let i = 0; i < certListLen; ++i) {
		let cert = {};
		SecurityInfoParser.parseCertStream(iStream, cert);
		certList[i] = cert;
	}
	outObj["certList"] = certList;
};
SecurityInfoParser.readID = function(iStream) {
	var m = new Array(4);
	m[0] = iStream.read32();
	m[1] = iStream.read16();
	m[2] = iStream.read16();
	m[3] = new Array(8);
	for (let i = 0; i < 8; ++i) {
		m[3][i] = iStream.read8();
	}
	return m;
};
SecurityInfoParser.ID_equal = function(a, b) {
	if (a[0] !== b[0]) return false;
	if (a[1] !== b[1]) return false;
	if (a[2] !== b[2]) return false;
	for (let i = 0; i < 8; ++i) {
		if (a[3][i] !== b[3][i]) return false;
	}
	return true;
};
SecurityInfoParser.packSecurityInfo = function(siDataObj) {
	var pipe = new Pipe(false, false, 0, PR_UINT32_MAX, null);
	
	var oStream = new BinaryOutputStream(pipe.outputStream);
	SecurityInfoParser.packSecurityInfoStream(oStream, siDataObj);
	oStream.close();
	
	return pipe.inputStream;
};
SecurityInfoParser.packSecurityInfoStream = function(oStream, inObj) {
	SecurityInfoParser.writeID(oStream, SecurityInfoParser.TransportSecurityInfoID);
	SecurityInfoParser.writeID(oStream, SecurityInfoParser.nsISupportsID);
	
	SecurityInfoParser.writeID(oStream, SecurityInfoParser.TransportSecurityInfoMagic);
	
	oStream.write32(inObj["securityState"]);
	oStream.write32(inObj["subRequestsBrokenSecurity"]);
	oStream.write32(inObj["subRequestsNoSecurity"]);
	oStream.write32(inObj["errorCode"]);
	oStream.writeWStringZ(inObj["errorMessageCached"]);
	
	var SSLStatus = inObj["SSLStatus"];
	oStream.writeBoolean(SSLStatus !== null);
	if (SSLStatus !== null) {
		SecurityInfoParser.packSSLStatusStream(oStream, SSLStatus);
	}

	var failedCertChain = inObj["failedCertChain"];
	oStream.writeBoolean(failedCertChain !== null);
	if (failedCertChain !== null) {
		SecurityInfoParser.packFailedCertChainStream(oStream, failedCertChain);
	}
};
SecurityInfoParser.packSSLStatusStream = function(oStream, inObj) {
	SecurityInfoParser.writeID(oStream, SecurityInfoParser.nsSSLStatusID);
	SecurityInfoParser.writeID(oStream, SecurityInfoParser.nsISSLStatusID);
	
	SecurityInfoParser.packCertStream(oStream, inObj["serverCert"]);
	
	oStream.write16(inObj["cipherSuite"]);
	oStream.write16(inObj["protocolVersion"]);
	oStream.writeBoolean(inObj["isDomainMismatch"]);
	oStream.writeBoolean(inObj["isNotValidAtThisTime"]);
	oStream.writeBoolean(inObj["isUntrusted"]);
	oStream.writeBoolean(inObj["isEV"]);
	oStream.writeBoolean(inObj["hasIsEVStatus"]);
	oStream.writeBoolean(inObj["haveCipherSuiteAndProtocol"]);
	oStream.writeBoolean(inObj["haveCertErrorBits"]);
};
SecurityInfoParser.packCertStream = function(oStream, inObj) {
	SecurityInfoParser.writeID(oStream, SecurityInfoParser.nsNSSCertificateID);
	SecurityInfoParser.writeID(oStream, SecurityInfoParser.nsIX509CertID);
	
	oStream.write32(inObj["cachedEVStatus"]);
	
	var certBase64 = inObj["cert"];
	var cert = window.atob(certBase64);
	var len = cert.length;
	oStream.write32(len);
	oStream.writeBytes(cert, len);
};
SecurityInfoParser.packFailedCertChainStream = function(oStream, inObj) {
	SecurityInfoParser.writeID(oStream, SecurityInfoParser.nsX509CertListID);
	SecurityInfoParser.writeID(oStream, SecurityInfoParser.nsIX509CertListID);
	
	var certList = inObj["certList"];
	oStream.write32(certList.length);
	for (let i = 0; i < certList.length; ++i) {
		SecurityInfoParser.packCertStream(oStream, certList[i]);
	}
};
SecurityInfoParser.writeID = function(oStream, ID) {
	oStream.write32(ID[0]);
	oStream.write16(ID[1]);
	oStream.write16(ID[2]);
	for (let i = 0; i < 8; ++i) {
		oStream.write8(ID[3][i]);
	}
};

this.run();
}
httpReply.start();

