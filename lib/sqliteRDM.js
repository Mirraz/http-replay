const {Promise, promiseWaitAll, Deferred, tiePromiseWithDeferred} = require("./common");
const {dbName, dbPath} = require("./sqliteDM");
const {Cu} = require("chrome");
const {OS} = Cu.import("resource://gre/modules/osfile.jsm", {});
//const {Sqlite} = Cu.import("resource://gre/modules/Sqlite.jsm");
const {Sqlite} = require("./sqlite");

/*
colConfigArr = [
	"col01",
	{table: "table01", col: "col02", alias: "t01c02"},
]
*/

function makeSqlColNamesStr(colConfigArr) {
	return colConfigArr
		.map( column => {
			if (typeof column === "object" && column !== null) {
				return '"' + column.table + '"."' + column.col + '" AS "' + column.alias + '"';
			} else {
				return '"' + column + '"';
			}
		})
		.join(', ');
}

function makeResultColNames(colConfigArr) {
	return colConfigArr
		.map( column => {
			if (typeof column === "object" && column !== null) {
				return column.alias;
			} else {
				return column;
			}
		});
}

function selectObjs(dbConn, selectSql, colNames, params) {
	return dbConn.executeCached(selectSql, params)
		.then(
			rows => rows.map( row => {
				let obj = {};
				colNames.forEach( colName => {
					obj[colName] = row.getResultByName(colName);
				});
				return obj;
			})
		);
}

const interruptMessage = "Interrupted";

// RDM -- ReadDataModel
function RDMRoot() {
	this.dbConnPromise = OS.File.exists(dbPath)
		.then( dbFileExists => {
			if (! dbFileExists) throw Error("db file doesn't exist");
		})
		.then( () => Sqlite.openConnection({path: dbName}) );
	this.dbConnPromise
		.catch( e => {console.error(e)} );
	this.deferred = new Deferred();
}
RDMRoot.prototype = {
	isStopped: false,
	obsPromises: [],
	obsListPromises: [],
	
	// public
	getOnDonePromise: function() {
		return this.deferred.promise;
	},
	
	// public
	getObservationRowDataList: function() {
		if (this.isStopped) throw Error();
		const colNames = ["id", "name"];
		const sql = 'SELECT ' + makeSqlColNamesStr(colNames) + ' FROM "observations" ORDER BY "id"';
		let obsListPromise = this.dbConnPromise
			.then( dbConn => selectObjs(dbConn, sql, colNames) );
		obsListPromise
			.catch( e => {console.error(e)} );
		this.obsListPromises.push(obsListPromise);
		return obsListPromise;
	},
	
	// public
	getObservation: function(obsId) {
		if (this.isStopped) throw Error();
		let rdmObservation = new RDMObservation(this.dbConnPromise, obsId);
		this.obsPromises.push(rdmObservation.getOnDonePromise());
		return rdmObservation;
	},
	
	// public
	finish: function() {
		if (this.isStopped) throw Error();
		this.isStopped = true;
		let rootPromise = this.dbConnPromise
			.then(
				dbConn => promiseWaitAll([].concat(this.obsPromises, this.obsListPromises))
					.finally( () => dbConn.close() )
			);
		tiePromiseWithDeferred(rootPromise, this.deferred);
	},
	
	// public
	interrupt: function() {
		this.isStopped = true;
		let rootPromise = this.dbConnPromise
			.then( dbConn => dbConn.close() )
			.then( () => {throw Error(interruptMessage)} );
		tiePromiseWithDeferred(rootPromise, this.deferred);
	},
};

