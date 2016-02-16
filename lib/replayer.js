const {Promise, promiseWaitAll, BinaryInputStream, BinaryOutputStream} = require("./common");
const {getObservationList, RDMRoot} = require("./datamodel");
const {SecurityInfoPacker} = require("./securityinfo");
const {Cu, Ci, Cr} = require("chrome");

Cu.importGlobalProperties(["btoa"]);
const {Services} = Cu.import("resource://gre/modules/Services.jsm");
const cacheService = Services.cache2;
const {LoadContextInfo} = Cu.import("resource://gre/modules/LoadContextInfo.jsm");
var cacheStorage = cacheService.memoryCacheStorage(LoadContextInfo.default);
const ioService = Services.io;

var Replayer = {};
Replayer.getObservations = function() {
	try {
		let obsListPromise = getObservationList();
		obsListPromise
			.then( () => {console.log("list done")} )
			.catch( e => {console.error(e)} );
		return obsListPromise;
	} catch(e) {
		console.error(e);
		return Promise.reject(e);
	}
};
Replayer.playObservation = function(observationId) {
	try {
		let rdmRoot = new RDMRoot();
		try {
			let rdmOnDonePromise = rdmRoot.getOnDonePromise();
			rdmOnDonePromise
				.then( () => {console.log("root done")} )
				.catch( e => {console.error(e)} );
			let rdmObservation = rdmRoot.getObservation(observationId);
			try {
				rdmRoot.finish();
				let respListPromise = rdmObservation.getResponseList();
				rdmObservation.finish();
				
				let resPromise = respListPromise
					.then(
						rdmRespList => rdmRespList.map( rdmResp => new CachingRDMResp(rdmResp) )
					)
					.then(
						rdmRespList => Promise.resolve() // to catch possible throw in loadResponseList
							.then( () => CacheFiller.loadResponseList(rdmRespList) )
							.finally(
								() => rdmRespList.forEach( rdmResp => {rdmResp.finish()} )
							)
					);
				resPromise
					.then( () => {console.log("read done")} )
					.catch( e => {console.error(e)} );
				return resPromise;
			} catch(e) {
				rdmObservation.interrupt();
				throw e;
			}
		} catch(e) {
			rdmRoot.interrupt();
			throw e;
		}
	} catch(e) {
		console.error(e);
		return Promise.reject(e);
	}
};

function CachingRDMResp(rdmResp) {
	this.rdmResp = rdmResp;
}
CachingRDMResp.prototype = {
	http: null,
	data: null,
	httpStatus: null,
	cacheEntry: null,
	isStopped: false,
	
	checkAllWasGot: function() {
		if (
			this.http !== null &&
			this.data !== null &&
			this.httpStatus !== null &&
			this.cacheEntry !== null
		) this.finish();
	},
	
	getHttp: function() {
		if (this.http === null) this.http = this.rdmResp.getHttp();
		this.checkAllWasGot();
		return this.http;
	},
	
	getData: function() {
		if (this.data === null) this.data = this.rdmResp.getData();
		this.checkAllWasGot();
		return this.data;
	},
	
	getHttpStatus: function() {
		if (this.httpStatus === null) this.httpStatus = this.rdmResp.getHttpStatus();
		this.checkAllWasGot();
		return this.httpStatus;
	},
	
	getCacheEntry: function() {
		if (this.cacheEntry === null) this.cacheEntry = this.rdmResp.getCacheEntry();
		this.checkAllWasGot();
		return this.cacheEntry;
	},
	
	finish: function() {
		if (! this.isStopped) this.rdmResp.finish();
		this.isStopped = true;
	},
	
	interrupt: function() {
		this.rdmResp.interrupt();
		this.isStopped = true;
	},
};

