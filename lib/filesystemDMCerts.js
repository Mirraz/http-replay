const {Promise, promiseWaitAll, Deferred, tiePromiseWithDeferred} = require("./common");
const {Cu} = require("chrome");
const {OS} = Cu.import("resource://gre/modules/osfile.jsm", {});
Cu.importGlobalProperties(["crypto"]);

const interruptMessage = "Interrupted";

function arrayEquals(firstArray, secondArray) {
	return	(
		firstArray.length === secondArray.length &&
		firstArray.every( (element, index) => element === secondArray[index] )
	);
}

function SDMCerts(basePath, parentPromise) {
	this.basePath = basePath;
	this.dirPromise = parentPromise
		.then( () => OS.File.makeDir(this.basePath) );
	this.dirPromise
		.catch( e => {console.error(e)} );
	
	let hashSet = new Set();
	this.hashSetFilledPromise = this.dirPromise
		.then( () => {
			let iterator = new OS.File.DirectoryIterator(this.basePath);
			return Promise.resolve()
				.then( () => iterator.nextBatch() )
				.finally( () => iterator.close() )
				.then(entries => {
					entries
						.map( entry => entry["name"] )
						.forEach( hash => {
							hashSet.add(hash);
						});
				});
		});
	this.hashSetFilledPromise
		.catch( e => {console.error(e)} );
	this.hashSet = hashSet;
	
	this.filesCache = new FilesCache(this.basePath, this.dirPromise, 256);
	this.deferred = new Deferred();
}
SDMCerts.digestAlgo = "SHA-256";
SDMCerts.prototype = {
	isStopped: false,
	savePromises: [],
	
	// public
	getOnDonePromise: function() {
		return this.deferred.promise;
	},
	
	// public
	saveCert: function(certByteArray, certIdListPromise) {
		if (this.isStopped) throw Error();
		let hashPromise = this.getHash(certByteArray);
		let savePromise = this.save(hashPromise, certByteArray, certIdListPromise);
		this.savePromises.push(savePromise);
		return hashPromise;
	},
	
	// data -- ByteArray
	// returns: string
	// private
	getHash: function(data) {
		return crypto.subtle.digest(SDMCerts.digestAlgo, new Uint8Array(data))
			.then( hashArrayBuffer => Base64URL.bytesToBase64String(new Uint8Array(hashArrayBuffer)) );
			// for collisions test
			//.then( hashArrayBuffer => String(new Uint8Array(hashArrayBuffer)[0] & 0x03) );
	},
	
	// data -- ByteArray
	// private
	save: function(hashPromise, data, certIdListPromise) {
		return Promise.all([hashPromise, this.hashSetFilledPromise])
			.then( results => {
				let hash = results[0];
				if (this.hashSet.has(hash)) {
					// collision check
					return this.filesCache.get(hash)
						.then( cachedData => {
							if (! arrayEquals(cachedData, data)) {
								console.error("certs hash collision");
								return this.saveCollision(hash, data, certIdListPromise);
							}
						});
				} else {
					this.hashSet.add(hash);
					return this.filesCache.add(hash, data);
				}
			});
	},
	
	// private
	saveCollision: function(hash, data, certIdListPromise) {
		return certIdListPromise
			.then( idList => {
				let fileName = [].concat(hash, idList).join(",");
				let filePath = OS.Path.join(this.basePath, fileName);
				return this.dirPromise
					.then(
						() => OS.File.writeAtomic(
							filePath,
							new Uint8Array(data),
							{noOverwrite: true, flush: true}
						)
					);
			});
	},
	
	// public
	flushCache: function() {
		this.filesCache.flush();
	},
	
	// public
	finish: function() {
		if (this.isStopped) throw Error();
		this.isStopped = true;
		let certsPromise = Promise.all([
			this.promise,
			promiseWaitAll(this.savePromises)
		]);
		tiePromiseWithDeferred(certsPromise, this.deferred);
	},
	
	// public
	interrupt: function() {
		this.isStopped = true;
		this.deferred.reject(interruptMessage);
	},
};

