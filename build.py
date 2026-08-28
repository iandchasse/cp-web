#!/usr/bin/env python3
"""
Build driver: compile the full CrossPoint firmware to WebAssembly with emcc,
using the crosspoint-simulator HAL/Arduino/ESP shims. Mirrors the desktop
`[env:simulator]` source set + flags, but targets Emscripten (SDL2 -> canvas,
pthreads so the firmware's blocking loop + render thread work). The SD filesystem
is NOT baked into a .data package (Cloudflare Pages caps a single asset at
25 MiB); fs_ is mirrored into dist/fs as loose static files + manifest.json and
fetched into MEMFS at boot by the page loader. Networking is shimmed (no live
sockets).

Usage (after dot-sourcing emsdk_env.ps1 so emcc is on PATH):
  python build.py all           # build every model + copy page + loose fs
  python build.py model x4pro   # build a single model (x4 | x4pro | x3)
  python build.py page          # (re)copy page + models.json + loose fs + _headers
  python build.py fs            # (re)mirror fs_ into dist/fs + manifest.json only
  python build.py clean         # remove objects + dist

Flags:
  --skip-fs   don't mirror fs_ (CI builds the 134 MB SD tree separately)
"""
import os
import re
import subprocess
import sys
import concurrent.futures
import shutil

ROOT = os.path.dirname(os.path.abspath(__file__))
CPWEB = os.path.dirname(ROOT)
FW = os.path.join(CPWEB, "firmware")
SIM = os.path.join(CPWEB, "simulator")
SDK = os.path.join(FW, "freeink-sdk", "libs")
TP = os.path.join(CPWEB, "thirdparty")
SHIMS = os.path.join(ROOT, "shims")
OBJ = os.path.join(ROOT, "obj")
DIST = os.path.join(ROOT, "dist")
FSROOT = os.path.join(ROOT, "fs_")

DEFINES = [
    "SIMULATOR",
    "CROSSPOINT_SIMULATOR_PROJECT_WEBSERVER",
    'CROSSPOINT_VERSION="dev-web"',
    "ENABLE_SERIAL_LOG",
    "LOG_LEVEL=2",
    "EINK_DISPLAY_SINGLE_BUFFER_MODE=1",
    "MINIZ_NO_ZLIB_COMPATIBLE_NAMES=1",
    "XML_GE=0",
    "XML_CONTEXT_BYTES=1024",
    "USE_UTF8_LONG_NAMES=1",
    "PNG_MAX_BUFFERED_PIXELS=16416",
    "DISABLE_FS_H_WARNING=1",
    "DESTRUCTOR_CLOSES_FILE=1",
]

# Device profiles the crosspoint-simulator can represent at compile time.
# Each maps to a compile-time -D and a distinct WASM bundle (dist/<id>.js).
# Adding a new board here (once the simulator BoardConfig.h supports it, e.g.
# a DeLink profile) makes it appear in the switcher automatically via
# dist/models.json -- no HTML edits needed.
MODELS = {
    "x4": {
        "label": "XTEINK X4",
        "defines": [],
        "w": 480, "h": 800,        # portrait-native (SDL rotates landscape fb)
        "touch": False,
        "note": "Keyboard only.",
    },
    "x4pro": {
        "label": "XTEINK X4 Pro",
        "defines": ["SIMULATOR_DEVICE_X4_PRO"],
        "w": 480, "h": 800,
        "touch": True,
        "note": "Touch enabled: click = tap, drag = swipe. Frontlight + Home key.",
    },
    "x3": {
        "label": "XTEINK X3",
        "defines": ["SIMULATOR_DEVICE_X3"],
        "w": 528, "h": 792,        # 3.7\" 3:2 panel (792x528 landscape fb)
        "touch": False,
        "note": "Keyboard only. 3.7\" 3:2 panel.",
    },
}
DEFAULT_MODEL = "x4"

# Source-path exclusions (relative substrings, matched case-insensitively with
# forward slashes). Mirrors build_src_filter minus-entries plus host tests/tools.
SRC_EXCLUDE = [
    "/src/network/firmwareflasher.cpp",
    "/src/network/otabootswitch.cpp",
    "/src/network/otaupdater.cpp",
    "/platform/skip_efuse_blk_check.c",
    "/lib/hal/",           # simulator provides the HAL
    "/test/", "/tests/", "/test_", "/tools/", "/examples/", "/example/",
    "simulator_main.cpp",  # we provide our own web entry point
]


def norm(p):
    return p.replace("\\", "/").lower()


