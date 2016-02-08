const {Promise, promiseWaitAll, Deferred, tiePromiseWithDeferred, dbName} = require("./common");
const {SecurityInfoParser} = require("./securityinfo");
const {Cu} = require("chrome");
const {OS} = Cu.import("resource://gre/modules/osfile.jsm", {});
const {Sqlite} = Cu.import("resource://gre/modules/Sqlite.jsm");

function makeInsertSql(tableName, columnNames) {
	return 'INSERT INTO "' + tableName + '" (' +
		columnNames.map( col => '"' + col + '"' ).join(', ') +
		') VALUES (' +
		columnNames.map( col => ":" + col ).join(', ') +
		')';
}

// returns: promise
function insertAndGetIdWithConn(dbConn, insertSql, params) {
	return dbConn.executeTransaction(function*(conn) {
		yield conn.executeCached(insertSql, params);
		let rows = yield conn.executeCached('SELECT last_insert_rowid() AS lastInsertRowID');
		return rows[0].getResultByName("lastInsertRowID");
	});
}

// returns: promise
function insertAndGetId(dbConnPromise, insertSql, params) {
	return dbConnPromise
		.then( dbConn => insertAndGetIdWithConn(dbConn, insertSql, params) );
}

function prepareEnumPreset(tableName, idColName, valueColName) {
	return {
		"idColName": idColName,
		"valueColName": valueColName,
		selectSql: 'SELECT "' + idColName + '" FROM "' + tableName + '" WHERE "' + valueColName + '" = :' + valueColName,
		insertSql: 'INSERT INTO "' + tableName + '" ("' + valueColName + '") VALUES (:' + valueColName + ')',
	};
}

// returns: promise
function obtainEnumIdWithConn(dbConn, preset, value) {
	return dbConn.executeTransaction(function*(conn) {
		let params = {};
		params[preset.valueColName] = value;
		let selectRows = yield dbConn.executeCached(preset.selectSql, params);
		if (selectRows.length !== 0) {
			return selectRows[0].getResultByName(preset.idColName);
		} else {
			yield dbConn.execute(preset.insertSql, params);
			let insertRows = yield conn.executeCached('SELECT last_insert_rowid() AS lastInsertRowID');
			return insertRows[0].getResultByName("lastInsertRowID");
		}
	});
}

// returns: promise
function obtainEnumId(dbConnPromise, preset, value) {
	return dbConnPromise
		.then( dbConn => obtainEnumIdWithConn(dbConn, preset, value) );
}

