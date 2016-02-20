const {SecurityInfoParser} = require("./securityinfo");

function prepareHttp(http, topic) {
	let requestHeaders = [];
	http.visitRequestHeaders({
		visitHeader: function(aHeader, aValue) {
			requestHeaders.push([aHeader, aValue]);
		}
	});
	
	let responseHeaders = [];
	http.visitResponseHeaders({
		visitHeader: function(aHeader, aValue) {
			responseHeaders.push([aHeader, aValue]);
		}
	});
	
	var httpDataObj = {
		topic: topic,
		
		// request
		requestMethod: http.requestMethod,
		URI: http.URI.spec,
		//originalURI: http.originalURI.spec,
		//name: http.name,
		requestHeaders: requestHeaders,
		referrer: (http.referrer !== null ? http.referrer.spec : null),
		
		// response
		responseStatus: http.responseStatus,
		responseStatusText: http.responseStatusText,
		//requestSucceeded: http.requestSucceeded,
		responseHeaders: responseHeaders,
		contentLength: http.contentLength,
		contentCharset: http.contentCharset,
		contentType: http.contentType,
		
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
	
	let metaData = [];
	aEntry.visitMetaData({
		onMetaDataElement: function(key, value) {
			metaData.push([key, value]);
		}
	});
	
	return {
		key:               aEntry.key,
		expirationTime:    aEntry.expirationTime,
		predictedDataSize: aEntry.predictedDataSize,
		storageDataSize:   aEntry.storageDataSize,
		dataSize:          aEntry.dataSize,
		metaData:          prepareCacheMeta(metaData),
	};
}

function prepareCacheMeta(metaData) {
	var out = [];
	metaData.forEach( keyValue => {
		let key   = keyValue[0];
		let value = keyValue[1];
		let outValue;
		switch(key) {
			case "security-info": {
				outValue = null;
				break;
			}
			case "response-head": {
				try {
					outValue = parseCachedResponseHead(value);
				} catch(e) {
					console.error(e);
					outValue = value;
				}
				break;
			}
			default: {
				outValue = value;
			}
		}
		out.push([key, outValue]);
	});
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

