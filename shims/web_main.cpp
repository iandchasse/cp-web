// Web entry point for the CrossPoint firmware WASM build.
//
// Runtime model: pthreads are enabled (so the firmware's ActivityManager render
// task, a FreeRTOS task -> std::thread, runs on a Web Worker unchanged), but
// main() runs on the browser MAIN thread. We drive the firmware's per-frame work
// from emscripten_set_main_loop instead of a blocking while() loop, so the tab
// never freezes and — crucially — every SDL/WebGL call happens on the main
// thread where a GL context is valid.
//
// This is safe because HalDisplay deliberately confines all SDL rendering to the
// main thread: the render task only converts the 1bpp framebuffer to ARGB and
// sets an atomic pendingPresent flag; presentIfNeeded() (called here) does the
// actual SDL upload/present. setup() and the HalGPIO SDL event pump also run on
// the main thread via this loop. This file replaces simulator_main.cpp (excluded
// from the build) so the upstream repos stay untouched.

#include <SDL.h>
#include <emscripten.h>
#include <unistd.h>

#include "Arduino.h"
#include "HalDisplay.h"
#include "HalGPIO.h"
#include "SdCardFontSystem.h"
#include "SimulatorLifecycle.h"

extern void setup();
extern void loop();
extern HalDisplay display;  // defined in firmware main.cpp

// Persist the firmware's runtime state tree (/fs_/.crosspoint, mounted as IDBFS
// by the page loader) to IndexedDB, then hand off to the page to reboot the
// WASM instance in place -- see cpwebSoftReboot in switcher.html. The fresh
// instance's own preRun remounts IDBFS and its setup() resumes the open book
// from state.json + progress.bin, reading back exactly what this call is
// about to write, just like the device restoring from SD after a power-wake.
// Falls back to rebooting without persisting if IndexedDB is unavailable: by
// the time this runs the main loop is already stopped (see main_tick()), so
// there is nothing left to lose by not waiting on it.
EM_JS(void, cpweb_persist_and_reboot, (), {
  try {
    if (typeof Module !== 'undefined' && Module.FS && Module.FS.syncfs) {
      Module.FS.syncfs(false, function (err) {
        if (err) { console.error('[idbfs] save on sleep failed', err); }
        if (window.cpwebSoftReboot) window.cpwebSoftReboot();
      });
      return;
    }
  } catch (e) { console.error('[idbfs] wake persist failed', e); }
  if (window.cpwebSoftReboot) window.cpwebSoftReboot();
});

// Tell the page the firmware has painted its first real frame -- the general
// readiness latch (window.__cpFirstFrame) anything calling into the WASM
// exports gates on. Fires on cold boot and again after every soft reboot.
EM_JS(void, cpweb_signal_first_frame, (), {
  if (window.cpwebFirstFrame) window.cpwebFirstFrame();
});

// The page streams SD font packs in after boot rather than holding startup for
// them (only the family the settings select is needed before the first frame).
// Font discovery runs once in setup(), so tell the registry the card changed;
// it re-scans the next time Settings or the reader asks for fonts, exactly as
// it does after a web-server font upload.
extern "C" EMSCRIPTEN_KEEPALIVE void cp_sd_fonts_changed() {
  sdFontSystem.markRegistryDirty();
}

// Flush a frame the render task finished, and announce the very first one so
// the page can start trusting the WASM exports (window.__cpFirstFrame). Every
// path that presents goes through here, including the ones that skip firmware
// work this frame.
static void present_and_signal() {
  static bool firstFrameSignaled = false;
  if (display.presentIfNeeded() && !firstFrameSignaled) {
    firstFrameSignaled = true;
    cpweb_signal_first_frame();
  }
}

static void main_tick() {
  if (display.shouldQuit()) {
    emscripten_cancel_main_loop();
    SDL_Quit();
    return;
  }

  if (gpio.isWebSleepActive()) {
    // Deep sleep: the firmware loop() is parked (see HalGPIO::startDeepSleep).
    // Keep the sleep screen on-canvas and wait for the power button. Every
    // other target treats a power-button wake as a fresh boot, not a resume
    // in place (see startDeepSleep() in patches/simulator-web.patch); getting
    // that here without a visible browser reload means stopping this instance
    // for good right now and handing off to the page, which reboots the WASM
    // module in place against the same canvas -- see cpweb_persist_and_reboot
    // and cpwebSoftReboot (switcher.html). The canvas keeps showing this
    // frame (the sleep screen) until the fresh instance's first frame paints
    // over it.
    if (gpio.pollWebSleepWake()) {
      emscripten_cancel_main_loop();
      SDL_Quit();
      cpweb_persist_and_reboot();
      return;
    }
    present_and_signal();
    return;
  }

  // The firmware paces itself with delay() at the end of loop() (10 ms, or
  // 50 ms once idle). On the main thread that cannot be a sleep -- see delay()
  // in the simulator's Arduino.h -- so it leaves a deadline here instead. Until
  // it passes, run no firmware work and let the browser have the thread; still
  // flush any frame the render task finished, so the panel never lags behind.
  if (millis() < cpwebDelayDeadline()) {
    present_and_signal();
    return;
  }

  // Clear input edge latches once per frame (see simulator_main.cpp): update()
  // may run many times within loop(); edges must survive across those calls and
  // reset only at this frame boundary.
  gpio.beginFrame();
  loop();
  // The render task set pendingPresent from its worker; flush to the canvas here
  // on the main thread, where SDL/WebGL is valid.
  present_and_signal();
}

int main(int argc, char **argv) {
  SimulatorLifecycle::initProcessArgs(argv);
  setup();
  // fps=0 -> drive from requestAnimationFrame; simulate_infinite_loop=1 -> unwind
  // the C stack and keep calling main_tick each frame (main() does not return).
  emscripten_set_main_loop(main_tick, 0, 1);
  return 0;
}
