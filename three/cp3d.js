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
import { RoomEnvironment } from './RoomEnvironment.js';
import { FramebufferReader } from '../runtime/framebuffer.js';
import { readFrontlight, frontlightEmissive, einkLut, applyLut } from '../runtime/frontlight.js';

const MODEL_URL = new URL('./x4-device.3mf', import.meta.url);

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
  // The panel is lit like a real e-paper display, not shown as a light source:
  // ink and paper are diffuse surfaces under the scene's lights, and only the
  // firmware's frontlight adds glow. These are the reflectances (sRGB) the
  // framebuffer's pure white and black map to, and how strong 100% light is.
  einkWhite: 236,
  einkBlack: 34,
  glow: 1.8,      // emissive at 100%: well past paper white, so a lit panel reads as lit
  exposure: 1.15, // overall scene brightness; e-paper in a bright room, not overcast
  shadows: true,
};

export class Device3D {
  constructor(host, opts = {}) {
    this.host = host;
    this.opts = { ...DEFAULTS, ...opts };
    this.modelUrl = opts.modelUrl || MODEL_URL;
    this.framebuffer = new FramebufferReader(
      opts.getModule || (() => window.Module),
      opts.isReady || (() => !!window.__cpFirstFrame),
    );
    // Frontlight state comes from the firmware too. Injectable for hosts that
    // do not use window.Module, like the framebuffer above.
    this.getFrontlight = opts.getFrontlight || (() => readFrontlight(window.Module));
    this.lut = einkLut(this.opts.einkWhite, this.opts.einkBlack);
    this.frontlight = { on: false, brightness: 0, warmth: 0 };
    this._abort = new AbortController();
    this._disposed = false;
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
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h, false);
    // Tone mapping so a lit frontlight can go brighter than paper white without
    // clipping to a flat block. Neutral (Khronos PBR) rather than ACES: ACES
    // desaturates and rolls off the mid-tones, which read as a muted, overcast
    // scene; Neutral keeps paper white white and only compresses the top end.
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = this.opts.exposure;
    if (this.opts.shadows) {
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    }
    // Out of flow on purpose: the host's height comes from flex, and the canvas
    // is sized from the host, so leaving it in flow would be circular.
    this.renderer.domElement.style.cssText =
      'display:block;position:absolute;inset:0;width:100%;height:100%;';
    this.host.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(30, w / h, 1, 4000);

    // Image-based lighting from a neutral studio room gives the case its soft
    // reflections and the panel an even ambient, the way a device on a desk is
    // lit by the room rather than by three spotlights. One key light on top of
    // that provides direction and the shadow.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    this.scene.environment = this.envMap;
    this.scene.environmentIntensity = 1.15;

    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(-120, 220, 240);
    if (this.opts.shadows) {
      key.castShadow = true;
      key.shadow.mapSize.set(2048, 2048);
      key.shadow.bias = -0.0004;
      key.shadow.normalBias = 0.4;   // model units are millimetres
      key.shadow.radius = 4;
    }
    this.scene.add(key);
    this.keyLight = key;
    const fill = new THREE.DirectionalLight(0xe8eef8, 0.5);
    fill.position.set(220, -40, 140);
    this.scene.add(fill);

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
    this.controls.addEventListener('change', () => { this._dirty = true; });

