// Copy runtime/framebuffer.{js,d.ts} with this component into silkscreen-site.
// Render inside its existing <Canvas>; pass the initialized WASM module and
// a readiness callback driven by cpwebFirstFrame. No second renderer is created.
import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { FramebufferReader, type FramebufferModule } from '../runtime/framebuffer.js';

export function LivePanel({ getModule, isReady, width = 0.0591, height = 0.0985 }: {
  getModule: () => FramebufferModule | null | undefined;
  isReady: () => boolean;
  width?: number;
  height?: number;
}) {
  const material = useRef<THREE.MeshBasicMaterial>(null);
  const texture = useRef<THREE.DataTexture | null>(null);
  const reader = useMemo(() => new FramebufferReader(getModule, isReady), [getModule, isReady]);
  useEffect(() => () => {
    texture.current?.dispose();
    texture.current = null;
    if (material.current) material.current.map = null;
  }, [reader]);
  useFrame(() => {
    const frame = reader.read();
    if (!frame || !material.current) return;
    if (!texture.current || texture.current.image.width !== frame.width || texture.current.image.height !== frame.height) {
      texture.current?.dispose();
      texture.current = new THREE.DataTexture(frame.pixels, frame.width, frame.height, THREE.RGBAFormat);
      texture.current.colorSpace = THREE.SRGBColorSpace;
      texture.current.magFilter = THREE.NearestFilter;
      texture.current.minFilter = THREE.LinearFilter;
      material.current.map = texture.current;
      material.current.needsUpdate = true;
    }
    texture.current.image.data = frame.pixels;
    texture.current.needsUpdate = true;
  });
  return (
    <mesh>
      <planeGeometry args={[width, height]} />
      <meshBasicMaterial ref={material} toneMapped={false} />
    </mesh>
  );
}
