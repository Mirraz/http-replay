const {Cu} = require("chrome");
const {OS} = Cu.import("resource://gre/modules/osfile.jsm", {});

const extensionDataDirName = "HttpReplay";
const extensionDataPath = OS.Path.join(OS.Constants.Path.profileDir, extensionDataDirName);

exports.extensionDataPath = extensionDataPath;