    // ---- Why there is NO adaptive resolution here ---------------------------
    // A previous version stepped the pixel ratio down (1 -> 0.75 -> 0.5) while
    // the camera moved, driven by an EMA of the frame delta. It was removed
    // because the control loop was unsound in two separate ways:
    //
    // 1. WRONG SIGNAL. The frame delta it measured is wall-clock time between
    //    rendered frames on a main thread SHARED with Emscripten's main_tick
    //    (the firmware). The firmware alone floors that delta well above the
    //    22 ms trip point, and no amount of shrinking our drawing buffer can
    //    move it. So the loop never saw the improvement it was waiting for and
    //    ratcheted straight to the 0.5 floor -- and because it only restored
    //    resolution once motion STOPPED, a sustained orbit could only ever step
    //    down. That is the "goes pixely after a couple of seconds" report.
    //
    // 2. THE CURE CAUSED THE DISEASE. Each step called setPixelRatio + setSize,
    //    which reallocates the drawing buffer, the depth buffer and (antialias
    //    is on) the MSAA buffers, synchronously, mid-drag. One orbit gesture
    //    paid up to three of those stalls.
    //
    // The original "quartering the pixels halves the frame cost" measurement
    // was taken on the SwiftShader QA box -- a CPU rasterizer, pathologically
    // fill-bound. On a real GPU this scene is 9 draw calls and ~64k triangles,
    // so there is nothing to reclaim and the reallocations are pure loss.
    // If a genuinely fill-bound machine ever needs help, the only sound signal
    // is the DIFFERENCE between frame deltas with and without our render (the
    // on-demand loop below already produces both), not the absolute delta.

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
    this.texBuf.fill(0xff); // start white, like a cleared panel...
    applyLut(this.texBuf, this.lut); // ...which on e-paper is light grey
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
    const buf = await fetch(this.modelUrl, { signal: this._abort.signal }).then((r) => {
      if (!r.ok) throw new Error('model fetch failed: ' + r.status);
      return r.arrayBuffer();
    });
    if (this._disposed) throw new Error('Device3D disposed');
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
      // Replace the model's flat #9DCFED with a matte dark plastic. Standard
      // (PBR) rather than the Phong an earlier version chose for fill-rate on
      // the SwiftShader QA box: with an environment map the difference is the
      // whole point -- soft room reflections are what make the case read as a
      // real object -- and rendering is on demand, so the cost is per change,
      // not per frame.
      const materials = Array.isArray(n.material) ? n.material : [n.material];
      for (const material of materials) {
        for (const value of Object.values(material)) if (value?.isTexture) value.dispose();
        material.dispose();
      }
      n.material = new THREE.MeshStandardMaterial({
        color: 0x363b43, roughness: 0.45, metalness: 0.05, envMapIntensity: 1.0,
        vertexColors: false,
      });
      n.castShadow = n.receiveShadow = !!this.opts.shadows;
    });
    this.tris = Math.round(tris);

    const box = new THREE.Box3().setFromObject(obj);
    const size = box.getSize(new THREE.Vector3());
    const ctr = box.getCenter(new THREE.Vector3());
    obj.position.sub(ctr);            // centre the model on the origin
    this.root.add(obj);
    this.size = size;

    if (this.opts.shadows) this._addGround(size);

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
    //
    // E-paper is a reflective display: the ink is a diffuse surface that the
    // room lights, not a backlit LCD. So the panel is a lit, fully rough
    // material whose map is the framebuffer already remapped to e-paper
    // reflectances (see einkLut). The firmware's frontlight is the only thing
    // that makes it emit: the same texture as an emissive map, tinted and
    // scaled by the light's warmth and brightness, so lit paper glows while
    // ink stays dark -- which is what an edge-lit panel actually does.
    const screen = new THREE.Mesh(
      new THREE.PlaneGeometry(panelW, panelH),
      new THREE.MeshStandardMaterial({
        map: this.tex, roughness: 0.85, metalness: 0, envMapIntensity: 0.8,
        emissiveMap: this.tex, emissive: 0x000000, emissiveIntensity: 0,
      })
    );
    screen.position.set(cx, cy, faceZ + o.zLift);
    screen.name = 'cp-screen';
    screen.receiveShadow = !!o.shadows;
    this.root.add(screen);
    this.screen = screen;
    this.panelRect = { w: panelW, h: panelH, cx, cy, sideGap, topGap };

    // Light leaking past the glass edge onto the bezel when the frontlight is
    // on: a faint additive halo just behind the panel plane, so only a thin
    // ring around it shows. The real light guides contain their light well,
    // so this is barely there. Invisible until the light comes on.
    const halo = new THREE.Mesh(
      new THREE.PlaneGeometry(panelW * 1.08, panelH * 1.05),
      new THREE.MeshBasicMaterial({
        map: this._haloTexture(), color: 0xffffff, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
      })
    );
    halo.position.set(cx, cy, faceZ + o.zLift - 0.02);
    halo.name = 'cp-halo';
    halo.renderOrder = 2;
    this.root.add(halo);
    this.halo = halo;

    this._applyFrontlight(this.getFrontlight(), true);
    this._addButtons(ctr);
  }

  // Radial falloff for the frontlight halo; generated once, 128 px is plenty
  // for a soft gradient that is only ever seen through additive blending.
  _haloTexture() {
    if (typeof document === 'undefined') return null;
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createRadialGradient(size / 2, size / 2, size * 0.28, size / 2, size / 2, size * 0.5);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  // Push firmware frontlight state into the panel's emissive term and the halo.
  // Called every frame from the render loop; cheap when nothing changed.
  _applyFrontlight(state, force = false) {
    const same = !force && state.on === this.frontlight.on &&
      state.brightness === this.frontlight.brightness && state.warmth === this.frontlight.warmth;
    if (same) return false;
    this.frontlight = { on: !!state.on, brightness: state.brightness | 0, warmth: state.warmth | 0 };
    const { color, intensity } = frontlightEmissive(this.frontlight, this.opts.glow);
    if (this.screen) {
      const material = this.screen.material;
      material.emissive.setRGB(color[0], color[1], color[2], THREE.LinearSRGBColorSpace);
      material.emissiveIntensity = intensity;
    }
    if (this.halo) {
      this.halo.material.color.setRGB(color[0], color[1], color[2], THREE.LinearSRGBColorSpace);
      this.halo.material.opacity = Math.min(0.12, intensity * 0.06);
      this.halo.visible = intensity > 0;
    }
    this._dirty = true;
    return true;
  }

  // A shadow catcher under the device. Only the shadow renders (ShadowMaterial
  // is otherwise invisible), so the background stays the page's own.
  _addGround(size) {
    const extent = Math.max(size.x, size.y, size.z) * 4;
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(extent, extent),
      new THREE.ShadowMaterial({ opacity: 0.32, transparent: true })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -size.y / 2 - 0.6;
    ground.receiveShadow = true;
    ground.name = 'cp-ground';
    this.scene.add(ground);
    this.ground = ground;
    // Fit the shadow camera to the device rather than the default 10-unit box.
    const cam = this.keyLight.shadow.camera;
    const half = Math.max(size.x, size.y, size.z) * 0.9;
    cam.left = -half; cam.right = half; cam.top = half; cam.bottom = -half;
    cam.near = 1; cam.far = 1200;
    cam.updateProjectionMatrix();
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

  // The runtime adapter is reusable with React Three Fiber or another renderer.
  syncPanel() {
    const frame = this.framebuffer.read();
    if (!frame) return false;
    if (this.fbW !== frame.height || this.fbH !== frame.width) {
      this.fbW = frame.height;
      this.fbH = frame.width;
      this.tex.dispose();
      this._buildPanelTexture();
      if (this.screen) {
        this.screen.material.map = this.tex;
        this.screen.material.needsUpdate = true;
        const height = this.opts.panelW * this.fbW / this.fbH;
        this.screen.position.y += (this.panelRect.h - height) / 2;
        this.screen.geometry.dispose();
        this.screen.geometry = new THREE.PlaneGeometry(this.opts.panelW, height);
        this.panelRect.h = height;
      }
    }
    // Ink and paper reflectances, not the framebuffer's absolute black/white.
    // In place: the reader owns and reuses this buffer, and hands it over only
    // when the frame actually changed, so this runs a few times a second.
    this.texBuf = applyLut(frame.pixels, this.lut);
    this.tex.image.data = this.texBuf;
    this.tex.needsUpdate = true;
    this.lastFrame = frame.frame;
    return true;
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
    if (this._raf || this._disposed) return;
    const tick = () => {
      this._raf = requestAnimationFrame(tick);
      // Both of these are cheap and must run every frame regardless: syncPanel
      // early-outs on an unchanged frame counter, and controls.update() is the
      // thing that advances damping (and fires 'change', setting _dirty).
      if (this.syncPanel()) this._dirty = true;
      if (this.screen) this._applyFrontlight(this.getFrontlight());
      this.controls.update();

      if (!this._dirty) return;
      this._dirty = false;

      this.renderer.render(this.scene, this.camera);
    };
    this._raf = requestAnimationFrame(tick);
  }

  // Force a redraw on the next frame. Anything that mutates the scene outside
  // of the camera and the panel must call this, or its change will not appear.
  invalidate() { this._dirty = true; }

  stop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  }

  // React effects and failed loads must release both CPU and GPU resources.
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._abort.abort();
    this.stop();
    window.removeEventListener('resize', this._onResize);
    this._ro?.disconnect();
    this.controls.dispose();
    const resources = new Set([this.tex, this.envMap].filter(Boolean));
    this.scene.traverse((node) => {
      if (node.geometry) resources.add(node.geometry);
      const materials = node.material ? (Array.isArray(node.material) ? node.material : [node.material]) : [];
      for (const material of materials) {
        resources.add(material);
        for (const value of Object.values(material)) if (value?.isTexture) resources.add(value);
      }
    });
    for (const resource of resources) resource.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
    this.ready = false;
  }
}
