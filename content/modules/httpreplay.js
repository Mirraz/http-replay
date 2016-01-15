var EXPORTED_SYMBOLS = ["HttpReplay"];

Components.utils.import("chrome://httpreplay/content/modules/common.js");

function HttpReplay() {};
HttpReplay.prototype = {
	start: function() {
		console.log("starting");
		try {
			//Components.utils.import("chrome://httpreplay/content/modules/recorder.js");
			//this.recorder = new Recorder();
			//this.recorder.start();
			
			Components.utils.import("chrome://httpreplay/content/modules/replayer.js");
			this.replayer = new Replayer();
			this.replayer.start("1449374400000");
		} catch(e) {
			console.error(e);
		}
		console.log("started");
	},
	stop: function () {
		console.log("stopping");
		//this.recorder.stop();
		this.replayer.stop();
		console.log("stoped");
	},
};

