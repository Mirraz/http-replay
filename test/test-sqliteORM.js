const SdkTest = require("sdk/test");
const {makeOrmPreset, executeOrmObj} = require("../lib/sqliteORM");
const {Cu} = require("chrome");
const {OS} = Cu.import("resource://gre/modules/osfile.jsm", {});
//const {Sqlite} = Cu.import("resource://gre/modules/Sqlite.jsm");
const {Sqlite} = require("../lib/sqlite");

const dbName = "test_storage.sqlite";
const dbPath = OS.Path.join(OS.Constants.Path.profileDir, dbName);

var dbConnPromise = OS.File.exists(dbPath)
	.then( dbFileExists => (dbFileExists ? OS.File.remove(dbPath) : undefined) )
	.then( () => Sqlite.openConnection({path: dbName}) );

function testOnDone(done) {
	--testCount;
	if (testCount === 0) {
		suiteOnDone(done);
	} else {
		if (testCount < 0) console.error("negative testCount");
		done();
	}
}

function suiteOnDone(done) {
	dbConnPromise
		.then( dbConn => dbConn.close())
		.catch( e => {console.error(e)} )
		.then( () => {done()} );
}

function dbConnTestRun(assert, done, run) {
	dbConnPromise
		.then( dbConn => run(dbConn) )
		.catch( e => {assert.ok(false, e)} )
		.then( () => {testOnDone(done)});
}

////////////////

function testSingleTable(assert, done) {
	const preset = makeOrmPreset({
		"table": {insert: ["value"]}
	});
	const valueStr = "qwerty";
	dbConnTestRun(assert, done, function(dbConn) {
		return dbConn.executeTransaction(function*(conn) {
				yield conn.execute('DROP TABLE IF EXISTS "table"');
				yield conn.execute(
					'CREATE TABLE "table" (' +
						'"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL' + ', ' +
						'"value" TEXT' +
					')'
				);
			})
			.then( () => executeOrmObj(
				dbConn,
				preset,
				{
					"table": {value: valueStr}
				}
			))
			.then(
				rowId => dbConn.execute('SELECT "id" FROM "table" WHERE "value" = :value', {value: valueStr})
					.then( rows => {
						assert.ok(rows.length === 1, "rows.length");
						assert.ok(rows[0].getResultByName("id") === rowId, "row.id");
					})
			);
	});
}

function arrayEquals(firstArray, secondArray) {
	return	(
		firstArray.length === secondArray.length &&
		firstArray.every( (element, index) => element === secondArray[index] )
	);
}

function testAllDatatypes(assert, done) {
	const preset = makeOrmPreset({
		"table": {insert: ["nuller", "id", "string", "blober", "number", "booler"]}
	});
	const nullValue = null;
	const intValue = 12345;
	const strValue = "qwerty";
	const blobValue = new Array(256*4).fill(undefined).map( (value, index) => index % 256 );
	const floatValue = 3.14159265359;
	const boolValue = true;
	dbConnTestRun(assert, done, function(dbConn) {
		return dbConn.executeTransaction(function*(conn) {
				yield conn.execute('DROP TABLE IF EXISTS "table"');
				yield conn.execute(
					'CREATE TABLE "table" ('+
						'"nuller" NULL' + ', ' +
						'"id" INTEGER NOT NULL' + ', ' +
						'"string" TEXT NOT NULL' + ', ' +
						'"blober" BLOB NOT NULL' + ', ' +
						'"number" REAL NOT NULL' + ', ' +
						'"booler" BOOLEAN NOT NULL' +
					')'
				);
			})
			.then( () => executeOrmObj(
				dbConn,
				preset,
				{
					"table": {
						nuller: nullValue,
						id:     intValue,
						string: strValue,
						blober: blobValue,
						number: floatValue,
						booler: boolValue
					}
				}
			))
			.then(
				rowId => dbConn.execute('SELECT * FROM "table"')
					.then( rows => {
						assert.ok(rows.length === 1, "rows.length");
						let row = rows[0];
						assert.ok(row.getResultByName("nuller") === nullValue,  "null");
						assert.ok(row.getResultByName("id")     === intValue,   "integer");
						assert.ok(row.getResultByName("string") === strValue,   "string");
						assert.ok(
							(
								Array.isArray(row.getResultByName("blober")) &&
								arrayEquals(row.getResultByName("blober"), blobValue)
							),
							"blob"
						);
						assert.ok(row.getResultByName("number") === floatValue, "float");
						assert.ok(Boolean(row.getResultByName("booler")) === boolValue, "bool");
					})
			);
	});
}

