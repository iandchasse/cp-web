export interface FrontlightState {
  present: boolean;
  on: boolean;
  /** 0..100 */
  brightness: number;
  /** 0..100, 0 = coolest */
  warmth: number;
}

export interface FrontlightEmissive {
  /** Linear RGB, each 0..1 */
  color: [number, number, number];
  intensity: number;
}

/** Read the frontlight from the simulator's exports; off when a build lacks them. */
export function readFrontlight(module: unknown): FrontlightState;

/** Emissive colour and strength for a lit panel material; intensity is 0 when off. */
export function frontlightEmissive(state: Pick<FrontlightState, 'on' | 'brightness' | 'warmth'>, glow?: number): FrontlightEmissive;

/** 256-entry table mapping framebuffer grey to e-paper reflectance, in sRGB. */
export function einkLut(white?: number, black?: number): Uint8Array;

/** Apply a LUT in place to RGBA pixels; alpha is untouched. Returns `pixels`. */
export function applyLut(pixels: Uint8Array, lut: Uint8Array): Uint8Array;
