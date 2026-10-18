import {test} from 'node:test';
import assert from 'node:assert/strict';
import {statements} from './sql-statements.mjs';
test('keeps complete trigger bodies, CASE END, quoted values and structural CRLF', () => {
  const sql = "CREATE TRIGGER t AFTER INSERT ON live BEGIN\r\n UPDATE witness SET n=n+1; SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'not;  complete') END; END;\r\nINSERT INTO witness VALUES(1,0);";
  const parts = statements(sql); assert.equal(parts.length,2); assert(parts[0].endsWith('END')); assert(parts[0].includes("'not;  complete'")); assert.equal(parts[1],'INSERT INTO witness VALUES(1,0)');
});
test('comments and escaped quotes do not terminate a statement', () => {
  assert.deepEqual(statements("SELECT 'a'';b' /* outer /* ; */ end */; -- ;\nSELECT \"a;b\";"),["SELECT 'a'';b'",'SELECT "a;b"']);
  assert.deepEqual(statements("SELECT X'ff00';"),["SELECT X'ff00'"]);
});
test('refuses truncated bodies, strings and comments', () => {
  for(const sql of ["SELECT 'x",'/* x','CREATE TRIGGER t AFTER INSERT ON live BEGIN SELECT 1;']) assert.throws(()=>statements(sql),/unterminated/);
});
