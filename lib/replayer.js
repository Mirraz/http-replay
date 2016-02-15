const {Promise, promiseWaitAll, BinaryInputStream, BinaryOutputStream} = require("./common");
const {getObservationList} = require("./datamodel");
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
	return getObservationList();
};
Replayer.playObservation = function(observationId) {
	try {
		return Promise.resolve(); // XXX
		var fillPromise = CacheFiller.getFillPromise(observationId);
		fillPromise
			.then( () => {console.log("done")} )
			.catch( e => {console.error(e)} );
		return fillPromise;
	} catch(e) {
		console.error(e);
	}
};

const extensionDataPath = "/root"; // XXX

var CacheFiller = {};
CacheFiller.getFillPromise = function(observationId) {
	var obsPath = OS.Path.join(extensionDataPath, observationId);
	return CacheFiller.prepareLoadObservationPromise(obsPath);
};
CacheFiller.prepareLoadObservationPromise = function(basePath) {
	let iterator = new OS.File.DirectoryIterator(basePath);
	return Promise.resolve()
		.then( () => iterator.nextBatch() )
		.finally( () => iterator.close() )
		.then( entries => CacheFiller.prepareLoadObservationDirPromise(basePath, entries) );
};
CacheFiller.prepareLoadObservationDirPromise = function(basePath, entries) {
	var httpPromiseArr = entries.map(
		entry => CacheFiller.prepareLoadJsonFilePromise(OS.Path.join(entry.path, "http"))
			.then( httpDataObj => [entry.name, httpDataObj] )
	);
	return Promise.all(httpPromiseArr)
		.then( results => {
			// filter duplicates: get only latest
			let map = {}; // uri => [id, httpDataObj]
			results.forEach( result => {
				let id = result[0];
				let httpDataObj = result[1];
				let timestamp = new Number(id);
				if (timestamp === Number.NaN) throw Error();
				let uriObj = CacheFiller.makeURIFromSpec(httpDataObj.request.URI);
				let uri = uriObj.specIgnoringRef;
				if (uri in map) {
					let prevId = map[uri][0];
					if (prevId < id) map[uri] = [id, httpDataObj];
				} else {
					map[uri] = [id, httpDataObj];
				}
			});
			let idAndHttpArr = [];
			for (uri in map) idAndHttpArr.push(map[uri]);
			return idAndHttpArr; // array of [id, httpDataObj]
		})
		.then(
			idAndHttpArr => promiseWaitAll(
				idAndHttpArr.map( idAndHttp => {
					let respPath = OS.Path.join(basePath, idAndHttp[0]);
					let httpPromise = Promise.resolve(idAndHttp[1]);
					return CacheFiller.prepareLoadResponsePromise(respPath, httpPromise)
						.catch( e => {console.error(e + " (" + respPath + ")")} );
				})
			)
		);
};
CacheFiller.prepareLoadJsonFilePromise = function(filePath) {
	return Promise.resolve()
		.then( () => OS.File.read(filePath) )
		.then( data => {
			let decoder = new TextDecoder();
			let str = decoder.decode(data);
			return JSON.parse(str);
		});
};
CacheFiller.prepareLoadResponsePromise = function(basePath, httpPromise) {
	var filterHttpPromise = httpPromise
		.then( httpDataObj => {
			if (httpDataObj.request.method !== "GET") throw null;
		});
	
	var statusPromise = CacheFiller.prepareLoadJsonFilePromise(OS.Path.join(basePath, "status"));
	var cachePromise  = CacheFiller.prepareLoadJsonFilePromise(OS.Path.join(basePath, "cache"));
	var filterCachePromise = cachePromise
		.catch( e => {throw null} );
	
	var filterStatusAndCachePromise = Promise.all([statusPromise, filterCachePromise])
	 	.then( values => {
	 		let statusDataObj = values[0];
	 		let cacheDataObj = values[1];
	 		
			if ("tracingResult" in statusDataObj)
				throw Error("status.tracingResult = " + tracingResult);
			if (!(
				statusDataObj.httpStatus === Cr.NS_OK ||
				statusDataObj.httpStatus === Cr.NS_BINDING_REDIRECTED
			)) throw Error("status.httpStatus = " + statusDataObj.httpStatus);
			
			if (statusDataObj.httpStatus === Cr.NS_BINDING_REDIRECTED && cacheDataObj.dataSize !== 0)
				throw Error("status.httpStatus = NS_BINDING_REDIRECTED, cache.dataSize = " + cacheDataObj.dataSize);
		});
	
	var filterCacheKeyPromsie = Promise.all([httpPromise, filterCachePromise])
		.then( values => {
			let httpDataObj = values[0];
			let cacheDataObj = values[1];
			let uriObj = CacheFiller.makeURIFromSpec(httpDataObj.request.URI);
			let uri = uriObj.specIgnoringRef;
			if (uri !== cacheDataObj.key) throw Error("http.URI = " + uri + " != cache.key = " + cacheDataObj.key);
		});
	
	return Promise.all([filterHttpPromise, filterStatusAndCachePromise, filterCacheKeyPromsie])
		.then( () => CacheFiller.prepareLoadFilteredResponsePromise(basePath, httpPromise, cachePromise) )
		.catch( e => {if (e !== null) throw e} );
};
CacheFiller.prepareLoadFilteredResponsePromise = function(basePath, httpPromise, cachePromise) {
	var dataPromise = cachePromise
		.then( cacheDataObj => {
			if (cacheDataObj.dataSize !== 0)
				return OS.File.read(OS.Path.join(basePath, "data"));
			else
				return [];
		});
	var dataLengthPromise = dataPromise.then( data => data.length );
	
	var cacheEntryPromise = httpPromise
		.then( httpDataObj => {
			let uriSpec = httpDataObj.request.URI;
			let uri = CacheFiller.makeURIFromSpec(uriSpec);
			return cacheStorage.openTruncate(uri, "");
		});
	
	var siBase64Promise = httpPromise
		.then( httpDataObj => {
			if (!("securityInfo" in httpDataObj)) return Promise.reject("http.securityInfo is not exist");
			if (httpDataObj["securityInfo"] === null) return null;
			let siDataObj = httpDataObj["securityInfo"];
			
			let certFileIDs = SecurityInfoPacker.getCertFileIDs(siDataObj);
			let certPromises = certFileIDs.map(
				certFileID => OS.File.read(OS.Path.join(basePath, "cert" + certFileID))
			);
			return Promise.all(certPromises)
				.then( certs => {
					let siPacker = new SecurityInfoPacker( certFileID => certs[certFileID] );
					let iStream = new BinaryInputStream(siPacker.packSecurityInfo(siDataObj));
					let bytes = iStream.readBytes(iStream.available());
					return btoa(bytes); // TODO: use base64 encoder stream
				});
		});
	
	var cacheMetaPromise = Promise.all([cachePromise, siBase64Promise, dataLengthPromise])
		.then( values => {
			let cacheDataObj = values[0];
			let siBase64 = values[1];
			let dataLength = values[2];
			let metaDataObj = cacheDataObj.meta;
		
			let meta = {};
			for (let key in metaDataObj) {
				if (key === "request" || key === "response") continue;
				meta[key] = metaDataObj[key];
			}
			
			{
				let reqObj = metaDataObj["request"];
				meta["request-method"] = reqObj["method"];
				let reqHeaders = reqObj["headers"];
				reqHeaders.forEach( header => {
					meta["request-" + header[0]] = header[1];
				});
			}
			
			{
				let respLines = [];
				let respObj = metaDataObj["response"];
				respLines.push(respObj["statusLine"]);
				let respHeaders = respObj["headers"];
				respHeaders.forEach( header => {
					let key = header[0];
					let val = header[1];
					if (key === "Content-Encoding") return;
					if (key === "Content-Length") value = dataLength;
					respLines.push(key + ": " + val);
				});
				meta["response-head"] = respLines.map( line => line+"\r\n" ).join("");
			}
			
			if (siBase64 !== null) meta["security-info"] = siBase64;
			
			return meta;
		});
	
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

