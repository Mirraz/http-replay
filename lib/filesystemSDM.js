const {Promise, promiseWaitAll, Deferred, tiePromiseWithDeferred, cloneReplace} = require("./common");
const {interruptMessage} = require("./DMCommon");
const {SecurityInfoUtils} = require("./securityinfo");
const {extensionDataDirPath, observationsDirPath, certsDirPath} = require("./filesystemDM");
const {SDMCerts} = require("./filesystemDMCerts");
const {Cu} = require("chrome");
const {TextEncoder, OS} = Cu.import("resource://gre/modules/osfile.jsm", {});

// SDM -- SaveDataModel
function SDMRoot() {
	this.basePath = observationsDirPath;
	this.promise = Promise.resolve() // do so to use .finally
		.then( () => OS.File.makeDir(extensionDataDirPath) )
		.then( () => OS.File.makeDir(this.basePath) );
	this.promise
		.catch( e => {console.error(e)} );
	this.deferred = new Deferred();
	
	this.sdmCerts = new SDMCerts(certsDirPath, this.promise);
	this.sdmCerts.getOnDonePromise()
		.then( () => {console.log("certs: done")} )
		.catch( e => {console.error("certs: " + e)} );
}
SDMRoot.prototype = {
	isStopped: false,
	obsPromise: null,
	prevObservationId: null,
	
	// public
	getOnDonePromise: function() {
		return this.deferred.promise;
	},
	
	// observationName may be undefined
	// public
	createObservation: function(observationName) {
		if (this.isStopped) throw Error();
		if (this.obsPromise !== null) throw Error(); // (for now) support only one Observation in time
		
		let observationId = Date.now();
		if (this.prevObservationId && observationId <= this.prevObservationId) observationId = this.prevObservationId + 1;
		this.prevObservationId = observationId;
		
		let obsBasePath = OS.Path.join(this.basePath, observationId);
		let observation = new SDMObservation(this, this.promise, obsBasePath, observationId, observationName);
		this.obsPromise = observation.getOnDonePromise();
		return observation;
	},
	
	// public
	finish: function() {
		if (this.isStopped) throw Error();
		this.isStopped = true;
		let obsPromise = (this.obsPromise === null ? Promise.resolve() : this.obsPromise);
		Promise.all([this.promise, obsPromise])
			.finally( () => this.sdmCerts.finish() );
		let rootPromise = Promise.all([this.promise, obsPromise, this.sdmCerts.getOnDonePromise()]);
		tiePromiseWithDeferred(rootPromise, this.deferred);
	},
	
	// public
	interrupt: function() {
		this.isStopped = true;
		this.sdmCerts.interrupt();
		this.deferred.reject(interruptMessage);
	},
};

// name may be undefined
function SDMObservation(sdmRoot, parentPromise, basePath, id, name) {
	this.sdmRoot = sdmRoot;
	this.basePath = basePath;
	this.id = id;
	let obsMetaData = {};
	if (name !== undefined) obsMetaData["name"] = name;
	this.promise = parentPromise
		.then( () => OS.File.makeDir(this.basePath) )
		.then(
			() => OS.File.writeAtomic(
				OS.Path.join(this.basePath, "meta"),
				new Uint8Array(
					(new TextEncoder()).encode(JSON.stringify(obsMetaData))
				),
				{noOverwrite: true, flush: true}
			)
		);
	this.promise
		.catch( e => {console.error(e)} );
	this.deferred = new Deferred();
}
SDMObservation.prototype = {
	isStopped: false,
	respPromises: [],
	prevResponseId: null,
	
	// public
	getOnDonePromise: function() {
		return this.deferred.promise;
	},
	
	// public
	getIdListPromise: function() {
		return Promise.resolve([this.id]);
	},
	
	// public
	createResponse: function() {
		if (this.isStopped) throw Error();
		
		let responseId = Date.now();
		if (this.prevResponseId && responseId <= this.prevResponseId) responseId = this.prevResponseId + 1;
		this.prevResponseId = responseId;
		
		let respBasePath = OS.Path.join(this.basePath, responseId);
		let response = new SDMResponse(this, this.promise, respBasePath, responseId);
		this.respPromises.push(response.getOnDonePromise());
		return response;
	},
	
	// public
	finish: function() {
		if (this.isStopped) throw Error();
		this.isStopped = true;
		let obsPromise = Promise.all([
			this.promise,
			promiseWaitAll(this.respPromises)
		]);
		tiePromiseWithDeferred(obsPromise, this.deferred);
	},
	
	// public
	interrupt: function() {
		this.isStopped = true;
		this.deferred.reject(interruptMessage);
	},
};

