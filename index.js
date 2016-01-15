var httpReplay;

exports.main = function (options, callbacks) {
	let { Cc, Ci, Cu, CC } = require('chrome');
	Cu.import("chrome://httpreplay/content/modules/httpreplay.js");
	httpReplay = new HttpReplay();
	httpReplay.start();
};

exports.onUnload = function (reason) {
	httpReplay.stop();
	httpReplay = null;
};

