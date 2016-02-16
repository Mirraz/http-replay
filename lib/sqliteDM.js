const {Cu} = require("chrome");
const {OS} = Cu.import("resource://gre/modules/osfile.jsm", {});

const dbName = "http-replay.sqlite";
const dbPath = OS.Path.join(OS.Constants.Path.profileDir, dbName);

exports.dbName = dbName;
exports.dbPath = dbPath;
