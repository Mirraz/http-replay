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

function* insertAndGetId(dbConn, insertSql, params) {
	try {
		yield dbConn.executeCached(insertSql, params);
		let rows = yield dbConn.executeCached(SelectLastInsertRowidSql);
		return rows[0].getResultByIndex(0);
	} catch(e) {
		console.error(
			"(insertAndGetId)" + " " +
			"error = '" + e + "'" + " " +
			"insertSql = '" + insertSql + "'" + " " +
			"params = " + JSON.stringify(params)
		);
		throw e;
	}
}

function makeEnumPreset(tableName, idColName, valueColName) {
	return {
		"idColName": idColName,
		selectSql: 'SELECT "' + idColName + '" FROM "' + tableName + '" WHERE "' + valueColName + '" = :' + valueColName,
		insertSql: 'INSERT INTO "' + tableName + '" ("' + valueColName + '") VALUES (:' + valueColName + ')',
	};
}

function* obtainEnumId(dbConn, preset, params) {
	try {
		let selectRows = yield dbConn.executeCached(preset.selectSql, params);
		if (selectRows.length !== 0) {
			return selectRows[0].getResultByName(preset.idColName);
		} else {
			yield dbConn.execute(preset.insertSql, params);
			let insertRows = yield dbConn.executeCached(SelectLastInsertRowidSql);
			return insertRows[0].getResultByIndex(0);
		}
	} catch(e) {
		console.error(
			"(obtainEnumId)" + " " +
			"error = '" + e + "'" + " " +
			"preset = " + JSON.stringify(preset) + " " +
			"params = " + JSON.stringify(params)
		);
		throw e;
	}
}

////////////////

function makeTablePreset(table, type, configValue) {
	if (type === "insert") {
		if (!Array.isArray(configValue)) throw Error("Wrong table '" + table + "' preset value");
		let sql = (
			configValue.length === 0 ?
			'INSERT INTO "' + table + '" DEFAULT VALUES' :
			makeInsertSql(table, configValue)
		);
		return function*(dbConn, params) {
			return yield* insertAndGetId(dbConn, sql, params);
		};
	} else if (type === "enum") {
		if (!(typeof configValue === "object" && configValue !== null))
			throw Error("Wrong table '" + table + "' preset value");
		if (!(("id" in configValue) && ("value" in configValue)))
			throw Error("Missing param for enum table '" + table + "'");
		let idColName = configValue["id"];
		let valueColName = configValue["value"];
		let enumTablePreset = makeEnumPreset(table, idColName, valueColName);
		return function*(dbConn, params) {
			return yield* obtainEnumId(dbConn, enumTablePreset, params);
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
	for (let table in config) {
		let tablePresetConfig = config[table];
		if (Object.keys(tablePresetConfig).length !== 1) throw Error("Not a single preset for table '" + table + "'");
		let type = Object.keys(tablePresetConfig)[0];
		let configValue = tablePresetConfig[type];
		preset[table] = makeTablePreset(table, type, configValue);
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
	executeTable: function*(dbConn, table, params) {
		 return yield* this.tablePresets[table](dbConn, params);
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
		col01: function*() {
			yield some_promise;
			return some_id;
		}
	}
}

{
	table01: {
		col01: function*(executor) {
			return yield* executor.execute({...});
		}
	}
}

{
	table01: {
		col01: function*(executor) {
			let id = yield* executor.execute({...});
			executor.addSubExecutionResult(yield* executor.execute({...}));
			return id;
		}
	}
}

*/
function OOExecution(dbConn, ooPreset) {
	this.dbConn = dbConn;
	this.ooPreset = ooPreset;
	let self = this;
	this.subExecutor = {
		execute: function*(obj) {
			return yield* self.executeInternal(obj);
		},
		addSubExecutionResult: function(key, value) {
			self.subExecutionResults[key] = value;
		},
	};
}
OOExecution.prototype = {
	subExecutionResults: null,
	
	presetExists: function(table) {
		 return this.ooPreset.exists(table);
	},
	
	executeTable: function*(table, params) {
		return yield* this.ooPreset.executeTable(this.dbConn, table, params);
	},
	
	executeInternal: function*(obj) {
		if (!(Object.keys(obj).length === 1)) throw Error("Not a single table");
		let table = Object.keys(obj)[0];
		let params = obj[table];
		if (!(typeof params === "object" && params !== null)) throw Error("Wrong table '" + table + "' params");
		
		if (!this.presetExists(table)) throw Error("Not preset for table '" + table + "'");
		
		let resParams = {};
		for (let name in params) {
			let value = params[name];
			let valueType = (value === null ? "null" : typeof value);
			let resValue;
			if (["null", "boolean", "number", "string"].includes(valueType) || Array.isArray(value)) {
				resValue = value;
			} else if (valueType === "object") {
				resValue = yield* this.executeInternal(value);
			} else if (valueType === "function" && value.constructor.name === "GeneratorFunction") {
				resValue = yield* value(this.subExecutor);
			} else {
				throw Error("Unsupported table '" + table + "' param '" + name + "' value type");
			}
			resParams[name] = resValue;
		}
		
		return yield* this.executeTable(table, resParams);
	},

	execute: function(obj) {
		this.subExecutionResults = {};
		let self = this;
		return this.dbConn.executeTransaction(
			function*(conn) {
				if (self.dbConn !== conn) throw Error("transaction conn != dbConn");
				return yield* self.executeInternal(obj);
			}
		)
		.then( id => {
			if (Object.keys(this.subExecutionResults).length === 0) {
				return id;
			} else {
				return [id, this.subExecutionResults];
			}
		});
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