function SDMResponse(sdmObservation, parentPromise, basePath, id) {
	this.sdmObservation = sdmObservation;
	this.basePath = basePath;
	this.id = id;
	this.promise = parentPromise
		.then( () => OS.File.makeDir(this.basePath) );
	this.promise
		.catch( e => {console.error(e)} );
	
	this.httpDeferred = new Deferred();
	this.siRawDeferred = new Deferred();
	this.dataDeferred = new Deferred();
	this.httpStatusDeferred = new Deferred();
	this.cacheEntryDeferred = new Deferred();
	
	let respPromise = Promise.all([
		this.httpDeferred.promise,
		this.httpStatusDeferred.promise,
		this.cacheEntryDeferred.promise,
	])
	.then(
		results => this.prepareSaveDataObjPromise(
			"meta",
			{
				http:   results[0],
				status: results[1],
				cache:  results[2],
			}
		)
	);
	this.onDonePromise = this.promise
		.then(
			() => promiseWaitAll([
				respPromise,
				this.siRawDeferred.promise,
				this.dataDeferred.promise,
			])
		);
	
	this.sdmCerts = this.sdmObservation.sdmRoot.sdmCerts;
}
SDMResponse.prototype = {
	httpTied: false,
	siRawTied: false,
	dataTied: false,
	httpStatusTied: false,
	cacheEntryTied: false,
	
	// public
	getOnDonePromise: function() {
		return this.onDonePromise;
	},
	
	// public
	getIdListPromise: function() {
		return this.sdmObservation.getIdListPromise()
			.then( idList => idList.concat(this.id) );
	},
	
	// data -- TypedArray (for example Uint8Array)
	// private
	prepareSaveDataPromise: function(fileName, data) {
		let filePath = OS.Path.join(this.basePath, fileName);
		let savePromise = this.promise
			.then( () => OS.File.writeAtomic(filePath, data, {noOverwrite: true, flush: true}) );
		savePromise
			.catch( e => {console.error(e)} );
		return savePromise;
	},
	
	// data -- ByteArray
	// private
	prepareSaveByteArrayPromise: function(fileName, data) {
		return this.prepareSaveDataPromise(fileName, new Uint8Array(data));
	},
	
	// private
	prepareSaveDataObjPromise: function(fileName, dataObj) {
		let encoder = new TextEncoder();
		let array = encoder.encode(JSON.stringify(dataObj));
		return this.prepareSaveDataPromise(fileName, array);
	},
	
	// returns: Promise<securityInfoJSON>
	// private
	saveSecurityInfo: function(securityInfo) {
		if (securityInfo === null) throw Error();
		let certs = SecurityInfoUtils.securityInfoGetCerts(securityInfo);
		return Promise.all(
			certs.map(
				(certData, index) => this.sdmCerts.saveCert(
					certData,
					this.getIdListPromise()
						.then( idList => idList.concat(index) )
				)
			)
		)
		.then(
			certIds => SecurityInfoUtils.securityInfoCloneReplaceCerts(
				securityInfo,
				(cert, index) => certIds[index]
			)
		);
	},
	
	// returns: Promise<securityInfoDataObjJSON>
	// private
	saveSecurityInfoDataObj: function(securityInfoData) {
		if (this.siRawTied) throw Error();
		if (securityInfoData === null) {
			this.siRawDeferred.resolve();
			this.siRawTied = true;
			return Promise.resolve(null);
		}
		// allow exactly one of "parsed" and "raw"
		if (("parsed" in securityInfoData) == ("raw" in securityInfoData)) throw Error();
		if ("parsed" in securityInfoData) {
			this.siRawDeferred.resolve();
			this.siRawTied = true;
			return this.saveSecurityInfo(securityInfoData.parsed)
				.then( securityInfoJSON => ({parsed: securityInfoJSON}) );
		} else { // if ("raw" in securityInfoData)
			if (securityInfoData.raw === null) throw Error();
			let siRawPromise = this.prepareSaveByteArrayPromise("securityInfoRaw", securityInfoData.raw);
			tiePromiseWithDeferred(siRawPromise, this.siRawDeferred);
			this.siRawTied = true;
			return Promise.resolve({raw: null})
		}
	},
	
	// public
	saveHttp: function(obj) {
		if (this.httpTied) throw Error();
		if (!("securityInfo" in obj)) throw Error();
		let httpJSONPromise = this.saveSecurityInfoDataObj(obj.securityInfo)
			.then( siJSON => cloneReplace(obj, [], {securityInfo: siJSON}) );
		tiePromiseWithDeferred(httpJSONPromise, this.httpDeferred);
		this.httpTied = true;
	},
	
	// public
	createData: function() {
		if (this.dataTied) throw Error();
		let dataFilePath = OS.Path.join(this.basePath, "data");
		let data = new SDMData(dataFilePath, this.promise);
		tiePromiseWithDeferred(data.getOnDonePromise(), this.dataDeferred);
		this.dataTied = true;
		return data;
	},
	
	// public
	saveHttpStatus: function(obj) {
		if (this.httpStatusTied) throw Error();
		let httpStatusPromise = Promise.resolve(obj);
		tiePromiseWithDeferred(httpStatusPromise, this.httpStatusDeferred);
		this.httpStatusTied = true;
	},
	
	// if null then don't save anything
	// public
	saveCacheEntry: function(obj) {
		if (this.cacheEntryTied) throw Error();
		let cacheEntryPromise = Promise.resolve(obj); // including case if obj === null
		tiePromiseWithDeferred(cacheEntryPromise, this.cacheEntryDeferred);
		this.cacheEntryTied = true;
	},
	
	// public
	interrupt: function() {
		if (! this.httpTied) {
			this.httpDeferred.resolve(null);
			this.httpTied = true;
		}
		if (! this.siRawTied) {
			this.siRawDeferred.resolve();
			this.siRawTied = true;
		}
		if (! this.dataTied) {
			this.dataDeferred.resolve();
			this.dataTied = true;
		}
		if (! this.httpStatusTied) {
			this.httpStatusDeferred.resolve(null);
			this.httpStatusTied = true;
		}
		if (! this.cacheEntryTied) {
			this.cacheEntryDeferred.resolve(null);
			this.cacheEntryTied = true;
		}
	},
};

