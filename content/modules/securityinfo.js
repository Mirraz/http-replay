var EXPORTED_SYMBOLS = ["SecurityInfoParser", "SecurityInfoPacker"];

Components.utils.import("chrome://httpreplay/content/modules/common.js");

var SecurityInfo = {
	TransportSecurityInfoID:    [0x16786594, 0x0296, 0x4471, [0x80, 0x96, 0x8F, 0x84, 0x49, 0x7C, 0xA4, 0x28]],
	nsISupportsID:              [0x00000000, 0x0000, 0x0000, [0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46]],
	TransportSecurityInfoMagic: [0xA9863A23, 0x1FAA, 0x4169, [0xB0, 0xD2, 0x81, 0x29, 0xEC, 0x7C, 0xB1, 0xDE]],
	nsSSLStatusID:              [0xE2F14826, 0x9E70, 0x4647, [0xB2, 0x3F, 0x10, 0x10, 0xF5, 0x12, 0x46, 0x28]],
	nsISSLStatusID:             [0xFA9BA95B, 0xCA3B, 0x498A, [0xB8, 0x89, 0x7C, 0x79, 0xCF, 0x28, 0xFE, 0xE8]],
	nsNSSCertificateID:         [0x660A3226, 0x915C, 0x4FFB, [0xBB, 0x20, 0x89, 0x85, 0xA6, 0x32, 0xDF, 0x05]],
	nsIX509CertID:              [0xF8ED8364, 0xCED9, 0x4C6E, [0x86, 0xBA, 0x48, 0xAF, 0x53, 0xC3, 0x93, 0xE6]],
	nsX509CertListID:           [0x959FB165, 0x6517, 0x487F, [0xAB, 0x9B, 0xD8, 0x91, 0x3B, 0xE5, 0x31, 0x97]],
	nsIX509CertListID:          [0xAE74CDA5, 0xCD2F, 0x473F, [0x96, 0xF5, 0xF0, 0xB7, 0xFF, 0xF6, 0x2C, 0x68]],
};