def excluded(path):
    n = norm(path)
    return any(x in n for x in SRC_EXCLUDE) or lib_src_only_excluded(path)


def lib_src_only_excluded(path):
    """Mirror PlatformIO's Library Dependency Finder: a library that has a
    `src/` subdirectory compiles ONLY from that `src/`. Anything else in the
    library tree (e.g. miniz/third_party/miniz.c, which is #included by
    miniz_impl.c) must not be compiled as its own translation unit."""
    n = norm(path)
    libroot = norm(os.path.join(FW, "lib")) + "/"
    if libroot not in n:
        return False
    rest = "/" + n.split(libroot, 1)[1]      # e.g. "/miniz/third_party/miniz.c"
    lib = rest.strip("/").split("/", 1)[0]
    if os.path.isdir(os.path.join(FW, "lib", lib, "src")):
        return f"/{lib}/src/" not in rest
    return False


def collect_sources():
    srcs = []
    roots = [
        os.path.join(FW, "src"),
        os.path.join(FW, "lib"),
        os.path.join(SIM, "src"),
        os.path.join(SDK, "ui", "FreeInkUI", "src"),
        SHIMS,
    ]
    for r in roots:
        for dp, _, files in os.walk(r):
            for f in files:
                if f.endswith((".cpp", ".c")):
                    full = os.path.join(dp, f)
                    if not excluded(full):
                        srcs.append(full)
    return sorted(set(srcs))


def collect_includes():
    inc = []

    def add(d):
        if os.path.isdir(d) and d not in inc:
            inc.append(d)

    # 1) my shims first (MD5Builder shadow, etc.)
    add(SHIMS)
    # 2) simulator shims (must beat SDK hardware headers of the same name)
    add(os.path.join(SIM, "src"))
    for sub in ("common", "freertos", "mbedtls"):
        add(os.path.join(SIM, "src", sub))
    # 3) all firmware/src dirs that contain headers
    for dp, _, files in os.walk(os.path.join(FW, "src")):
        if any(f.endswith((".h", ".hpp")) for f in files):
            add(dp)
    # 4) all firmware/lib dirs (except hal) that contain headers
    for dp, _, files in os.walk(os.path.join(FW, "lib")):
        if "/hal/" in norm(dp + "/") or norm(dp).endswith("/lib/hal"):
            continue
        if "/test" in norm(dp) or "/tool" in norm(dp) or "/example" in norm(dp):
            continue
        if any(f.endswith((".h", ".hpp")) for f in files):
            add(dp)
    # 5) FreeInkUI + Icons headers (SDK, header-only pieces we do use)
    add(os.path.join(SDK, "ui", "FreeInkUI", "include"))
    add(os.path.join(SDK, "assets", "Icons", "include"))
    # 6) third-party (ArduinoJson single header)
    add(TP)
    return inc


INCLUDES = collect_includes()
INC_FLAGS = [f"-I{d}" for d in INCLUDES]

COMMON = ["-Wno-narrowing", "-Wno-deprecated-declarations",
          "-fno-exceptions", "-pthread", "-sUSE_SDL=2"]

# clang/libc++ instantiates std::vector<T>::~vector eagerly (it is constexpr
# since C++20), so a firmware header holding a std::vector of a *forward-declared*
# type fails to compile under emcc even though it builds fine with GCC/libstdc++
# on device. HomeActivity.h does exactly that with `struct RecentBook;`. Force the
# real definition in ahead of it. Firmware stays pristine; build-level fix only.
FW_FORCE_INCLUDES = ["-include", "RecentBooksStore.h"]

# The simulator's WString.h both declares `String` and turns on
# ARDUINOJSON_ENABLE_ARDUINO_STRING, which is what makes `.as<String>()` resolve.
# It only works if it is seen *before* ArduinoJson.h. The desktop build gets that
# ordering via Arduino.h; here we force it for every C++ TU so the macro is also
# uniform everywhere (mismatched values across TUs would be an ODR violation).
CXX_FORCE_INCLUDES = ["-include", "WString.h"]

FW_SRC_PREFIX = norm(os.path.join(FW, "src")) + "/"


def force_includes_for(src):
    """Force-includes for a C++ TU. WString.h must come first (see above)."""
    flags = list(CXX_FORCE_INCLUDES)
    if norm(src).startswith(FW_SRC_PREFIX):
        flags += FW_FORCE_INCLUDES
    return flags


