const {Promise, promiseWaitAll, Deferred, tiePromiseWithDeferred, dbName} = require("./common");
const {SecurityInfoParser} = require("./securityinfo");
const {Cu} = require("chrome");
const {OS} = Cu.import("resource://gre/modules/osfile.jsm", {});
//const {Sqlite} = Cu.import("resource://gre/modules/Sqlite.jsm");
const {Sqlite} = require("./sqlite");
const {makeOrmPreset, executeOrmObj, cloneReplace} = require("./sqliteORM");

// DM -- DataModel
function DMRoot() {
	var dbPath = OS.Path.join(OS.Constants.Path.profileDir, dbName);
	this.dbConnPromise = OS.File.exists(dbPath)
		.then( dbFileExists => DMRoot.createDatabase(dbName, dbFileExists) );
		//.then(
		//	dbConn => dbConn.execute('PRAGMA foreign_keys = ON')
		//		.then( () => dbConn )
		//);
	this.dbConnPromise
		.catch( e => {console.error(e)} );
	this.deferred = new Deferred();
}
DMRoot.prototype = {
	obsPromise: null,
	
	getOnDonePromise: function() {
		return this.deferred.promise;
	},
	
	createObservation: function() {
		if (this.obsPromise !== null) throw Error(); // (for now) support only one Observation in time
		var observation = new DMObservation(this.dbConnPromise);
		this.obsPromise = observation.getOnDonePromise();
		return observation;
	},
	
	finish: function() {
		var obsPromise = (this.obsPromise === null ? Promise.resolve() : this.obsPromise);
		var resPromise = this.dbConnPromise
			.then(
				dbConn => obsPromise
					.finally( () => dbConn.close() )
			);
		tiePromiseWithDeferred(resPromise, this.deferred);
	},
};
// returns: promise which
//     resolves with dbConn (and we have to close it later)
//     or rejects with error (and we don't need to close connection)
DMRoot.createDatabase = function(dbName, dbFileExists) {
	var dbConnPromise = Sqlite.openConnection({path: dbName});
	if (dbFileExists) {
		return dbConnPromise;
	} else {
		const sqlCommentRe = /--.*$/;
		const emptyLineRe = /^\s*$/;
		let schemaStatementsPromise = Promise.resolve()
			.then( () => require("sdk/self") )
			.then( sdkSelf => sdkSelf.data.load("schema.sql") )
			.then(
				schemaStr => schemaStr
					.split(/\r?\n/)
					.map( line => line.replace(sqlCommentRe, "") )
					.filter( line => ! emptyLineRe.test(line) )
					.map( line => line + "\n" )
					.join("")
					.split(";\n")
					.slice(0, -1)
			);
		return dbConnPromise
			.then(
				dbConn => schemaStatementsPromise
					.then(
						schemaStatements => dbConn.executeTransaction(
							function*(conn) {
								for (let i=0; i<schemaStatements.length; ++i) {
									let statement = schemaStatements[i];
									yield conn.execute(statement);
								}
							}
						)
					)
					.catch(
						e => dbConn.close()
							.then(
								() => {
									throw e;
								},
								closeErr => {
									console.error(closeErr);
									throw e;
								}
							)
					)
					.then( () => dbConn )
			);
	}
};

const observationOOPreset = makeOrmPreset({"observations": {insert: ["name"]}});
function DMObservation(dbConnPromise) {
	this.dbConnPromise = dbConnPromise;
	this.obsIdPromise = dbConnPromise
		.then(
			dbConn => executeOrmObj(dbConn, observationOOPreset, {
				"observations": {name: null}
			})
		);
	this.obsIdPromise
		.catch( e => {console.error(e)} );
	this.deferred = new Deferred();
}
DMObservation.prototype = {
	isStopped: false,
	respPromises: [],
	
	getOnDonePromise: function() {
		return this.deferred.promise;
	},
	
	createResponse: function() {
		if (this.isStopped) throw Error();
		var response = new DMResponse(this.dbConnPromise, this.obsIdPromise);
		this.respPromises.push(response.getOnDonePromise());
		return response;
	},
	
	finish: function() {
		this.isStopped = true;
		
		var promiseArr = [].concat(this.obsIdPromise, this.respPromises);
		tiePromiseWithDeferred(promiseWaitAll(promiseArr), this.deferred);
	},
};

