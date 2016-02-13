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
	"http_request_header_list_id" INTEGER NOT NULL,
	"referrer" TEXT, -- redundant
	
	-- response
	"statusCode" INTEGER NOT NULL,
	"statusText" TEXT NOT NULL,
	"http_response_header_list_id" INTEGER NOT NULL,
	"contentLength" INTEGER NOT NULL, -- redundant
	"http_response_content_type_id" INTEGER NOT NULL, -- redundant
	"http_response_content_charset_id" INTEGER NOT NULL, -- redundant
	
	"securityInfoData_id" INTEGER,
	
	FOREIGN KEY("response_id") REFERENCES "responses"("id"),
	FOREIGN KEY("http_topic_id") REFERENCES "http_topics"("id"),
	FOREIGN KEY("http_request_method_id") REFERENCES "http_request_methods"("id"),
	FOREIGN KEY("http_request_header_list_id") REFERENCES "http_request_header_lists"("id"),
	FOREIGN KEY("http_response_header_list_id") REFERENCES "http_response_header_lists"("id"),
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

CREATE TABLE "http_request_header_lists" (
	"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL
);

CREATE TABLE "http_request_header_lists_to_entries" (
	"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, -- order is important
	"http_request_header_list_id" INTEGER NOT NULL,
	"http_request_header_id" INTEGER NOT NULL,
	FOREIGN KEY("http_request_header_list_id") REFERENCES "http_request_header_lists"("id"),
	FOREIGN KEY("http_request_header_id") REFERENCES "http_request_headers"("id")
);

CREATE TABLE "http_request_headers" (
	"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	"http_request_header_name_id" INTEGER NOT NULL,
	"value" TEXT,
	FOREIGN KEY("http_request_header_name_id") REFERENCES "http_request_header_names"("id")
);

CREATE TABLE "http_request_header_names" (
	"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	"value" TEXT NOT NULL UNIQUE
);

CREATE TABLE "http_response_header_lists" (
	"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL
);

CREATE TABLE "http_response_header_lists_to_entries" (
	"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, -- order is important
	"http_response_header_list_id" INTEGER NOT NULL,
	"http_response_header_id" INTEGER NOT NULL,
	FOREIGN KEY("http_response_header_list_id") REFERENCES "http_response_header_lists"("id"),
	FOREIGN KEY("http_response_header_id") REFERENCES "http_response_headers"("id")
);

CREATE TABLE "http_response_headers" (
	"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	"http_response_header_name_id" INTEGER NOT NULL,
	"value" TEXT,
	FOREIGN KEY("http_response_header_name_id") REFERENCES "http_response_header_names"("id")
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
	FOREIGN KEY("failedCertChain_id") REFERENCES "certLists"("id")
);

CREATE TABLE "SSLStatuses" (
	"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	"serverCert_id" INTEGER NOT NULL,
	"cipherSuite" INTEGER NOT NULL,
	"protocolVersion" INTEGER NOT NULL,
	"isDomainMismatch" BOOLEAN NOT NULL,
	"isNotValidAtThisTime" BOOLEAN NOT NULL,
	"isUntrusted" BOOLEAN NOT NULL,
	"isEV" BOOLEAN NOT NULL,
	"hasIsEVStatus" BOOLEAN NOT NULL,
	"haveCipherSuiteAndProtocol" BOOLEAN NOT NULL,
	"haveCertErrorBits" BOOLEAN NOT NULL,
	FOREIGN KEY("serverCert_id") REFERENCES "certs"("id")
);

CREATE TABLE "certLists" (
	"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL
);

CREATE TABLE "certLists_to_certObjs" (
	"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, -- order is very important
	"certList_id" INTEGER NOT NULL,
	"certObj_id" INTEGER NOT NULL,
	FOREIGN KEY("certList_id") REFERENCES "certLists"("id"),
	FOREIGN KEY("certObj_id") REFERENCES "certObjs"("id")
);

CREATE TABLE "certObjs" (
	"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	"cachedEVStatus" INTEGER NOT NULL,
	"certData_id" INTEGER NOT NULL,
	FOREIGN KEY("certData_id") REFERENCES "certDatas"("id")
);

CREATE TABLE "certDatas" (
	"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	"cert" BLOB NOT NULL
);

CREATE TABLE "certHashes" (
	"certData_id" INTEGER NOT NULL,
	"hash" INTEGER NOT NULL,
	FOREIGN KEY("certData_id") REFERENCES "certDatas"("id")
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
	"tracing_status" INTEGER NOT NULL,
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
	"http_request_header_list_id" INTEGER NOT NULL,
	"http_response_status_http_version_id" INTEGER NOT NULL,
	"http_response_status_code" INTEGER NOT NULL,
	"http_response_status_text" TEXT NOT NULL,
	"http_response_header_list_id" INTEGER NOT NULL,
	"cache_entry_meta_list_id" INTEGER NOT NULL,
	
	FOREIGN KEY("response_id") REFERENCES "responses"("id"),
	FOREIGN KEY("http_request_method_id") REFERENCES "http_request_methods"("id"),
	FOREIGN KEY("http_request_header_list_id") REFERENCES "http_request_header_lists"("id"),
	FOREIGN KEY("http_response_status_http_version_id") REFERENCES "http_response_status_http_versions"("id"),
	FOREIGN KEY("http_response_header_list_id") REFERENCES "http_response_header_lists"("id"),
	FOREIGN KEY("cache_entry_meta_list_id") REFERENCES "cache_entry_meta_lists"("id")
);

CREATE TABLE "http_response_status_http_versions" (
	"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	"value" TEXT NOT NULL UNIQUE
);

CREATE TABLE "cache_entry_meta_lists" (
	"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL
);

CREATE TABLE "cache_entry_meta_lists_to_entries" (
	"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	"cache_entry_meta_list_id" INTEGER NOT NULL,
	"cache_entry_meta_id" INTEGER NOT NULL,
	FOREIGN KEY("cache_entry_meta_list_id") REFERENCES "cache_entry_meta_lists"("id"),
	FOREIGN KEY("cache_entry_meta_id") REFERENCES "cache_entry_metas"("id")
);

CREATE TABLE "cache_entry_metas" (
	"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	"cache_entry_meta_name_id" INTEGER NOT NULL,
	"value" TEXT,
	FOREIGN KEY("cache_entry_meta_name_id") REFERENCES "cache_entry_meta_names"("id")
);

CREATE TABLE "cache_entry_meta_names" (
	"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	"value" TEXT NOT NULL UNIQUE
);



--COMMIT;