def obj_path(src, objdir):
    rel = norm(src)
    rel = rel.replace(norm(CPWEB) + "/", "").replace("/", "__").replace(":", "")
    return os.path.join(objdir, rel + ".o")


def parse_depfile(path):
    """Parse a Make-style .d file into the list of files the object depends on.

    Returns None when the depfile is missing/unreadable, which callers treat as
    "must rebuild" (e.g. objects produced before depfile tracking existed).
    """
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            text = f.read()
    except OSError:
        return None
    text = text.replace("\\\r\n", " ").replace("\\\n", " ")
    # Strip the leading "<target>:". Start at 2 so a Windows drive letter ("C:")
    # is never mistaken for the separator; the real one is followed by whitespace.
    idx = text.find(":", 2)
    while idx != -1 and idx + 1 < len(text) and text[idx + 1] not in " \t\r\n":
        idx = text.find(":", idx + 1)
    if idx == -1:
        return None
    parts = re.split(r"(?<!\\)\s+", text[idx + 1:].strip())
    return [p.replace("\\ ", " ") for p in parts if p]


def is_up_to_date(out, cmd):
    """True only if `out` exists, was built by an identical command line, and
    every recorded dependency is older than it.

    Comparing only the source mtime silently reuses objects built against a
    previous firmware API after a pull (headers change, .cpp files don't), and
    ignoring the command line silently reuses objects built with different flags.
    """
    if not os.path.exists(out):
        return False
    try:
        with open(out + ".cmd", "r", encoding="utf-8") as f:
            if f.read() != "\n".join(cmd):
                return False
    except OSError:
        return False
    deps = parse_depfile(out + ".d")
    if not deps:
        return False
    try:
        out_mtime = os.path.getmtime(out)
        return all(os.path.getmtime(d) <= out_mtime for d in deps)
    except OSError:
        return False


def compile_one(task):
    src, def_flags, objdir = task
    out = obj_path(src, objdir)
    is_c = src.endswith(".c")
    std = ["-std=gnu11"] if is_c else ["-std=gnu++2a"]
    forced = [] if is_c else force_includes_for(src)
    cmd = ["emcc", "-c", src, "-O2", "-g0", "-MMD", "-MF", out + ".d"] + \
        std + COMMON + forced + def_flags + INC_FLAGS + ["-o", out]
    if is_up_to_date(out, cmd):
        return (src, 0, "")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        # Never leave a stale object/sidecar behind for a failed compile.
        for f in (out, out + ".d", out + ".cmd"):
            if os.path.exists(f):
                os.remove(f)
    else:
        with open(out + ".cmd", "w", encoding="utf-8") as f:
            f.write("\n".join(cmd))
    return (src, p.returncode, p.stderr)


def compile_model(model_id):
    m = MODELS[model_id]
    def_flags = [f"-D{d}" for d in (DEFINES + m["defines"])]
    objdir = os.path.join(OBJ, model_id)
    srcs = collect_sources()
    print(f"[{model_id}] {len(srcs)} sources, {len(INCLUDES)} include dirs")
    os.makedirs(objdir, exist_ok=True)
    fails = []
    done = 0
    tasks = [(s, def_flags, objdir) for s in srcs]
    with concurrent.futures.ThreadPoolExecutor(max_workers=os.cpu_count()) as ex:
        for src, rc, err in ex.map(compile_one, tasks):
            done += 1
            if rc != 0:
                fails.append((src, err))
                print(f"  FAIL ({done}/{len(srcs)}) {os.path.relpath(src, CPWEB)}")
    print(f"[{model_id}] compiled {len(srcs)-len(fails)}/{len(srcs)} OK, "
          f"{len(fails)} failed")
    if fails:
        print("\n===== FIRST 12 FAILURES (first error line each) =====")
        for src, err in fails[:12]:
            first = ""
            for line in err.splitlines():
                if "error:" in line or "fatal error:" in line:
                    first = line.strip()
                    break
            print(f"\n### {os.path.relpath(src, CPWEB)}")
            print("   " + (first or (err.strip().splitlines() or [""])[0][:300]))
        print("\n===== FULL STDERR of first failure =====")
        print(fails[0][1][:4000])
    return 0 if not fails else 1


