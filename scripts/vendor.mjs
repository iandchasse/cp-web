// Keep the static deployment npm-free while making vendor updates reproducible.
import { readFile, writeFile } from 'node:fs/promises';
import { transform } from 'esbuild';

const root = new URL('../', import.meta.url);
const files = [
  ['three/build/three.module.js', 'three.module.min.js'],
  ['three/build/three.core.js', 'three.core.min.js'],
  ['three/examples/jsm/controls/OrbitControls.js', 'OrbitControls.js'],
  ['three/examples/jsm/loaders/3MFLoader.js', '3MFLoader.js'],
  ['three/examples/jsm/utils/BufferGeometryUtils.js', 'BufferGeometryUtils.js'],
  ['fflate/esm/browser.js', 'fflate.module.js'],
  ['three/LICENSE', 'LICENSE.three'],
  ['fflate/LICENSE', 'LICENSE.fflate'],
];
for (const [source, dest] of files) {
  let content = await readFile(new URL('node_modules/' + source, root), 'utf8');
  if (dest.endsWith('.min.js')) {
    content = content.replaceAll('./three.core.js', './three.core.min.js');
    content = (await transform(content, {
      minify: true, format: 'esm', legalComments: 'inline',
      supported: { 'template-literal': false },
    })).code;
  }
  if (source.startsWith('three/examples/')) {
    content = content.replaceAll("from 'three'", "from './three.module.min.js'")
      .replaceAll("from '../libs/fflate.module.js'", "from './fflate.module.js'")
      .replaceAll("from '../utils/BufferGeometryUtils.js'", "from './BufferGeometryUtils.js'");
  }
  const target = new URL('three/' + dest, root);
  if (process.argv.includes('--check')) {
    if (content !== await readFile(target, 'utf8')) throw new Error('Vendor drift: ' + dest);
  } else {
    await writeFile(target, content);
  }
}
console.log(process.argv.includes('--check') ? 'Vendor files verified.' : 'Vendor files updated.');
