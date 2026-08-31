// Attribute what is keeping the on-demand render loop awake: camera 'change'
// events (damping settling), panel updates, or something else entirely.
(async () => {
 try {
  const d = window.__dev3d;
  let changes = 0, panelUpdates = 0, renders = 0;

  const onCh = () => changes++;
  d.controls.addEventListener('change', onCh);

  const origSync = d.syncPanel.bind(d);
  d.syncPanel = () => { const r = origSync(); if (r) panelUpdates++; return r; };

  const origRender = d.renderer.render.bind(d.renderer);
  d.renderer.render = (s, c) => { renders++; origRender(s, c); };

  const t0 = performance.now();
  await new Promise((r) => setTimeout(r, 2000));

  d.controls.removeEventListener('change', onCh);
  d.syncPanel = origSync;
  d.renderer.render = origRender;

  return JSON.stringify({
    windowMs: +(performance.now() - t0).toFixed(0),
    changeEvents: changes,
    panelUpdates: panelUpdates,
    renders: renders,
    dirtyNow: d._dirty,
    pixelRatio: d.renderer.getPixelRatio(),
  });
 } catch (e) { return JSON.stringify({ error: String(e && e.stack || e) }); }
})()