def link_model(model_id):
    objdir = os.path.join(OBJ, model_id)
    objs = []
    for dp, _, files in os.walk(objdir):
        for f in files:
            if f.endswith(".o"):
                objs.append(os.path.join(dp, f))
    if not objs:
        print(f"[{model_id}] no objects; compile first")
        return 1
    os.makedirs(DIST, exist_ok=True)
    link = [
        "emcc", "-O2", "-pthread",
        "-sUSE_SDL=2",
        "-sPTHREAD_POOL_SIZE=8",
        "-sALLOW_MEMORY_GROWTH=1",
        "-sINITIAL_MEMORY=134217728",
        "-sEXIT_RUNTIME=0",
        "-sASSERTIONS=1",
        "-sFORCE_FILESYSTEM=1",
        "-sSTACK_SIZE=1048576",
        # FS + run-dependency hooks let the page loader write the SD tree into
        # MEMFS before main(). No --preload-file: the fs_ tree is served as loose
        # static files (see copy_fs) because Cloudflare Pages caps assets at
        # 25 MiB and our dictionary/font set exceeds that as one package.
        "-sEXPORTED_RUNTIME_METHODS=FS,addRunDependency,removeRunDependency,HEAPU8,HEAPU32",
        "-lidbfs.js",
    ]
    link += objs + ["-o", os.path.join(DIST, f"{model_id}.js")]
    # Remove any stale baked data package from an earlier --preload-file build.
    stale = os.path.join(DIST, f"{model_id}.data")
    if os.path.exists(stale):
        os.remove(stale)
    print(f"[{model_id}] linking {len(objs)} objects...")
    p = subprocess.run(link, capture_output=True, text=True)
    if p.returncode != 0:
        print(f"[{model_id}] LINK FAILED")
        lines = [l for l in p.stderr.splitlines()
                 if any(k in l for k in ("error:", "undefined symbol", "wasm-ld"))]
        print("\n".join(lines[:80]) or p.stderr[:4000])
        return 1
    print(f"[{model_id}] OK ->", os.path.join(DIST, f"{model_id}.js"))
    return 0


def build_model(model_id):
    rc = compile_model(model_id)
    if rc:
        return rc
    return link_model(model_id)


def _iter_fs_files():
    """Yield (abspath, relposix) for every real SD file under fs_, skipping OS
    junk and AppleDouble sidecars."""
    skip = {".DS_Store", "Thumbs.db", "desktop.ini"}
    for dp, _, files in os.walk(FSROOT):
        for f in files:
            if f in skip or f.startswith("._"):
                continue
            full = os.path.join(dp, f)
            rel = os.path.relpath(full, FSROOT).replace("\\", "/")
            yield full, rel


def copy_fs():
    """Mirror the fs_ tree into dist/fs as loose static files and emit
    manifest.json. The page loader fetches these into MEMFS at boot instead of a
    baked .data package (25 MiB Cloudflare Pages asset cap).

    manifest schema (forward-compatible):
      { "version": 1,
        "files": [ { "path": "/fs_/<rel>",  # MEMFS destination
                     "url":  "fs/<rel>",     # page-relative fetch URL
                     "size": <bytes>,
                     "defer": <bool> },      # true -> load in background
                   ... ] }
    A future oversized asset can be expressed as {"parts": [url, ...]} (the
    loader concatenates them) or an absolute R2 "url"; no loader change needed.
    """
    import json
    os.makedirs(DIST, exist_ok=True)
    fsout = os.path.join(DIST, "fs")
    if os.path.isdir(fsout):
        shutil.rmtree(fsout)
    files, total, deferred = [], 0, 0
    for full, rel in _iter_fs_files():
        dst = os.path.join(fsout, rel.replace("/", os.sep))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(full, dst)
        size = os.path.getsize(full)
        # Dictionaries are large and discovered lazily (only when Settings is
        # opened), so stream them after boot instead of blocking the first paint.
        defer = rel.startswith("dictionaries/")
        total += size
        deferred += size if defer else 0
        files.append({"path": "/fs_/" + rel, "url": "fs/" + rel,
                      "size": size, "defer": defer})
    files.sort(key=lambda e: e["path"])
    with open(os.path.join(DIST, "manifest.json"), "w") as f:
        json.dump({"version": 1, "files": files}, f, indent=2)
    print(f"[fs] {len(files)} loose files -> dist/fs "
          f"({total/1048576:.1f} MB total, {deferred/1048576:.1f} MB deferred)")
    return 0


