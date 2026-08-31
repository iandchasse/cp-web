// Frame-pacing sampler.
//
// renderer.render() returns before the GPU is done, so timing it in isolation
// only measures CPU submission cost. The honest metric for "is moving it around
// smooth" is the achieved rAF delta, which includes GPU backpressure, the
// firmware's own emscripten main loop, and any layout/compositing.
//
// Phases are tagged so idle can be compared against an active orbit drag:
//   window.__fps.phase = 'orbit'
(() => {
  if (window.__fps && window.__fps.stop) window.__fps.stop();

  const s = {
    phase: 'idle',
    running: true,
    deltas: [],      // [phase, ms]
    render: [],      // [phase, ms] time inside three.js render
    longtasks: [],   // [phase, ms]
  };

  let last = performance.now();
  const tick = (t) => {
    if (!s.running) return;
    s.deltas.push([s.phase, +(t - last).toFixed(2)]);
    last = t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame((t) => { last = t; requestAnimationFrame(tick); });

  // Attribute how much of each frame is the three.js draw, so we can tell a
  // slow scene apart from a main thread that is busy with the firmware.
  const d = window.__dev3d;
  if (d && d.renderer && !d.renderer.__wrapped) {
    const orig = d.renderer.render.bind(d.renderer);
    d.renderer.render = (sc, cam) => {
      const a = performance.now();
      orig(sc, cam);
      s.render.push([s.phase, +(performance.now() - a).toFixed(2)]);
    };
    d.renderer.__wrapped = true;
    s.unwrap = () => { d.renderer.render = orig; d.renderer.__wrapped = false; };
  }

  try {
    const po = new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        s.longtasks.push([s.phase, +e.duration.toFixed(1)]);
      }
    });
    po.observe({ entryTypes: ['longtask'] });
    s.po = po;
  } catch (e) { /* longtask unsupported */ }

  s.stop = () => {
    s.running = false;
    try { s.po.disconnect(); } catch (e) {}
    try { s.unwrap(); } catch (e) {}
  };

  window.__fps = s;
  return 'fps sampler started';
})()
