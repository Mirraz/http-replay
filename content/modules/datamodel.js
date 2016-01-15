var EXPORTED_SYMBOLS = ["DMRoot"];

Components.utils.import("chrome://httpreplay/content/modules/common.js");

var {TextDecoder, TextEncoder, OS} = Cu.import("resource://gre/modules/osfile.jsm", {});

// DM -- DataModel
function DMRoot() {
	this.basePath = OS.Path.join(OS.Constants.Path.profileDir, "HttpReplay");
	this.promise = Promise.resolve()
		.then( () => OS.File.makeDir(this.basePath) );
	this.promise
		.catch( e => {console.error(e)} );
	this.deferred = new Deferred();
}
DMRoot.prototype = {
	isObsCreated: false,
	prevObservationId: null,
	
	getOnDonePromise: function() {
		return this.deferred.promise;
	},
	
	createObservation: function() {
		if (this.isObsCreated) throw Error(); // (for now) support only one Observation in time
		this.isObsCreated = true;
		
		var observationId = Date.now();
		if (this.prevObservationId && observationId <= this.prevObservationId) observationId = this.prevObservationId + 1;
		this.prevObservationId = observationId;
		
		var obsBasePath = OS.Path.join(this.basePath, observationId);
		var observation = new DMObservation(obsBasePath, this.promise);
		tiePromiseWithDeferred(observation.getOnDonePromise(), this.deferred);
		return observation;
	},
	
	finish: function() {
		if (! this.isObsCreated) this.deferred.resolve();
	},
};

function DMObservation(basePath, parentPromise) {
	this.basePath = basePath;
	this.promise = parentPromise
		.then( () => OS.File.makeDir(this.basePath) );
	this.promise
		.catch( e => {console.error(e)} );
	this.deferred = new Deferred();
}
DMObservation.prototype = {
	isStopped: false,
	prevResponseId: null,
	respPromises: [],
	
	getOnDonePromise: function() {
		return this.deferred.promise;
	},
	
	createResponse: function() {
		if (this.isStopped) throw Error();
		
		var responseId = Date.now();
		if (this.prevResponseId && responseId <= this.prevResponseId) responseId = this.prevResponseId + 1;
		this.prevResponseId = responseId;
		
		var respBasePath = OS.Path.join(this.basePath, responseId);
		var response = new DMResponse(respBasePath, this.promise);
		this.respPromises.push(response.getOnDonePromise());
		return response;
	},
	
	finish: function() {
		this.isStopped = true;
		
		var promiseArr = [].concat(this.promise, this.respPromises);
		tiePromiseWithDeferred(promiseWaitAll(promiseArr), this.deferred);
	},
};

function DMResponse(basePath, parentPromise) {
	this.basePath = basePath;
	this.promise = parentPromise
		.then( () => OS.File.makeDir(this.basePath) );
	this.promise
		.catch( e => {console.error(e)} );
	
	this.httpDeferred = new Deferred();
	this.dataDeferred = new Deferred();
	this.httpStatusDeferred = new Deferred();
	this.cacheEntryDeferred = new Deferred();
	
	var promiseArr = [
		this.promise,
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
		var filePath = OS.Path.join(this.basePath, fileName);
		var savePromise = this.promise
			.then( () => OS.File.writeAtomic(filePath, data, {noOverwrite: true, flush: true}) );
		savePromise
			.catch( e => {console.error(e)} );
		return savePromise;
	},
	
	// data -- ByteArray
	prepareSaveByteArrayPromise: function(fileName, data) {
		return this.prepareSaveDataPromise(fileName, new Uint8Array(data));
	},
	
	prepareSaveDataObjPromise: function(fileName, dataObj) {
		let encoder = new TextEncoder();
		let array = encoder.encode(JSON.stringify(dataObj));
		return this.prepareSaveDataPromise(fileName, array);
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
		var dataFilePath = OS.Path.join(this.basePath, "data");
		var dmData = new DMData(dataFilePath, this.promise);
		tiePromiseWithDeferred(dmData.getOnDonePromise(), this.dataDeferred);
		this.dataTied = true;
		return dmData;
	},
	
	saveHttpStatus: function(dataObj) {
		var httpStatusPromise = this.prepareSaveDataObjPromise("status", dataObj);
		tiePromiseWithDeferred(httpStatusPromise, this.httpStatusDeferred);
		this.httpStatusTied = true;
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

function DMData(filePath, parentPromise) {
	this.promise = parentPromise
		.then( () => OS.File.open(filePath, {write: true, truncate: true}) )
		.then( file => {this.file = file} );
	this.promise
		.catch( e => {console.error(e)} );
	this.deferred = new Deferred();
}
DMData.prototype = {
	getOnDonePromise: function() {
		return this.deferred.promise;
	},
	
	// data -- TypedArray (for example Uint8Array)
	write: function(data) {
		this.promise = this.promise
			.then( () => this.file.write(data) );
		this.promise
			.catch( e => {console.error(e)} );
	},
	
	// data -- ByteArray
	writeByteArray: function(data) {
		this.write(new Uint8Array(data));
	},
	
	close: function() {
		var donePromise = this.promise
			.finally( () => this.file.close() );
		tiePromiseWithDeferred(donePromise, this.deferred);
	},
};

