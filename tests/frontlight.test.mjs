import test from 'node:test';
import assert from 'node:assert/strict';
import { readFrontlight, frontlightEmissive, einkLut, applyLut } from '../runtime/frontlight.js';

const OFF = { present: false, on: false, brightness: 0, warmth: 0 };

test('frontlight reads the simulator exports and is off for builds without them', () => {
  assert.deepEqual(readFrontlight({}, () => true), OFF);
  const module = { _cp_frontlight_present: () => 1, _cp_frontlight_on: () => 1,
    _cp_frontlight_brightness: () => 60, _cp_frontlight_warmth: () => 50 };
  assert.deepEqual(readFrontlight(module, () => true), { present: true, on: true, brightness: 60, warmth: 50 });
});

test('frontlight never calls an export before the runtime is ready', () => {
  // Emscripten installs abort-on-call stubs until initialization finishes, so
  // a defined export is not a callable one. Reading one aborts the runtime.
  const abort = () => { throw new Error('native function called before runtime initialization'); };
  const stubs = { _cp_frontlight_present: abort, _cp_frontlight_on: abort,
    _cp_frontlight_brightness: abort, _cp_frontlight_warmth: abort };
  assert.deepEqual(readFrontlight(stubs, () => false), OFF);
  assert.deepEqual(readFrontlight(stubs), OFF, 'no readiness check given: assume not ready');
});

test('frontlight emissive is dark when off, tinted by warmth, and monotonic in brightness', () => {
  assert.equal(frontlightEmissive({ on: false, brightness: 100, warmth: 0 }).intensity, 0);
  assert.equal(frontlightEmissive({ on: true, brightness: 0, warmth: 0 }).intensity, 0);
  const cool = frontlightEmissive({ on: true, brightness: 60, warmth: 0 });
  const warm = frontlightEmissive({ on: true, brightness: 60, warmth: 100 });
  assert.ok(cool.color[2] > cool.color[0], 'cool white leans blue');
  assert.ok(warm.color[0] > warm.color[2], 'warm leans amber');
  assert.equal(cool.intensity, warm.intensity, 'warmth does not change brightness');
  let last = 0;
  for (const level of [1, 10, 25, 50, 75, 100]) {
    const { intensity } = frontlightEmissive({ on: true, brightness: level, warmth: 30 });
    assert.ok(intensity > last, `brightness ${level} brighter than the step before`);
    last = intensity;
  }
  assert.equal(frontlightEmissive({ on: true, brightness: 100, warmth: 0 }, 2).intensity, 2 * last);
});

test('e-ink LUT maps framebuffer white and black to reflectance and leaves alpha alone', () => {
  const lut = einkLut(222, 52);
  assert.equal(lut[255], 222);
  assert.equal(lut[0], 52);
  assert.ok(lut[128] > 52 && lut[128] < 222);
  const pixels = Uint8Array.of(255, 255, 255, 255, 0, 0, 0, 255);
  assert.deepEqual([...applyLut(pixels, lut)], [222, 222, 222, 255, 52, 52, 52, 255]);
});
