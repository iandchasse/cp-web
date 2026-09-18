// Frontlight state for the 3D view, CrossInk edition.
//
// Under SIMULATOR, CrossInk does not use the simulator library's HalFrontlight
// at all: include/CrossInkHalFrontlight.h defines its own header-only class of
// the same name, with an inline getInstance() whose function-local static is
// the object every firmware call site drives. The simulator's HalFrontlight.cpp
// holds a second, unrelated instance. Exporting from there (as the CrossPoint
// patch does) reads a light nobody switches on -- the drawer worked, the 3D
// panel never lit. So for this variant the simulator's copy is excluded from
// the build (see VARIANTS in build.py) and the exports live here, against the
// same header the firmware compiles.
#include <CrossInkHalFrontlight.h>
#include <emscripten.h>

extern "C" {
EMSCRIPTEN_KEEPALIVE int cp_frontlight_present() { return Frontlight.present() ? 1 : 0; }
EMSCRIPTEN_KEEPALIVE int cp_frontlight_on() { return Frontlight.isOn() ? 1 : 0; }
EMSCRIPTEN_KEEPALIVE int cp_frontlight_brightness() { return Frontlight.brightness(); }
EMSCRIPTEN_KEEPALIVE int cp_frontlight_warmth() { return Frontlight.warmth(); }
}
