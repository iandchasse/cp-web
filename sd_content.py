"""Select deployable SD content without deleting the source archive/tree."""
import base64
import fnmatch
import json


def select_files(files, profile_path):
    """Validate every allowlist rule before the build replaces previous output."""
    with open(profile_path, encoding="utf-8") as stream:
        profile = json.load(stream)
    patterns = profile.get("include")
    if profile.get("version") != 1 or not isinstance(patterns, list) or not patterns:
        raise ValueError("SD profile requires version 1 and a nonempty include list")
    selected = set()
    for pattern in patterns:
        if not isinstance(pattern, str) or pattern.startswith("/") or ".." in pattern.split("/") or "\\" in pattern:
            raise ValueError(f"Invalid SD profile pattern: {pattern!r}")
        matches = {rel for _, rel in files if fnmatch.fnmatchcase(rel, pattern)}
        if not matches:
            raise ValueError(f"SD profile pattern matches no files: {pattern}")
        selected.update(matches)
    return [(path, rel) for path, rel in files if rel in selected]


def curate_seed(seed, included_paths):
    """Keep settings, real book recents and their thumbnails; regenerate caches.

    The original seed remains unchanged. No migration of returning users' IDBFS
    data is performed; this only describes first-visit defaults.
    """
    paths = set(included_paths)
    source = seed["files"]

    def decode(name):
        return json.loads(base64.b64decode(source[name]))

    def encode(value):
        return base64.b64encode(json.dumps(value, separators=(",", ":")).encode()).decode("ascii")

    settings = decode("settings.json")
    font = settings.get("sdFontFamilyName", "")
    if font and not any(path.startswith(f"fonts/{font}/") for path in paths):
        settings["sdFontFamilyName"] = ""
    dictionary = settings.get("dictionaryName", "")
    if dictionary and not any(path.startswith(f"dictionaries/{dictionary}/") for path in paths):
        settings["dictionaryName"] = ""
    recents = decode("recent.json")
    recents["books"] = [book for book in recents["books"] if book["path"].lstrip("/") in paths]
    files = {"settings.json": encode(settings), "recent.json": encode(recents)}
    for book in recents["books"]:
        cover = book.get("coverBmpPath", "")
        if not cover.startswith("/.crosspoint/"):
            continue
        pattern = cover[len("/.crosspoint/"):].replace("[HEIGHT]", "*")
        for name, data in source.items():
            if fnmatch.fnmatchcase(name, pattern):
                files[name] = data
    return {"version": 1, "note": "Curated demo defaults; book caches regenerate on first open.", "files": files}
