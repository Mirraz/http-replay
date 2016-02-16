const {SecurityInfoParser} = require("./securityinfo");

function prepareHttp(http, topic) {
	var httpReqHeads = [];
	http.visitRequestHeaders({
		visitHeader: function(aHeader, aValue) {
			httpReqHeads.push([aHeader, aValue]);
		}
	});
	
	var httpRespHeads = [];
	http.visitResponseHeaders({
		visitHeader: function(aHeader, aValue) {
			httpRespHeads.push([aHeader, aValue]);
		}
	});
	
	var httpDataObj = {
		"topic": topic,
		request: {
			method: http.requestMethod,
			URI: http.URI.spec,
			//originalURI: http.originalURI.spec,
			//name: http.name,
			headers: httpReqHeads,
			referrer: (http.referrer !== null ? http.referrer.spec : null),
		},
		response: {
			statusCode: http.responseStatus,
			statusText: http.responseStatusText,
			//requestSucceeded: http.requestSucceeded,
			headers: httpRespHeads,
			contentLength: http.contentLength,
			contentCharset: http.contentCharset,
			contentType: http.contentType,
		},
		securityInfo: (http.securityInfo !== null ? prepareHttpSecurityInfo(http.securityInfo) : null),
	};
	
	return httpDataObj;
}

function prepareHttpSecurityInfo(securityInfo) {
	try {
		var siDataObj = new SecurityInfoParser( byteArray => byteArray ).parseSecurityInfo(securityInfo);
		return {"parsed": siDataObj};
	} catch(e) {
		console.error("parseSecurityInfo error: " + e);
		var siByteArray = SecurityInfoParser.getSerializedSecurityInfo(securityInfo);
		return {"raw": siByteArray};
	}
}

function prepareHttpStatus(tracingErr, httpStatus) {
	let tracingStatus;
	{
		let e = tracingErr;
		if (typeof e === "number") {
			tracingStatus = e;
		} else if (e !== null && typeof e === "object" && ("result" in e)) {
			let resNum = Number(e.result);
			if (Number.isNaN(resNum)) throw e.result;
			tracingStatus = resNum;
		} else {
			throw e;
		}
	}
	return {
		httpStatus:    httpStatus,
		tracingStatus: tracingStatus
	};
}

function prepareCacheEntry(aEntry) {
	if (aEntry === null) return null;
	var out = {
		key:               aEntry.key,
		expirationTime:    aEntry.expirationTime,
		predictedDataSize: aEntry.predictedDataSize,
		storageDataSize:   aEntry.storageDataSize,
		dataSize:          aEntry.dataSize,
	};
	out["meta"] = prepareCacheMeta(aEntry);
	return out;
}

function prepareCacheMeta(aEntry) {
	var out = {};
	var otherMeta = [];
	var reqHeaders = [];
	aEntry.visitMetaData({
		onMetaDataElement: function(key, value) {
			switch(key) {
				case "security-info": {
					break;
				}
				case "response-head": {
					try {
						out["response"] = parseCachedResponseHead(value);
					} catch(e) {
						console.error(e);
					}
					break;
				}
				case "request-method": {
					out["request"] = {
						method: value
					};
					break;
				}
				default: {
					if (key.startsWith("request-")) {
						reqHeaders.push([key.substr("request-".length), value]);
					} else {
						otherMeta.push([key, value]);
					}
				}
			}
		}
	});
	if (!("request"  in out)) throw Error("cache entry hasn't 'request-method' meta");
	if (!("response" in out)) throw Error("cache entry hasn't 'response-head' mata");
	out["request"]["headers"] = reqHeaders;
	out["other"] = otherMeta;
	return out;
}

const httpStatusLineRe = /^(HTTP[^ ]+) (\d+) (.*)$/;
const httpHeaderRe = /^([^:]+): (.*)$/;
function parseCachedResponseHead(headStr) {
	let lines = headStr.split("\r\n");
	if (lines.length < 2) throw Error();
	if (lines[lines.length - 1] !== "") throw Error();
	
	let out = {};
	{
		let res = lines[0].match(httpStatusLineRe);
		if (res === null) throw Error();
		if (res.length !== 4) throw Error();
		out["statusHttpVersion"] = res[1];
		out["statusCode"]        = Number(res[2]);
		out["statusText"]        = res[3];
	}
	
	out["headers"] = lines.slice(1, -1)
		.map(headerLine => {
			let res = headerLine.match(httpHeaderRe);
			if (res === null) throw Error();
			if (res.length !== 3) throw Error();
			let name = res[1];
			let value = res[2];
			return [name, value];
		});
	
	return out;
}

exports.prepareHttp = prepareHttp;
exports.prepareHttpStatus = prepareHttpStatus;
exports.prepareCacheEntry = prepareCacheEntry;

