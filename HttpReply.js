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

const observerService = Cc["@mozilla.org/observer-service;1"].getService(Ci.nsIObserverService);

const cacheService = Cc["@mozilla.org/netwerk/cache-storage-service;1"].getService(Ci.nsICacheStorageService);
Cu.import("resource://gre/modules/LoadContextInfo.jsm");

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
	cacheStorage: cacheService.memoryCacheStorage(LoadContextInfo.default),
	
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
				// TODO: write version into separate file
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
			repl.print(e);
		}
	},
	
	onModifyRequest: function(http) {
		http.QueryInterface(Ci.nsIHttpChannel);
		
		
	},
	
	onExamineAnyResponse: function(http, topic) {
		http.QueryInterface(Ci.nsIHttpChannel);
		//repl.print("start " + http.URI.asciiSpec);
		
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
			// TODO: if traced data length == 0 then save data from cache entry
			var cacheEntryPromise = HttpObserver.saveCacheEntry(
				respDirPromise,
				respBasePath,
				this.cacheStorage,
				http.URI,
				[httpHeadersPromise, respBasePath]
			);
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
				//repl.print("done  " + url);
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
		
		let certCount = 0;
		let certsSavePromise = Promise.resolve();
		let siParser = new SecurityInfoParser(function(bytes) {
			let certPath = OS.Path.join(respBasePath, "cert" + certCount);
			certsSavePromise = HttpObserver.createFileToWrite(certsSavePromise, certPath, function(file) {
				return file.write(HttpObserver.StringToUint8Array(bytes));
			});
			return certCount++;
		});
		certsSavePromise
			.catch( e => {
				repl.print(e);
			});
		
		let securityInfoDataObj;
		if (http.securityInfo !== null) {
			securityInfoDataObj = siParser.parseSecurityInfo(http.securityInfo);
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
		return Promise.all([certsSavePromise, file.write(array)]);
	});
};
HttpObserver.saveCacheEntry = function(respDirPromise, respBasePath, cacheStorage, URI, siCheckData) {
	var cacheEntryPath = OS.Path.join(respBasePath, "cache");
	return HttpObserver.createFileToWrite(respDirPromise, cacheEntryPath, function(file) {
		return HttpObserver.makeCacheEntryPromise(cacheStorage, URI)
			.then( aEntry => {
				if (aEntry === null) return;
				return HttpObserver.writeCacheEntry(aEntry, file, siCheckData);
			});

	});
};
HttpObserver.makeCacheEntryPromise = function(cacheStorage, URI) {
	return new Promise( (resolve, reject) => {
		cacheStorage.asyncOpenURI(URI, "", Ci.nsICacheStorage.OPEN_READONLY, {
			onCacheEntryCheck: function(aEntry, aApplicationCache) {
			},
			onCacheEntryAvailable: function(aEntry, aNew, aApplicationCache, aResult) {
				if (aResult == Cr.NS_OK) {
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
HttpObserver.writeCacheEntry = function(aEntry, file, siCheckData) {
	var out = {};
	
	var reqHeaders = [];
	aEntry.visitMetaData({
		onMetaDataElement: function(key, value) {
			switch(key) {
				case "security-info": {
					HttpObserver.compareSavedAndCachedSecurityInfo(value, siCheckData);
					break;
				}
				case "response-head": {
					let parsed = HttpObserver.parseCachedResponseHead(value);
					let statusLine = parsed[0];
					let headers    = parsed[1];
					out[key] = {
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
	
	var encoder = new TextEncoder();
	var array = encoder.encode(JSON.stringify(out));
	return file.write(array);
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
HttpObserver.compareSavedAndCachedSecurityInfo = function(siCachedBase64, siCheckData) {
	var httpHeadersPromise = siCheckData[0];
	var respBasePath       = siCheckData[1];
	var httpHeadersPath = OS.Path.join(respBasePath, "http");
	httpHeadersPromise
		.then( () => OS.File.open(httpHeadersPath, {read: true, existing: true}) )
		.then( file => {
			return Promise.resolve()
				.then( () => file.read() )
				.finally( () => file.close() )
		})
		.then( data => JSON.parse(HttpObserver.Uint8ArrayToString(data)) )
		.then( httpDataObj => httpDataObj["securityInfo"] )
		.then( siDataObj => {
			if (
				siDataObj === null && siCachedBase64 !== null ||
				siDataObj !== null && siCachedBase64 === null
			) return Promise.resolve(
				"si: " +
				 "saved is "+ (siDataObj      === null ? "" : "not ") + "null" +
				" but " +
				"cached is "+ (siCachedBase64 === null ? "" : "not ") + "null"
			);

			let certFileIDs = [];
			if (siDataObj.SSLStatus !== null) certFileIDs.push(siDataObj.SSLStatus.serverCert.cert);
			if (siDataObj.failedCertChain !== null) {
				siDataObj.failedCertChain.certList.forEach( certObj => {
					certFileIDs.push(certObj.cert);
				});
			}
			for (let i=0; i<certFileIDs.length; ++i) if (certFileIDs[i] !== i) throw Error();

			let certPromises = certFileIDs.map( certFileID => {
				let certPath = OS.Path.join(respBasePath, "cert" + certFileID);
				return Promise.resolve()
					.then( () => OS.File.open(certPath, {read: true, existing: true}) )
					.then( file => {
						return Promise.resolve()
							.then( () => file.read() )
							.finally( () => file.close() );
					})
					.then( data => HttpObserver.Uint8ArrayToString(data) );
			});

			return Promise.all(certPromises)
				.then( certs => {
					let siPacker = new SecurityInfoPacker(function(certFileID) {
						return certs[certFileID];
					});
					let iStream = new BinaryInputStream(siPacker.packSecurityInfo(siDataObj));
					let siBytes = iStream.readBytes(iStream.available());
					let siBase64 = window.btoa(siBytes);
					if (siCachedBase64 !== siBase64) return Promise.reject("si: saved != cached");
				});
		})
		.catch( e => {
			repl.print(e + "(" + respBasePath + ")");
		});
};
HttpObserver.Uint8ArrayToString = function(bytes) {
	var str = "";
	for (let i = 0; i < bytes.length; i++) {
		str += String.fromCharCode(bytes[i]);
	}
	return str;
};
HttpObserver.StringToUint8Array = function(str) {
	var array = new Uint8Array(new ArrayBuffer(str.length));
	for(i = 0; i < str.length; i++) {
		array[i] = str.charCodeAt(i);
	}
	return array;
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
var Pipe = CC('@mozilla.org/pipe;1', 'nsIPipe', 'init');
const PR_UINT32_MAX = 0xffffffff;

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
			var pipe = new Pipe(false, false, 0, PR_UINT32_MAX, null);
			var oStream = new BinaryOutputStream(pipe.outputStream);

			var data = iStream.readByteArray(aCount);
			oStream.writeByteArray(data, aCount);

			this.filePromise = this.filePromise.then( () => this.file.write(new Uint8Array(data)) );

			this.originalListener.onDataAvailable(aRequest, aContext, pipe.inputStream, aOffset, aCount);
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
				// TODO
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

var ObjectOutputStream = CC('@mozilla.org/binaryoutputstream;1', 'nsIObjectOutputStream', 'setOutputStream');

var SecurityInfo = {
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

function SecurityInfoParser(certWriter) {
	this.certWriter = certWriter; // binaryString => smth
}
SecurityInfoParser.prototype = {
	parseSecurityInfo: function(securityInfo) {
		securityInfo.QueryInterface(Ci.nsISerializable);

		var pipe = new Pipe(false, false, 0, PR_UINT32_MAX, null);
		var objOStream = new ObjectOutputStream(pipe.outputStream);
		objOStream.writeCompoundObject(securityInfo, Ci.nsISupports, true);
		objOStream.close();

		var iStream = new BinaryInputStream(pipe.inputStream);
		var res = {};
		this.parseSecurityInfoStream(iStream, res);

		var remainderCount;
		try {
			remainderCount = iStream.available();
		} catch(e) {
			remainderCount = 0;
		}
		if (remainderCount > 0) throw Error("remainder");
		iStream.close();

		return res;
	},
	parseSecurityInfoStream: function(iStream, outObj) {
		var cid = SecurityInfoParser.readID(iStream);
		var iid = SecurityInfoParser.readID(iStream);
		if (! SecurityInfoParser.ID_equal(cid, SecurityInfo.TransportSecurityInfoID))
			throw Error("TransportSecurityInfo cid");
		if (! SecurityInfoParser.ID_equal(iid, SecurityInfo.nsISupportsID))
			throw Error("nsISupports iid");
		//outObj["cid"] = cid;
		//outObj["iid"] = iid;

		var id = SecurityInfoParser.readID(iStream);
		if (! SecurityInfoParser.ID_equal(id, SecurityInfo.TransportSecurityInfoMagic))
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
			this.parseSSLStatusStream(iStream, SSLStatus);
		} else {
			SSLStatus = null;
		}
		outObj["SSLStatus"] = SSLStatus;

		var failedCertChain;
		if (iStream.readBoolean()) {
			failedCertChain = {};
			this.parseFailedCertChainStream(iStream, failedCertChain);
		} else {
			failedCertChain = null;
		}
		outObj["failedCertChain"] = failedCertChain;
	},
	parseSSLStatusStream: function(iStream, outObj) {
		var cid = SecurityInfoParser.readID(iStream);
		var iid = SecurityInfoParser.readID(iStream);
		if (! SecurityInfoParser.ID_equal(cid, SecurityInfo.nsSSLStatusID))
			throw Error("nsSSLStatus cid");
		if (! SecurityInfoParser.ID_equal(iid, SecurityInfo.nsISSLStatusID))
			throw Error("nsISSLStatus iid");
		//outObj["cid"] = cid;
		//outObj["iid"] = iid;

		outObj["serverCert"] = {};
		this.parseCertStream(iStream, outObj["serverCert"]);

		outObj["cipherSuite"]                = iStream.read16();
		outObj["protocolVersion"]            = iStream.read16();
		outObj["isDomainMismatch"]           = iStream.readBoolean();
		outObj["isNotValidAtThisTime"]       = iStream.readBoolean();
		outObj["isUntrusted"]                = iStream.readBoolean();
		outObj["isEV"]                       = iStream.readBoolean();
		outObj["hasIsEVStatus"]              = iStream.readBoolean();
		outObj["haveCipherSuiteAndProtocol"] = iStream.readBoolean();
		outObj["haveCertErrorBits"]          = iStream.readBoolean();
	},
	parseCertStream: function(iStream, outObj) {
		var cid = SecurityInfoParser.readID(iStream);
		var iid = SecurityInfoParser.readID(iStream);
		if (! SecurityInfoParser.ID_equal(cid, SecurityInfo.nsNSSCertificateID))
			throw Error("nsNSSCertificate cid");
		if (! SecurityInfoParser.ID_equal(iid, SecurityInfo.nsIX509CertID))
			throw Error("nsIX509Cert iid");
		//outObj["cid"] = cid;
		//outObj["iid"] = iid;

		outObj["cachedEVStatus"] = iStream.read32();

		var certLen = iStream.read32();
		var certBytes = iStream.readBytes(certLen);
		//outObj["len"] = certLen;
		outObj["cert"] = this.certWriter(certBytes);
	},
	parseFailedCertChainStream: function(iStream, outObj) {
		var cid = SecurityInfoParser.readID(iStream);
		var iid = SecurityInfoParser.readID(iStream);
		if (! SecurityInfoParser.ID_equal(cid, SecurityInfo.nsX509CertListID))
			throw Error("nsX509CertList cid");
		if (! SecurityInfoParser.ID_equal(iid, SecurityInfo.nsIX509CertListID))
			throw Error("nsIX509CertList iid");
		//outObj["cid"] = cid;
		//outObj["iid"] = iid;

		var certListLen = iStream.read32();
		//outObj["certListLen"] = certListLen;
		var certList = new Array(certListLen);
		for (let i = 0; i < certListLen; ++i) {
			let cert = {};
			this.parseCertStream(iStream, cert);
			certList[i] = cert;
		}
		outObj["certList"] = certList;
	},
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

function SecurityInfoPacker(certReader) {
	this.certReader = certReader; // smth => binaryString
}
SecurityInfoPacker.prototype = {
	packSecurityInfo: function(siDataObj) {
		var pipe = new Pipe(false, false, 0, PR_UINT32_MAX, null);

		var oStream = new BinaryOutputStream(pipe.outputStream);
		this.packSecurityInfoStream(oStream, siDataObj);
		oStream.close();

		return pipe.inputStream;
	},
	packSecurityInfoStream: function(oStream, inObj) {
		SecurityInfoParser.writeID(oStream, SecurityInfo.TransportSecurityInfoID);
		SecurityInfoParser.writeID(oStream, SecurityInfo.nsISupportsID);

		SecurityInfoParser.writeID(oStream, SecurityInfo.TransportSecurityInfoMagic);

		oStream.write32(inObj["securityState"]);
		oStream.write32(inObj["subRequestsBrokenSecurity"]);
		oStream.write32(inObj["subRequestsNoSecurity"]);
		oStream.write32(inObj["errorCode"]);
		oStream.writeWStringZ(inObj["errorMessageCached"]);

		var SSLStatus = inObj["SSLStatus"];
		oStream.writeBoolean(SSLStatus !== null);
		if (SSLStatus !== null) {
			this.packSSLStatusStream(oStream, SSLStatus);
		}

		var failedCertChain = inObj["failedCertChain"];
		oStream.writeBoolean(failedCertChain !== null);
		if (failedCertChain !== null) {
			this.packFailedCertChainStream(oStream, failedCertChain);
		}
	},
	packSSLStatusStream: function(oStream, inObj) {
		SecurityInfoParser.writeID(oStream, SecurityInfo.nsSSLStatusID);
		SecurityInfoParser.writeID(oStream, SecurityInfo.nsISSLStatusID);

		this.packCertStream(oStream, inObj["serverCert"]);

		oStream.write16(inObj["cipherSuite"]);
		oStream.write16(inObj["protocolVersion"]);
		oStream.writeBoolean(inObj["isDomainMismatch"]);
		oStream.writeBoolean(inObj["isNotValidAtThisTime"]);
		oStream.writeBoolean(inObj["isUntrusted"]);
		oStream.writeBoolean(inObj["isEV"]);
		oStream.writeBoolean(inObj["hasIsEVStatus"]);
		oStream.writeBoolean(inObj["haveCipherSuiteAndProtocol"]);
		oStream.writeBoolean(inObj["haveCertErrorBits"]);
	},
	packCertStream: function(oStream, inObj) {
		SecurityInfoParser.writeID(oStream, SecurityInfo.nsNSSCertificateID);
		SecurityInfoParser.writeID(oStream, SecurityInfo.nsIX509CertID);

		oStream.write32(inObj["cachedEVStatus"]);

		var cert = this.certReader(inObj["cert"]);
		var len = cert.length;
		oStream.write32(len);
		oStream.writeBytes(cert, len);
	},
	packFailedCertChainStream: function(oStream, inObj) {
		SecurityInfoParser.writeID(oStream, SecurityInfo.nsX509CertListID);
		SecurityInfoParser.writeID(oStream, SecurityInfo.nsIX509CertListID);

		var certList = inObj["certList"];
		oStream.write32(certList.length);
		for (let i = 0; i < certList.length; ++i) {
			this.packCertStream(oStream, certList[i]);
		}
	},
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

