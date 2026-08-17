/** Print each raw mesh's bounding box so orientation guesses can be checked. */
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NodeIO } from '@gltf-transform/core';

const here = dirname(fileURLToPath(import.meta.url));
const dir = resolve(here, '..', 'assets_raw');
const io = new NodeIO();

for (const name of readdirSync(dir).filter((n) => n.endsWith('.glb'))) {
  const doc = await io.read(join(dir, name));
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];

  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const position = prim.getAttribute('POSITION');
      if (!position) continue;
      const lo = position.getMin([0, 0, 0]);
      const hi = position.getMax([0, 0, 0]);
      for (let i = 0; i < 3; i += 1) {
        min[i] = Math.min(min[i], lo[i]);
        max[i] = Math.max(max[i], hi[i]);
      }
    }
  }

  const size = { x: max[0] - min[0], y: max[1] - min[1], z: max[2] - min[2] };
  const longest = size.x >= size.y && size.x >= size.z ? 'X' : size.y >= size.z ? 'Y' : 'Z';
  console.log(
    `${name.padEnd(18)} size = ${size.x.toFixed(2)} x ${size.y.toFixed(2)} x ${size.z.toFixed(2)}   longest=${longest}`,
  );
}
