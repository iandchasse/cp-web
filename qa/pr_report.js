// Reports what the pixel ratio did across the gesture. A stable renderer
// reports one distinct value; the adaptive-resolution version stepped
// 1 -> 0.75 -> 0.5 and stuck at the floor for the rest of a sustained orbit.
(() => {
  const s = window.__prSamples || [];
  if (window.__prTimer) { clearInterval(window.__prTimer); window.__prTimer = null; }
  if (!s.length) return 'NO SAMPLES';
  const uniq = [...new Set(s)];
  return JSON.stringify({
    samples: s.length,
    distinct: uniq,
    first: s[0],
    last: s[s.length - 1],
    min: Math.min(...s),
    max: Math.max(...s),
    verdict: uniq.length === 1 ? 'STABLE' : 'CHANGED x' + uniq.length,
  });
})()
