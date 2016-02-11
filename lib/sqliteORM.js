//const {Cu} = require("chrome");
//const {Sqlite} = Cu.import("resource://gre/modules/Sqlite.jsm");
const {Sqlite} = require("./sqlite");

// remove: array of keys
// append: object
function cloneReplace(origObj, remove, append) {
	let cloneObj = {};
	Object.keys(origObj)
		.filter( key => !remove.includes(key) )
		.forEach( key => {cloneObj[key] = origObj[key]} );
	Object.keys(append)
		.forEach( key => {cloneObj[key] = append[key]} );
	return cloneObj;
};

////////////////

const SelectLastInsertRowidSql = 'SELECT last_insert_rowid()';

function makeInsertSql(tableName, columnNames) {
	return 'INSERT INTO "' + tableName + '" (' +
		columnNames.map( col => '"' + col + '"' ).join(', ') +
		') VALUES (' +
		columnNames.map( col => ":" + col ).join(', ') +
		')';
}

// returns: promise
function insertAndGetId(dbConn, insertSql, params) {
	return dbConn.executeTransaction(function*(conn) {
		yield conn.executeCached(insertSql, params);
		let rows = yield conn.executeCached(SelectLastInsertRowidSql);
		return rows[0].getResultByIndex(0);
	});
}

function makeEnumPreset(tableName, idColName, valueColName) {
	return {
		"idColName": idColName,
		selectSql: 'SELECT "' + idColName + '" FROM "' + tableName + '" WHERE "' + valueColName + '" = :' + valueColName,
		insertSql: 'INSERT INTO "' + tableName + '" ("' + valueColName + '") VALUES (:' + valueColName + ')',
	};
}

// returns: promise
function obtainEnumId(dbConn, preset, params) {
	return dbConn.executeTransaction(function*(conn) {
		let selectRows = yield dbConn.executeCached(preset.selectSql, params);
		if (selectRows.length !== 0) {
			return selectRows[0].getResultByName(preset.idColName);
		} else {
			yield dbConn.execute(preset.insertSql, params);
			let insertRows = yield conn.executeCached(SelectLastInsertRowidSql);
			return insertRows[0].getResultByIndex(0);
		}
	});
}

////////////////

function makeTablePreset(type, configValue) {
	if (type === "insert") {
		if (!Array.isArray(configValue)) throw Error("Wrong table '" + table + "' preset value");
		let sql = (
			configValue.length === 0 ?
			'INSERT INTO "' + table + '" DEFAULT VALUES' :
			makeInsertSql(table, configValue)
		);
		return function (dbConn, params) {
			return insertAndGetId(dbConn, sql, params);
		};
	} else if (type === "enum") {
		if (!(typeof configValue === "object" && configValue !== null))
			throw Error("Wrong table '" + table + "' preset value");
		if (!(("id" in configValue) && ("value" in configValue)))
			throw Error("Missing param for enum table '" + table + "'");
		let idColName = configValue["id"];
		let valueColName = configValue["value"];
		let enumTablePreset = makeEnumPreset(table, idColName, valueColName);
		return function (dbConn, params) {
			return obtainEnumId(dbConn, enumTablePreset, params);
		};
	} else {
		throw Error("Unsupported table '" + table + "' preset type");
	}
}

/*
{
	table01: {
		insert: ["col01", "col02", "col03"]
	},
	table02: {
		enum: {
			id: "id",
			value: "value"
		}
	},
	table03: {
		insert: []
	},
}

*/
function makePreset(config) {
	var preset = {};
	for (table in config) {
		let tablePresetConfig = config[table];
		if (Object.keys(tablePresetConfig).length !== 1) throw Error("Not a single preset for table '" + table + "'");
		let type = Object.keys(tablePresetConfig)[0];
		let configValue = tablePresetConfig[type];
		preset[table] = makeTablePreset(type, configValue);
	}
	return preset;
}

function OOPreset(config) {
	this.tablePresets = makePreset(config);
}
OOPreset.prototype = {
	exists: function(table) {
		return (table in this.tablePresets);
	},
	executeTable: function(dbConn, table, params) {
		 return this.tablePresets[table](dbConn, params);
	},
};

/*

{
	table01: {
		col01: value01,
		col02: value02
	}
}

{
	table01: {
		col01: value01,
		col02: [blob_value...]
	}
}

{
	table01: {
		col01: {
			table02 : {
				col11: value11,
				col12: valie12
			}
		}
	}
}

enum
{
	table01: {
		col01: value
	}
}

INSERT INTO "table01" DEFAULT VALUES
{
	table01: {}
}

{
	table01: {
		col01: function() {
			return Promise.resolve(some_id);
		}
	}
}

{
	table01: {
		col01: function(executor) {
			return executor.execute({...});
		}
	}
}

{
	table01: {
		col01: function(executor) {
			executor.addSidePromise(executor.execute({...}));
			return executor.execute({...});
		}
	}
}

*/
function OOExecution(dbConn, ooPreset) {
	this.dbConn = dbConn;
	this.ooPreset = ooPreset;
	let self = this;
	this.subExecutor = {
		execute: function(obj) {
			return self.executeInternal(obj);
		},
		addSidePromise: function(sidePromise) {
			self.sidePromises.push(sidePromise);
		},
	};
}
OOExecution.prototype = {
	sidePromises: null,
	
	presetExists: function(table) {
		 return this.ooPreset.exists(table);
	},
	
	executeTable: function(table, params) {
		return this.ooPreset.executeTable(this.dbConn, table, params);
	},
	
	executeInternal: function(obj) {
		if (!(Object.keys(obj).length === 1)) throw Error("Not a single table");
		let table = Object.keys(obj)[0];
		let params = obj[table];
		if (!(typeof params === "object" && params !== null)) throw Error("Wrong table '" + table + "' params");
		
		if (!this.presetExists(table)) throw Error("Not preset for table '" + table + "'");
		let execFunction = function(params) {
			return this.executeTable(table, params);
		}.bind(this);
		
		let primitives = {};
		let childs = {};
		for (let name in params) {
			let value = params[name];
			let valueType = (value === null ? "null" : typeof value);
			if (["null", "boolean", "number", "string"].includes(valueType) || Array.isArray(value)) {
				primitives[name] = value;
			} else if (valueType === "object") {
				childs[name] = value;
			} else { // TODO: function
				throw Error("Unsupported table '" + table + "' param '" + name + "' value type");
			}
		}
		if (Object.keys(childs).length === 0) {
			return execFunction(primitives);
		} else {
			let names = Object.keys(childs);
			return Promise.all(
				names.map( name => this.executeInternal(childs[name]) )
			)
			.then( results => {
				if (names.length !== results.length) throw Error("Prmise results number");
				let resParams = {};
				for (let name in primitives) resParams[name] = primitives[name];
				for(let i=0; i<names.length; ++i) {
					let name = names[i];
					let value = results[i];
					resParams[name] = value;
				}
				return execFunction(resParams);
			});
		}
	},

	execute: function(obj) {
		this.sidePromises = [];
		return this.executeInternal(obj);
	},
	
	getSidePromises: function() {
		return this.sidePromises;
	},
};

////////////////

exports.cloneReplace = cloneReplace;
exports.OOPreset = OOPreset;
exports.OOExecution = OOExecution;
exports.makeOrmPreset = function(config) {
	return new OOPreset(config);
}
exports.executeOrmObj = function(dbConn, ooPreset, obj) {
	return new OOExecution(dbConn, ooPreset).execute(obj);
}

