"""Whole-statement and exact witness-allowance negative controls."""
import importlib.util
from pathlib import Path
import unittest
from content_revision_sql import migration
from sql_statements import statements, canonical

spec = importlib.util.spec_from_file_location('migration_check', Path(__file__).with_name('migration-check.py'))
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)


class Statements(unittest.TestCase):
    def test_quotes_comments_crlf_case_and_trigger_body(self):
        sql = "CREATE TRIGGER x AFTER INSERT ON a BEGIN\r\nSELECT CASE WHEN 1 THEN 'END;  x' ELSE 'a'';b' END; /* ; */ SELECT 2; END; -- ;\r\nSELECT 3;"
        parts = statements(sql)
        self.assertEqual(len(parts), 2)
        self.assertIn("'END;  x'", parts[0])
        self.assertIn("'a'';b'", parts[0])
        self.assertEqual(parts[1], 'SELECT 3')
        self.assertEqual(len(statements('SELECT 1/* outer /* inner; */ end */;SELECT "a;b";')), 2)

    def test_dollar_quotes(self):
        for tag in ['$$', '$fixed_tag$']:
            sql = f"CREATE FUNCTION f() RETURNS void AS {tag} BEGIN PERFORM 'a;  b'; END; {tag} LANGUAGE plpgsql; SELECT 1;"
            self.assertEqual(len(statements(sql)), 2)
            self.assertIn("'a;  b'", statements(sql)[0])

    def test_unterminated(self):
        for sql in ["SELECT 'x", 'SELECT "x', '/* x', 'SELECT $tag$x', 'CREATE TRIGGER x AFTER INSERT ON a BEGIN SELECT 1;']:
            with self.assertRaises(ValueError):
                statements(sql)

    def test_inventory_and_narrow_bodies(self):
        for dialect in ['cf', 'pg']:
            good = migration(dialect)
            label = check.CF_DIR if dialect == 'cf' else 'server migrations'
            known = {'live','items','site_fields','site_embed_sources','site_stream_settings','private_approvals','training_approvals','themes','share_cards','media'}
            def errors(parts):
                return check.check_list(label, [('witness', ';\n'.join(parts)+';')], known)
            self.assertEqual(errors(good), [])
            for altered in [good[:-2]+good[-1:], [good[-1],*good[:-1]], good+[good[1]],
                            [x.replace('content_revision__live__', 'other__live__') for x in good],
                            [x.replace('AFTER INSERT ON live','AFTER DELETE ON owner') for x in good] if dialect=='cf' else [x.replace('ON live','ON owner') for x in good],
                            [x.replace('THEN prior.n + 1','THEN 0').replace('THEN content_revision.n + 1','THEN 0') for x in good],
                            [x.replace('prior.n >= 0','1 = 1').replace("typeof(content_revision.n) = 'integer'",'1 = 1') for x in good],
                            good+['UPDATE owner SET name = \'changed\''],
                            [x.replace('RETURN NULL;', 'DELETE FROM owner; RETURN NULL;') for x in good] if dialect=='pg' else [x.replace('INSERT INTO content_revision (id,epoch,n)', 'DELETE FROM owner; INSERT INTO content_revision (id,epoch,n)') for x in good]]:
                self.assertTrue(errors(altered), (dialect, altered))
            # A forged trigger cannot be accepted as a header followed by
            # individually allowed writes to a same-migration table.
            forged = ['CREATE TABLE scratch(id INTEGER)', "CREATE TRIGGER content_revision__live__ai AFTER INSERT ON live BEGIN INSERT INTO scratch VALUES(1); DELETE FROM owner; END"]
            self.assertTrue(errors(forged))

    def test_literal_case_and_whitespace_are_not_erased(self):
        self.assertNotEqual(canonical("SELECT 'a  b'"), canonical("SELECT 'a b'"))
        self.assertNotEqual(canonical("SELECT 'secret'"), canonical("SELECT 'SECRET'"))


if __name__ == '__main__':
    unittest.main()