function testEmptyTable(assert, done) {
	const preset = makeOrmPreset({
		"table": {insert: []}
	});
	dbConnTestRun(assert, done, function(dbConn) {
		return dbConn.executeTransaction(function*(conn) {
				yield conn.execute('DROP TABLE IF EXISTS "table"');
				yield conn.execute(
					'CREATE TABLE "table" (' +
						'"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL' +
					')'
				);
			})
			.then( () => executeOrmObj(
				dbConn,
				preset,
				{
					"table": {}
				}
			))
			.then(
				id => dbConn.execute('SELECT "id" FROM "table"')
					.then( rows => {
						assert.ok(rows.length === 1, "rows.length");
						assert.ok(rows[0].getResultByName("id") === id, "row.id");
					})
					.then( () => executeOrmObj(
						dbConn,
						preset,
						{
							"table": {}
						}
					))
					.then( id02 => {
						assert.ok(id !== id02, "unique ids");
						return dbConn.execute('SELECT "id" FROM "table"')
							.then( rows => {
								assert.ok(rows.length === 2, "rows.length second time");
								let ids = rows.map( row => row.getResultByName("id") );
								assert.ok(ids.includes(id  ), "id01");
								assert.ok(ids.includes(id02), "id02");
							});
					})
			);
	});
}

function testNestedTables(assert, done) {
	const preset = makeOrmPreset({
		"table01": {insert: ["value"]},
		"table02": {insert: ["table01_id", "value"]},
	});
	const table01ValueStr = "qwerty";
	const table02ValueStr = "asdfgh";
	dbConnTestRun(assert, done, function(dbConn) {
		return dbConn.executeTransaction(function*(conn) {
				yield conn.execute('DROP TABLE IF EXISTS "table01"');
				yield conn.execute('DROP TABLE IF EXISTS "table02"');
				yield conn.execute('PRAGMA foreign_keys = ON');
				yield conn.execute(
					'CREATE TABLE "table01" (' +
						'"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL' + ', ' +
						'"value" TEXT' +
					')'
				);
				yield conn.execute(
					'CREATE TABLE "table02" (' +
						'"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL' + ', ' +
						'"table01_id" INTEGER NOT NULL' + ', ' +
						'"value" TEXT' + ', ' +
						'FOREIGN KEY("table01_id") REFERENCES "table01"("id")' +
					')'
				);
			})
			.then( () => executeOrmObj(
				dbConn,
				preset,
				{
					"table02": {
						table01_id: {
							"table01": {
								value: table01ValueStr
							}
						},
						value: table02ValueStr
					}
				}
			))
			.then(
				table02Id => dbConn.execute('SELECT "id", "table01_id" FROM "table02" WHERE "value" = :value', {value: table02ValueStr})
					.then( rows => {
						assert.ok(rows.length === 1, "table02.rows.length");
						let row = rows[0];
						assert.ok(row.getResultByName("id") === table02Id, "table02.row.id");
						let table01Id = row.getResultByName("table01_id");
						return dbConn.execute('SELECT "value" FROM "table01" WHERE "id" = :id', {id: table01Id})
					})
			)
			.then( rows => {
				assert.ok(rows.length === 1, "table01.rows.length");
				let row = rows[0];
				assert.ok(row.getResultByName("value") === table01ValueStr, "table01.row.value");
			});
	});
}

function testEnumTable(assert, done) {
	const preset = makeOrmPreset({
		"table": {"enum": {id: "id", value: "value"}},
	});
	const tableValueStr = "qwerty";
	const tableValue02Str = "asdfgh";
	dbConnTestRun(assert, done, function(dbConn) {
		return dbConn.executeTransaction(function*(conn) {
				yield conn.execute('DROP TABLE IF EXISTS "table"');
				yield conn.execute(
					'CREATE TABLE "table" (' +
						'"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL' + ', ' +
						'"value" TEXT NOT NULL UNIQUE' +
					')'
				);
			})
			.then( () => executeOrmObj(
				dbConn,
				preset,
				{
					"table": {
						value: tableValueStr
					}
				}
			))
			.then(
				id => executeOrmObj(
					dbConn,
					preset,
					{
						"table": {
							value: tableValueStr
						}
					}
				)
				.then( idFirst => {
					assert.ok(id === idFirst, "enum is found first time");
				})
				.then( () => executeOrmObj(
					dbConn,
					preset,
					{
						"table": {
							value: tableValue02Str
						}
					}
				))
				.then( id02 => {assert.ok(id !== id02, "unique enum")} )
				.then( () => executeOrmObj(
					dbConn,
					preset,
					{
						"table": {
							value: tableValueStr
						}
					}
				))
				.then( idSecond => {
					assert.ok(id === idSecond, "enum is found second time");
				})
			);
	});
}