function FilesCache(basePath, parentPromise, cacheDataMaxCount) {
	this.basePath = basePath;
	this.promise = parentPromise;
	this.cacheQueue = new CacheQueue(cacheDataMaxCount);
}
FilesCache.prototype = {
	// add new data entry
	// data -- ByteArray
	// returns: Promise resolves on done
	// public
	add: function(hash, data) {
		this.cacheQueue.add(hash, Promise.resolve(data));
		let filePath = OS.Path.join(this.basePath, hash);
		let writePromise = this.promise
			.then(
				() => OS.File.writeAtomic(
					filePath,
					new Uint8Array(data),
					{noOverwrite: true, flush: true}
				)
			);
		writePromise
			.catch( e => {console.error(e)} );
		return writePromise;
	},
	
	// get existing data entry
	// returns: Promise<cachedData>
	// public
	get: function(hash) {
		let cacheDataPromise = this.cacheQueue.find(hash);
		if (cacheDataPromise !== undefined) return cacheDataPromise;
		let filePath = OS.Path.join(this.basePath, hash);
		let readPromise = this.promise
			.then( () => OS.File.read(filePath) );
		this.cacheQueue.add(hash, readPromise);
		return readPromise;
	},
	
	// public
	flush: function() {
		this.cacheQueue.clear();
	},
};

function CacheQueue(maxSize) {
	this.maxSize = maxSize;
}
CacheQueue.prototype = {
	keyList: [],
	entryMap: new Map(),
	
	// add new entry, do replacement if needed
	// public
	add: function(key, value) {
		if (this.keyList.length >= this.maxSize) {
			let oldKey = this.keyList.shift();
			this.entryMap.delete(oldKey);
		}
		this.keyList.push(key);
		this.entryMap.set(key, value);
	},
	
	// returns: value or undefined if not found
	// public
	find: function(key) {
		return this.entryMap.get(key);
	},
	
	// public
	clear: function() {
		this.keyList = [];
		this.entryMap = new Map();
	},
};

// Standard 'base64url' with URL and Filename Safe Alphabet (RFC 4648)
var Base64URL = {};
Base64URL.CODES = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".split("");
// without padding
Base64URL.bytesToBase64String = function(bytes) {
	let str = "";
	let appendCode = function(b) {
		//if (b >= CODES.length) throw Error();
		str += Base64URL.CODES[b];
	};
	let b;
	for (let i = 0; i < bytes.length; i += 3) {
		appendCode((bytes[i] & 0xFC) >> 2);
		b = (bytes[i] & 0x03) << 4;
		if (i + 1 < bytes.length) {
			b |= (bytes[i + 1] & 0xF0) >> 4;
			appendCode(b);
			b = (bytes[i + 1] & 0x0F) << 2;
			if (i + 2 < bytes.length) {
				b |= (bytes[i + 2] & 0xC0) >> 6;
				appendCode(b);
				appendCode(bytes[i + 2] & 0x3F);
			} else {
				appendCode(b);
			}
		} else {
			appendCode(b);
		}
	}
	return str;
};

////////////////

function RDMCerts(basePath, parentPromise) {
	this.basePath = basePath;
	let existsPromise = parentPromise
		.then( () => OS.File.exists(this.basePath) );
	this.promise = existsPromise
		.then( exists => {
			if (! exists) throw Error("certs dir doesn't exist");
		})
	existsPromise
		.catch( e => {console.error(e)} );
	this.deferred = new Deferred();
}
RDMCerts.prototype = {
	// public
	getOnDonePromise: function() {
		return this.deferred.promise;
	},

	// public
	getCert: function(certHash) {
		let filePath = OS.Path.join(this.basePath, certHash);
		return this.promise
			.then( () => OS.File.exists(filePath) )
			.then( exists => {
				if (! exists) throw Error("cert file '" + certHash + "' doesn't exist");
				return OS.File.read(filePath);
			});
	},
	
	// public
	finish: function() {
		if (this.isStopped) throw Error();
		this.isStopped = true;
		let certsPromise = this.promise;
		tiePromiseWithDeferred(certsPromise, this.deferred);
	},
	
	// public
	interrupt: function() {
		this.isStopped = true;
		this.deferred.reject(interruptMessage);
	},
};

////////////////

exports.SDMCerts = SDMCerts;
exports.RDMCerts = RDMCerts;

