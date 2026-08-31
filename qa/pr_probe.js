// Samples the renderer's pixel ratio continuously. The adaptive-resolution
// regression only shows up DURING a sustained drag (it restored full
// resolution once motion stopped), so sampling before/after would miss it
// entirely -- the sampler has to run across the whole gesture.
(() => {
  window.__prSamples = [];
  if (window.__prTimer) clearInterval(window.__prTimer);
  window.__prTimer = setInterval(() => {
    const d = window.__dev3d;
    if (d && d.renderer) window.__prSamples.push(+d.renderer.getPixelRatio().toFixed(3));
  }, 80);
  return 'pr sampler installed, dPR=' + window.devicePixelRatio;
})()
