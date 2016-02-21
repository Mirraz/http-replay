const {Promise, promiseWaitAll, Deferred, tiePromiseWithDeferred} = require("./common");
const {BinaryInputStream, BinaryOutputStream} = require("./commonStream");
const {extensionDataPath} = require("./filesystemDM");
const {Cu} = require("chrome");
const {TextDecoder, TextEncoder, OS} = Cu.import("resource://gre/modules/osfile.jsm", {});

const interruptMessage = "Interrupted";

// RDM -- ReadDataModel
function RDMRoot() {
	this.basePath = extensionDataPath;
	this.promise = OS.File.exists(this.basePath)
		.then( exists => {
			if (! exists) throw Error("extension data dir doesn't exist");
		})
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
		let iterator = new OS.File.DirectoryIterator(this.basePath);
		let obsListPromise = this.promise
			.then( () => iterator.nextBatch() )
			.finally( () => iterator.close() )
			.then( entries => entries.map( entry => entry["name"] ) )
			.then(
				entries => entries
					.sort( (a,b) => a-b )
					.map( obsId => ({id: obsId, name: obsId}) )
			);
		obsListPromise
			.catch( e => {console.error(e)} );
		this.obsListPromises.push(obsListPromise);
		return obsListPromise;
	},
	
	// public
	getObservation: function(obsId) {
		if (this.isStopped) throw Error();
		let obsBasePath = OS.Path.join(this.basePath, obsId);
		let rdmObservation = new RDMObservation(obsBasePath, this.promise);
		this.obsPromises.push(rdmObservation.getOnDonePromise());
		return rdmObservation;
	},
	
	// public
	finish: function() {
		if (this.isStopped) throw Error();
		this.isStopped = true;
		let rootPromise = Promise.all([
			this.promise,
			promiseWaitAll([].concat(this.obsPromises, this.obsListPromises))
		]);
		tiePromiseWithDeferred(rootPromise, this.deferred);
	},
	
	// public
	interrupt: function() {
		this.isStopped = true;
		this.deferred.reject(interruptMessage);
	},
};

function RDMObservation(basePath, parentPromise) {
	this.basePath = basePath;
	this.promise = parentPromise;
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
		let iterator = new OS.File.DirectoryIterator(this.basePath);
		let respListPromise = this.promise
			.then( () => iterator.nextBatch() )
			.finally( () => iterator.close() )
			.then(
				entries => entries
					.map( entry => entry["name"] )
					.map( respId => OS.Path.join(this.basePath, respId) )
					.map( respBasePath => new RDMResponse(respBasePath, this.promise) )
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
			this.promise,
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

function RDMResponse(basePath, parentPromise) {
	this.basePath = basePath;
	this.promise = parentPromise;
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
	getHttp: function() {
		if (this.isStopped) throw Error();
		let httpPath = OS.Path.join(this.basePath, "http");
		let httpPromise = this.promise
			.then( () => RDMResponse.getJsonFile(httpPath) );
		this.childPromises.push(httpPromise);
		return httpPromise;
	},
	
	// public
	getData: function() {
		if (this.isStopped) throw Error();
		let dataPath = OS.Path.join(this.basePath, "data");
		let dataPromise = this.promise
			.then( () => OS.File.exists(dataPath) )
			.then( exists => {
				if (! exists) return null;
				return OS.File.read(dataPath);
			});
		this.childPromises.push(
			dataPromise.then( () => undefined ) // don't hold data to save memory
		);
		return dataPromise;
	},
	
	// public
	getHttpStatus: function() {
		if (this.isStopped) throw Error();
		let httpStatusPath = OS.Path.join(this.basePath, "status");
		let httpStatusPromise = this.promise
			.then( () => RDMResponse.getJsonFile(httpStatusPath) );
		this.childPromises.push(httpStatusPromise);
		return httpStatusPromise;
	},
	
	// public
	getCacheEntry: function() {
		if (this.isStopped) throw Error();
		let cachePath = OS.Path.join(this.basePath, "cache");
		let cacheEntryPromise = this.promise
			.then( () => OS.File.exists(cachePath) )
			.then( exists => {
				if (! exists) return null;
				return RDMResponse.getJsonFile(cachePath);
			});
		this.childPromises.push(cacheEntryPromise);
		return cacheEntryPromise;
	},
	
	// public
	finish: function() {
		if (this.isStopped) throw Error();
		this.isStopped = true;
		let respPromise = Promise.all([
			this.promise,
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
RDMResponse.getJsonFile = function(filePath) {
	return Promise.resolve()
		.then( () => OS.File.read(filePath) )
		.then( data => {
			let decoder = new TextDecoder();
			let str = decoder.decode(data);
			return JSON.parse(str);
		});
};

////////////////

exports.RDMRoot = RDMRoot;

