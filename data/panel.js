document.getElementById("record").onclick = function(event) {
	document.getElementById("record").style.display = "none";
	document.getElementById("stop"  ).style.display = "block";
	self.port.emit("panel-click-record");
}

document.getElementById("stop").onclick = function(event) {
	document.getElementById("record").style.display = "block";
	document.getElementById("stop"  ).style.display = "none";
	self.port.emit("panel-click-stop");
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

