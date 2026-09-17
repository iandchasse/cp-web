export interface FramebufferModule {
  HEAPU8: Uint8Array;
  _cp_fb_counter(): number;
  _cp_fb_sync(): number;
  _cp_fb_ptr(): number;
  _cp_fb_width(): number;
  _cp_fb_height(): number;
}
export interface PanelFrame {
  pixels: Uint8Array<ArrayBuffer>;
  width: number;
  height: number;
  frame: number;
}
export class FramebufferReader {
  constructor(getModule: () => FramebufferModule | null | undefined, isReady: () => boolean);
  read(): PanelFrame | null;
}
export function rotatePanel(src: Uint8Array, dst: Uint8Array, width: number, height: number): void;
