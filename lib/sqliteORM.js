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
		"valueColName": valueColName,
		selectSql: 'SELECT "' + idColName + '" FROM "' + tableName + '" WHERE "' + valueColName + '" = :' + valueColName,
		insertSql: 'INSERT INTO "' + tableName + '" ("' + valueColName + '") VALUES (:' + valueColName + ')',
	};
}

// returns: promise
function obtainEnumIdWithConn(dbConn, preset, value) {
	return dbConn.executeTransaction(function*(conn) {
		let params = {};
		params[preset.valueColName] = value;
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
function makeOrmPreset(config) {
	var preset = {};
	for (table in config) {
		let tablePresetConfig = config[table];
		if (Object.keys(tablePresetConfig).length !== 1) throw Error("Not a single preset for table '" + table + "'");
		let type = Object.keys(tablePresetConfig)[0];
		let tablePresetConfigValue = tablePresetConfig[type];
		if (type === "insert") {
			if (!Array.isArray(tablePresetConfigValue)) throw Error();
			let sql = (
				tablePresetConfigValue.length === 0 ?
				'INSERT INTO "' + table + '" DEFAULT VALUES' :
				makeInsertSql(table, tablePresetConfigValue)
			);
			preset[table] = {insert: sql};
		} else { // TODO
			throw Error("Unsupported table '" + table + "' preset type");
		}
	}
	return preset;
}

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

INSERT INTO "table01" DEFAULT VALUES
{
	table01: {}
}

{
	table01: [
		{col01: value01, col02: value11},
		{col01: value02, col02: value12},
		{col01: value03, col02: value13}
	]
}

{
	table01: {
		col01: function() {
			return Promise.resolve(something);
		}
	}
}

{
	table01: {
		col01: function(execute) {
			return execute({...});
		}
	}
}

{
	table01: {
		col01: function(execute, addSidePromise) {
			addSidePromise(execute({...}));
			return execute({...});
		}
	}
}

*/
function executeOrmObj(dbConn, preset, obj) {
	return new OOExecution(dbConn, preset).execute(obj);
}

function OOExecution(dbConn, preset) {
	this.dbConn = dbConn;
	this.preset = preset;
}
OOExecution.prototype = {
	execute: function(obj) {
		if (!(Object.keys(obj).length === 1)) throw Error("Not a single table");
		let table = Object.keys(obj)[0];
		let params = obj[table];
		if (!(table in this.preset)) throw Error("Not preset for table '" + table + "'");
		let tablePreset = this.preset[table];
		if (!(Object.keys(tablePreset).length === 1)) throw Error("Table '" + table + "' preset has not single type");
		let tablePresetType = Object.keys(tablePreset)[0];
		let tablePresetValue = tablePreset[tablePresetType];
		if (tablePresetType === "insert") {
			let paramsType = (params === null ? "null" : typeof params);
			if (paramsType === "object") {
				let primitives = {};
				let childs = {};
				for (let name in params) {
					let value = params[name];
					let valueType = (value === null ? "null" : typeof value);
					if (["null", "boolean", "number", "string"].includes(valueType) || Array.isArray(value)) {
						primitives[name] = value;
					} else if (valueType === "object") {
						childs[name] = value;
					} else {
						throw Error("Unsupported table '" + table + "' param '" + name + "' value type");
					}
				}
				if (Object.keys(childs).length === 0) {
					return insertAndGetId(this.dbConn, tablePresetValue, primitives);
				} else {
					let names = Object.keys(childs);
					return Promise.all(
						names.map( name => this.execute(childs[name]) )
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
						return insertAndGetId(this.dbConn, tablePresetValue, resParams);
					});
				}
			} else { // TODO
				throw Error("Unsupported table '" + table + "' params");
			}
		} else { // TODO
			throw Error("Unsupported table '" + table + "' preset type");
		}
	},
};

exports.cloneReplace = cloneReplace;
exports.makeOrmPreset = makeOrmPreset;
exports.executeOrmObj = executeOrmObj;

