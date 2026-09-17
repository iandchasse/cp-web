import base64
import json
import pathlib
import tempfile
import unittest

from sd_content import curate_seed, select_files


def encode(value):
    return base64.b64encode(json.dumps(value).encode()).decode()


def decode(value):
    return json.loads(base64.b64decode(value))


class ContentTests(unittest.TestCase):
    def test_seed_drops_removed_features_and_rebuildable_caches(self):
        seed = {"files": {
            "settings.json": encode({"fontFamily": 0, "sdFontFamilyName": "Bitter", "dictionaryName": "english"}),
            "recent.json": encode({"books": [
                {"path": "/books/keep.epub", "coverBmpPath": "/.crosspoint/epub_1/thumb_[HEIGHT].bmp"},
                {"path": "/books/remove.epub", "coverBmpPath": "/.crosspoint/epub_2/thumb_[HEIGHT].bmp"},
            ]}),
            "epub_1/thumb_226.bmp": "cover",
            "epub_1/sections/1.bin": "old-layout",
            "epub_2/thumb_226.bmp": "removed-cover",
        }}
        result = curate_seed(seed, ["books/keep.epub"])
        settings = decode(result["files"]["settings.json"])
        self.assertEqual(settings, {"fontFamily": 0, "sdFontFamilyName": "", "dictionaryName": ""})
        self.assertEqual(len(decode(result["files"]["recent.json"])["books"]), 1)
        self.assertEqual(set(result["files"]), {"settings.json", "recent.json", "epub_1/thumb_226.bmp"})
        self.assertEqual(decode(seed["files"]["settings.json"])["sdFontFamilyName"], "Bitter")

    def test_profile_matches_explicit_books_and_rejects_typos(self):
        with tempfile.TemporaryDirectory() as folder:
            profile = pathlib.Path(folder) / "profile.json"
            files = [("a", "books/keep.epub"), ("b", "fonts/font.bin")]
            profile.write_text(json.dumps({"version": 1, "include": ["books/keep.epub"]}))
            self.assertEqual(select_files(files, profile), [files[0]])
            profile.write_text(json.dumps({"version": 1, "include": ["books/absent.epub"]}))
            with self.assertRaisesRegex(ValueError, "matches no files"):
                select_files(files, profile)

    def test_demo_keeps_exactly_three_seeded_books(self):
        root = pathlib.Path(__file__).resolve().parents[1]
        seed = json.loads((root / "seed.json").read_text())
        books = decode(seed["files"]["recent.json"])["books"]
        expected = {book["path"].lstrip("/") for book in books}
        profile = json.loads((root / "sd-profile.json").read_text())
        self.assertEqual(set(profile["include"]), expected)
        self.assertEqual(len(expected), 3)
