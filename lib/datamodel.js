const {Promise, promiseWaitAll, Deferred, tiePromiseWithDeferred, dbName} = require("./common");
const {SecurityInfoParser} = require("./securityinfo");
const {Cu} = require("chrome");
const {OS} = Cu.import("resource://gre/modules/osfile.jsm", {});
const {Sqlite} = Cu.import("resource://gre/modules/Sqlite.jsm");

// DM -- DataModel
function DMRoot() {
	var dbPath = OS.Path.join(OS.Constants.Path.profileDir, dbName);
	this.dbConnPromise = OS.File.exists(dbPath)
		.then( dbFileExists => DMRoot.createDatabase(dbName, dbFileExists) )
		.then(dbConn => dbConn.execute('PRAGMA foreign_keys = ON')
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

function DMObservation(dbConnPromise) {
	this.dbConnPromise = dbConnPromise;
	this.obsIdPromise = dbConnPromise
		.then(
			dbConn => dbConn.executeTransaction(function*(conn) {
				yield conn.execute('INSERT INTO "observations" ("name") VALUES (:name)', {name: null});
				let rows = yield conn.execute('SELECT last_insert_rowid() AS lastInsertRowID');
				return rows[0].getResultByName("lastInsertRowID");
			})
		)
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

function DMResponse(dbConnPromise, obsIdPromise) {
	this.dbConnPromise = dbConnPromise;
	this.obsIdPromise = obsIdPromise;
	this.responseIdPromise = Promise.all([this.dbConnPromise, this.obsIdPromise])
		.then(
			results => results[0].executeTransaction(function*(conn) {
				yield conn.execute('INSERT INTO "responses" ("observation_id") VALUES (:observationId)', {observationId: results[1]});
				let rows = yield conn.execute('SELECT last_insert_rowid() AS lastInsertRowID');
				return rows[0].getResultByName("lastInsertRowID");
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
DMResponse.prototype = {
	httpTied: false,
	dataTied: false,
	httpStatusTied: false,
	cacheEntryTied: false,

	getOnDonePromise: function() {
		return this.onDonePromise;
	},
	
	// data -- TypedArray (for example Uint8Array)
	prepareSaveDataPromise: function(fileName, data) {
		//var filePath = OS.Path.join(this.basePath, fileName);
		var savePromise = this.responseIdPromise;
		//	.then( () => OS.File.writeAtomic(filePath, data, {noOverwrite: true, flush: true}) );
		//savePromise
		//	.catch( e => {console.error(e)} );
		return savePromise;
	},
	
	// data -- ByteArray
	prepareSaveByteArrayPromise: function(fileName, data) {
		return this.prepareSaveDataPromise(fileName, new Uint8Array(data));
	},
	
	prepareSaveDataObjPromise: function(fileName, dataObj) {
		//let encoder = new TextEncoder();
		//let array = encoder.encode(JSON.stringify(dataObj));
		let array = JSON.stringify(dataObj);
		return this.prepareSaveDataPromise(fileName, array);
	},
	
	prepareAndSaveHttp: function(http, topic) {
		this.saveHttp(DMResponse.prepareHttp(http, topic));
	},
	
	saveHttp: function(obj) {
		var promiseArr = [];
		{
			if (!("http" in obj)) throw Error();
			let httpDataObj = obj["http"];
			let httpPromise = this.prepareSaveDataObjPromise("http", httpDataObj);
			promiseArr.push(httpPromise);
		}
		if ("certs" in obj) {
			let certs = obj["certs"];
			certs.forEach( (cert, i) => {
				let certPromise = this.prepareSaveByteArrayPromise("cert" + i, cert);
				promiseArr.push(certPromise);
			});
		};
		if ("securityInfoRaw" in obj) {
			let siByteArray = obj["securityInfoRaw"];
			let siPromise = this.prepareSaveByteArrayPromise("securityInfoRaw", siByteArray);
			promiseArr.push(siPromise);
		};
		tiePromiseWithDeferred(promiseWaitAll(promiseArr), this.httpDeferred);
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
		var httpStatusPromise = this.prepareSaveDataObjPromise("status", dataObj);
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
		var cacheEntryPromise = this.prepareSaveDataObjPromise("cache", dataObj);
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
	
	var si = DMResponse.prepareHttpSecurityInfo(http.securityInfo);
	
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
DMResponse.prepareHttpSecurityInfo = function(securityInfo) {
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

