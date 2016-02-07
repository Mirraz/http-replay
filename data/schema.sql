--PRAGMA foreign_keys = ON;
--BEGIN TRANSACTION;



CREATE TABLE "observations" (
	"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	"name" TEXT
);



CREATE TABLE "responses" (
	"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	"observation_id" INTEGER NOT NULL,
	FOREIGN KEY("observation_id") REFERENCES "observations"("id")
);



CREATE TABLE "http_channels" (
	"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	"response_id" INTEGER NOT NULL,
	"http_topic_id" INTEGER NOT NULL,

	-- request
	"http_request_method_id" INTEGER NOT NULL,
	"uri" TEXT NOT NULL,
	-- http_request_headers
	"referrer" TEXT NOT NULL, -- redundant
	
	-- response
	"statusCode" INTEGER NOT NULL,
	"statusText" TEXT NOT NULL,
	-- http_response_headers
	"contentLength" INTEGER NOT NULL, -- redundant
	"http_response_content_type_id" INTEGER NOT NULL, -- redundant
	"http_response_content_charset_id" INTEGER, -- redundant
	
	"securityInfoData_id" INTEGER NOT NULL,
	
	FOREIGN KEY("response_id") REFERENCES "responses"("id")
	FOREIGN KEY("http_topic_id") REFERENCES "http_topics"("id"),
	FOREIGN KEY("http_request_method_id") REFERENCES "http_request_methods"("id"),
	FOREIGN KEY("http_response_content_type_id") REFERENCES "http_response_content_types"("id"),
	FOREIGN KEY("http_response_content_charset_id") REFERENCES "http_response_content_charsets"("id"),
	FOREIGN KEY("securityInfoData_id") REFERENCES "securityInfoDatas"("id")
);

CREATE TABLE "http_topics" (
	"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	"value" TEXT NOT NULL UNIQUE
);

CREATE TABLE "http_request_methods" (
	"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	"value" TEXT NOT NULL UNIQUE
);

CREATE TABLE "http_response_content_types" (
	"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	"value" TEXT NOT NULL UNIQUE
);

CREATE TABLE "http_response_content_charsets" (
	"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	"value" TEXT NOT NULL UNIQUE
);

CREATE TABLE "http_request_headers" (
	"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, -- order is important
	"http_channel_id" INTEGER NOT NULL,
	"http_request_header_name_id" INTEGER NOT NULL,
	"value" TEXT,
	FOREIGN KEY("http_channel_id") REFERENCES "http_channels"("id"),
	FOREIGN KEY("http_request_header_name_id") REFERENCES "http_request_header_names"("id")
);

CREATE TABLE "http_response_headers" (
	"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, -- order is important
	"http_channel_id" INTEGER NOT NULL,
	"http_response_header_name_id" INTEGER NOT NULL,
	"value" TEXT,
	FOREIGN KEY("http_channel_id") REFERENCES "http_channels"("id"),
	FOREIGN KEY("http_response_header_name_id") REFERENCES "http_response_header_names"("id")
);

CREATE TABLE "http_request_header_names" (
	"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	"value" TEXT NOT NULL UNIQUE
);

CREATE TABLE "http_response_header_names" (
	"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	"value" TEXT NOT NULL UNIQUE
);



CREATE TABLE "securityInfoDatas" (
	"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	"securityInfo_id" INTEGER,
	"securityInfoRaw_id" INTEGER,
	FOREIGN KEY("securityInfo_id") REFERENCES "securityInfos"("id"),
	FOREIGN KEY("securityInfoRaw_id") REFERENCES "securityInfoRaws"("id")
);

CREATE TABLE "securityInfoRaws" (
	"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	"data" BLOB NOT NULL
);

CREATE TABLE "securityInfos" (
	"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	"securityState" INTEGER NOT NULL,
	"subRequestsBrokenSecurity" INTEGER NOT NULL,
	"subRequestsNoSecurity" INTEGER NOT NULL,
	"errorCode" INTEGER NOT NULL,
	"errorMessageCached" TEXT,
	"SSLStatus_id" INTEGER,
	"failedCertChain_id" INTEGER,
	FOREIGN KEY("SSLStatus_id") REFERENCES "SSLStatuses"("id"),
	FOREIGN KEY("failedCertChain_id") REFERENCES "failedCerts"("id")
);

