const {Promise, promiseWaitAll, Deferred, tiePromiseWithDeferred} = require("./common");
const {Cu} = require("chrome");
const {OS} = Cu.import("resource://gre/modules/osfile.jsm", {});
Cu.importGlobalProperties(["crypto"]);

const interruptMessage = "Interrupted";

function SDMCerts(basePath, parentPromise) {
	this.basePath = basePath;
	this.promise = parentPromise
		.then( () => OS.File.makeDir(this.basePath) );
	this.promise
		.catch( e => {console.error(e)} );
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
	saveCert: function(certByteArray) {
		if (this.isStopped) throw Error();
		let buffer = new Uint8Array(certByteArray);
		let hashPromise = crypto.subtle.digest(SDMCerts.digestAlgo, buffer)
			.then( hashArrayBuffer => Base64URL.bytesToBase64String(new Uint8Array(hashArrayBuffer)) );
		let savePromise = Promise.all([hashPromise, this.promise])
			.then( results => {
				let hash = results[0];
				let filePath = OS.Path.join(this.basePath, hash);
				return OS.File.exists(filePath)
					.then( exists => {
						if (exists) return;
						let savePromise = OS.File.writeAtomic(filePath, buffer, {noOverwrite: true, flush: true});
						savePromise
							.catch( e => {console.error(e)} );
						return savePromise;
					})
					.then( () => hash );
			});
		this.savePromises.push(savePromise);
		return hashPromise;
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

exports.SDMCerts = SDMCerts;
exports.RDMCerts = RDMCerts;

