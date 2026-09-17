// Copy runtime/framebuffer.{js,d.ts} and runtime/frontlight.{js,d.ts} with this
// component into silkscreen-site. Render inside its existing <Canvas>; pass the
// initialized WASM module and a readiness callback driven by cpwebFirstFrame.
// No second renderer is created.
//
// The panel is a lit surface, not a light: e-paper reflects the scene's light,
// so give the Canvas an environment or lights. The firmware's frontlight is the
// only emissive term, tinted by its warmth and scaled by its brightness.
import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { FramebufferReader, type FramebufferModule } from '../runtime/framebuffer.js';
import { readFrontlight, frontlightEmissive, einkLut, applyLut } from '../runtime/frontlight.js';

export function LivePanel({ getModule, isReady, width = 0.0591, height = 0.0985, glow = 0.9 }: {
  getModule: () => FramebufferModule | null | undefined;
  isReady: () => boolean;
  width?: number;
  height?: number;
  /** Emissive strength at 100% frontlight brightness */
  glow?: number;
}) {
  const material = useRef<THREE.MeshStandardMaterial>(null);
  const texture = useRef<THREE.DataTexture | null>(null);
  const reader = useMemo(() => new FramebufferReader(getModule, isReady), [getModule, isReady]);
  const lut = useMemo(() => einkLut(), []);
  const light = useRef({ on: false, brightness: -1, warmth: -1 });
  useEffect(() => () => {
    texture.current?.dispose();
    texture.current = null;
    if (material.current) material.current.map = material.current.emissiveMap = null;
  }, [reader]);
  useFrame(() => {
    if (!material.current) return;
    const frame = reader.read();
    if (frame) {
      if (!texture.current || texture.current.image.width !== frame.width || texture.current.image.height !== frame.height) {
        texture.current?.dispose();
        texture.current = new THREE.DataTexture(frame.pixels, frame.width, frame.height, THREE.RGBAFormat);
        texture.current.colorSpace = THREE.SRGBColorSpace;
        texture.current.magFilter = THREE.NearestFilter;
        texture.current.minFilter = THREE.LinearFilter;
        material.current.map = material.current.emissiveMap = texture.current;
        material.current.needsUpdate = true;
      }
      // In place: the reader reuses this buffer and only returns it on a new frame.
      texture.current.image.data = applyLut(frame.pixels, lut);
      texture.current.needsUpdate = true;
    }
    // Gated on the same readiness latch as the framebuffer: the frontlight
    // exports abort the runtime if called before it has initialized.
    const state = readFrontlight(getModule(), isReady);
    const last = light.current;
    if (state.on !== last.on || state.brightness !== last.brightness || state.warmth !== last.warmth) {
      light.current = { on: state.on, brightness: state.brightness, warmth: state.warmth };
      const { color, intensity } = frontlightEmissive(state, glow);
      material.current.emissive.setRGB(color[0], color[1], color[2], THREE.LinearSRGBColorSpace);
      material.current.emissiveIntensity = intensity;
    }
  });
  return (
    <mesh receiveShadow>
      <planeGeometry args={[width, height]} />
      <meshStandardMaterial ref={material} roughness={0.92} metalness={0} emissive="#000000" emissiveIntensity={0} />
    </mesh>
  );
}