function SecurityInfoParser(certWriter) {
	this.certWriter = certWriter; // binaryString => smth
}
SecurityInfoParser.getSerializedSecurityInfoStream = function(securityInfo) {
	securityInfo.QueryInterface(Ci.nsISerializable);

	var pipe = new Pipe(false, false, 0, PR_UINT32_MAX, null);
	var objOStream = new ObjectOutputStream(pipe.outputStream);
	objOStream.writeCompoundObject(securityInfo, Ci.nsISupports, true);
	objOStream.close();

	return new BinaryInputStream(pipe.inputStream);
};
SecurityInfoParser.getSerializedSecurityInfo = function(securityInfo) {
	var iStream = SecurityInfoParser.getSerializedSecurityInfoStream(securityInfo);
	var siByteArray = iStream.readByteArray(iStream.available());
	iStream.close();
	return siByteArray;
};
SecurityInfoParser.prototype = {
	parseSecurityInfo: function(securityInfo) {
		var iStream = SecurityInfoParser.getSerializedSecurityInfoStream(securityInfo);
		var res = {};
		this.parseSecurityInfoStream(iStream, res);

		var remainderCount;
		try {
			remainderCount = iStream.available();
		} catch(e) {
			remainderCount = 0;
		}
		if (remainderCount > 0) throw Error("remainder");
		iStream.close();

		return res;
	},
	parseSecurityInfoStream: function(iStream, outObj) {
		var cid = SecurityInfoParser.readID(iStream);
		var iid = SecurityInfoParser.readID(iStream);
		if (! SecurityInfoParser.ID_equal(cid, SecurityInfo.TransportSecurityInfoID))
			throw Error("TransportSecurityInfo cid");
		if (! SecurityInfoParser.ID_equal(iid, SecurityInfo.nsISupportsID))
			throw Error("nsISupports iid");
		//outObj["cid"] = cid;
		//outObj["iid"] = iid;

		var id = SecurityInfoParser.readID(iStream);
		if (! SecurityInfoParser.ID_equal(id, SecurityInfo.TransportSecurityInfoMagic))
			throw Error("TransportSecurityInfoMagic");
		//outObj["magic"] = id;

		outObj["securityState"]             = iStream.read32();
		outObj["subRequestsBrokenSecurity"] = iStream.read32();
		outObj["subRequestsNoSecurity"]     = iStream.read32();
		outObj["errorCode"]                 = iStream.read32();
		outObj["errorMessageCached"]        = iStream.readString();

		var SSLStatus;
		if (iStream.readBoolean()) {
			SSLStatus = {};
			this.parseSSLStatusStream(iStream, SSLStatus);
		} else {
			SSLStatus = null;
		}
		outObj["SSLStatus"] = SSLStatus;

		var failedCertChain;
		if (iStream.readBoolean()) {
			failedCertChain = {};
			this.parseFailedCertChainStream(iStream, failedCertChain);
		} else {
			failedCertChain = null;
		}
		outObj["failedCertChain"] = failedCertChain;
	},
	parseSSLStatusStream: function(iStream, outObj) {
		var cid = SecurityInfoParser.readID(iStream);
		var iid = SecurityInfoParser.readID(iStream);
		if (! SecurityInfoParser.ID_equal(cid, SecurityInfo.nsSSLStatusID))
			throw Error("nsSSLStatus cid");
		if (! SecurityInfoParser.ID_equal(iid, SecurityInfo.nsISSLStatusID))
			throw Error("nsISSLStatus iid");
		//outObj["cid"] = cid;
		//outObj["iid"] = iid;

		outObj["serverCert"] = {};
		this.parseCertStream(iStream, outObj["serverCert"]);

		outObj["cipherSuite"]                = iStream.read16();
		outObj["protocolVersion"]            = iStream.read16();
		outObj["isDomainMismatch"]           = iStream.readBoolean();
		outObj["isNotValidAtThisTime"]       = iStream.readBoolean();
		outObj["isUntrusted"]                = iStream.readBoolean();
		outObj["isEV"]                       = iStream.readBoolean();
		outObj["hasIsEVStatus"]              = iStream.readBoolean();
		outObj["haveCipherSuiteAndProtocol"] = iStream.readBoolean();
		outObj["haveCertErrorBits"]          = iStream.readBoolean();
	},
	parseCertStream: function(iStream, outObj) {
		var cid = SecurityInfoParser.readID(iStream);
		var iid = SecurityInfoParser.readID(iStream);
		if (! SecurityInfoParser.ID_equal(cid, SecurityInfo.nsNSSCertificateID))
			throw Error("nsNSSCertificate cid");
		if (! SecurityInfoParser.ID_equal(iid, SecurityInfo.nsIX509CertID))
			throw Error("nsIX509Cert iid");
		//outObj["cid"] = cid;
		//outObj["iid"] = iid;

		outObj["cachedEVStatus"] = iStream.read32();

		var certLen = iStream.read32();
		var certByteArray = iStream.readByteArray(certLen);
		//outObj["len"] = certLen;
		outObj["cert"] = this.certWriter(certByteArray);
	},
	parseFailedCertChainStream: function(iStream, outObj) {
		var cid = SecurityInfoParser.readID(iStream);
		var iid = SecurityInfoParser.readID(iStream);
		if (! SecurityInfoParser.ID_equal(cid, SecurityInfo.nsX509CertListID))
			throw Error("nsX509CertList cid");
		if (! SecurityInfoParser.ID_equal(iid, SecurityInfo.nsIX509CertListID))
			throw Error("nsIX509CertList iid");
		//outObj["cid"] = cid;
		//outObj["iid"] = iid;

		var certListLen = iStream.read32();
		//outObj["certListLen"] = certListLen;
		var certList = new Array(certListLen);
		for (let i = 0; i < certListLen; ++i) {
			let cert = {};
			this.parseCertStream(iStream, cert);
			certList[i] = cert;
		}
		outObj["certList"] = certList;
	},
};
SecurityInfoParser.readID = function(iStream) {
	var m = new Array(4);
	m[0] = iStream.read32();
	m[1] = iStream.read16();
	m[2] = iStream.read16();
	m[3] = new Array(8);
	for (let i = 0; i < 8; ++i) {
		m[3][i] = iStream.read8();
	}
	return m;
};
SecurityInfoParser.ID_equal = function(a, b) {
	if (a[0] !== b[0]) return false;
	if (a[1] !== b[1]) return false;
	if (a[2] !== b[2]) return false;
	for (let i = 0; i < 8; ++i) {
		if (a[3][i] !== b[3][i]) return false;
	}
	return true;
};

