const {Promise, promiseWaitAll, Deferred, tiePromiseWithDeferred, cloneReplace} = require("./common");
const {SecurityInfoUtils} = require("./securityinfo");
const {extensionDataDirPath, observationsDirPath, certsDirPath} = require("./filesystemDM");
const {SDMCerts} = require("./filesystemDMCerts");
const {Cu} = require("chrome");
const {TextEncoder, OS} = Cu.import("resource://gre/modules/osfile.jsm", {});

const interruptMessage = "Interrupted";

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
	this.sdmCerts.getOnDonePromise() // TODO
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
	
	// public
	createObservation: function(obsName) { // TODO use obsName
		if (this.isStopped) throw Error();
		if (this.obsPromise !== null) throw Error(); // (for now) support only one Observation in time
		
		let observationId = Date.now();
		if (this.prevObservationId && observationId <= this.prevObservationId) observationId = this.prevObservationId + 1;
		this.prevObservationId = observationId;
		
		let obsBasePath = OS.Path.join(this.basePath, observationId);
		let observation = new SDMObservation(obsBasePath, this.promise, this.sdmCerts);
		this.obsPromise = observation.getOnDonePromise();
		return observation;
	},
	
	// public
	finish: function() {
		if (this.isStopped) throw Error();
		this.isStopped = true;
		let obsPromise = (this.obsPromise === null ? Promise.resolve() : this.obsPromise);
		let rootPromise = Promise.all([this.promise, obsPromise]);
		rootPromise
			.finally( () => this.sdmCerts.finish() );
		tiePromiseWithDeferred(rootPromise, this.deferred);
	},
	
	// public
	interrupt: function() {
		this.isStopped = true;
		this.sdmCerts.interrupt();
		this.deferred.reject(interruptMessage);
	},
};

function SDMObservation(basePath, parentPromise, sdmCerts) {
	this.basePath = basePath;
	this.promise = parentPromise
		.then( () => OS.File.makeDir(this.basePath) );
	this.promise
		.catch( e => {console.error(e)} );
	this.deferred = new Deferred();
	this.sdmCerts = sdmCerts;
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
	createResponse: function() {
		if (this.isStopped) throw Error();
		
		let responseId = Date.now();
		if (this.prevResponseId && responseId <= this.prevResponseId) responseId = this.prevResponseId + 1;
		this.prevResponseId = responseId;
		
		let respBasePath = OS.Path.join(this.basePath, responseId);
		let response = new SDMResponse(respBasePath, this.promise, this.sdmCerts);
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

function SDMResponse(basePath, parentPromise, sdmCerts) {
	this.basePath = basePath;
	this.promise = parentPromise
		.then( () => OS.File.makeDir(this.basePath) );
	this.promise
		.catch( e => {console.error(e)} );
	
	this.httpDeferred = new Deferred();
	this.dataDeferred = new Deferred();
	this.httpStatusDeferred = new Deferred();
	this.cacheEntryDeferred = new Deferred();
	
	let promiseArr = [
		this.httpDeferred.promise,
		this.dataDeferred.promise,
		this.httpStatusDeferred.promise,
		this.cacheEntryDeferred.promise,
	];
	
	this.onDonePromise = Promise.all([
		this.promise,
		promiseWaitAll(promiseArr)
	]);
	
	this.sdmCerts = sdmCerts;
}
SDMResponse.prototype = {
	httpTied: false,
	dataTied: false,
	httpStatusTied: false,
	cacheEntryTied: false,
	
	// public
	getOnDonePromise: function() {
		return this.onDonePromise;
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
		let certs = [];
		let securityInfoClone = SecurityInfoUtils.securityInfoCloneReplaceCerts(
			securityInfo,
			cert => certs.push(cert) - 1
		);
		if (certs.length === 0) return Promise.resolve(securityInfoClone);
		return Promise.all(
			certs.map( certData => this.sdmCerts.saveCert(certData) )
		)
		.then(
			certIds => SecurityInfoUtils.securityInfoCloneReplaceCerts(
				securityInfoClone,
				certIdx => certIds[certIdx]
			)
		);
	},
	
	// returns: [Promise<securityInfoDataObjJSON>, otherPromiseList]
	// private
	saveSecurityInfoDataObj: function(securityInfoData) {
		if (securityInfoData === null) return [Promise.resolve(null), []];
		// allow exactly one of "parsed" and "raw"
		if (("parsed" in securityInfoData) == ("raw" in securityInfoData)) throw Error();
		if ("parsed" in securityInfoData) {
			return [
				this.saveSecurityInfo(securityInfoData.parsed)
					.then( securityInfoJSON => ({parsed: securityInfoJSON}) ),
				[]
			];
		} else { // if ("raw" in securityInfoData)
			if (securityInfoData.raw === null) throw Error();
			let siRawPromise = this.prepareSaveByteArrayPromise("securityInfoRaw", securityInfoData.raw);
			return [Promise.resolve({raw: null}), [siRawPromise]];
		}
	},
	
	// public
	saveHttp: function(obj) {
		if (this.httpTied) throw Error();
		if (!("securityInfo" in obj)) throw Error();
		let siPromiseList = this.saveSecurityInfoDataObj(obj.securityInfo);
		let siJSONPromise      = siPromiseList[0];
		let siOtherPromiseList = siPromiseList[1];
		let httpObjPromise = siJSONPromise
			.then( siJSON => cloneReplace(obj, [], {securityInfo: siJSON}) )
			.then( objJSON => this.prepareSaveDataObjPromise("http", objJSON) );
		let httpPromise = Promise.all([].concat(httpObjPromise, siOtherPromiseList));
		tiePromiseWithDeferred(httpPromise, this.httpDeferred);
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
		let httpStatusPromise = this.prepareSaveDataObjPromise("status", obj);
		tiePromiseWithDeferred(httpStatusPromise, this.httpStatusDeferred);
		this.httpStatusTied = true;
	},
	
	// if null then don't save anything
	// public
	saveCacheEntry: function(obj) {
		if (this.cacheEntryTied) throw Error();
		if (obj === null) {
			this.cacheEntryDeferred.resolve();
			this.cacheEntryTied = true;
			return;
		}
		let cacheEntryPromise = this.prepareSaveDataObjPromise("cache", obj);
		tiePromiseWithDeferred(cacheEntryPromise, this.cacheEntryDeferred);
		this.cacheEntryTied = true;
	},
	
	// public
	interrupt: function() {
		if (! this.httpTied) {
			this.httpDeferred.resolve();
			this.httpTied = true;
		}
		if (! this.dataTied) {
			this.dataDeferred.resolve();
			this.dataTied = true;
		}
		if (! this.httpStatusTied) {
			this.httpStatusDeferred.resolve();
			this.httpStatusTied = true;
		}
		if (! this.cacheEntryTied) {
			this.cacheEntryDeferred.resolve();
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
