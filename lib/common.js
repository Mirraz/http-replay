Promise.prototype.finally = function(callback) {
	let p = this.constructor;
	return this.then(
		value  => p.resolve(callback()).then(() => value),
		reason => p.resolve(callback()).then(() => { throw reason })
	);
};
Promise.prototype.wait = function(callback) {
	let p = this.constructor;
	return this.then(
		value  => p.resolve(callback([false, value])),
		reason => p.resolve(callback([true, reason]))
	);
};

function promiseWaitAll(promiseArr) {
	return Promise.all(
		promiseArr.map(
			promise => promise.then(
				value  => [false, value],
				reason => [true, reason]
			)
		)
	).then( resArr => {
		let errRes = resArr.find( res => res[0] );
		if (errRes === undefined) {
			return Promise.resolve(resArr.map( res => res[1] ));
		} else {
			return Promise.reject(errRes[1]);
		}
	});
}

function Deferred() {
	this.resolve = null;
	this.reject  = null;
	this.promise = new Promise( (resolve, reject) => {
		this.resolve = resolve;
		this.reject = reject;
	});
	Object.freeze(this);
}

function tiePromiseWithDeferred(promise, deferred) {
	promise.then(
		v => {deferred.resolve(v)},
		e => {deferred.reject (e)}
	);
}

const {Cu, CC} = require("chrome");

const BinaryInputStream = CC('@mozilla.org/binaryinputstream;1', 'nsIBinaryInputStream', 'setInputStream');
const BinaryOutputStream = CC('@mozilla.org/binaryoutputstream;1', 'nsIBinaryOutputStream', 'setOutputStream');
const ObjectOutputStream = CC('@mozilla.org/binaryoutputstream;1', 'nsIObjectOutputStream', 'setOutputStream');
const Pipe = CC('@mozilla.org/pipe;1', 'nsIPipe', 'init');
const PR_UINT32_MAX = 0xffffffff;

const {OS} = Cu.import("resource://gre/modules/osfile.jsm", {});
const extensionDataPath = OS.Path.join(OS.Constants.Path.profileDir, "HttpReplay");

exports.Promise = Promise;
exports.promiseWaitAll = promiseWaitAll;
exports.Deferred = Deferred;
exports.tiePromiseWithDeferred = tiePromiseWithDeferred;

exports.BinaryInputStream = BinaryInputStream;
exports.BinaryOutputStream = BinaryOutputStream;
exports.ObjectOutputStream = ObjectOutputStream;
exports.Pipe = Pipe;
exports.PR_UINT32_MAX = PR_UINT32_MAX;

exports.extensionDataPath = extensionDataPath;