function RDMObservation(dbConnPromise, obsId) {
	this.dbConnPromise = dbConnPromise;
	this.obsId = obsId;
	this.deferred = new Deferred();
}
RDMObservation.prototype = {
	isStopped: false,
	// array of promises, each resolves with (array of promises, each resolves when response is done)
	respPromiseListPromiseList: [],
	
	// public
	getOnDonePromise: function() {
		return this.deferred.promise;
	},
	
	// returns: Promise<[RDMResponse list]>
	// public
	getResponseList: function() {
		if (this.isStopped) throw Error();
		const colNames = [
			"id",
			"http_channel_id",
			"http_response_data_id",
			"http_status_id",
			"cache_entry_id"
		];
		const sql = 'SELECT ' + makeSqlColNamesStr(colNames) + ' FROM "responses" WHERE "observation_id" = :observation_id';
		let respListPromise = this.dbConnPromise
			.then(
				dbConn => selectObjs(dbConn, sql, colNames, {observation_id: this.obsId})
					.then(
						rowObjs => rowObjs.map( rowObj => new RDMResponse(dbConn, rowObj) )
					)
			);
		respListPromise
			.catch( e => {console.log(e)} );
		
		let respListAndWaitPromise = respListPromise
			.then(
				rdmResponses => [
					rdmResponses,
					rdmResponses.map( rdmResponse => rdmResponse.getOnDonePromise() )
				]
			);
		this.respPromiseListPromiseList.push(
			respListAndWaitPromise.then( results => results[1] )
		);
		return respListAndWaitPromise.then( results => results[0] );
	},
	
	// public
	finish: function() {
		if (this.isStopped) throw Error();
		this.isStopped = true;
		let promiseList = this.respPromiseListPromiseList.map(
			respPromiseListPromise => respPromiseListPromise
				.then( respPromiseList => promiseWaitAll(respPromiseList) )
		);
		let obsPromise = Promise.all([
			this.dbConnPromise,
			promiseWaitAll(promiseList)
		]);
		tiePromiseWithDeferred(obsPromise, this.deferred);
	},
	
	// public
	interrupt: function() {
		this.isStopped = true;
		this.deferred.reject(interruptMessage);
	},
};

