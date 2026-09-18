import importlib.util
import pathlib
import tempfile
import json
import os
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('build', ROOT / 'build.py')
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


class BuildTests(unittest.TestCase):
    def test_bad_profile_preserves_filesystem_and_seed(self):
        # --slim validates every allowlist rule before replacing the output.
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            source = root / 'source'
            source.mkdir()
            old = root / 'fs' / 'book'
            old.parent.mkdir()
            old.write_text('old book')
            (root / 'seed.json').write_text('old seed')
            with patch.object(build, 'FSROOT', str(source)), patch.object(build, 'DIST', folder):
                self.assertEqual(build.copy_fs(slim=True), 1)
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
                self.assertEqual(build.copy_fs(), 0)
            entry = json.loads((output / 'manifest.json').read_text())['files'][0]
            self.assertEqual(entry['url'], 'fs/book%20%231%25.epub')
            self.assertEqual(entry['path'], '/fs_/book #1%.epub')

    def test_oversized_assets_are_split_into_fetchable_parts(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            source = root / 'source'
            (source / 'dictionaries').mkdir(parents=True)
            big = source / 'dictionaries' / 'big.dict'
            # Incompressible, so it is stored as-is and must be split. (A
            # compressible file of the same size fits in one part once gzipped.)
            big.write_bytes(os.urandom(build.PART_SIZE + 5))
            output = root / 'output'
            with patch.object(build, 'FSROOT', str(source)), patch.object(build, 'DIST', str(output)):
                self.assertEqual(build.copy_fs(), 0)
            entry = json.loads((output / 'manifest.json').read_text())['files'][0]
            self.assertEqual(entry['parts'], ['fs/dictionaries/big.dict.part-0', 'fs/dictionaries/big.dict.part-1'])
            self.assertNotIn('url', entry)
            self.assertEqual(entry['size'], build.PART_SIZE + 5)
            parts = sorted((output / 'fs' / 'dictionaries').glob('big.dict.part-*'))
            self.assertEqual(b''.join(part.read_bytes() for part in parts), big.read_bytes())
            # The whole file must not also ship, or the deploy pays for it twice.
            self.assertFalse((output / 'fs' / 'dictionaries' / 'big.dict').exists())

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
            objdir = pathlib.Path(folder) / 'crosspoint' / 'x4pro'
            objdir.mkdir(parents=True)
            (objdir / 'removed.o').write_bytes(b'old')
            current = objdir / 'current.o'
            current.write_bytes(b'new')
            with patch.object(build, 'OBJ', folder), patch.object(build, 'DIST', folder), \
                    patch.object(build, 'collect_sources', return_value=['current.cpp']), \
                    patch.object(build, 'obj_path', return_value=str(current)), \
                    patch.object(build.subprocess, 'run') as run:
                run.return_value.returncode = 0
                self.assertEqual(build.link_model('crosspoint', 'x4pro'), 0)
                command = run.call_args.args[0]
                # Objects go in a response file (Windows command-line limit),
                # so the orphan must be absent from that, not from argv.
                listed = (objdir / 'link.rsp').read_text()
                self.assertIn(str(current).replace('\\', '/'), listed)
                self.assertNotIn('removed.o', listed)
                self.assertIn(str(pathlib.Path(folder) / 'crosspoint-x4pro.js'), command)

    def test_variants_get_their_own_paths_defines_and_shims(self):
        for variant, spec in build.VARIANTS.items():
            build.use_variant(variant)
            self.assertTrue(build.FW.endswith(spec['firmware']), build.FW)
            self.assertTrue(build.SIM.endswith(spec['simulator']), build.SIM)
            defines = build.variant_defines(variant, 'x4pro')
            self.assertTrue(any(d.startswith('-D' + spec['version'] + '=') for d in defines),
                            'missing version macro for ' + variant)
            # Another variant's shims must never be compiled into this one.
            shims = [src for src in build.collect_sources()
                     if build.norm(build.SHIMS) in build.norm(src)]
            for other in build.VARIANTS:
                if other == variant:
                    continue
                self.assertFalse(any('/%s/' % other in build.norm(src) for src in shims),
                                 '%s compiled %s shims' % (variant, other))
        build.use_variant(build.ENABLED_VARIANTS[0])

    def test_crossink_and_crosspoint_disagree_about_the_simulator_stubs(self):
        # CrossPoint needs firmware_link_stubs.cpp (upstream dropped its
        # MySerialImpl/uzlib definitions); CrossInk still defines both itself
        # and would link them twice. A regression here is a duplicate symbol.
        self.assertNotIn('firmware_link_stubs.cpp', build.VARIANTS['crosspoint']['exclude'])
        self.assertIn('firmware_link_stubs.cpp', build.VARIANTS['crossink']['exclude'])

    def test_crossink_frontlight_is_exported_from_its_own_singleton(self):
        # CrossInk's firmware drives the inline HalFrontlight in its own
        # include/CrossInkHalFrontlight.h, not the simulator's. Exporting from
        # the simulator read a light nobody switched on.
        #
        # Checked against excluded() with a synthetic path, not against
        # collect_sources() walking the real simulator checkout: CI runs this
        # suite before the "Clone firmware and simulator" step, so
        # simulator/src/ does not exist yet at test time and collect_sources()
        # would find nothing there regardless of what excluded() says.
        build.use_variant('crossink')
        self.assertTrue(build.excluded(os.path.join(build.SIM, 'src', 'HalFrontlight.cpp')),
                         "the simulator's HalFrontlight must not be compiled for CrossInk")
        # shims/ is part of this repo, not an external checkout, so it is
        # always present -- safe to check via collect_sources() directly.
        sources = [build.norm(s) for s in build.collect_sources()]
        self.assertTrue(any(s.endswith('/shims/crossink/frontlight_exports.cpp') for s in sources))
        build.use_variant('crosspoint')
        self.assertFalse(build.excluded(os.path.join(build.SIM, 'src', 'HalFrontlight.cpp')),
                          "CrossPoint must still compile the simulator's own HalFrontlight")
        sources = [build.norm(s) for s in build.collect_sources()]
        self.assertFalse(any('/shims/crossink/' in s for s in sources))
        build.use_variant(build.ENABLED_VARIANTS[0])


if __name__ == '__main__':
    unittest.main()
