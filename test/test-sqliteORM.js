const SdkTest = require("sdk/test");
const {executeOrmObj, makeOrmPreset} = require("../lib/sqliteORM");
const {Cu} = require("chrome");
const {OS} = Cu.import("resource://gre/modules/osfile.jsm", {});
//const {Sqlite} = Cu.import("resource://gre/modules/Sqlite.jsm");
const {Sqlite} = require("../lib/sqlite");

Promise.prototype.finally = function(callback) {
	let p = this.constructor;
	return this.then(
		value  => p.resolve(callback()).then(() => value),
		reason => p.resolve(callback()).then(() => { throw reason })
	);
};

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
				yield dbConn.execute('DROP TABLE IF EXISTS "table"');
				yield dbConn.execute(
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
				rowId => dbConn.execute('SELECT id FROM "table" WHERE "value" = :value', {value: valueStr})
					.then( rows => {
						assert.ok(rows.length === 1, "rows.length");
						assert.ok(rows[0].getResultByName("id") === rowId, "row.id");
					})
			);
	});
}
exports["test single table"] = testSingleTable;

function testEmptyTable(assert, done) {
	const preset = makeOrmPreset({
		"table": {insert: []}
	});
	dbConnTestRun(assert, done, function(dbConn) {
		return dbConn.executeTransaction(function*(conn) {
				yield dbConn.execute('DROP TABLE IF EXISTS "table"');
				yield dbConn.execute(
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
exports["test empty table"] = testEmptyTable;

function testNestedTables(assert, done) {
	const preset = makeOrmPreset({
		"table01": {insert: ["value"]},
		"table02": {insert: ["table01_id", "value"]},
	});
	const table01ValueStr = "qwerty";
	const table02ValueStr = "asdfgh";
	dbConnTestRun(assert, done, function(dbConn) {
		return dbConn.executeTransaction(function*(conn) {
				yield dbConn.execute('DROP TABLE IF EXISTS "table01"');
				yield dbConn.execute('DROP TABLE IF EXISTS "table02"');
				yield dbConn.execute('PRAGMA foreign_keys = ON');
				yield dbConn.execute(
					'CREATE TABLE "table01" (' +
						'"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL' + ', ' +
						'"value" TEXT' +
					')'
				);
				yield dbConn.execute(
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
				table02Id => dbConn.execute('SELECT id, table01_id FROM "table02" WHERE "value" = :value', {value: table02ValueStr})
					.then( rows => {
						assert.ok(rows.length === 1, "table02.rows.length");
						let row = rows[0];
						assert.ok(row.getResultByName("id") === table02Id, "table02.row.id");
						let table01Id = row.getResultByName("table01_id");
						return dbConn.execute('SELECT value FROM "table01" WHERE "id" = :id', {id: table01Id})
					})
			)
			.then( rows => {
				assert.ok(rows.length === 1, "table01.rows.length");
				let row = rows[0];
				assert.ok(row.getResultByName("value") === table01ValueStr, "table01.row.value");
			});
	});
}
exports["test nested tables"] = testNestedTables;

function testEnumTable(assert, done) {
	const preset = makeOrmPreset({
		"table": {"enum": {id: "id", value: "value"}},
	});
	const tableValueStr = "qwerty";
	const tableValue02Str = "asdfgh";
	dbConnTestRun(assert, done, function(dbConn) {
		return dbConn.executeTransaction(function*(conn) {
				yield dbConn.execute('DROP TABLE IF EXISTS "table"');
				yield dbConn.execute(
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
exports["test enum table"] = testEnumTable;

////////////////

var testCount = Object.keys(exports).filter( key => key.indexOf("test") === 0 ).length;

SdkTest.run(exports);

