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
  python build.py all             # build every firmware x device + page + loose fs
  python build.py model crossink  # build one firmware (device defaults to x4pro)
  python build.py page          # (re)copy page + models.json + loose fs + _headers
  python build.py fs            # (re)mirror fs_ into dist/fs + manifest.json only
  python build.py clean         # remove objects + dist

Flags:
  --skip-fs   don't mirror fs_ (CI builds the SD tree separately)
  --slim      ship only sd-profile.json's allowlist instead of the whole tree
"""
import os
import re
import subprocess
import sys
import concurrent.futures
import shutil
import base64
import functools
import gzip
import io
import itertools
from urllib.parse import quote
from sd_content import select_files, curate_seed

ROOT = os.path.dirname(os.path.abspath(__file__))

# The upstream clones (firmware, simulator, thirdparty) live BESIDE this repo in
# the original local workspace, but CI clones them INSIDE it -- which is also
# what .gitignore assumes. Support both, preferring the inside layout, so the
# same build.py works locally and on a runner.
CPWEB = os.environ.get("CPWEB_DEPS")
if not CPWEB:
    CPWEB = ROOT if os.path.isdir(os.path.join(ROOT, "firmware")) else os.path.dirname(ROOT)

TP = os.path.join(CPWEB, "thirdparty")
SHIMS = os.path.join(ROOT, "shims")
OBJ = os.path.join(ROOT, "obj")
DIST = os.path.join(ROOT, "dist")
FSROOT = os.path.join(ROOT, "fs_")

# Firmware variants. CrossInk is a fork of CrossPoint with its own simulator, so
# each variant is a separate (firmware, simulator) pair with its own web patch;
# they share this harness, the page, the 3D view and the SD tree. Everything
# here was derived by building both: see REVIEW.md.
#
#   dirs        checkout locations, relative to CPWEB. CrossPoint keeps the
#               original firmware/ + simulator/ names so existing trees work.
#   patch       the web patch for that simulator, in patches/.
#   version     the macro the firmware prints its version from.
#   defines     extra -D on top of DEFINES below.
#   sdk_libs    freeink-sdk libraries to compile and include, beyond FreeInkUI.
#   exclude     extra source-path exclusions. These differ per variant even for
#               the SAME file: firmware_link_stubs.cpp supplies MySerialImpl and
#               the uzlib checksums that CrossPoint dropped upstream, while
#               CrossInk still defines both itself and would link twice.
VARIANTS = {
    "crosspoint": {
        "label": "CrossPoint",
        "firmware": "firmware",
        "simulator": "simulator",
        "patch": "simulator-web.patch",
        "version": "CROSSPOINT_VERSION",
        "defines": [],
        "sdk_libs": [],
        "exclude": [],
    },
    "crossink": {
        "label": "CrossInk",
        "firmware": "firmware-crossink",
        "simulator": "simulator-crossink",
        "patch": "crossink-simulator-web.patch",
        "version": "CROSSINK_VERSION",
        # CROSSPOINT_SIM_USE_NATIVE_DECODERS is deliberately absent: it wants
        # bitbank2/JPEGDEC as a PlatformIO lib_dep. Without it the simulator's
        # own decoder shim is used, exactly as the CrossPoint build does.
        "defines": ["CROSSINK_APP_CAP_TOUCH=1", "CROSSINK_APP_CAP_USB_DRIVE=0",
                    'CROSSINK_FIRMWARE_DEVICE_TYPE="x3-x4"'],
        "sdk_libs": [("network", "NearbyTransfer")],
        "exclude": ["firmware_link_stubs.cpp",   # CrossInk defines these itself
                    "/halclocksim/",             # second HalClock implementation
                    "simulatorsmoketest.cpp"],   # host-only, uses try/catch
    },
}
# Variants that are built, advertised in models.json and deployed.
ENABLED_VARIANTS = ["crosspoint", "crossink"]

# Set by use_variant(); every path below depends on which firmware is building.
VARIANT = None
FW = SIM = SDK = None
INCLUDES = INC_FLAGS = None

# Cloudflare Pages rejects a single asset over 25 MiB; anything larger is served
# as numbered .part-N files and rejoined by the page loader.
PART_SIZE = 20 * 1024 * 1024

def firmware_version(variant):
    """That variant's firmware version, as `git describe` reports in its tree.

    Shown on the boot and Settings screens. A pinned checkout is detached at a
    SHA, so describe resolves it against the nearest upstream tag, e.g.
    "1.6.5rc" or "v1.5.1-3-g7a092e8". Falls back to the pinned ref when git is
    unavailable (a source export rather than a clone), never to a made-up number.
    """
    tree = os.path.join(CPWEB, VARIANTS[variant]["firmware"])
    try:
        described = subprocess.run(
            ["git", "-C", tree, "describe", "--tags", "--always", "--dirty"],
            capture_output=True, text=True)
        if described.returncode == 0 and described.stdout.strip():
            return described.stdout.strip() + "-web"
    except OSError:
        pass
    key = variant.upper() + "_FIRMWARE_REF="
    for line in open(os.path.join(ROOT, "pins.env"), encoding="utf-8"):
        if line.startswith(key):
            return line.split("=", 1)[1].strip()[:8] + "-web"
    return "unknown-web"


# Shared by every variant; each adds its own version macro and extras.
DEFINES = [
    "SIMULATOR",
    "CROSSPOINT_SIMULATOR_PROJECT_WEBSERVER",
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
DEFAULT_MODEL = "x4pro"

# Models that are built, advertised in models.json and deployed. The others stay
# defined above but are stashed; add an id back here to restore it.
ENABLED_MODELS = ["x4pro"]

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


def use_variant(variant):
    """Point every path at one variant's checkout. Call before building it."""
    global VARIANT, FW, SIM, SDK, INCLUDES, INC_FLAGS
    if variant not in VARIANTS:
        raise KeyError(variant)
    VARIANT = variant
    FW = os.path.join(CPWEB, VARIANTS[variant]["firmware"])
    SIM = os.path.join(CPWEB, VARIANTS[variant]["simulator"])
    SDK = os.path.join(FW, "freeink-sdk", "libs")
    INCLUDES = collect_includes()
    INC_FLAGS = ["-I" + d for d in INCLUDES]
    return variant


