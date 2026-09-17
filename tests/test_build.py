import importlib.util
import pathlib
import tempfile
import json
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('build', ROOT / 'build.py')
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


class BuildTests(unittest.TestCase):
    def test_bad_profile_preserves_filesystem_and_seed(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            source = root / 'source'
            source.mkdir()
            old = root / 'fs' / 'book'
            old.parent.mkdir()
            old.write_text('old book')
            (root / 'seed.json').write_text('old seed')
            with patch.object(build, 'FSROOT', str(source)), patch.object(build, 'DIST', folder):
                self.assertEqual(build.copy_fs(), 1)
            self.assertEqual(old.read_text(), 'old book')
            self.assertEqual((root / 'seed.json').read_text(), 'old seed')

    def test_asset_urls_escape_fragments_and_percent(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            source = root / 'source'
            source.mkdir()
            (source / 'book #1%.epub').write_bytes(b'book')
            output = root / 'output'
            with patch.object(build, 'FSROOT', str(source)), patch.object(build, 'DIST', str(output)):
                self.assertEqual(build.copy_fs(full_fs=True), 0)
            entry = json.loads((output / 'manifest.json').read_text())['files'][0]
            self.assertEqual(entry['url'], 'fs/book%20%231%25.epub')
            self.assertEqual(entry['path'], '/fs_/book #1%.epub')

    def test_compiler_upgrade_invalidates_object_signature(self):
        with patch.object(build, 'compiler_identity', return_value='old compiler'):
            old = build.command_signature(['emcc', '-c', 'app.cpp'])
        with patch.object(build, 'compiler_identity', return_value='new compiler'):
            self.assertNotEqual(old, build.command_signature(['emcc', '-c', 'app.cpp']))

    def test_missing_fs_preserves_previous_output(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            old = root / 'fs' / 'book'
            old.parent.mkdir()
            old.write_text('book')
            with patch.object(build, 'FSROOT', str(root / 'missing')), patch.object(build, 'DIST', folder):
                self.assertEqual(build.copy_fs(), 1)
            self.assertEqual(old.read_text(), 'book')

    def test_link_ignores_orphaned_objects(self):
        with tempfile.TemporaryDirectory() as folder:
            objdir = pathlib.Path(folder) / 'x4'
            objdir.mkdir()
            (objdir / 'removed.o').write_bytes(b'old')
            current = objdir / 'current.o'
            current.write_bytes(b'new')
            with patch.object(build, 'OBJ', folder), patch.object(build, 'DIST', folder), \
                    patch.object(build, 'collect_sources', return_value=['current.cpp']), \
                    patch.object(build, 'obj_path', return_value=str(current)), \
                    patch.object(build.subprocess, 'run') as run:
                run.return_value.returncode = 0
                self.assertEqual(build.link_model('x4'), 0)
                command = run.call_args.args[0]
                self.assertIn(str(current), command)
                self.assertNotIn(str(objdir / 'removed.o'), command)


if __name__ == '__main__':
    unittest.main()