CREATE TABLE "SSLStatuses" (
	"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	"serverCert_id" INTEGER NOT NULL,
	"cipherSuite" INTEGER NOT NULL,
	"protocolVersion" INTEGER NOT NULL,
	"isDomainMismatch" NUMERIC NOT NULL,
	"isNotValidAtThisTime" NUMERIC NOT NULL,
	"isUntrusted" NUMERIC NOT NULL,
	"isEV" NUMERIC NOT NULL,
	"hasIsEVStatus" NUMERIC NOT NULL,
	"haveCipherSuiteAndProtocol" NUMERIC NOT NULL,
	"haveCertErrorBits" NUMERIC NOT NULL,
	FOREIGN KEY("serverCert_id") REFERENCES "certs"("id")
);

CREATE TABLE "failedCerts" (
	"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	"securityInfo_id" INTEGER NOT NULL,
	"cert_id" INTEGER NOT NULL,
	"order_number" INTEGER NOT NULL,
	FOREIGN KEY("securityInfo_id") REFERENCES "securityInfos"("id"),
	FOREIGN KEY("cert_id") REFERENCES "certs"("id")
);

CREATE TABLE "certs" (
	"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	"cachedEVStatus" INTEGER NOT NULL,
	"cert" BLOB NOT NULL
);

CREATE TABLE "cert_hashes" (
	"cert_id" INTEGER NOT NULL,
	"hash" INTEGER NOT NULL,
	FOREIGN KEY("cert_id") REFERENCES "certs"("id")
);



CREATE TABLE "http_response_datas" (
	"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	"response_id" INTEGER NOT NULL,
	"data" BLOB,
	FOREIGN KEY("response_id") REFERENCES "responses"("id")
);



CREATE TABLE "http_statuses" (
	"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	"response_id" INTEGER NOT NULL,
	"listener_status" INTEGER NOT NULL,
	"http_status" INTEGER NOT NULL,
	FOREIGN KEY("response_id") REFERENCES "responses"("id")
);



CREATE TABLE "cache_entries" (
	"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	"response_id" INTEGER NOT NULL,
	"key" TEXT NOT NULL,
	"expirationTime" INTEGER NOT NULL,
	"predictedDataSize" INTEGER NOT NULL,
	"storageDataSize" INTEGER NOT NULL,
	"dataSize" INTEGER NOT NULL,
	
	-- meta
	"http_request_method_id" INTEGER NOT NULL,
	-- cache_entry_request_headers
	"http_response_status_http_version_id" INTEGER NOT NULL,
	"http_response_status_code" INTEGER NOT NULL,
	"http_response_status_text" TEXT NOT NULL,
	-- cache_entry_response_headers
	-- cache_entry_metas (other)
	
	FOREIGN KEY("response_id") REFERENCES "responses"("id"),
	FOREIGN KEY("http_request_method_id") REFERENCES "http_request_methods"("id"),
	FOREIGN KEY("http_response_status_http_version_id") REFERENCES "http_response_status_http_versions"("id")
);

CREATE TABLE "http_response_status_http_versions" (
	"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	"value" TEXT NOT NULL UNIQUE
);

CREATE TABLE "cache_entry_metas" (
	"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	"cache_entry_id" INTEGER NOT NULL,
	"cache_entry_meta_name_id" INTEGER NOT NULL,
	"value" TEXT,
	FOREIGN KEY("cache_entry_id") REFERENCES "cache_entries"("id"),
	FOREIGN KEY("cache_entry_meta_name_id") REFERENCES "cache_entry_meta_names"("id")
);

CREATE TABLE "cache_entry_meta_names" (
	"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	"value" TEXT NOT NULL UNIQUE
);

CREATE TABLE "cache_entry_request_headers" (
	"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	"cache_entry_id" INTEGER NOT NULL,
	"http_request_header_name_id" INTEGER NOT NULL,
	"value" TEXT,
	FOREIGN KEY("cache_entry_id") REFERENCES "cache_entries"("id"),
	FOREIGN KEY("http_request_header_name_id") REFERENCES "http_request_header_names"("id")
);

CREATE TABLE "cache_entry_response_headers" (
	"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	"cache_entry_id" INTEGER NOT NULL,
	"http_response_header_name_id" INTEGER NOT NULL,
	"value" TEXT,
	FOREIGN KEY("cache_entry_id") REFERENCES "cache_entries"("id"),
	FOREIGN KEY("http_response_header_name_id") REFERENCES "http_response_header_names"("id")
);



--COMMIT;
