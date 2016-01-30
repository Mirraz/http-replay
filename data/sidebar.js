function listItemOnclick() {
	addon.port.emit("sidebar-item-click", this.getAttribute("id"));
}

addon.port.on("sidebar-onload", function(itemsData) {
	let listNode = document.getElementById("list");
	itemsData.forEach( itemData => {
		let node = document.createElement("div");
		node.setAttribute("class", "list-item");
		node.setAttribute("id", itemData.id);
		node.addEventListener("click", listItemOnclick.bind(node));
		let textnode = document.createTextNode(itemData.text);
		node.appendChild(textnode);
		listNode.appendChild(node);
	});
});

