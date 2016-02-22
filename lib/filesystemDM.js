const {Cu} = require("chrome");
const {OS} = Cu.import("resource://gre/modules/osfile.jsm", {});

const extensionDataDirName = "HttpReplay";
const extensionDataDirPath = OS.Path.join(OS.Constants.Path.profileDir, extensionDataDirName);
const observationsDirName  = "obs";
const observationsDirPath  = OS.Path.join(extensionDataDirPath, observationsDirName);

exports.extensionDataDirPath = extensionDataDirPath;
exports.observationsDirPath = observationsDirPath;
