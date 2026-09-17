/** Frontlight state and how it should light a rendered e-ink panel.
 *
 * The firmware never changes the framebuffer for the frontlight, exactly as on
 * the device: the LEDs sit in the glass above the ink. So a rendered panel has
 * to add the glow itself. This maps the firmware's on/brightness/warmth to an
 * emissive colour and strength for a physically lit material; the panel's
 * diffuse look (paper grey, ink black) is separate, see einkLut().
 */

const OFF = { present: false, on: false, brightness: 0, warmth: 0 };

/** Read the frontlight from the simulator exports; off until the runtime is up.
 *
 * `isReady` must be the firmware's real first-frame latch, not a timeout and
 * not a check that the export exists: before initialization Emscripten installs
 * stubs that ABORT the whole runtime when called, so "is the function defined?"
 * is not a safe test. Same rule as FramebufferReader. Builds without the
 * exports (an older WASM bundle) report the light off rather than throwing.
 */
export function readFrontlight(module, isReady = () => false) {
  if (!isReady() || !module?._cp_frontlight_on) return OFF;
  return {
    present: !!module._cp_frontlight_present(),
    on: !!module._cp_frontlight_on(),
    brightness: module._cp_frontlight_brightness(),
    warmth: module._cp_frontlight_warmth(),
  };
}

// Linear-light tints of the two LED strings on an X4 Pro: a slightly blue
// cool white and an amber warm one. Warmth mixes between them.
const COOL = [0.78, 0.86, 1.0];
const WARM = [1.0, 0.62, 0.30];

/**
 * Emissive colour (linear RGB, 0..1) and intensity for a panel material.
 * `glow` scales the brightest setting; intensity is 0 whenever the light is off.
 */
export function frontlightEmissive({ on, brightness, warmth }, glow = 1) {
  const level = Math.min(100, Math.max(0, brightness || 0)) / 100;
  if (!on || level === 0) return { color: [0, 0, 0], intensity: 0 };
  const mix = Math.min(100, Math.max(0, warmth || 0)) / 100;
  const color = COOL.map((cool, i) => cool * (1 - mix) + WARM[i] * mix);
  // Perceived brightness on the device is far from linear in the percentage:
  // the first steps matter most. A power curve keeps 10% clearly visible
  // without letting 100% bleach the ink.
  return { color, intensity: glow * (0.12 + 0.88 * Math.pow(level, 1.4)) };
}

/**
 * Lookup table mapping framebuffer grey (0..255) to what the ink reflects, in
 * sRGB. E-paper is not paper white: ~45% reflectance for white and ~4% for
 * black, which under scene lighting reads as light grey and dark charcoal.
 */
export function einkLut(white = 222, black = 52) {
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) lut[v] = Math.round(black + (white - black) * v / 255);
  return lut;
}

/** Apply a LUT in place to an RGBA buffer, leaving alpha alone. */
export function applyLut(pixels, lut) {
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = lut[pixels[i]];
    pixels[i + 1] = lut[pixels[i + 1]];
    pixels[i + 2] = lut[pixels[i + 2]];
  }
  return pixels;
}