const responseOOPreset = makeOrmPreset({"responses": {insert: ["observation_id"]}});
function DMResponse(dbConnPromise, obsIdPromise) {
	this.dbConnPromise = dbConnPromise;
	this.responseIdPromise = Promise.all([this.dbConnPromise, obsIdPromise])
		.then(
			results => executeOrmObj(results[0], responseOOPreset, {
				"responses": {observation_id: results[1]}
			})
		);
	this.responseIdPromise
		.catch( e => {console.error(e)} );
	
	this.httpDeferred = new Deferred();
	this.dataDeferred = new Deferred();
	this.httpStatusDeferred = new Deferred();
	this.cacheEntryDeferred = new Deferred();
	
	var promiseArr = [
		this.responseIdPromise,
		this.httpDeferred.promise,
		this.dataDeferred.promise,
		this.httpStatusDeferred.promise,
		this.cacheEntryDeferred.promise,
	];
	this.onDonePromise = promiseWaitAll(promiseArr);
}
const commonOOPresetConfig = {
	"http_request_methods": {
		"enum": {id: "id", value: "value"}
	},
	"http_response_status_http_versions": {
		"enum": {id: "id", value: "value"}
	},
	"http_response_content_types": {
		"enum": {id: "id", value: "value"}
	},
	"http_response_content_charsets": {
		"enum": {id: "id", value: "value"}
	},
	"http_request_header_lists": {
		insert: []
	},
	"http_request_header_lists_to_entries": {
		insert: [
			"http_request_header_list_id",
			"http_request_header_id"
		]
	},
	"http_request_headers": {
		insert: [
			"http_request_header_name_id",
			"value"
		]
	},
	"http_request_header_names": {
		"enum": {id: "id", value: "value"}
	},
	"http_response_header_lists": {
		insert: []
	},
	"http_response_header_lists_to_entries": {
		insert: [
			"http_response_header_list_id",
			"http_response_header_id"
		]
	},
	"http_response_headers": {
		insert: [
			"http_response_header_name_id",
			"value"
		]
	},
	"http_response_header_names": {
		"enum": {id: "id", value: "value"}
	},
};
const httpChannelOOPreset = makeOrmPreset(cloneReplace(commonOOPresetConfig, [], {
	"http_channels": {
		insert: [
			"response_id",
			"http_topic_id",
			"http_request_method_id",
			"uri",
			"http_request_header_list_id",
			"referrer",
			"statusCode",
			"statusText",
			"http_response_header_list_id",
			"contentLength",
			"http_response_content_type_id",
			"http_response_content_charset_id",
			"securityInfoData_id"
		]
	},
	"http_topics": {
		"enum": {id: "id", value: "value"}
	},
	"securityInfoDatas": {
		insert: [
			"securityInfo_id",
			"securityInfoRaw_id"
		]
	},
	"securityInfoRaws": {
		insert: ["data"]
	},
	"securityInfos": {
		insert: [
			"securityState",
			"subRequestsBrokenSecurity",
			"subRequestsNoSecurity",
			"errorCode",
			"errorMessageCached",
			"SSLStatus_id",
			"failedCertChain_id",
		]
	},
	"SSLStatuses": {
		insert: [
			"serverCert_id",
			"cipherSuite",
			"protocolVersion",
			"isDomainMismatch",
			"isNotValidAtThisTime",
			"isUntrusted",
			"isEV",
			"hasIsEVStatus",
			"haveCipherSuiteAndProtocol",
			"haveCertErrorBits",
		]
	},
	"certLists": {
		insert: []
	},
	"certLists_to_certObjs": {
		insert: [
			"certList_id",
			"certObj_id"
		]
	},
	"certObjs": {
		insert: [
			"cachedEVStatus",
			"certData_id"
		]
	},
	"certDatas": {
		insert: ["cert"]
	},
}));
const httpStatusOOPreset = makeOrmPreset({
	"http_statuses": {
		insert: [
			"response_id",
			"tracing_status",
			"http_status",
		]
	}
});
const cacheEntryOOPreset = makeOrmPreset(cloneReplace(commonOOPresetConfig, [], {
	"cache_entries": {
		insert: [
			"response_id",
			"key",
			"expirationTime",
			"predictedDataSize",
			"storageDataSize",
			"dataSize",
			"http_request_method_id",
			"http_request_header_list_id",
			"http_response_status_code",
			"http_response_status_text",
			"http_response_status_http_version_id",
			"http_response_header_list_id",
			"cache_entry_meta_list_id",
		]
	},
	"cache_entry_meta_lists": {
		insert: []
	},
	"cache_entry_meta_lists_to_entries": {
		insert: [
			"cache_entry_meta_list_id",
			"cache_entry_meta_id"
		]
	},
	"cache_entry_metas": {
		insert: [
			"cache_entry_meta_name_id",
			"value"
		]
	},
	"cache_entry_meta_names": {
		"enum": {id: "id", value: "value"}
	}
}));
DMResponse.prototype = {
	httpTied: false,
	dataTied: false,
	httpStatusTied: false,
	cacheEntryTied: false,

	getOnDonePromise: function() {
		return this.onDonePromise;
	},
	
	prepareAndSaveHttp: function(http, topic) {
		this.saveHttp(DMResponse.prepareHttp(http, topic));
	},
	
	saveHttp: function(obj) {
		let securityInfoDataOO;
		{
			let securityInfoData = obj.securityInfo;
			if (securityInfoData === null) {
				securityInfoDataOO = null;
			} else {
				let securityInfoOO;
				let securityInfo = ("parsed" in securityInfoData ? securityInfoData.parsed : null);
				if (securityInfo === null) {
					securityInfoOO = null;
				} else {
					let SSLStatusOO;
					let SSLStatus = securityInfo.SSLStatus;
					if (SSLStatus === null) {
						SSLStatusOO = null;
					} else {
						let certObj = SSLStatus.serverCert;
						let certObjOO = {
							"certObjs": cloneReplace(
								certObj,
								["cert"],
								{
									certData_id: {
										"certDatas": {cert: certObj.cert}
									}
								}
							)
						};
						SSLStatusOO = {
							"SSLStatuses": cloneReplace(
								SSLStatus,
								["serverCert"],
								{
									serverCert_id: certObjOO
								}
							)
						};
					}
					let certListOO;
					if (securityInfo.failedCertChain === null) {
						certListOO = null;
					} else {
						certListOO = function*(executor) {
							return yield* DMResponse.certListCallback(securityInfo.failedCertChain.certList, executor);
						};
					}
					securityInfoOO = {
						"securityInfos": cloneReplace(
							securityInfo,
							["SSLStatus", "failedCertChain"],
							{
								SSLStatus_id: SSLStatusOO,
								failedCertChain_id: certListOO
							}
						)
					};
				}
				let securityInfoRawOO;
				let securityInfoRaw = ("raw" in securityInfo ? securityInfoData.raw : null);
				if (securityInfoRaw === null) {
					securityInfoRawOO = null;
				} else {
					securityInfoRawOO = {
						"securityInfoRaws": {data: securityInfoRaw}
					};
				}
				securityInfoDataOO = {
					"securityInfoDatas": {
						securityInfo_id: securityInfoOO,
						securityInfoRaw_id: securityInfoRawOO
					}
				};
			}
		}
		
		let httpChannelOOTableParams = {
			// response_id: we will set it later: after this.responseIdPromise resolve
			http_topic_id: {"http_topics": {value: obj.topic}},
			http_request_method_id: {"http_request_methods": {value: obj.request.method}},
			uri: obj.request.URI,
			http_request_header_list_id: function*(executor) {
				return yield* DMResponse.httpRequestHeaderListCallback(obj.request.headers, executor);
			},
			referrer: obj.request.referrer,
			statusCode: obj.response.statusCode,
			statusText: obj.response.statusText,
			http_response_header_list_id: function*(executor) {
				return yield* DMResponse.httpResponseHeaderListCallback(obj.response.headers, executor);
			},
			contentLength: obj.response.contentLength,
			http_response_content_type_id: {"http_response_content_types": {value: obj.response.contentType}},
			http_response_content_charset_id: {"http_response_content_charsets": {value: obj.response.contentCharset}},
			securityInfoData_id: securityInfoDataOO,
		};
		
		// resolves with [httpChannelId, {<sub executions results>}]
		let httpChannelPromise = Promise.all([
			this.dbConnPromise,
			this.responseIdPromise
		])
		.then (
			results => executeOrmObj(results[0], httpChannelOOPreset, {
				"http_channels": cloneReplace(httpChannelOOTableParams, [], {response_id: results[1]})
			})
		);
		httpChannelPromise
			.catch( e => {console.error(e)} );
		tiePromiseWithDeferred(httpChannelPromise, this.httpDeferred);
		this.httpTied = true;
	},
	
	createData: function() {
		var dataFilePath = null; //var dataFilePath = OS.Path.join(this.basePath, "data");
		var dmData = new DMData(this.dbConnPromise, this.responseIdPromise);
		tiePromiseWithDeferred(dmData.getOnDonePromise(), this.dataDeferred);
		this.dataTied = true;
		return dmData;
	},
	
	prepareAndSaveHttpStatus: function(httpStatus, dataError) {
		this.saveHttpStatus(DMResponse.prepareHttpStatus(httpStatus, dataError));
	},
	
	saveHttpStatus: function(obj) {
		let httpStatusPromise = Promise.all([
			this.dbConnPromise,
			this.responseIdPromise
		])
		.then(
			results => executeOrmObj(results[0], httpStatusOOPreset, {
				"http_statuses": {
					response_id: results[1],
					tracing_status: ("tracingStatus" in obj ? obj.tracingStatus : 0),
					http_status: obj.httpStatus,
				}
			})
		)
		httpStatusPromise
			.catch( e => {console.error(e)} );
		tiePromiseWithDeferred(httpStatusPromise, this.httpStatusDeferred);
		this.httpStatusTied = true;
	},
	
	prepareAndSaveCacheEntry: function(aEntry) {
		let outCacheEntry;
		if (aEntry === null) {
			outCacheEntry = null;
		} else {
			outCacheEntry = DMResponse.prepareCacheEntry(aEntry);
		}
		this.saveCacheEntry(outCacheEntry);
	},
	
	// if null then don't save anything
	saveCacheEntry: function(obj) {
		if (obj === null) {
			this.cacheEntryDeferred.resolve();
			this.cacheEntryTied = true;
			return;
		}
		let meta = obj.meta;
		let cacheEntryOOTableParams = cloneReplace(obj, ["meta"], {
			// response_id: we will set it later
			http_request_method_id: {"http_request_methods": {value: meta.request.method}},
			http_request_header_list_id: function*(executor) {
				return yield* DMResponse.httpRequestHeaderListCallback(meta.request.headers, executor);
			},
			http_response_status_http_version_id: meta.response.status.httpVersion,
			http_response_status_code: meta.response.status.code,
			http_response_status_text: meta.response.status.text,
			http_response_header_list_id: function*(executor) {
				return yield* DMResponse.httpResponseHeaderListCallback(meta.response.headers, executor);
			},
			cache_entry_meta_list_id: function*(executor) {
				return yield* DMResponse.cacheEntryMetaListCallback(meta.other, executor);
			},
		});
		
		let cacheEntryPromise = Promise.all([
			this.dbConnPromise,
			this.responseIdPromise
		])
		.then(
			results => executeOrmObj(results[0], cacheEntryOOPreset, {
				"cache_entries": cloneReplace(cacheEntryOOTableParams, [], {response_id: results[1]})
			})
		);
		cacheEntryPromise
			.catch( e => {console.error(e)} );
		tiePromiseWithDeferred(cacheEntryPromise, this.cacheEntryDeferred);
		this.cacheEntryTied = true;
	},
	
	interrupt: function() {
		if (! this.httpTied) this.httpDeferred.resolve();
		if (! this.dataTied) this.dataDeferred.resolve();
		if (! this.httpStatusTied) this.httpStatusDeferred.resolve();
		if (! this.cacheEntryTied) this.cacheEntryDeferred.resolve();
	},
};
DMResponse.certListCallback = function*(certList, executor) {
	let certListId = yield* executor.execute({"certLists": {}});
	let relIds = [];
	for (let certObj of certList) {
		let relId = yield* executor.execute({
			"certLists_to_certObjs": {
				certList_id: certListId,
				certObj_id: {
					"certObjs": cloneReplace(
						certObj,
						["cert"],
						{
							certData_id: {
								"certDatas": {cert: certObj.cert}
							}
						}
					)
				}
			}
		});
		relIds.push(relId);
	}
	executor.addSubExecutionResult("certLists_to_certObjs", relIds);
	return certListId;
};
DMResponse.httpRequestHeaderListCallback = function*(headerList, executor) {
	let headerListId = yield* executor.execute({"http_request_header_lists": {}});
	let relIds = [];
	for (let header of headerList) {
		let relId = yield* executor.execute({
			"http_request_header_lists_to_entries": {
				http_request_header_list_id: headerListId,
				http_request_header_id: {
					"http_request_headers": {
						http_request_header_name_id: {
							"http_request_header_names": {value: header[0]}
						},
						value: header[1]
					}
				}
			}
		});
		relIds.push(relId);
	}
	executor.addSubExecutionResult("http_request_header_lists_to_entries", relIds);
	return headerListId;
};
DMResponse.httpResponseHeaderListCallback = function*(headerList, executor) {
	let headerListId = yield* executor.execute({"http_response_header_lists": {}});
	let relIds = [];
	for (let header of headerList) {
		let relId = yield* executor.execute({
			"http_response_header_lists_to_entries": {
				http_response_header_list_id: headerListId,
				http_response_header_id: {
					"http_response_headers": {
						http_response_header_name_id: {
							"http_response_header_names": {value: header[0]}
						},
						value: header[1]
					}
				}
			}
		});
		relIds.push(relId);
	}
	executor.addSubExecutionResult("http_response_header_lists_to_entries", relIds);
	return headerListId;
};
DMResponse.cacheEntryMetaListCallback = function*(metaList, executor) {
	let metaListId = yield* executor.execute({"cache_entry_meta_lists": {}});
	let relIds = [];
	for (let meta of metaList) {
		let relId = yield* executor.execute({
			"cache_entry_meta_lists_to_entries": {
				cache_entry_meta_list_id: metaListId,
				cache_entry_meta_id: {
					"cache_entry_metas": {
						cache_entry_meta_name_id: {
							"cache_entry_meta_names": {value: meta[0]}
						},
						value: meta[1]
					}
				}
			}
		});
		relIds.push(relId);
	}
	executor.addSubExecutionResult("cache_entry_meta_lists_to_entries", relIds);
	return metaListId;
};
DMResponse.prepareHttp = function(http, topic) {
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
		securityInfo: (http.securityInfo !== null ? DMResponse.prepareHttpSecurityInfo(http.securityInfo) : null),
	};
	
	return httpDataObj;
};
DMResponse.prepareHttpSecurityInfo = function(securityInfo) {
	try {
		var siDataObj = new SecurityInfoParser( byteArray => byteArray ).parseSecurityInfo(securityInfo);
		return {"parsed": siDataObj};
	} catch(e) {
		console.error("parseSecurityInfo error: " + e);
		var siByteArray = SecurityInfoParser.getSerializedSecurityInfo(securityInfo);
		return {"raw": siByteArray};
	}
};
DMResponse.prepareHttpStatus = function(tracingErr, httpStatus) {
	let out = {"httpStatus": httpStatus};
	if (tracingErr !== null) {
		let e = tracingErr;
		let tracingStatus;
		if ((typeof e) === "number") {
			tracingStatus = e;
		} else if (e !== null && typeof e === "object" && ("result" in e)) {
			let resNum = Number(e.result);
			if (Number.isNaN(resNum)) throw e.result;
			tracingStatus = resNum;
		} else {
			throw e;
		}
		out["tracingStatus"] = tracingStatus;
	}
	return out;
};
DMResponse.prepareCacheEntry = function(aEntry) {
	var out = {
		key:               aEntry.key,
		expirationTime:    aEntry.expirationTime,
		predictedDataSize: aEntry.predictedDataSize,
		storageDataSize:   aEntry.storageDataSize,
		dataSize:          aEntry.dataSize,
	};
	out["meta"] = DMResponse.prepareCacheMeta(aEntry);
	return out;
};
DMResponse.prepareCacheMeta = function(aEntry) {
	var out = {};
	var otherMeta = [];
	var reqHeaders = [];
	aEntry.visitMetaData({
		onMetaDataElement: function(key, value) {
			switch(key) {
				case "security-info": {
					break;
				}
				case "response-head": {
					try {
						out["response"] = DMResponse.parseCachedResponseHead(value);
					} catch(e) {
						console.error(e);
					}
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
						otherMeta.push([key, value]);
					}
				}
			}
		}
	});
	if (!("request"  in out)) throw Error("cache entry hasn't 'request-method' meta");
	if (!("response" in out)) throw Error("cache entry hasn't 'response-head' mata");
	out["request"]["headers"] = reqHeaders;
	out["other"] = otherMeta;
	return out;
};
const httpStatusLineRe = /^(HTTP[^ ]+) (\d+) (.*)$/;
const httpHeaderRe = /^([^:]+): (.*)$/;
DMResponse.parseCachedResponseHead = function(headStr) {
	let lines = headStr.split("\r\n");
	if (lines.length < 2) throw Error();
	if (lines[lines.length - 1] !== "") throw Error();
	
	let status = {};
	{
		let res = lines[0].match(httpStatusLineRe);
		if (res === null) throw Error();
		if (res.length !== 4) throw Error();
		status["httpVersion"] = res[1];
		status["code"]        = Number(res[2]);
		status["text"]        = res[3];
	}
	
	let headers = lines.slice(1, -1)
		.map(headerLine => {
			let res = headerLine.match(httpHeaderRe);
			if (res === null) throw Error();
			if (res.length !== 3) throw Error();
			let name = res[1];
			let value = res[2];
			return [name, value];
		});
	
	return {"status": status, "headers": headers};
};

function DMData(dbConnPromise, responseIdPromise) {
	this.dbConnPromise = dbConnPromise;
	this.responseIdPromise = responseIdPromise;
	this.deferred = new Deferred();
}
DMData.prototype = {
	getOnDonePromise: function() {
		return this.deferred.promise;
	},
	
	// data -- TypedArray (for example Uint8Array)
	write: function(data) {
		/*this.promise = this.promise
			.then( () => this.file.write(data) );
		this.promise
			.catch( e => {console.error(e)} );*/
	},
	
	// data -- ByteArray
	writeByteArray: function(data) {
		this.write(new Uint8Array(data));
	},
	
	close: function() {
		var donePromise = this.responseIdPromise;
			//.finally( () => this.file.close() );
		tiePromiseWithDeferred(donePromise, this.deferred);
	},
};

exports.DMRoot = DMRoot;

