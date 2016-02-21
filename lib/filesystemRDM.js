const {Promise, promiseWaitAll, Deferred, tiePromiseWithDeferred, cloneReplace} = require("./common");
const {BinaryInputStream, BinaryOutputStream} = require("./commonStream");
const {SecurityInfoUtils} = require("./securityinfo");
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
	
	// private
	prepareReadDataPromise: function(fileName, notFailIfNotExist) {
		let filePath = OS.Path.join(this.basePath, fileName);
		return this.promise
			.then( () => OS.File.exists(filePath) )
			.then( exists => {
				if (exists) return OS.File.read(filePath);
				if (notFailIfNotExist) return null;
				throw Error("File '" + fileName + "' doesn't exist");
			});
	},
	
	// private
	prepareReadByteArrayPromise: function(fileName, notFailIfNotExist) {
		return this.prepareReadDataPromise(fileName, notFailIfNotExist);
	},
	
	// private
	prepareReadDataObjPromise: function(fileName, notFailIfNotExist) {
		return this.prepareReadDataPromise(fileName, notFailIfNotExist)
			.then( data => {
				if (data === null) return null;
				let decoder = new TextDecoder();
				let str = decoder.decode(data);
				return JSON.parse(str);
			});
	},
	
	// returns: Promise<securityInfo>
	// private
	getSecurityInfo: function(securityInfoJSON) {
		if (securityInfoJSON === null) throw Error();
		let certIds = SecurityInfoUtils.securityInfoGetCerts(securityInfoJSON);
		return Promise.all(
			certIds.map( certId => this.prepareReadByteArrayPromise("cert" + certId) )
		)
		.then( certs => {
			if (certIds.length !== certs.length) throw Error();
			let certMap = {};
			for (let i=0; i<certIds.length; ++i) {
				let certId = certIds[i];
				let cert = certs[i];
				certMap[certId] = cert;
			}
			return certMap;
		})
		.then(
			certMap => SecurityInfoUtils.securityInfoCloneReplaceCerts(
				securityInfoJSON,
				certId => certMap[certId]
			)
		);
	},
	
	// returns: Promise<securityInfoDataObj>
	// private
	getSecurityInfoDataObj: function(securityInfoDataJSON) {
		if (securityInfoDataJSON === null) return Promise.resolve(null);
		// allow exactly one of "parsed" and "raw"
		if (("parsed" in securityInfoDataJSON) == ("raw" in securityInfoDataJSON)) throw Error();
		if ("parsed" in securityInfoDataJSON) {
			return this.getSecurityInfo(securityInfoDataJSON.parsed)
				.then( securityInfo => ({parsed: securityInfo}) );
		} else { // if ("raw" in securityInfoData)
			if (securityInfoDataJSON.raw !== null) throw Error();
			return this.prepareReadByteArrayPromise("securityInfoRaw")
				.then( securityInfoRaw => ({raw: securityInfoRaw}) );
		}
	},
	
	// public
	getHttp: function() {
		if (this.isStopped) throw Error();
		let httpPromise = this.prepareReadDataObjPromise("http")
			.then(
				httpObjJSON => this.getSecurityInfoDataObj(httpObjJSON.securityInfo)
					.then(
						siDataObj => cloneReplace(httpObjJSON, [], {securityInfo: siDataObj})
					)
			);
		this.childPromises.push(httpPromise);
		return httpPromise;
	},
	
	// public
	getData: function() {
		if (this.isStopped) throw Error();
		let dataPromise = this.prepareReadByteArrayPromise("data", true);
		this.childPromises.push(
			dataPromise.then( () => undefined ) // don't hold data to save memory
		);
		return dataPromise;
	},
	
	// public
	getHttpStatus: function() {
		if (this.isStopped) throw Error();
		let httpStatusPromise = this.prepareReadDataObjPromise("status")
		this.childPromises.push(httpStatusPromise);
		return httpStatusPromise;
	},
	
	// public
	getCacheEntry: function() {
		if (this.isStopped) throw Error();
		let cacheEntryPromise = this.prepareReadDataObjPromise("cache", true);
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

////////////////

exports.RDMRoot = RDMRoot;

