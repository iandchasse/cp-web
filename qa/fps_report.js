(() => {
  const s = window.__fps;
  if (!s) return JSON.stringify({ error: 'sampler not started' });
  s.stop();

  const stat = (arr) => {
    if (!arr.length) return null;
    const v = arr.slice().sort((a, b) => a - b);
    const q = (p) => v[Math.min(v.length - 1, Math.floor(v.length * p))];
    return {
      n: v.length,
      median: +q(0.5).toFixed(2),
      p90: +q(0.9).toFixed(2),
      max: +v[v.length - 1].toFixed(2),
      fps: +(1000 / q(0.5)).toFixed(1),
    };
  };

  const byPhase = (pairs) => {
    const out = {};
    for (const [ph, ms] of pairs) (out[ph] = out[ph] || []).push(ms);
    for (const k of Object.keys(out)) out[k] = stat(out[k]);
    return out;
  };

  // Count frames slower than 20 ms -- visible hitching at a 60 Hz target.
  const janky = {};
  for (const [ph, ms] of s.deltas) {
    janky[ph] = janky[ph] || { total: 0, over20: 0, over50: 0 };
    janky[ph].total++;
    if (ms > 20) janky[ph].over20++;
    if (ms > 50) janky[ph].over50++;
  }

  return JSON.stringify({
    frameDelta: byPhase(s.deltas),
    threeRender: byPhase(s.render),
    jank: janky,
    longtasks: byPhase(s.longtasks),
  }, null, 1);
})()