function RDMResponse(dbConn, respRowData) {
	this.dbConn = dbConn;
	this.respRowData = respRowData;
	this.deferred = new Deferred();
}
RDMResponse.prototype = {
	isStopped: false,
	childPromises: [],
	
	// public
	getOnDonePromise: function() {
		return this.deferred.promise;
	},
	
	// public
	getId: function() {
		return this.respRowData.id;
	},
	
	// private
	getFailedCertChain: function(failedCertChain_id) {
		if (failedCertChain_id === null) return Promise.resolve(null);
		const colConfigArr = [
			"cachedEVStatus",
			{table: "certDatas", col: "cert", alias: "cert_data"}
		];
		const resultColNames = makeResultColNames(colConfigArr);
		const sql = '' +
			'SELECT ' + makeSqlColNamesStr(colConfigArr) + ' ' +
			'FROM "certLists_to_certObjs"' + ' ' +
			'JOIN "certObjs"' + ' ' +
				'ON "certObj_id" = "certObjs"."id"' + ' ' +
			'JOIN "certDatas"' + ' ' +
				'ON "certData_id" = "certDatas"."id"' + ' ' +
			'WHERE "certList_id" = :id' + ' ' +
			'ORDER BY "certLists_to_certObjs"."id"';
		return Promise.resolve(this.dbConn)
			.then( dbConn => selectObjs(dbConn, sql, resultColNames, {id: failedCertChain_id}) )
			.then(
				objs => objs.map(
					obj => ({
						cachedEVStatus: obj.cachedEVStatus,
						cert:           obj.cert_data
					})
				)
			);
	},
	
	// private
	getSecurityInfoDataObj: function(securityInfoData_id) {
		if (securityInfoData_id === null) return Promise.resolve(null);
		const colConfigArr = [
			"securityInfo_id",
			"securityInfoRaw_id",
			{table: "securityInfoRaws", col: "data", alias: "securityInfoRaw_data"},
			"securityState",
			"subRequestsBrokenSecurity",
			"subRequestsNoSecurity",
			"errorCode",
			"errorMessageCached",
			"SSLStatus_id",
			"failedCertChain_id",
			"cipherSuite",
			"protocolVersion",
			"isDomainMismatch",
			"isNotValidAtThisTime",
			"isUntrusted",
			"isEV",
			"hasIsEVStatus",
			"haveCipherSuiteAndProtocol",
			"haveCertErrorBits",
			"cachedEVStatus",
			{table: "certDatas", col: "cert", alias: "cert_data"},
		];
		const resultColNames = makeResultColNames(colConfigArr);
		const sql = '' +
			'SELECT ' + makeSqlColNamesStr(colConfigArr) + ' ' +
			'FROM "securityInfoDatas"' + ' ' +
			'LEFT OUTER JOIN "securityInfoRaws"' + ' ' +
				'ON "securityInfoRaw_id" = "securityInfoRaws"."id"' + ' ' +
			'LEFT OUTER JOIN "securityInfos"' + ' ' +
				'ON "securityInfo_id" = "securityInfos"."id"' + ' ' +
			'LEFT OUTER JOIN "SSLStatuses"' + ' ' +
				'ON "SSLStatus_id" = "SSLStatuses"."id"' + ' ' +
			'JOIN "certObjs"' + ' ' +
				'ON "serverCert_id" = "certObjs"."id"' + ' ' +
			'JOIN "certDatas"' + ' ' +
				'ON "certData_id" = "certDatas"."id"' + ' ' +
			'WHERE "securityInfoDatas"."id" = :id';
		return Promise.resolve(this.dbConn)
			.then( dbConn => selectObjs(dbConn, sql, resultColNames, {id: securityInfoData_id}) )
			.then( objs => objs[0] )
			.then(obj => {
				if (obj.securityInfo_id === null && obj.securityInfoRaw_id === null) throw Error();
				if (obj.securityInfoRaw_id !== null) return {raw: obj.securityInfoRaw_data};
				// now obj.securityInfo_id !== null
				return this.getFailedCertChain(obj.failedCertChain_id)
					.then( failedCertChain => {
						let SSLStatus;
						if (obj.SSLStatus_id === null) {
							SSLStatus = null;
						} else {
							SSLStatus = {
								serverCert: {
									cachedEVStatus: obj.cachedEVStatus,
									cert:           obj.cert_data
								},
								cipherSuite:                obj.cipherSuite,
								protocolVersion:            obj.protocolVersion,
								isDomainMismatch:           Boolean(obj.isDomainMismatch),
								isNotValidAtThisTime:       Boolean(obj.isNotValidAtThisTime),
								isUntrusted:                Boolean(obj.isUntrusted),
								isEV:                       Boolean(obj.isEV),
								hasIsEVStatus:              Boolean(obj.hasIsEVStatus),
								haveCipherSuiteAndProtocol: Boolean(obj.haveCipherSuiteAndProtocol),
								haveCertErrorBits:          Boolean(obj.haveCertErrorBits),
							};
						}
						let securityInfo = {
							securityState:             obj.securityState,
							subRequestsBrokenSecurity: obj.subRequestsBrokenSecurity,
							subRequestsNoSecurity:     obj.subRequestsNoSecurity,
							errorCode:                 obj.errorCode,
							errorMessageCached:        obj.errorMessageCached,
							SSLStatus:                 SSLStatus,
							failedCertChain:           failedCertChain,
						};
						return {parsed: securityInfo};
					});
			});
	},
	
	// private
	getHttpRequestHeaders: function(listId) {
		const colConfigArr = [
			{table: "http_request_header_names", col: "value", alias: "name"},
			{table: "http_request_headers", col: "value", alias: "value"}
		];
		const resultColNames = makeResultColNames(colConfigArr);
		const sql = '' +
			'SELECT ' + makeSqlColNamesStr(colConfigArr) + ' ' +
			'FROM "http_request_header_lists_to_entries"' + ' ' +
			'JOIN "http_request_headers"' + ' ' +
				'ON "http_request_header_id" = "http_request_headers"."id"' + ' ' +
			'JOIN "http_request_header_names"' + ' ' +
				'ON "http_request_header_name_id" = "http_request_header_names"."id"' + ' ' +
			'WHERE "http_request_header_list_id" = :id' + ' ' +
			'ORDER BY "http_request_header_lists_to_entries"."id"';
		return Promise.resolve(this.dbConn)
			.then( dbConn => selectObjs(dbConn, sql, resultColNames, {id: listId}) )
			.then(
				objs => objs.map( obj => [obj["name"], obj["value"]] )
			);
	},
	
	// private
	getHttpResponseHeaders: function(listId) {
		const colConfigArr = [
			{table: "http_response_header_names", col: "value", alias: "name"},
			{table: "http_response_headers", col: "value", alias: "value"}
		];
		const resultColNames = makeResultColNames(colConfigArr);
		const sql = '' +
			'SELECT ' + makeSqlColNamesStr(colConfigArr) + ' ' +
			'FROM "http_response_header_lists_to_entries"' + ' ' +
			'JOIN "http_response_headers"' + ' ' +
				'ON "http_response_header_id" = "http_response_headers"."id"' + ' ' +
			'JOIN "http_response_header_names"' + ' ' +
				'ON "http_response_header_name_id" = "http_response_header_names"."id"' + ' ' +
			'WHERE "http_response_header_list_id" = :id' + ' ' +
			'ORDER BY "http_response_header_lists_to_entries"."id"';
		return Promise.resolve(this.dbConn)
			.then( dbConn => selectObjs(dbConn, sql, resultColNames, {id: listId}) )
			.then(
				objs => objs.map( obj => [obj["name"], obj["value"]] )
			);
	},
	
	// public
	getHttp: function() {
		if (this.isStopped) throw Error();
		const colConfigArr = [
			{table: "http_topics", col: "value", alias: "http_topic"},
			{table: "http_request_methods", col: "value", alias: "http_request_method"},
			"uri",
			"http_request_header_list_id",
			"referrer",
			"statusCode",
			"statusText",
			"http_response_header_list_id",
			"contentLength",
			{table: "http_response_content_types", col: "value", alias: "http_response_content_type"},
			{table: "http_response_content_charsets", col: "value", alias: "http_response_content_charset"},
			"securityInfoData_id",
		];
		const resultColNames = makeResultColNames(colConfigArr);
		const sql = '' +
			'SELECT ' + makeSqlColNamesStr(colConfigArr) + ' ' +
			'FROM "http_channels"' + ' ' +
			'JOIN "http_topics"' + ' ' +
				'ON "http_topic_id" = "http_topics"."id"' + ' ' +
			'JOIN "http_request_methods"' + ' ' +
				'ON "http_request_method_id" = "http_request_methods"."id"' + ' ' +
			'JOIN "http_response_content_types"' + ' ' +
				'ON "http_response_content_type_id" = "http_response_content_types"."id"' + ' ' +
			'JOIN "http_response_content_charsets"' + ' ' +
				'ON "http_response_content_charset_id" = "http_response_content_charsets"."id"' + ' ' +
			'WHERE "http_channels"."id" = :id';
		let httpChannelPromise = Promise.resolve(this.dbConn)
			.then( dbConn => selectObjs(dbConn, sql, resultColNames, {id: this.respRowData.http_channel_id}) )
			.then( objs => objs[0] )
			.then(
				obj => Promise.all([
					this.getHttpRequestHeaders(obj.http_request_header_list_id),
					this.getHttpResponseHeaders(obj.http_response_header_list_id),
					this.getSecurityInfoDataObj(obj.securityInfoData_id),
				])
				.then(
					results => ({
						topic:              obj.http_topic,
						
						// request
						requestMethod:      obj.http_request_method,
						URI:                obj.uri,
						requestHeaders:     results[0],
						referrer:           obj.referrer,
						
						// response
						responseStatus:     obj.statusCode,
						responseStatusText: obj.statusText,
						responseHeaders:    results[1],
						contentLength:      obj.contentLength,
						contentCharset:     obj.contentCharset,
						contentType:        obj.contentType,
						
						securityInfo:       results[2],
					})
				)
			);
		this.childPromises.push(httpChannelPromise);
		return httpChannelPromise;
	},
	
	// public
	getData: function() {
		if (this.isStopped) throw Error();
		if (this.respRowData.http_response_data_id === null) return Promise.resolve(null);
		const colConfigArr = [
			"data"
		];
		const resultColNames = makeResultColNames(colConfigArr);
		const sql = '' +
			'SELECT ' + makeSqlColNamesStr(colConfigArr) + ' ' +
			'FROM "http_response_datas"' + ' ' +
			'WHERE "id" = :id';
		// split to dataDBPromise(asseses to db) and dataPromise(not asseses to db)
		// to finish RDMResponse and close dbConn earlier
		let dataDBPromise = Promise.resolve(this.dbConn)
			.then( dbConn => selectObjs(dbConn, sql, resultColNames, {id: this.respRowData.http_response_data_id}) );
		let dataPromise = dataDBPromise
			.then( objs => objs[0] )
			.then( obj => obj.data );
		this.childPromises.push(
			dataDBPromise.then( () => undefined ) // don't hold data to save memory
		);
		return dataPromise;
	},
	
	// public
	getHttpStatus: function() {
		if (this.isStopped) throw Error();
		const colConfigArr = [
			"tracing_status",
			"http_status"
		];
		const resultColNames = makeResultColNames(colConfigArr);
		const sql = '' +
			'SELECT ' + makeSqlColNamesStr(colConfigArr) + ' ' +
			'FROM "http_statuses"' + ' ' +
			'WHERE "id" = :id';
		// split to 2 promises: see comment in getData()
		let httpStatusDBPromise = Promise.resolve(this.dbConn)
			.then( dbConn => selectObjs(dbConn, sql, resultColNames, {id: this.respRowData.http_status_id}) );
		let httpStatusPromise = httpStatusDBPromise
			.then( objs => objs[0] )
			.then(
				obj => ({
					httpStatus:    obj.http_status,
					tracingStatus: obj.tracing_status
				})
			);
		this.childPromises.push(httpStatusDBPromise);
		return httpStatusPromise;
	},
	
	// private
	getCacheEntryMetas: function(listId) {
		const colConfigArr = [
			{table: "cache_entry_meta_names", col: "value", alias: "name"},
			{table: "cache_entry_metas", col: "value", alias: "value"}
		];
		const resultColNames = makeResultColNames(colConfigArr);
		const sql = '' +
			'SELECT ' + makeSqlColNamesStr(colConfigArr) + ' ' +
			'FROM "cache_entry_meta_lists_to_entries"' + ' ' +
			'JOIN "cache_entry_metas"' + ' ' +
				'ON "cache_entry_meta_id" = "cache_entry_metas"."id"' + ' ' +
			'JOIN "cache_entry_meta_names"' + ' ' +
				'ON "cache_entry_meta_name_id" = "cache_entry_meta_names"."id"' + ' ' +
			'WHERE "cache_entry_meta_list_id" = :id' + ' ' +
			'ORDER BY "cache_entry_meta_lists_to_entries"."id"';
		return Promise.resolve(this.dbConn)
			.then( dbConn => selectObjs(dbConn, sql, resultColNames, {id: listId}) )
			.then(
				objs => objs.map( obj => [obj["name"], obj["value"]] )
			);
	},
	
	// public
	getCacheEntry: function() {
		if (this.isStopped) throw Error();
		if (this.respRowData.cache_entry_id === null) return Promise.resolve(null);
		const colConfigArr = [
			"key",
			"expirationTime",
			"predictedDataSize",
			"storageDataSize",
			"dataSize",
			{table: "http_request_methods", col: "value", alias: "http_request_method"},
			"http_request_header_list_id",
			{table: "http_response_status_http_versions", col: "value", alias: "http_response_status_http_version"},
			"http_response_status_code",
			"http_response_status_text",
			"http_response_header_list_id",
			"cache_entry_meta_list_id",
		];
		const resultColNames = makeResultColNames(colConfigArr);
		const sql = '' +
			'SELECT ' + makeSqlColNamesStr(colConfigArr) + ' ' +
			'FROM "cache_entries"' + ' ' +
			'JOIN "http_request_methods"' + ' ' +
				'ON "http_request_method_id" = "http_request_methods"."id"' + ' ' +
			'JOIN "http_response_status_http_versions"' + ' ' +
				'ON "http_response_status_http_version_id" = "http_response_status_http_versions"."id"' + ' ' +
			'WHERE "cache_entries"."id" = :id';
		let cacheEntryPromise = Promise.resolve(this.dbConn)
			.then( dbConn => selectObjs(dbConn, sql, resultColNames, {id: this.respRowData.cache_entry_id}) )
			.then( objs => objs[0] )
			.then(
				obj => Promise.all([
					this.getHttpRequestHeaders(obj.http_request_header_list_id),
					this.getHttpResponseHeaders(obj.http_response_header_list_id),
					this.getCacheEntryMetas(obj.cache_entry_meta_list_id),
				])
				.then(
					results => ({
						key:               obj.key,
						expirationTime:    obj.expirationTime,
						predictedDataSize: obj.predictedDataSize,
						storageDataSize:   obj.storageDataSize,
						dataSize:          obj.dataSize,
						metaData:          RDMResponse.prepareCacheMeta(obj, results[0], results[1], results[2]),
					})
				)
			);
		this.childPromises.push(cacheEntryPromise);
		return cacheEntryPromise;
	},
	
	// public
	finish: function() {
		if (this.isStopped) throw Error();
		this.isStopped = true;
		let respPromise = Promise.all([
			this.dbConnPromise,
			promiseWaitAll(this.childPromises)
		]);
		tiePromiseWithDeferred(respPromise, this.deferred);
	},
	
	// public
	interrupt: function() {
		this.isStopped = true;
		this.deferred.reject(interruptMessage);
	},
};
// private
RDMResponse.prepareCacheMeta = function(obj, httpRequestHeaders, httpResponseHeaders, otherMetas) {
	let res = [];
	res.push(["request-method", obj.http_request_method]);
	res = res.concat(
		httpRequestHeaders.map( header => ["request-" + header[0], header[1]] )
	);
	res.push(
		[
			"response-head",
			{
				statusHttpVersion: obj.http_response_status_http_version,
				statusCode: obj.http_response_status_code,
				statusText: obj.http_response_status_text,
				headers: httpResponseHeaders,
			}
		]
	);
	res = res.concat(otherMetas);
	return res;
};

////////////////

exports.RDMRoot = RDMRoot;

