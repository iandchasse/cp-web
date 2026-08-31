// CrossPoint 3D device view.
//
// Renders the Xteink X4 case model with the live e-ink panel projected onto its
// front face, as an alternative to the flat 2D canvas.
//
// Two things drive the design:
//
// 1. The panel texture comes from the WASM heap, not from the SDL canvas.
//    HalDisplay already keeps the panel as an ARGB buffer for SDL_UpdateTexture;
//    cp_fb_sync() snapshots it and returns a frame counter. Reading back the SDL
//    canvas instead would need preserveDrawingBuffer plus a GPU->CPU->GPU round
//    trip, and would race the present. See the export block in HalDisplay.cpp.
//
// 2. The .3mf is a 3D-printing mockup: one mesh, no UVs, no normals, one flat
//    colour, and a completely featureless front face. So we do not texture the
//    mesh -- we float a separate quad in front of it, plus a synthetic bezel so
//    the panel doesn't look like a sticker. That is also what makes this work
//    for any arbitrary model: nothing about it depends on the model's topology.

import * as THREE from './three.module.min.js';
import { ThreeMFLoader } from './3MFLoader.js';
import { OrbitControls } from './OrbitControls.js';

const MODEL_URL = './three/x4-device.3mf';

// Geometry measured off the mesh itself by measure_model.mjs, in millimetres and
// in the model's own frame (before the load() centring). Hardcoded rather than
// re-derived at runtime because finding these needs dense surface sampling --
// the mesh is a print mockup whose flat areas are a handful of huge triangles,
// so a vertex histogram misses them entirely.
const GEO = {
  faceZ: 3.10,        // the panel plane. NB the frontmost geometry is 3.70:
                      // a small raised lip across the chin, not the glass.
  faceTop: 56.92,     // top edge of the front face
  faceBottom: -56.92, // bottom edge of the front face
  faceW: 66.32,       // front face width  (the 69.8 bbox includes the buttons)
  bodyX: 34.60,       // side wall
  buttonX: 35.20,     // button crest
};

// Every control on the device is a rocker except power, so each rocker is split
// into two independently-pressable halves.
//
// All of it is real geometry measured off the mesh. The front rockers read as
// two 19.5mm slots in the chin, bounded by three raised 0.6mm rims -- end caps
// at x = +/-21.6 and a shared centre divider at x = 0 -- all spanning
// y -55.20..-53.30. (An earlier orthographic render missed these: the rims are
// shallow and vanish under flat lighting. The mesh doesn't lie.)
const SIDE_BUTTONS = [
  { id: 'power', label: 'Power',     y: [27.90, 37.90], code: 'KeyP',       key: 'p',          keyCode: 80 },
  { id: 'up',    label: 'Page up',   y: [ 2.15, 11.40], code: 'ArrowUp',    key: 'ArrowUp',    keyCode: 38 },
  { id: 'down',  label: 'Page down', y: [-7.10,  2.15], code: 'ArrowDown',  key: 'ArrowDown',  keyCode: 40 },
];

// Rocker slots, measured: inner edges of the rims. Each splits at its midpoint
// (-11.40 and +11.40), outer half = the "away" action.
const FRONT_ROCKER = { yMid: -54.25, ySpan: 1.90, inner: 1.65, outer: 21.15, mid: 11.40 };

const FRONT_BUTTONS = [
  { id: 'back',    label: 'Back',   x: [-FRONT_ROCKER.outer, -FRONT_ROCKER.mid],   code: 'Escape',     key: 'Escape',     keyCode: 27 },
  { id: 'confirm', label: 'Select', x: [-FRONT_ROCKER.mid,   -FRONT_ROCKER.inner], code: 'Enter',      key: 'Enter',      keyCode: 13 },
  { id: 'left',    label: 'Left',   x: [ FRONT_ROCKER.inner,  FRONT_ROCKER.mid],   code: 'ArrowLeft',  key: 'ArrowLeft',  keyCode: 37 },
  { id: 'right',   label: 'Right',  x: [ FRONT_ROCKER.mid,    FRONT_ROCKER.outer], code: 'ArrowRight', key: 'ArrowRight', keyCode: 39 },
];

// Screen placement, in millimetres. panelW is the only free parameter: the top
// gap is derived so it matches the side gap, and the height follows from the
// panel's aspect. All overridable from the query string for calibration.
const DEFAULTS = {
  panelW: 59.10,  // visible panel width
  topGap: null,   // null = match the side gap
  zLift: 0.05,    // how far the panel floats above the face plane
};