function testCallbackValue(assert, done) {
	const preset = makeOrmPreset({
		"table": {insert: ["value"]}
	});
	const valueStr = "qwerty";
	dbConnTestRun(assert, done, function(dbConn) {
		return dbConn.executeTransaction(function*(conn) {
				yield conn.execute('DROP TABLE IF EXISTS "table"');
				yield conn.execute(
					'CREATE TABLE "table" (' +
						'"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL' + ', ' +
						'"value" TEXT' +
					')'
				);
			})
			.then( () => executeOrmObj(
				dbConn,
				preset,
				{
					"table": {
						value: function() {
							return Promise.resolve(valueStr);
						}
					}
				}
			))
			.then(
				rowId => dbConn.execute('SELECT "id" FROM "table" WHERE "value" = :value', {value: valueStr})
					.then( rows => {
						assert.ok(rows.length === 1, "rows.length");
						assert.ok(rows[0].getResultByName("id") === rowId, "row.id");
					})
			);
	});
}

function testCallbackSubExecution(assert, done) {
	const preset = makeOrmPreset({
		"table01": {insert: ["value"]},
		"table02": {insert: ["table01_id", "value"]},
	});
	const table01ValueStr = "qwerty";
	const table02ValueStr = "asdfgh";
	dbConnTestRun(assert, done, function(dbConn) {
		return dbConn.executeTransaction(function*(conn) {
				yield conn.execute('DROP TABLE IF EXISTS "table01"');
				yield conn.execute('DROP TABLE IF EXISTS "table02"');
				yield conn.execute('PRAGMA foreign_keys = ON');
				yield conn.execute(
					'CREATE TABLE "table01" (' +
						'"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL' + ', ' +
						'"value" TEXT' +
					')'
				);
				yield conn.execute(
					'CREATE TABLE "table02" (' +
						'"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL' + ', ' +
						'"table01_id" INTEGER NOT NULL' + ', ' +
						'"value" TEXT' + ', ' +
						'FOREIGN KEY("table01_id") REFERENCES "table01"("id")' +
					')'
				);
			})
			.then( () => executeOrmObj(
				dbConn,
				preset,
				{
					"table02": {
						table01_id: function(executor) {
							return executor.execute({
								"table01": {
									value: table01ValueStr
								}
							});
						},
						value: table02ValueStr
					}
				}
			))
			.then(
				table02Id => dbConn.execute('SELECT "id", "table01_id" FROM "table02" WHERE "value" = :value', {value: table02ValueStr})
					.then( rows => {
						assert.ok(rows.length === 1, "table02.rows.length");
						let row = rows[0];
						assert.ok(row.getResultByName("id") === table02Id, "table02.row.id");
						let table01Id = row.getResultByName("table01_id");
						return dbConn.execute('SELECT "value" FROM "table01" WHERE "id" = :id', {id: table01Id})
					})
			)
			.then( rows => {
				assert.ok(rows.length === 1, "table01.rows.length");
				let row = rows[0];
				assert.ok(row.getResultByName("value") === table01ValueStr, "table01.row.value");
			});
	});
}

function arrayContentsEquals(firstArray, secondArray) {
	if (firstArray.length !== secondArray.length) return false;
	let firstArraySorted = firstArray.slice();
	firstArraySorted.sort();
	let secondArraySorted = secondArray.slice();
	secondArraySorted.sort();
	return arrayEquals(firstArraySorted, secondArraySorted);
}

