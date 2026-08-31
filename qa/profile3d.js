// Structural + timing audit of the 3D view. Returned as JSON to the harness.
//
// Counts (meshes, draw calls, triangles, materials, programs) are hardware
// independent and are the actionable numbers. Absolute frame times under
// headless SwiftShader are NOT representative of a real GPU, but they do show
// where cost is concentrated, and SwiftShader exaggerates fragment work, which
// is exactly what pixel-rate problems look like.
(async () => {
 try {
  const d = window.__dev3d;
  if (!d) return JSON.stringify({ error: 'no __dev3d' });
  const { renderer, scene, camera } = d;

  const meshes = [];
  const mats = new Set();
  const geos = new Set();
  let tris = 0, indexed = 0, nonIndexed = 0;
  scene.traverse((n) => {
    if (!n.isMesh) return;
    meshes.push(n);
    mats.add(n.material);
    geos.add(n.geometry);
    const g = n.geometry;
    const c = g.index ? g.index.count : g.attributes.position.count;
    tris += c / 3;
    if (g.index) indexed++; else nonIndexed++;
  });

  const matTypes = {};
  for (const m of mats) matTypes[m.type] = (matTypes[m.type] || 0) + 1;

  const lights = [];
  scene.traverse((n) => { if (n.isLight) lights.push(n.type); });

  renderer.info.reset();
  renderer.render(scene, camera);
  const info = {
    calls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
    programs: renderer.info.programs ? renderer.info.programs.length : -1,
    textures: renderer.info.memory.textures,
    geometries: renderer.info.memory.geometries,
  };

  // Time render() alone, excluding controls/syncPanel, over N frames.
  const timeRender = (n) => new Promise((res) => {
    const ts = [];
    let i = 0;
    const step = () => {
      const t0 = performance.now();
      renderer.render(scene, camera);
      ts.push(performance.now() - t0);
      if (++i < n) requestAnimationFrame(step);
      else {
        ts.sort((a, b) => a - b);
        res({
          median: +ts[ts.length >> 1].toFixed(2),
          p90: +ts[Math.floor(ts.length * 0.9)].toFixed(2),
          max: +ts[ts.length - 1].toFixed(2),
        });
      }
    };
    requestAnimationFrame(step);
  });

  const baseline = await timeRender(40);

  // How much of that is the device model vs. the screen quad? Hide the model.
  const modelRoot = d.root;
  const wasVisible = modelRoot.visible;
  modelRoot.visible = false;
  const withoutModel = await timeRender(30);
  modelRoot.visible = wasVisible;

  // Cost of pixel rate: halve the resolution and re-time.
  const pr = renderer.getPixelRatio();
  renderer.setPixelRatio(pr / 2);
  const halfRes = await timeRender(30);
  renderer.setPixelRatio(pr);

  return JSON.stringify({
    meshes: meshes.length,
    uniqueMaterials: mats.size,
    uniqueGeometries: geos.size,
    matTypes,
    lights,
    tris: Math.round(tris),
    indexed, nonIndexed,
    info,
    pixelRatio: pr,
    devicePixelRatio: window.devicePixelRatio,
    cssSize: [renderer.domElement.clientWidth, renderer.domElement.clientHeight],
    drawingBuffer: [renderer.domElement.width, renderer.domElement.height],
    renderMs: { baseline, withoutModel, halfRes },
  }, null, 1);
 } catch (e) {
  return JSON.stringify({ error: String(e && e.stack || e) });
 }
})()
