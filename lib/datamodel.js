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
		.then( dbFileExists => DMRoot.createDatabase(dbName, dbFileExists) )
		.then(
			dbConn => dbConn.execute('PRAGMA foreign_keys = ON')
				.then( () => dbConn )
		);
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

const responseOOPreset = makeOrmPreset({
	"responses": {
		insert: [
			"observation_id",
			"http_channel_id",
			"http_response_data_id",
			"http_status_id",
			"cache_entry_id",
		]
	}
});
function DMResponse(dbConnPromise, obsIdPromise) {
	this.dbConnPromise = dbConnPromise;
	
	this.httpDeferred = new Deferred();
	this.dataDeferred = new Deferred();
	this.httpStatusDeferred = new Deferred();
	this.cacheEntryDeferred = new Deferred();
	
	this.onDonePromise = promiseWaitAll([
		this.dbConnPromise,
		obsIdPromise,
		this.httpDeferred.promise,
		this.dataDeferred.promise,
		this.httpStatusDeferred.promise,
		this.cacheEntryDeferred.promise,
	])
	.then(
		resArr => ({
			dbConn:                resArr[0],
			observation_id:        resArr[1],
			http_channel_id:       resArr[2],
			http_response_data_id: resArr[3],
			http_status_id:        resArr[4],
			cache_entry_id:        resArr[5],
		})
	)
	.then(
		results => executeOrmObj(results.dbConn, responseOOPreset, {
			"responses": {
				observation_id:        results.observation_id,
				http_channel_id:       results.http_channel_id,
				http_response_data_id: results.http_response_data_id,
				http_status_id:        results.http_status_id,
				cache_entry_id:        results.cache_entry_id,
			}
		})
	);
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
			"tracing_status",
			"http_status",
		]
	}
});
const cacheEntryOOPreset = makeOrmPreset(cloneReplace(commonOOPresetConfig, [], {
	"cache_entries": {
		insert: [
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
		
		let httpChannelOO = {
			"http_channels": {
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
			}
		};
		
		let httpChannelPromise = this.dbConnPromise
			.then( dbConn => executeOrmObj(dbConn, httpChannelOOPreset, httpChannelOO) )
			.then( results => results[0] ); // ignore sub-executions results
		httpChannelPromise
			.catch( e => {console.error(e)} );
		tiePromiseWithDeferred(httpChannelPromise, this.httpDeferred);
		this.httpTied = true;
	},
	
	createData: function() {
		var dmData = new DMData(this.dbConnPromise);
		tiePromiseWithDeferred(dmData.getOnDonePromise(), this.dataDeferred);
		this.dataTied = true;
		return dmData;
	},
	
	prepareAndSaveHttpStatus: function(httpStatus, dataError) {
		this.saveHttpStatus(DMResponse.prepareHttpStatus(httpStatus, dataError));
	},
	
	saveHttpStatus: function(obj) {
		let httpStatusOO = {
			"http_statuses": {
				tracing_status: ("tracingStatus" in obj ? obj.tracingStatus : 0),
				http_status: obj.httpStatus
			}
		};
		let httpStatusPromise = this.dbConnPromise
			.then( dbConn => executeOrmObj(dbConn, httpStatusOOPreset, httpStatusOO) );
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
			this.cacheEntryDeferred.resolve(null);
			this.cacheEntryTied = true;
			return;
		}
		let meta = obj.meta;
		let cacheEntryOO = {
			"cache_entries": cloneReplace(obj, ["meta"], {
				http_request_method_id: {"http_request_methods": {value: meta.request.method}},
				http_request_header_list_id: function*(executor) {
					return yield* DMResponse.httpRequestHeaderListCallback(meta.request.headers, executor);
				},
				http_response_status_http_version_id: {
					"http_response_status_http_versions": {
						value: meta.response.status.httpVersion
					}
				},
				http_response_status_code: meta.response.status.code,
				http_response_status_text: meta.response.status.text,
				http_response_header_list_id: function*(executor) {
					return yield* DMResponse.httpResponseHeaderListCallback(meta.response.headers, executor);
				},
				cache_entry_meta_list_id: function*(executor) {
					return yield* DMResponse.cacheEntryMetaListCallback(meta.other, executor);
				},
			})
		};
		
		let cacheEntryPromise = this.dbConnPromise
			.then( dbConn => executeOrmObj(dbConn, cacheEntryOOPreset, cacheEntryOO) )
			.then( results => results[0] ); // ignore sub-executions results
		cacheEntryPromise
			.catch( e => {console.error(e)} );
		tiePromiseWithDeferred(cacheEntryPromise, this.cacheEntryDeferred);
		this.cacheEntryTied = true;
	},
	
	interrupt: function() {
		if (! this.httpTied) this.httpDeferred.resolve(null);
		if (! this.dataTied) this.dataDeferred.resolve(null);
		if (! this.httpStatusTied) this.httpStatusDeferred.resolve(null);
		if (! this.cacheEntryTied) this.cacheEntryDeferred.resolve(null);
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

function DMData(dbConnPromise) {
	this.dbConnPromise = dbConnPromise;
	this.deferred = new Deferred();
}
const httpResponseDataOOPreset = makeOrmPreset({
	"http_response_datas": {
		insert: ["data"]
	}
});
DMData.prototype = {
	dataBuffer: [],

	getOnDonePromise: function() {
		return this.deferred.promise;
	},
	
	writeByteArray: function(data) {
		this.dataBuffer = this.dataBuffer.concat(data);
	},
	
	close: function() {
		let httpResponseDataOO = {
			"http_response_datas": {
				data: this.dataBuffer
			}
		};
		this.dataBuffer = []; // not necessary, doing it now to free memory earlier
		let dataPromise = this.dbConnPromise
			.then( dbConn => executeOrmObj(dbConn, httpResponseDataOOPreset, httpResponseDataOO) );
		dataPromise
			.catch( e => {console.error(e)} );
		tiePromiseWithDeferred(dataPromise, this.deferred);
	},
};

exports.DMRoot = DMRoot;