function readOverrides() {
  const q = new URLSearchParams(location.search);
  const out = Object.assign({}, DEFAULTS);
  for (const k of Object.keys(DEFAULTS)) {
    const v = parseFloat(q.get(k));
    if (Number.isFinite(v)) out[k] = v;
  }
  return out;
}

export class Device3D {
  constructor(host, opts) {
    this.host = host;
    this.opts = readOverrides();
    // Physical panel size. The framebuffer is always the landscape panel; the
    // firmware rotates content into it (see cp_fb_orientation below).
    this.fbW = (opts && opts.fbW) || 800;
    this.fbH = (opts && opts.fbH) || 480;
    this.lastFrame = -1;
    this.ready = false;
    this._raf = null;
    this._initScene();
  }

  _initScene() {
    const w = this.host.clientWidth || 640;
    const h = this.host.clientHeight || 900;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));    this.renderer.setSize(w, h, false);
    // Out of flow on purpose: the host's height comes from flex, and the canvas
    // is sized from the host, so leaving it in flow would be circular.
    this.renderer.domElement.style.cssText =
      'display:block;position:absolute;inset:0;width:100%;height:100%;';
    this.host.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(30, w / h, 1, 4000);

    // Three-point-ish lighting. The model ships one flat light-blue colour and
    // no normals, so shading is entirely down to computeVertexNormals + these.
    this.scene.add(new THREE.HemisphereLight(0xbfd4e8, 0x20242b, 1.5));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(-120, 180, 260);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xaec4dd, 0.8);
    fill.position.set(220, -60, 140);
    this.scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffffff, 1.1);
    rim.position.set(60, 120, -260);
    this.scene.add(rim);

    this.root = new THREE.Group();
    this.scene.add(this.root);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = false;
    this.controls.rotateSpeed = 0.55;

    // ---- On-demand rendering ----------------------------------------------
    // The scene is static apart from the panel and the camera, so rendering
    // every frame regardless was burning fill rate continuously. Measured on
    // the SwiftShader QA box: stopping the render loop took the frame delta
    // from 117 ms to 50 ms, while renderer.render() itself only costs ~0.6 ms
    // of CPU -- i.e. the cost is raster, not draw calls, and it was being paid
    // even when the image was identical.
    //
    // Deliberately driven off the controls' own 'change' event rather than
    // update()'s return value: damping means the camera keeps moving after the
    // pointer is released, and 'change' is what OrbitControls fires for both.
    this._dirty = true;
    this._lastChange = 0;
    this.controls.addEventListener('change', () => {
      this._dirty = true;
      this._lastChange = performance.now();
    });

    // ---- Adaptive resolution while moving ----------------------------------
    // During motion every frame is legitimately dirty, so on-demand rendering
    // cannot help there; the only lever left is pixels (the scene is fill-bound
    // -- quartering the pixel count roughly halved the frame cost).
    //
    // Driven by *measured* frame time rather than a fixed factor, because the
    // right answer is hardware dependent: a machine that already holds 60 fps
    // should never be blurred, while a slow one needs the help. Resolution only
    // steps down while motion is actually costing frames, and always returns to
    // full once it settles -- so the still image is never degraded.
    this._fullPR = Math.min(window.devicePixelRatio || 1, 2);
    this._scale = 1;          // fraction of _fullPR currently being rendered
    this._frameEma = null;
    this._lastRenderT = 0;
    this._dragging = false;
    this.controls.addEventListener('start', () => { this._dragging = true; });
    this.controls.addEventListener('end', () => { this._dragging = false; });

    this._buildPanelTexture();
    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    // The host is flex-sized, so it can change height without the window ever
    // resizing (the legend rewrapping is enough). Watch the box itself.
    if (window.ResizeObserver) {
      this._ro = new ResizeObserver(() => this.resize());
      this._ro.observe(this.host);
    }
  }

  // A DataTexture over a plain (non-shared) RGBA buffer we refill each frame.
  _buildPanelTexture() {
    // Glass-shaped, not buffer-shaped: the texture is always the portrait
    // panel as mounted (fbH x fbW). _blit does the fixed physical rotation.
    this.texBuf = new Uint8Array(this.fbW * this.fbH * 4);
    this.texBuf.fill(0xff); // start white, like a cleared panel
    this.tex = new THREE.DataTexture(this.texBuf, this.fbH, this.fbW, THREE.RGBAFormat);
    // Nearest keeps the Bayer dithering crisp instead of smearing it to mush.
    this.tex.magFilter = THREE.NearestFilter;
    this.tex.minFilter = THREE.LinearMipmapLinearFilter;
    this.tex.generateMipmaps = true;
    this.tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.needsUpdate = true;
  }

  async load(onProgress) {
    const loader = new ThreeMFLoader();
    const buf = await fetch(MODEL_URL).then((r) => {
      if (!r.ok) throw new Error('model fetch failed: ' + r.status);
      return r.arrayBuffer();
    });
    if (onProgress) onProgress('parsing model');
    const obj = loader.parse(buf);

    // The 3MF declares unit="meter" but ThreeMFLoader does not apply it, so the
    // model arrives ~1000x too small -- small enough to fall inside the camera
    // near plane and render as nothing at all. Scale to millimetres.
    obj.scale.setScalar(1000);

    let tris = 0;
    obj.traverse((n) => {
      if (!n.isMesh) return;
      const g = n.geometry;
      // No normals in the file; without these the mesh renders unlit-flat.
      if (!g.attributes.normal) g.computeVertexNormals();
      tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
      // Replace the model's flat #9DCFED with something that reads as a device.
      //
      // Phong rather than Standard: the scene is fill-bound (one mesh covering
      // most of the viewport, only 9 draw calls), so the body's fragment shader
      // is the dominant cost. Measured at 1.5x faster overall than the PBR
      // material -- and with a single flat colour, no maps and computed
      // normals, there is nothing for PBR to express: a pixel diff of the two
      // renders came out 90.7% identical, with 0.008% of pixels differing by
      // more than 24/255 (confined to specular highlight edges).
      n.material = new THREE.MeshPhongMaterial({
        color: 0x3c4149, shininess: 25, specular: 0x2a2f36,
        vertexColors: false,
      });
    });
    this.tris = Math.round(tris);

    const box = new THREE.Box3().setFromObject(obj);
    const size = box.getSize(new THREE.Vector3());
    const ctr = box.getCenter(new THREE.Vector3());
    obj.position.sub(ctr);            // centre the model on the origin
    this.root.add(obj);
    this.size = size;

    this._addScreen(box, ctr, size);
    this._frameCamera(size);
    this.ready = true;
    return { tris: this.tris, size: [size.x, size.y, size.z] };
  }

  _addScreen(box, ctr, size) {
    const o = this.opts;
    const panelW = o.panelW;
    const panelH = panelW * (this.fbW / this.fbH); // portrait: 800/480

    // The gap above the glass matches the gap either side of it, which is what
    // the eye actually reads as "centred". Everything below then falls out as
    // the chin, which is where the real device hides the ribbon cable.
    const sideGap = (GEO.faceW - panelW) / 2;
    const topGap = Number.isFinite(o.topGap) ? o.topGap : sideGap;

    // Measured constants are in model space; load() centres the model on the
    // origin, so shift by the same amount to land in root space.
    const faceZ = GEO.faceZ - ctr.z;
    const topY = GEO.faceTop - ctr.y;
    const cx = -ctr.x;                 // centre on the face, not the bbox: the
                                       // buttons make the bbox asymmetric in x
    const cy = topY - topGap - panelH / 2;

    // No synthetic bezel: the panel is the bezel. It sits a hair proud of the
    // face plane, still well behind the 3.70 lip across the chin, so it reads as
    // set into the case rather than stuck on it.
    const screen = new THREE.Mesh(
      new THREE.PlaneGeometry(panelW, panelH),
      // Basic, not Standard: e-ink is the light source of record here. Shading
      // the panel would fight the firmware's own greys.
      new THREE.MeshBasicMaterial({ map: this.tex, toneMapped: false })
    );
    screen.position.set(cx, cy, faceZ + o.zLift);
    screen.name = 'cp-screen';
    this.root.add(screen);
    this.screen = screen;
    this.panelRect = { w: panelW, h: panelH, cx, cy, sideGap, topGap };

    this._addButtons(ctr);
  }

  // Pads over the device's controls so they can be raycast and pressed. Boxes
  // rather than planes so they stay hittable when the device is turned away.
  // Invisible until pressed, then they flash, which is the only press feedback
  // available on a model whose buttons do not actually move.
  _addButtons(ctr) {
    this.buttons = [];

    const mk = (b, w, h, d, pos) => {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(w, h, d),
        new THREE.MeshBasicMaterial({
          color: 0x7aa2f7, transparent: true, opacity: 0, depthWrite: false,
        })
      );
      mesh.position.copy(pos);
      mesh.name = 'cp-btn-' + b.id;
      mesh.userData.button = b;
      mesh.renderOrder = 5;
      this.root.add(mesh);
      this.buttons.push(mesh);
    };

    for (const b of SIDE_BUTTONS) {
      mk(b, 1.6, b.y[1] - b.y[0], 3.4,
         new THREE.Vector3(GEO.buttonX - ctr.x, (b.y[0] + b.y[1]) / 2 - ctr.y, -ctr.z));
    }

    // Front rockers. The moulded slot is only 1.9mm tall, which is a cruel hit
    // target for a mouse, so the box is grown vertically about the slot's centre
    // while staying inside the face. Depth spans the 3.10 face to just past the
    // 3.70 rim crest so the pads always win the raycast against the glass.
    const padH = Math.min(5.4, (FRONT_ROCKER.yMid - (GEO.faceBottom + 0.2)) * 2);
    const padY = FRONT_ROCKER.yMid - ctr.y;
    for (const b of FRONT_BUTTONS) {
      mk(b, b.x[1] - b.x[0], padH, 1.4,
         new THREE.Vector3((b.x[0] + b.x[1]) / 2 - ctr.x, padY, GEO.faceZ + 0.3 - ctr.z));
    }
  }

  // Hit-test a client-space point against the panel and the buttons. Returns
  // {kind:'screen', uv} | {kind:'button', button, mesh} | null. Kept here rather
  // than in the page so three.js stays behind this module's front door.
  pick(clientX, clientY) {
    if (!this._castRay(clientX, clientY)) return null;

    // Buttons first: they stand proud of the case, and a miss on them should
    // still be able to fall through to the panel.
    const bHit = this._ray.intersectObjects(this.buttons, false)[0];
    const sHit = this._ray.intersectObject(this.screen, false)[0];
    if (bHit && (!sHit || bHit.distance <= sHit.distance)) {
      return { kind: 'button', button: bHit.object.userData.button, mesh: bHit.object };
    }
    if (sHit && sHit.uv) return { kind: 'screen', uv: sHit.uv.clone() };
    return null;
  }

  // Where a point lands on the panel's *infinite* plane, clamped to the glass.
  // Used while dragging: a swipe that runs off the edge of the panel should keep
  // tracking to the edge rather than freezing where it left, or the gesture
  // arrives at the firmware too short to clear its swipe threshold.
  projectToPanel(clientX, clientY) {
    if (!this._castRay(clientX, clientY)) return null;
    this.screen.updateMatrixWorld();
    const n = new THREE.Vector3(0, 0, 1)
      .transformDirection(this.screen.matrixWorld).normalize();
    const p0 = new THREE.Vector3().setFromMatrixPosition(this.screen.matrixWorld);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, p0);
    const pt = this._ray.ray.intersectPlane(plane, new THREE.Vector3());
    if (!pt) return null;
    this.screen.worldToLocal(pt);
    const cl = (t) => Math.min(1, Math.max(0, t));
    return new THREE.Vector2(
      cl(pt.x / this.panelRect.w + 0.5),
      cl(pt.y / this.panelRect.h + 0.5)
    );
  }

  _castRay(clientX, clientY) {
    if (!this.screen) return false;
    const r = this.renderer.domElement.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    this._ndc = this._ndc || new THREE.Vector2();
    this._ray = this._ray || new THREE.Raycaster();
    this._ndc.x = ((clientX - r.left) / r.width) * 2 - 1;
    this._ndc.y = -((clientY - r.top) / r.height) * 2 + 1;
    this._ray.setFromCamera(this._ndc, this.camera);
    return true;
  }

  setButtonActive(mesh, on) {
    if (!mesh) return;
    mesh.material.opacity = on ? 0.45 : (this._hints ? 0.22 : 0);
    this._dirty = true;
  }

  // Reveal every hitbox at once. The front rockers are placed by hand (the model
  // does not have them), so being able to see where they landed is how their
  // placement gets checked rather than assumed.
  showButtonHints(on) {
    this._hints = !!on;
    for (const m of this.buttons || []) m.material.opacity = on ? 0.22 : 0;
    this._dirty = true;
  }

  // Inverse of pick(): where a given panel coordinate, or a named button, lands
  // on screen right now. Used by the automated input tests so they can drive
  // real pointer events through the same path a user would, and handy for
  // calibrating placement from the console.
  panelToClient(u, v) {
    if (!this.screen) return null;
    const r = this.renderer.domElement.getBoundingClientRect();
    this.screen.updateMatrixWorld();
    const p = new THREE.Vector3(
      (u - 0.5) * this.panelRect.w,
      (v - 0.5) * this.panelRect.h, 0);
    this.screen.localToWorld(p).project(this.camera);
    return { x: r.left + (p.x * 0.5 + 0.5) * r.width,
             y: r.top + (-p.y * 0.5 + 0.5) * r.height };
  }

  buttonToClient(id) {
    const mesh = (this.buttons || []).find((m) => m.userData.button.id === id);
    if (!mesh) return null;
    const r = this.renderer.domElement.getBoundingClientRect();
    mesh.updateMatrixWorld();
    const p = new THREE.Vector3().setFromMatrixPosition(mesh.matrixWorld);
    p.project(this.camera);
    return { x: r.left + (p.x * 0.5 + 0.5) * r.width,
             y: r.top + (-p.y * 0.5 + 0.5) * r.height };
  }

  _frameCamera(size) {
    const maxDim = Math.max(size.x, size.y, size.z);
    this.modelSize = size.clone ? size.clone() : size;
    // Framing depends on the live aspect, which may have changed between
    // construction and the model finishing loading.
    this.resize();
    // Rough start: fit on BOTH axes. A PerspectiveCamera's fov is vertical, so
    // in a tall narrow viewport a height-only fit silently clips the sides.
    const vTan = Math.tan(this.camera.fov * Math.PI / 360);
    const dist = Math.max(
      (maxDim / 2) / vTan,                                       // fit height
      (maxDim / 2) / (vTan * Math.max(this.camera.aspect, 0.1)), // fit width
    ) * 1.25;
    this.camera.position.set(dist * 0.30, dist * 0.14, dist * 0.94);
    this.camera.lookAt(0, 0, 0);
    this.controls.target.set(0, 0, 0);

    // Then tighten it: the estimate above is a bounding-sphere-ish guess, and
    // the camera's tilt foreshortens the device, so it always leaves the model
    // smaller than it needs to be. Project the real bbox and rescale the
    // distance until the silhouette actually fills the viewport. Orbiting is
    // around the origin, so scaling the position scales the distance.
    const FILL = 0.92;
    const v = new THREE.Vector3();
    for (let i = 0; i < 5; i++) {
      this.camera.updateMatrixWorld();
      this.camera.updateProjectionMatrix();
      let m = 0;
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
        v.set(sx * size.x / 2, sy * size.y / 2, sz * size.z / 2).project(this.camera);
        m = Math.max(m, Math.abs(v.x), Math.abs(v.y));
      }
      const f = m / FILL;
      if (!isFinite(f) || f <= 0 || Math.abs(f - 1) < 0.005) break;
      this.camera.position.multiplyScalar(f);
      this.camera.lookAt(0, 0, 0);
    }

    this.controls.minDistance = maxDim * 0.7;
    this.controls.maxDistance = maxDim * 4;
    this.controls.update();
    this.homeCam = this.camera.position.clone();
  }

  // Pull the panel from the WASM heap if it changed since the last upload.
  syncPanel() {
    // Before the runtime is initialised the exported symbols exist but abort
    // the module when called, so testing for the function is not enough --
    // gate on the page's first-frame latch, which proves main() is running.
    if (!window.__cpFirstFrame) return false;
    const M = window.Module;
    if (!M || !M._cp_fb_sync || !M._cp_fb_ptr) return false;

    let counter;
    try { counter = M._cp_fb_counter(); } catch (e) { return false; }
    if (counter === this.lastFrame) return false;
    this.lastFrame = counter;

    // NOTE: deliberately orientation-blind. See _blit.
    M._cp_fb_sync();
    const ptr = M._cp_fb_ptr();
    // HEAPU8.buffer is a SharedArrayBuffer in this pthreads build, and some
    // browsers refuse a SAB-backed view as a texture source. Copy out. At
    // 800x480 that is 1.5 MB (~0.2 ms) and only when the panel actually
    // changed, which for e-ink is a handful of times a second.
    const src = new Uint8Array(M.HEAPU8.buffer, ptr, this.fbW * this.fbH * 4);
    this._blit(src);
    this.tex.needsUpdate = true;
    return true;
  }

  // Copy the physical panel into the texture.
  //
  // ORIENTATION: intentionally ignored. The framebuffer is always the panel's
  // native 800x480 scanout, and the panel is physically mounted rotated behind
  // portrait glass -- so buffer -> glass is a FIXED transform, no matter what
  // the firmware's orientation setting is. Rotating here as well would be
  // rotating twice.
  //
  // This is where the 2D and 3D views legitimately differ. presentIfNeeded()
  // rotates the SDL *window* so a landscape book is upright on your monitor,
  // which is a convenience: you cannot tilt a monitor. In 3D you can just orbit
  // the model, and the whole point is to show the real device, so landscape
  // content must appear sideways on portrait glass exactly as it does in your
  // hands. cp_fb_orientation() is therefore not consulted by this path.
  //
  // The panel is greyscale (argbGray sets R==G==B), so the ARGB->RGBA byte
  // order difference is invisible and channels copy straight across. That
  // breaks if the panel ever goes colour.
  _blit(src) {
    const W = this.fbW, H = this.fbH;     // 800 x 480 source
    const dst = this.texBuf;              // 480 x 800 destination
    const dw = H;
    // Content sits rotated 90 CCW in the buffer, so undo with 90 CW. Texture v
    // runs bottom-up while image row 0 is the top; folding that flip in here
    // rather than using tex.flipY keeps the raycast UV maths in _addScreen
    // simple.
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const s = (y * W + x) * 4;
        const dx = H - 1 - y;
        const dy = W - 1 - x;             // includes the vertical flip
        const d = (dy * dw + dx) * 4;
        dst[d] = src[s + 2]; dst[d + 1] = src[s + 1];
        dst[d + 2] = src[s]; dst[d + 3] = 255;
      }
    }
  }

  resize() {
    const w = this.host.clientWidth || 640;
    const h = this.host.clientHeight || 900;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    // Re-fit after a window resize, but only while the view is untouched --
    // once the user has orbited or zoomed, their framing is theirs to keep.
    if (this.homeCam && this.modelSize && !this._reframing &&
        this.camera.position.distanceTo(this.homeCam) < this.homeCam.length() * 0.002) {
      this._reframing = true;
      this._frameCamera(this.modelSize);
      this._reframing = false;
    }
    this._dirty = true;
  }

  resetView() {
    if (!this.homeCam) return;
    this.camera.position.copy(this.homeCam);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  start() {
    if (this._raf) return;
    const tick = () => {
      this._raf = requestAnimationFrame(tick);
      // Both of these are cheap and must run every frame regardless: syncPanel
      // early-outs on an unchanged frame counter, and controls.update() is the
      // thing that advances damping (and fires 'change', setting _dirty).
      if (this.syncPanel()) this._dirty = true;
      this.controls.update();

      const now = performance.now();
      // Damping keeps the camera moving after the pointer lifts, and the lower
      // the frame rate the longer that tail lasts in wall-clock terms (it
      // decays per frame, not per second) -- so "moving" has to outlast 'end'.
      const moving = this._dragging || (now - this._lastChange) < 180;
      if (!moving && this._scale !== 1) {
        this._setScale(1);          // motion stopped: put the crisp image back
        this._frameEma = null;
      }

      if (!this._dirty) {
        this._lastRenderT = 0;      // don't count an idle gap as a slow frame
        return;
      }
      this._dirty = false;

      if (moving && this._lastRenderT) {
        const dt = now - this._lastRenderT;
        this._frameEma = this._frameEma === null
          ? dt : this._frameEma * 0.8 + dt * 0.2;
        // ~45 fps. Step down only while motion is actually costing frames.
        if (this._frameEma > 22 && this._scale > 0.5) {
          this._setScale(this._scale > 0.75 ? 0.75 : 0.5);
          this._frameEma = null;    // re-measure at the new resolution
        }
      }
      this._lastRenderT = now;

      this.renderer.render(this.scene, this.camera);
    };
    this._raf = requestAnimationFrame(tick);
  }

  // Force a redraw on the next frame. Anything that mutates the scene outside
  // of the camera and the panel must call this, or its change will not appear.
  invalidate() { this._dirty = true; }

  _setScale(s) {
    if (this._scale === s) return;
    this._scale = s;
    const c = this.renderer.domElement;
    this.renderer.setPixelRatio(this._fullPR * s);
    // updateStyle=false: the canvas is positioned by CSS (inset:0), so its
    // layout size must not be touched -- only the drawing buffer.
    this.renderer.setSize(c.clientWidth, c.clientHeight, false);
    this._dirty = true;
  }

  stop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  }
}