def variant_defines(variant, model_id):
    """-D flags for one (variant, model) pair, in PlatformIO's order."""
    spec = VARIANTS[variant]
    defines = DEFINES + ['%s="%s"' % (spec["version"], firmware_version(variant))]
    defines += spec["defines"] + MODELS[model_id]["defines"]
    return ["-D" + d for d in defines]


def bundle_id(variant, model_id):
    """The name of a built bundle: dist/<variant>-<model>.js."""
    return variant + "-" + model_id


def norm(p):
    return p.replace("\\", "/").lower()


def excluded(path):
    n = norm(path)
    rules = SRC_EXCLUDE + VARIANTS[VARIANT]["exclude"] if VARIANT else SRC_EXCLUDE
    # Shims live per variant in shims/<variant>/; another variant's are not ours.
    marker = norm(SHIMS) + "/"
    if marker in n:
        owner = n.split(marker, 1)[1].split("/", 1)
        if len(owner) > 1 and owner[0] in VARIANTS and owner[0] != VARIANT:
            return True
    return any(x in n for x in rules) or lib_src_only_excluded(path)


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
    # Extra SDK libraries this variant pulls in (CrossInk adds NearbyTransfer).
    roots += [os.path.join(SDK, *lib, "src") for lib in VARIANTS[VARIANT]["sdk_libs"]]
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
    # 3) firmware/include (PlatformIO passes -Iinclude; CrossInk relies on it
    #    for AppCapabilities.h and CrossInkHalFrontlight.h)
    add(os.path.join(FW, "include"))
    # 3b) all firmware/src dirs that contain headers
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
    for lib in VARIANTS[VARIANT]["sdk_libs"]:
        add(os.path.join(SDK, *lib, "include"))
    # 6) third-party (ArduinoJson single header)
    add(TP)
    return inc


use_variant(ENABLED_VARIANTS[0])

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
            if f.read() != command_signature(cmd):
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


