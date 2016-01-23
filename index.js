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
		worker.port.emit(
			"sidebar-onload",
			[
				{id: "item01", text: "Item 01"},
				{id: "item02", text: "Item 02"}
			]
		);
		worker.port.on("sidebar-item-click", function(id) {
			console.log("sidebar-item-click: " + id);
		});
	}
});

panel.port.on("panel-onload", function (clientSizes) {
	panel.resize(clientSizes.width, clientSizes.height);
});

panel.port.on("panel-click-record", function () {
	console.log("panel-click-record");
});

panel.port.on("panel-click-choose-replay", function () {
	sidebar.show();
	panel.hide();
});