def copy_page(built=None, skip_fs=False):
    """Copy the switcher HTML + COI service worker into dist/, and write
    models.json describing which model bundles are available."""
    import json
    os.makedirs(DIST, exist_ok=True)
    page = os.path.join(ROOT, "switcher.html")
    if os.path.exists(page):
        shutil.copy(page, os.path.join(DIST, "index.html"))
    sw = os.path.join(ROOT, "coi-serviceworker.js")
    if os.path.exists(sw):
        shutil.copy(sw, os.path.join(DIST, "coi-serviceworker.js"))
    # three.js + the device model for the 3D view. Copied wholesale rather than
    # bundled: the page pulls these in via an importmap only when the user
    # actually turns 3D on, so the 2D path never pays for them.
    three_src = os.path.join(ROOT, "three")
    if os.path.isdir(three_src):
        three_dst = os.path.join(DIST, "three")
        if os.path.isdir(three_dst):
            shutil.rmtree(three_dst)
        shutil.copytree(three_src, three_dst)
        n = len(os.listdir(three_dst))
        mb = sum(os.path.getsize(os.path.join(three_dst, f))
                 for f in os.listdir(three_dst)) / 1e6
        print(f"[page] three/ {n} files ({mb:.1f} MB)")
    hdr = os.path.join(ROOT, "_headers")
    if os.path.exists(hdr):
        shutil.copy(hdr, os.path.join(DIST, "_headers"))
    # GitHub Pages runs Jekyll by default, which silently drops files and dirs
    # whose names start with an underscore -- including _headers. The bundle is
    # host-agnostic, so emit the opt-out unconditionally; it is inert elsewhere.
    open(os.path.join(DIST, ".nojekyll"), "w").close()
    # Optional first-visit default state applied by the loader when IDBFS is
    # empty (Lyra Extended theme, recents + covers, font/dictionary/sleep).
    seed = os.path.join(ROOT, "seed.json")
    if os.path.exists(seed):
        shutil.copy(seed, os.path.join(DIST, "seed.json"))
    # Only advertise models whose JS bundle actually exists in dist/.
    if built is None:
        built = [mid for mid in MODELS
                 if os.path.exists(os.path.join(DIST, f"{mid}.js"))]
    manifest = [{
        "id": mid,
        "label": MODELS[mid]["label"],
        "w": MODELS[mid]["w"],
        "h": MODELS[mid]["h"],
        "touch": MODELS[mid]["touch"],
        "note": MODELS[mid]["note"],
    } for mid in MODELS if mid in built]
    with open(os.path.join(DIST, "models.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"[page] index.html + models.json ({', '.join(built) or 'none'})")
    # CI builds the code and the SD tree separately: the tree is ~134 MB and
    # changes far less often than the wasm, so re-mirroring it every run just
    # buys a slow artifact upload. Guard against a *silent* empty library --
    # if fs_ is genuinely missing, say so rather than emitting a manifest with
    # zero files, which deploys as a reader with no books.
    if skip_fs:
        print("[page] skipping fs mirror (--skip-fs)")
        if not os.path.exists(os.path.join(DIST, "fs", "manifest.json")) and \
           not os.path.exists(os.path.join(DIST, "manifest.json")):
            print("[page] note: no existing manifest.json in dist/ -- pair this "
                  "with a dist-fs artifact before deploying")
        return 0
    if not os.path.isdir(FSROOT):
        print(f"[page] ERROR: {FSROOT} missing and --skip-fs not given")
        return 1
    copy_fs()
    return 0


def cmd_clean():
    for d in (OBJ, DIST):
        if os.path.isdir(d):
            shutil.rmtree(d)
    print("[clean] removed obj/ and dist/")
    return 0


if __name__ == "__main__":
    argv = [a for a in sys.argv[1:] if not a.startswith("--")]
    flags = {a for a in sys.argv[1:] if a.startswith("--")}
    skip_fs = "--skip-fs" in flags
    cmd = argv[0] if argv else "all"
    if cmd == "clean":
        sys.exit(cmd_clean())
    elif cmd == "page":
        sys.exit(copy_page(skip_fs=skip_fs))
    elif cmd == "fs":
        sys.exit(copy_fs())
    elif cmd == "model":
        if len(argv) < 2 or argv[1] not in MODELS:
            print("usage: build.py model <" + " | ".join(MODELS) + ">")
            sys.exit(2)
        mid = argv[1]
        rc = build_model(mid)
        if rc == 0:
            copy_page(skip_fs=skip_fs)
        sys.exit(rc)
    elif cmd == "all":
        built = []
        for mid in MODELS:
            if build_model(mid) == 0:
                built.append(mid)
            else:
                print(f"[all] {mid} FAILED")
        copy_page(built, skip_fs=skip_fs)
        sys.exit(0 if len(built) == len(MODELS) else 1)
    else:
        print(__doc__)
        sys.exit(2)