@functools.lru_cache(maxsize=1)
def compiler_identity():
    return (os.path.realpath(shutil.which("emcc") or "emcc") + "\n" +
            subprocess.check_output(["emcc", "--version"], text=True))


def command_signature(cmd):
    # emsdk upgrades replace the executable at the same path. The command alone
    # cannot tell old objects from ones built with the newly activated compiler.
    return compiler_identity() + "\n" + "\n".join(cmd)


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
            f.write(command_signature(cmd))
    return (src, p.returncode, p.stderr)


def compile_model(variant, model_id):
    compiler_identity()  # Prime the cached version before starting workers.
    use_variant(variant)
    bundle = bundle_id(variant, model_id)
    def_flags = variant_defines(variant, model_id)
    objdir = os.path.join(OBJ, variant, model_id)
    srcs = collect_sources()
    print(f"[{bundle}] {len(srcs)} sources, {len(INCLUDES)} include dirs")
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
    print(f"[{bundle}] compiled {len(srcs)-len(fails)}/{len(srcs)} OK, "
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


def link_model(variant, model_id):
    use_variant(variant)
    bundle = bundle_id(variant, model_id)
    objdir = os.path.join(OBJ, variant, model_id)
    # Removed/renamed sources leave old objects behind. Never link those.
    objs = [obj_path(src, objdir) for src in collect_sources()]
    if not objs:
        print(f"[{bundle}] no objects; compile first")
        return 1
    missing = [obj for obj in objs if not os.path.isfile(obj)]
    if missing:
        print(f"[{bundle}] {len(missing)} objects missing; compile first")
        return 1
    os.makedirs(DIST, exist_ok=True)
    link = [
        "em++", "-O2", "-pthread",
        "-sUSE_SDL=2",
        # One worker for the firmware's render task, plus headroom: every
        # worker in the pool loads and instantiates the module before main()
        # may run, and eight of them were pure startup cost on phones.
        "-sPTHREAD_POOL_SIZE=4",
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
    # Pass the objects in a response file: two variants' worth of mangled
    # object names is past the 32k Windows command-line limit (WinError 206).
    rsp = os.path.join(objdir, "link.rsp")
    with open(rsp, "w", encoding="utf-8") as f:
        f.write("\n".join('"' + o.replace("\\", "/") + '"' for o in objs))
    link += ["@" + rsp, "-o", os.path.join(DIST, f"{bundle}.js")]
    # Remove any stale baked data package from an earlier --preload-file build.
    stale = os.path.join(DIST, f"{bundle}.data")
    if os.path.exists(stale):
        os.remove(stale)
    print(f"[{bundle}] linking {len(objs)} objects...")
    p = subprocess.run(link, capture_output=True, text=True)
    if p.returncode != 0:
        print(f"[{bundle}] LINK FAILED")
        lines = [l for l in p.stderr.splitlines()
                 if any(k in l for k in ("error:", "undefined symbol", "wasm-ld"))]
        print("\n".join(lines[:80]) or p.stderr[:4000])
        return 1
    print(f"[{bundle}] OK ->", os.path.join(DIST, f"{bundle}.js"))
    return 0


def build_model(variant, model_id):
    rc = compile_model(variant, model_id)
    if rc:
        return rc
    return link_model(variant, model_id)


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


def copy_fs(slim=False):
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
    if not os.path.isdir(FSROOT):
        print(f"[fs] ERROR: {FSROOT} missing; existing output preserved")
        return 1
    candidates = list(_iter_fs_files())
    try:
        selected = candidates if not slim else select_files(candidates, os.path.join(ROOT, "sd-profile.json"))
        with open(os.path.join(ROOT, "seed.json"), encoding="utf-8") as stream:
            seed = json.load(stream)
        # The one SD font family the seeded settings select has to be present
        # before the first frame (setup() loads it, or clears the selection).
        # Every other family can stream in afterwards.
        seeded_font = json.loads(base64.b64decode(seed["files"]["settings.json"])).get("sdFontFamilyName", "")
        # Always curate: the seed's recents, covers and font/dictionary choices
        # name specific files, and a seeded recent whose book is not in this
        # build is a home-screen card that opens nothing.
        seed = curate_seed(seed, [rel for _, rel in selected])
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f"[fs] ERROR: {error}; existing output preserved")
        return 1
    os.makedirs(DIST, exist_ok=True)
    fsout = os.path.join(DIST, "fs")
    if os.path.isdir(fsout):
        # Never follow an unexpected output symlink/junction outside dist/.
        if os.path.normcase(os.path.realpath(fsout)) != os.path.normcase(os.path.abspath(fsout)):
            raise ValueError(f"Refusing to replace redirected output: {fsout}")
        shutil.rmtree(fsout)
    files, total, deferred, split = [], 0, 0, 0
    for full, rel in selected:
        dst = os.path.join(fsout, rel.replace("/", os.sep))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        size = os.path.getsize(full)
        # Dictionaries are large and discovered lazily (only when Settings is
        # opened), so stream them after boot instead of blocking the first paint.
        # Likewise font families other than the selected one: the page tells the
        # firmware to re-scan once they land (cp_sd_fonts_changed).
        defer = rel.startswith("dictionaries/") or (
            rel.startswith("fonts/") and rel.split("/")[1] != seeded_font)
        total += size
        deferred += size if defer else 0
        entry = {"path": "/fs_/" + rel, "size": size, "defer": defer}
        # Neither GitHub Pages nor Cloudflare compresses these content types, so
        # compress them here and let the loader inflate. Fonts land at ~36% and
        # the dictionary at ~22%; EPUBs are already zip archives, so they fail
        # the ratio test and ship as they are.
        body = None
        with open(full, "rb") as source:
            raw = source.read()
        packed = gzip.compress(raw, 6, mtime=0)
        if len(packed) < size * 0.9:
            body, entry["encoding"] = packed, "gzip"
            rel = rel + ".gz"
            dst = dst + ".gz"
        stored = len(body) if body is not None else size
        if stored > PART_SIZE:
            # Cloudflare Pages rejects any single asset over 25 MiB, and a
            # dictionary alone is well past that. Serve it as numbered parts;
            # the loader concatenates them back into one MEMFS file and checks
            # the total against "size", so a truncated part cannot slip through.
            parts = []
            stream = io.BytesIO(body) if body is not None else open(full, "rb")
            try:
                for index in itertools.count():
                    chunk = stream.read(PART_SIZE)
                    if not chunk:
                        break
                    with open(f"{dst}.part-{index}", "wb") as out:
                        out.write(chunk)
                    parts.append(f"{quote(rel, safe='/')}.part-{index}")
            finally:
                stream.close()
            entry["parts"] = ["fs/" + part for part in parts]
            split += 1
        elif body is not None:
            with open(dst, "wb") as out:
                out.write(body)
            entry["url"] = "fs/" + quote(rel, safe="/")
        else:
            shutil.copy2(full, dst)
            entry["url"] = "fs/" + quote(rel, safe="/")
        files.append(entry)
    # Eager files first; among the deferred, fonts before dictionaries so the
    # Settings font list fills in seconds rather than after a 10 MB dictionary.
    files.sort(key=lambda e: (e["defer"], not e["path"].startswith("/fs_/fonts/"), e["path"]))
    with open(os.path.join(DIST, "manifest.json"), "w") as f:
        json.dump({"version": 1, "files": files}, f, indent=2)
    with open(os.path.join(DIST, "seed.json"), "w", encoding="utf-8") as f:
        json.dump(seed, f, separators=(",", ":"))
    selected_paths = {rel for _, rel in selected}
    omitted = sum(os.path.getsize(path) for path, rel in candidates if rel not in selected_paths)
    served = sum(os.path.getsize(os.path.join(dp, f))
                 for dp, _, names in os.walk(fsout) for f in names)
    print(f"[fs] {len(files)} loose files -> dist/fs "
          f"({total/1048576:.1f} MB total, {deferred/1048576:.1f} MB deferred, "
          f"{served/1048576:.1f} MB served after compression)")
    print(f"[fs] {'demo' if slim else 'full'} profile: omitted {omitted/1048576:.1f} MB; source fs_/ unchanged")
    if split:
        print(f"[fs] {split} oversized file(s) served in {PART_SIZE/1048576:.0f} MB parts")
    return 0


def copy_page(built=None, skip_fs=False, slim=False):
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
    shutil.copytree(os.path.join(ROOT, "runtime"), os.path.join(DIST, "runtime"), dirs_exist_ok=True)
    # three.js + the device model for the 3D view. Copied wholesale rather than
    # bundled: the page imports these modules only when the user
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
    if os.path.exists(seed) and not os.path.exists(os.path.join(DIST, "seed.json")):
        shutil.copy(seed, os.path.join(DIST, "seed.json"))
    # Bundles left over from earlier builds (a stashed model or variant, or the
    # pre-variant flat names) must not be deployed.
    wanted = {bundle_id(v, m) for v in ENABLED_VARIANTS for m in ENABLED_MODELS}
    for name in os.listdir(DIST):
        stem, ext = os.path.splitext(name)
        if ext in (".js", ".wasm") and stem not in wanted and stem != "coi-serviceworker":
            os.remove(os.path.join(DIST, name))
    # Only advertise bundles whose JS actually exists in dist/.
    if built is None:
        built = [(v, m) for v in ENABLED_VARIANTS for m in ENABLED_MODELS
                 if os.path.exists(os.path.join(DIST, bundle_id(v, m) + ".js"))]
    manifest = [{
        "id": bundle_id(variant, mid),
        "firmware": VARIANTS[variant]["label"],
        "version": firmware_version(variant).removesuffix("-web"),
        "label": f'{VARIANTS[variant]["label"]} {firmware_version(variant).removesuffix("-web")}',
        "device": MODELS[mid]["label"],
        "w": MODELS[mid]["w"],
        "h": MODELS[mid]["h"],
        "touch": MODELS[mid]["touch"],
        "note": MODELS[mid]["note"],
    } for variant in ENABLED_VARIANTS for mid in ENABLED_MODELS if (variant, mid) in built]
    with open(os.path.join(DIST, "models.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    names = ", ".join(bundle_id(v, m) for v, m in built) or "none"
    print(f"[page] index.html + models.json ({names})")
    # CI builds the code and the SD tree separately: the tree is ~62 MB and
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
    return copy_fs(slim=slim)


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
    slim = "--slim" in flags
    cmd = argv[0] if argv else "all"
    if cmd == "clean":
        sys.exit(cmd_clean())
    elif cmd == "page":
        sys.exit(copy_page(skip_fs=skip_fs, slim=slim))
    elif cmd == "fs":
        sys.exit(copy_fs(slim=slim))
    elif cmd == "model":
        # build.py model <variant> [device], e.g. "model crossink" or
        # "model crosspoint x4pro". The device defaults to the only enabled one.
        usage = ("usage: build.py model <" + " | ".join(ENABLED_VARIANTS) + "> [" +
                 " | ".join(ENABLED_MODELS) + "]")
        if len(argv) < 2 or argv[1] not in ENABLED_VARIANTS:
            print(usage)
            if len(argv) >= 2 and argv[1] in VARIANTS:
                print(f"{argv[1]} is stashed; add it to ENABLED_VARIANTS to build it")
            elif len(argv) >= 2 and argv[1] in MODELS:
                print(f"{argv[1]} is a device, not a firmware; name the firmware first")
            sys.exit(2)
        variant = argv[1]
        mid = argv[2] if len(argv) > 2 else ENABLED_MODELS[0]
        if mid not in ENABLED_MODELS:
            print(usage)
            sys.exit(2)
        rc = build_model(variant, mid)
        if rc == 0:
            rc = copy_page(skip_fs=skip_fs, slim=slim)
        sys.exit(rc)
    elif cmd == "all":
        built = []
        for variant in ENABLED_VARIANTS:
            for mid in ENABLED_MODELS:
                if build_model(variant, mid) == 0:
                    built.append((variant, mid))
                else:
                    print(f"[all] {bundle_id(variant, mid)} FAILED")
        page_rc = copy_page(built, skip_fs=skip_fs, slim=slim)
        wanted = len(ENABLED_VARIANTS) * len(ENABLED_MODELS)
        sys.exit(0 if len(built) == wanted and page_rc == 0 else 1)
    else:
        print(__doc__)
        sys.exit(2)
