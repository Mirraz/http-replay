document.getElementById("record").onclick = function(event) {
	self.port.emit("panel-click-record");
}

document.getElementById("replay").onclick = function(event) {
	self.port.emit("panel-click-choose-replay");
}

self.port.emit(
	"panel-onload",
	{
		width:  document.documentElement.clientWidth,
		height: document.documentElement.clientHeight
	}
);