function testCallbackSidePromise(assert, done) {
	const preset = makeOrmPreset({
		"main": {insert: ["value", "list_id"]},
		"lists": {insert: []},
		"lists_to_entries": {insert: ["list_id", "entry_id"]},
		"entries": {insert: ["value"]},
	});
	const mainValueStr = "qwerty";
	const entryValueStrArr = [
		"qwer",
		"wert",
		"erty",
		"rtyu",
	];
	dbConnTestRun(assert, done, function(dbConn) {
		return dbConn.executeTransaction(function*(conn) {
				yield conn.execute('DROP TABLE IF EXISTS "main"');
				yield conn.execute('DROP TABLE IF EXISTS "lists"');
				yield conn.execute('DROP TABLE IF EXISTS "lists_to_entries"');
				yield conn.execute('DROP TABLE IF EXISTS "entries"');
				yield conn.execute('PRAGMA foreign_keys = ON');
				yield conn.execute(
					'CREATE TABLE "main" (' +
						'"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL' + ', ' +
						'"value" TEXT' + ', ' +
						'"list_id" INTEGER NOT NULL' + ', ' +
						'FOREIGN KEY("list_id") REFERENCES "lists"("id")' +
					')'
				);
				yield conn.execute(
					'CREATE TABLE "lists" (' +
						'"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL' +
					')'
				);
				yield conn.execute(
					'CREATE TABLE "lists_to_entries" (' +
						'"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL' + ', ' +
						'"list_id" INTEGER NOT NULL' + ', ' +
						'"entry_id" INTEGER NOT NULL' + ', ' +
						'FOREIGN KEY("list_id") REFERENCES "lists"("id")' + ', ' +
						'FOREIGN KEY("entry_id") REFERENCES "entries"("id")' +
					')'
				);
				yield conn.execute(
					'CREATE TABLE "entries" (' +
						'"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL' + ', ' +
						'"value" TEXT' +
					')'
				);
			})
			.then(
				() => executeOrmObj(
					dbConn,
					preset,
					{
						"main": {
							value: mainValueStr,
							list_id: function(executor) {
								let listIdPromise = executor.execute({"lists": {}});
								executor.addSidePromise(
									"rels",
									listIdPromise
										.then(
											listId => Promise.all(
												entryValueStrArr.map(
													entryValueStr => executor.execute({
														"lists_to_entries": {
															list_id: listId,
															entry_id: {
																"entries": {
																	value: entryValueStr
																}
															}
														}
													})
												)
											)
										)
								);
								return listIdPromise;
							}
						}
					}
				)
			)
			.then( results => {
				assert.ok(results.length === 2, "execution result");
				let mainId = results[0];
				let subResults = results[1];
				assert.ok(typeof subResults === "object" && subResults !== null, "subResults is a map");
				assert.ok(arrayEquals(["rels"], Object.keys(subResults)), "subResults keys");
				let relIds = subResults["rels"];
				return dbConn.execute('SELECT "id", "value", "list_id" FROM "main"')
					.then( rows => {
						assert.ok(rows.length === 1, "main.rows.count");
						let row = rows[0];
						assert.ok(row.getResultByName("id") === mainId, "main.id");
						assert.ok(row.getResultByName("value") === mainValueStr, "main.value");
						return row.getResultByName("list_id");
					})
					.then(
						listId => dbConn.execute('SELECT * FROM "lists_to_entries"')
							.then( rows => {
								assert.ok(rows.length === entryValueStrArr.length, "lists_to_entries.rows.count");
								assert.ok(
									rows.map( row => row.getResultByName("list_id") ).every( val => val === listId ),
									"lists_to_entries.rows.list_id"
								);
								assert.ok(
									arrayContentsEquals(relIds, rows.map( row => row.getResultByName("id") )),
									"lists_to_entries.rows.id"
								);
								return rows.map( row => row.getResultByName("entry_id") );
							})
							.then(
								entryIds => dbConn.execute('SELECT * FROM "entries"')
									.then( rows => {
										assert.ok(rows.length === entryValueStrArr.length, "entries.rows.count");
										assert.ok(
											arrayContentsEquals(entryIds, rows.map( row => row.getResultByName("id") )),
											"entries.rows.id"
										);
										assert.ok(
											arrayContentsEquals(entryValueStrArr, rows.map( row => row.getResultByName("value") )),
											"entries.rows.value"
										);
									})
							)
					)
			});
	});
}

exports["test single table"] = testSingleTable;
exports["test all datatypes"] = testAllDatatypes;
exports["test empty table"] = testEmptyTable;
exports["test nested tables"] = testNestedTables;
exports["test enum table"] = testEnumTable;
exports["test callback value"] = testCallbackValue;
exports["test callback sub execution"] = testCallbackSubExecution;
exports["test callback side promise"] = testCallbackSidePromise;

////////////////

var testCount = Object.keys(exports).filter( key => key.indexOf("test") === 0 ).length;

SdkTest.run(exports);

