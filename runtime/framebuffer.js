/** Framework-independent reader for the simulator's physical ARGB panel.
 * Call read() only after the real first-frame callback, never a boot timeout.
 * Returned RGBA pixels are bottom-up portrait data, suitable for DataTexture.
 */
export class FramebufferReader {
  constructor(getModule, isReady) {
    this.getModule = getModule;
    this.isReady = isReady;
    this.module = null;
    this.frame = -1;
    this.pixels = null;
  }

  read() {
    if (!this.isReady()) return null;
    const module = this.getModule();
    if (!module?._cp_fb_counter || !module._cp_fb_sync || !module._cp_fb_ptr) return null;
    if (module === this.module && module._cp_fb_counter() === this.frame) return null;
    const width = module._cp_fb_width();
    const height = module._cp_fb_height();
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new Error('Invalid framebuffer dimensions');
    }
    const frame = module._cp_fb_sync();
    const ptr = module._cp_fb_ptr();
    // Reacquire after sync: memory growth replaces Emscripten's heap views.
    const src = new Uint8Array(module.HEAPU8.buffer, ptr, width * height * 4);
    if (!this.pixels || this.pixels.length !== src.length) this.pixels = new Uint8Array(src.length);
    rotatePanel(src, this.pixels, width, height);
    this.module = module;
    this.frame = frame;
    return { pixels: this.pixels, width: height, height: width, frame };
  }
}

export function rotatePanel(src, dst, width, height) {
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4;
      const d = ((width - 1 - x) * height + height - 1 - y) * 4;
      dst[d] = src[s + 2];
      dst[d + 1] = src[s + 1];
      dst[d + 2] = src[s];
      dst[d + 3] = 255;
    }
  }
}
