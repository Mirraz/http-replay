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

exports.Promise = Promise;
exports.promiseWaitAll = promiseWaitAll;
exports.Deferred = Deferred;
exports.tiePromiseWithDeferred = tiePromiseWithDeferred;