// DM -- DataModel
function DMRoot() {
	var dbPath = OS.Path.join(OS.Constants.Path.profileDir, dbName);
	this.dbConnPromise = OS.File.exists(dbPath)
		.then( dbFileExists => DMRoot.createDatabase(dbName, dbFileExists) );
		//.then( dbConn => dbConn.execute('PRAGMA foreign_keys = ON') // TODO
		//	.then( () => dbConn )
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

const observationInsertSql = makeInsertSql("observations", ["name"]);
function DMObservation(dbConnPromise) {
	this.dbConnPromise = dbConnPromise;
	this.obsIdPromise = insertAndGetId(dbConnPromise, observationInsertSql, {name: null});
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

const responseInsertSql = makeInsertSql("responses", ["observation_id"]);
function DMResponse(dbConnPromise, obsIdPromise) {
	this.dbConnPromise = dbConnPromise;
	this.responseIdPromise = Promise.all([this.dbConnPromise, obsIdPromise])
		.then( results => insertAndGetIdWithConn(results[0], responseInsertSql, {observation_id: results[1]}) );
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
DMResponse.HttpChannelInsertSql = makeInsertSql(
	"http_channels",
	[
		"response_id",
		"http_topic_id",
		"http_request_method_id",
		"uri",
		"referrer",
		"statusCode",
		"statusText",
		"contentLength",
		"http_response_content_type_id",
		"http_response_content_charset_id",
		"securityInfoData_id"
	]
);
DMResponse.HttpTopicPreset                  = prepareEnumPreset("http_topics",                    "id", "value");
DMResponse.HttpRequestMethodPreset          = prepareEnumPreset("http_request_methods",           "id", "value");
DMResponse.HttpResponseContentTypePreset    = prepareEnumPreset("http_response_content_types",    "id", "value");
DMResponse.HttpResponseContentCharsetPreset = prepareEnumPreset("http_response_content_charsets", "id", "value");
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
		var httpChannelIdPromise =
			Promise.all([
				this.dbConnPromise,
				this.responseIdPromise,
				obtainEnumId(this.dbConnPromise, DMResponse.HttpTopicPreset,                  obj.topic),
				obtainEnumId(this.dbConnPromise, DMResponse.HttpRequestMethodPreset,          obj.request.method),
				obtainEnumId(this.dbConnPromise, DMResponse.HttpResponseContentTypePreset,    obj.response.contentType),
				obtainEnumId(this.dbConnPromise, DMResponse.HttpResponseContentCharsetPreset, obj.response.contentCharset),
			])
			.then( resArr => {
				return {
					dbConn:                           resArr[0],
					response_id:                      resArr[1],
					http_topic_id:                    resArr[2],
					http_request_method_id:           resArr[3],
					http_response_content_type_id:    resArr[4],
					http_response_content_charset_id: resArr[5],
				};
			})
			.then(
				results => insertAndGetIdWithConn(results.dbConn, DMResponse.HttpChannelInsertSql, {
					response_id:                      results.response_id,
					http_topic_id:                    results.http_topic_id,
					http_request_method_id:           results.http_request_method_id,
					uri:                              obj.request.URI,
					referrer:                         obj.request.referrer,
					statusCode:                       obj.response.statusCode,
					statusText:                       obj.response.statusText,
					contentLength:                    obj.response.contentLength,
					http_response_content_type_id:    results.http_response_content_type_id,
					http_response_content_charset_id: results.http_response_content_charset_id,
					securityInfoData_id:              0, // TODO
				})
			);
		
		tiePromiseWithDeferred(httpChannelIdPromise, this.httpDeferred);
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
	
	saveHttpStatus: function(dataObj) {
		var httpStatusPromise = Promise.resolve(); //this.prepareSaveDataObjPromise("status", dataObj);
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
	saveCacheEntry: function(dataObj) {
		if (dataObj === null) {
			this.cacheEntryDeferred.resolve();
			return;
		}
		var cacheEntryPromise = Promise.resolve(); //this.prepareSaveDataObjPromise("cache", dataObj);
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
// returns: {parsed: {obj: {SECURITY_INFO_DATA_OBJ}, certs: [CERTS]}} or {raw: SECURITY_INFO_BYTES}
DMResponse.prepareHttpSecurityInfo = function(securityInfo) {
	try {
		var certCount = 0;
		var certs = [];
		var siDataObj = new SecurityInfoParser( byteArray => {
			certs[certCount] = byteArray;
			return certCount++;
		}).parseSecurityInfo(securityInfo);
		var out = {
			"obj": siDataObj,
			"certs": certs,
		};
		return {"parsed": out};
	} catch(e) {
		console.error("parseSecurityInfo error: " + e);
		var siByteArray = SecurityInfoParser.getSerializedSecurityInfo(securityInfo);
		return {"raw": siByteArray};
	}
};
DMResponse.prepareHttpStatus = function(httpStatus, dataError) {
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
	
	var reqHeaders = [];
	aEntry.visitMetaData({
		onMetaDataElement: function(key, value) {
			switch(key) {
				case "security-info": {
					break;
				}
				case "response-head": {
					let parsed = DMResponse.parseCachedResponseHead(value);
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
DMResponse.parseCachedResponseHead = function(headStr) {
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

