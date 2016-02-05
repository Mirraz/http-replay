const {Recorder} = require("./recorder");
var recorder = new Recorder();
const {Replayer} = require("./replayer");

// ui

var self = require("sdk/self");
var { ToggleButton } = require("sdk/ui/button/toggle");
var { Panel } = require("sdk/panel");
var { Sidebar } = require("sdk/ui/sidebar");

var button = ToggleButton({
	id: "http-replay",
	label: "Http Replay",
	icon: {
		"16": "./icon-16.png",
		"32": "./icon-32.png",
		"64": "./icon-64.png"
	},
	onChange: function(state) {
		if (state.checked) panel.show({position: button});
	}
});

var panel = Panel({
	contentURL: self.data.url("panel.html"),
	contentScriptFile: self.data.url("panel.js"),
	onHide: function () {
		button.state('window', {checked: false});
	}
});

var sidebar = require("sdk/ui/sidebar").Sidebar({
	id: "http-replay",
	title: "Http Replay",
	url: self.data.url("sidebar.html"),
	onReady: function (worker) {
		Replayer.getObservations()
			.catch( () => {} ) // TODO [1]
			.then( ids =>
				ids.map( id => {
					return {"id": id, "text": id};
				})
			)
			.then( itemsData => {
				worker.port.emit("sidebar-onload", itemsData)
			})
			.catch( e => {console.error(e)} ); // TODO [1]
		worker.port.on("sidebar-item-click", function(id) {
			Replayer.playObservation(id)
				.then( () => null ); // TODO
		});
	}
});

panel.port.on("panel-onload", function(clientSizes) {
	panel.resize(clientSizes.width, clientSizes.height);
});

panel.port.on("panel-click-record", function() {
	recorder.start();
});

panel.port.on("panel-click-stop", function() {
	recorder.stop(); // TODO onDonePromise
});

panel.port.on("panel-click-choose-replay", function() {
	sidebar.show();
	panel.hide();
});