var CacheFiller = {};
CacheFiller.loadResponseList = function(rdmRespList) {
	return Promise.all(
		rdmRespList.map( rdmResp => rdmResp.getHttp() )
	)
	.then( httpDataObjs => {
		if (httpDataObjs.length !== rdmRespList.length) throw Error();
		let resList = [];
		let uriSet = new Set();
		// filter duplicates: accept only latest
		for (let i=httpDataObjs.length-1; i>=0; --i) {
			let httpDataObj = httpDataObjs[i];
			let rdmResp = rdmRespList[i];
			let uriObj = CacheFiller.makeURIFromSpec(httpDataObj.request.URI);
			let uri = uriObj.specIgnoringRef;
			if (!uriSet.has(uri)) {
				resList.unshift(rdmResp);
				uriSet.add(uri);
			} else {
				rdmResp.finish();
			}
		}
		return resList;
	})
	.then(
		filteredList => Promise.all(
			filteredList.map(
				rdmResp => CacheFiller.loadResponse(rdmResp)
			)
		)
	);
};
CacheFiller.loadResponse = function(rdmResp) {
	return CacheFiller.filterResponse(rdmResp)
		.then( () => CacheFiller.loadFilteredResponse(rdmResp) )
		.catch( e => {if (e !== null) throw e} );
};
CacheFiller.filterResponse = function(rdmResp) {
	var filterHttpPromise = rdmResp.getHttp()
		.then( httpDataObj => {
			if (httpDataObj.request.method !== "GET") throw null;
		});
	
	var filterCachePromise = rdmResp.getCacheEntry()
		.then( cacheDataObj => {
			if (cacheDataObj === null) throw null;
			return cacheDataObj;
		});
	
	var filterStatusAndCachePromise = Promise.all([rdmResp.getHttpStatus(), filterCachePromise])
	 	.then( values => {
	 		let statusDataObj = values[0];
	 		let cacheDataObj = values[1];
	 		
			if (statusDataObj.tracingStatus !== Cr.NS_OK)
				throw Error("status.tracingStatus = " + tracingStatus);
			if (!(
				statusDataObj.httpStatus === Cr.NS_OK ||
				statusDataObj.httpStatus === Cr.NS_BINDING_REDIRECTED
			)) throw Error("status.httpStatus = " + statusDataObj.httpStatus);
			
			if (statusDataObj.httpStatus === Cr.NS_BINDING_REDIRECTED && cacheDataObj.dataSize !== 0)
				throw Error("status.httpStatus = NS_BINDING_REDIRECTED, cache.dataSize = " + cacheDataObj.dataSize);
		});
	
	var filterCacheKeyPromsie = Promise.all([rdmResp.getHttp(), filterCachePromise])
		.then( values => {
			let httpDataObj = values[0];
			let cacheDataObj = values[1];
			let uriObj = CacheFiller.makeURIFromSpec(httpDataObj.request.URI);
			let uri = uriObj.specIgnoringRef;
			if (uri !== cacheDataObj.key) throw Error("http.URI = " + uri + " != cache.key = " + cacheDataObj.key);
		});
	
	return Promise.all([filterHttpPromise, filterStatusAndCachePromise, filterCacheKeyPromsie]);
};
CacheFiller.loadFilteredResponse = function(rdmResp) {
	var dataPromise = rdmResp.getCacheEntry()
		.then( cacheDataObj => {
			if (cacheDataObj.dataSize !== 0)
				return rdmResp.getData();
			else
				return [];
		});
	var dataLengthPromise = dataPromise.then( data => data.length );
	
	var cacheEntryPromise = rdmResp.getHttp()
		.then( httpDataObj => {
			let uriSpec = httpDataObj.request.URI;
			let uri = CacheFiller.makeURIFromSpec(uriSpec);
			return cacheStorage.openTruncate(uri, "");
		});
	
	var siBase64Promise = rdmResp.getHttp()
		.then( httpDataObj => {
			if (!("securityInfo" in httpDataObj)) throw Error("http.securityInfo is not exist");
			if (httpDataObj["securityInfo"] === null) return null;
			let siObj = httpDataObj["securityInfo"];
			if ("raw" in siObj) return siObj.raw;
			if (!("parsed" in siObj)) throw Error("not 'row' nor 'parsed' in http.securityInfo");
			let siDataObj = siObj.parsed;
			
			let siPacker = new SecurityInfoPacker( byteArray => byteArray );
			let iStream = new BinaryInputStream(siPacker.packSecurityInfo(siDataObj));
			let bytes = iStream.readBytes(iStream.available());
			return btoa(bytes); // TODO: use base64 encoder stream
		});
	
	var cacheMetaPromise = Promise.all([rdmResp.getCacheEntry(), siBase64Promise, dataLengthPromise])
		.then( values => {
			let cacheDataObj = values[0];
			let siBase64 = values[1];
			let dataLength = values[2];
			let metaDataObj = cacheDataObj.meta;
			let meta = {};
			
			{
				metaDataObj.other.forEach( entry => {
					meta[entry[0]] = entry[1];
				});
			}
			
			{
				let reqObj = metaDataObj.request;
				meta["request-method"] = reqObj.method;
				let reqHeaders = reqObj.headers;
				reqHeaders.forEach( header => {
					meta["request-" + header[0]] = header[1];
				});
			}
			
			{
				let respLines = [];
				let respObj = metaDataObj.response;
				respLines.push(respObj.statusHttpVersion + " " + respObj.statusCode + " " + respObj.statusText);
				let respHeaders = respObj.headers;
				respHeaders.forEach( header => {
					let key = header[0];
					let val = header[1];
					if (key === "Content-Encoding") return;
					if (key === "Content-Length") value = dataLength;
					respLines.push(key + ": " + val);
				});
				meta["response-head"] = respLines.map( line => line + "\r\n" ).join("");
			}
			
			if (siBase64 !== null) meta["security-info"] = siBase64;
			
			return meta;
		});
	
	dataPromise
		.finally( () => {rdmResp.finish()} );
	
	return Promise.all([cacheEntryPromise, cacheMetaPromise, dataPromise])
		.then( values => {
			let aEntry = values[0];
			let meta = values[1];
			let data = values[2];
			
			for (let key in meta) {
				aEntry.setMetaDataElement(key, meta[key]);
			}
			
			aEntry.setExpirationTime(Ci.nsICacheEntry.NO_EXPIRATION_TIME);
			
			let oStream = new BinaryOutputStream(aEntry.openOutputStream(0));
			oStream.writeByteArray(data, data.length);
			oStream.close();
		});
};
CacheFiller.makeURIFromSpec = function(spec) {
	return ioService.newURI(spec, null, null);
};

exports.Replayer = Replayer;