function SecurityInfoPacker(certReader) {
	this.certReader = certReader; // smth => binaryString
}
SecurityInfoPacker.prototype = {
	packSecurityInfo: function(siDataObj) {
		var pipe = new Pipe(false, false, 0, PR_UINT32_MAX, null);

		var oStream = new BinaryOutputStream(pipe.outputStream);
		this.packSecurityInfoStream(oStream, siDataObj);
		oStream.close();

		return pipe.inputStream;
	},
	packSecurityInfoStream: function(oStream, inObj) {
		SecurityInfoPacker.writeID(oStream, SecurityInfo.TransportSecurityInfoID);
		SecurityInfoPacker.writeID(oStream, SecurityInfo.nsISupportsID);

		SecurityInfoPacker.writeID(oStream, SecurityInfo.TransportSecurityInfoMagic);

		oStream.write32(inObj["securityState"]);
		oStream.write32(inObj["subRequestsBrokenSecurity"]);
		oStream.write32(inObj["subRequestsNoSecurity"]);
		oStream.write32(inObj["errorCode"]);
		oStream.writeWStringZ(inObj["errorMessageCached"]);

		var SSLStatus = inObj["SSLStatus"];
		oStream.writeBoolean(SSLStatus !== null);
		if (SSLStatus !== null) {
			this.packSSLStatusStream(oStream, SSLStatus);
		}

		var failedCertChain = inObj["failedCertChain"];
		oStream.writeBoolean(failedCertChain !== null);
		if (failedCertChain !== null) {
			this.packFailedCertChainStream(oStream, failedCertChain);
		}
	},
	packSSLStatusStream: function(oStream, inObj) {
		SecurityInfoPacker.writeID(oStream, SecurityInfo.nsSSLStatusID);
		SecurityInfoPacker.writeID(oStream, SecurityInfo.nsISSLStatusID);

		this.packCertStream(oStream, inObj["serverCert"]);

		oStream.write16(inObj["cipherSuite"]);
		oStream.write16(inObj["protocolVersion"]);
		oStream.writeBoolean(inObj["isDomainMismatch"]);
		oStream.writeBoolean(inObj["isNotValidAtThisTime"]);
		oStream.writeBoolean(inObj["isUntrusted"]);
		oStream.writeBoolean(inObj["isEV"]);
		oStream.writeBoolean(inObj["hasIsEVStatus"]);
		oStream.writeBoolean(inObj["haveCipherSuiteAndProtocol"]);
		oStream.writeBoolean(inObj["haveCertErrorBits"]);
	},
	packCertStream: function(oStream, inObj) {
		SecurityInfoPacker.writeID(oStream, SecurityInfo.nsNSSCertificateID);
		SecurityInfoPacker.writeID(oStream, SecurityInfo.nsIX509CertID);

		oStream.write32(inObj["cachedEVStatus"]);

		var cert = this.certReader(inObj["cert"]);
		var len = cert.length;
		oStream.write32(len);
		oStream.writeByteArray(cert, len);
	},
	packFailedCertChainStream: function(oStream, inObj) {
		SecurityInfoPacker.writeID(oStream, SecurityInfo.nsX509CertListID);
		SecurityInfoPacker.writeID(oStream, SecurityInfo.nsIX509CertListID);

		var certList = inObj["certList"];
		oStream.write32(certList.length);
		for (let i = 0; i < certList.length; ++i) {
			this.packCertStream(oStream, certList[i]);
		}
	},
};
SecurityInfoPacker.writeID = function(oStream, ID) {
	oStream.write32(ID[0]);
	oStream.write16(ID[1]);
	oStream.write16(ID[2]);
	for (let i = 0; i < 8; ++i) {
		oStream.write8(ID[3][i]);
	}
};
SecurityInfoPacker.getCertFileIDs = function(siDataObj) {
	var certFileIDs = [];
	if (siDataObj.SSLStatus !== null) certFileIDs.push(siDataObj.SSLStatus.serverCert.cert);
	if (siDataObj.failedCertChain !== null) {
		siDataObj.failedCertChain.certList.forEach( certObj => {
			certFileIDs.push(certObj.cert);
		});
	}
	for (let i=0; i<certFileIDs.length; ++i) if (certFileIDs[i] !== i) throw Error();
	return certFileIDs;
};