function SDMData(filePath, parentPromise) {
	this.filePromise = parentPromise
		.then( () => OS.File.open(filePath, {write: true, truncate: true}) );
	this.promise = this.filePromise;
	this.promise
		.catch( e => {console.error(e)} );
	this.deferred = new Deferred();
}
SDMData.prototype = {
	isStopped: false,
	
	// public
	getOnDonePromise: function() {
		return this.deferred.promise;
	},
	
	// data -- TypedArray (for example Uint8Array)
	// private
	write: function(data) {
		this.promise = Promise.all([this.filePromise, this.promise])
			.then( results => results[0].write(data) );
		this.promise
			.catch( e => {console.error(e)} );
	},
	
	// data -- ByteArray
	// public
	writeByteArray: function(data) {
		if (this.isStopped) throw Error();
		this.write(new Uint8Array(data));
	},
	
	// public
	close: function() {
		if (this.isStopped) throw Error();
		this.isStopped = true;
		let donePromise = this.filePromise
			.then(
				file => this.promise
					.finally( () => file.close() )
			);
		tiePromiseWithDeferred(donePromise, this.deferred);
	},
	
	// public
	interrupt: function() {
		this.isStopped = true;
		let donePromise = this.filePromise
			.then( file => file.close() );
		tiePromiseWithDeferred(donePromise, this.deferred);
	},
};

////////////////

exports.SDMRoot = SDMRoot;
