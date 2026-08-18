/**
 * Remove the modelled bowstring from the bow mesh.
 *
 * The generated bow is one merged mesh, so the string cannot be hidden by node
 * or material — but it can be found geometrically. A bowstring is by definition
 * the straight run between the two limb tips, so any triangle sitting within a
 * hair of that line, and away from the tips where the limbs meet it, is string.
 *
 * Removing it lets the game draw a string that actually bends with the draw
 * instead of leaving a rigid straight one crossing it.
 *
 *   node tools/strip-bowstring.mjs        (writes assets_raw/bow.glb in place)
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NodeIO } from '@gltf-transform/core';

const here = dirname(fileURLToPath(import.meta.url));
const bowPath = join(resolve(here, '..'), 'assets_raw', 'bow.glb');

/** How close to the tip-to-tip line counts as string, relative to bow height. */
const STRING_RADIUS = 0.045;
/** Skip this much at each end, where the limbs themselves reach the string. */
const TIP_MARGIN = 0.06;

const io = new NodeIO();
const document = await io.read(bowPath);

for (const mesh of document.getRoot().listMeshes()) {
  for (const primitive of mesh.listPrimitives()) {
    const position = primitive.getAttribute('POSITION');
    const indices = primitive.getIndices();
    if (!position || !indices) continue;

    const min = position.getMin([0, 0, 0]);
    const max = position.getMax([0, 0, 0]);
    const height = max[1] - min[1];
    const radius = height * STRING_RADIUS;

    // The string runs tip to tip. Both tips sit at the extremes of the long
    // axis, on whichever side of the bow is flat — take the extreme vertices.
    let topIndex = -1;
    let bottomIndex = -1;
    let topY = -Infinity;
    let bottomY = Infinity;
    const vertex = [0, 0, 0];
    for (let i = 0; i < position.getCount(); i += 1) {
      position.getElement(i, vertex);
      if (vertex[1] > topY) {
        topY = vertex[1];
        topIndex = i;
      }
      if (vertex[1] < bottomY) {
        bottomY = vertex[1];
        bottomIndex = i;
      }
    }
    if (topIndex < 0 || bottomIndex < 0) continue;

    const top = [0, 0, 0];
    const bottom = [0, 0, 0];
    position.getElement(topIndex, top);
    position.getElement(bottomIndex, bottom);

    const axis = [top[0] - bottom[0], top[1] - bottom[1], top[2] - bottom[2]];
    const axisLengthSq = axis[0] ** 2 + axis[1] ** 2 + axis[2] ** 2;
    if (axisLengthSq < 1e-9) continue;

    /** Perpendicular distance to the tip-to-tip line, plus where along it. */
    const measure = (point) => {
      const rel = [point[0] - bottom[0], point[1] - bottom[1], point[2] - bottom[2]];
      const t = (rel[0] * axis[0] + rel[1] * axis[1] + rel[2] * axis[2]) / axisLengthSq;
      const closest = [bottom[0] + axis[0] * t, bottom[1] + axis[1] * t, bottom[2] + axis[2] * t];
      const dx = point[0] - closest[0];
      const dy = point[1] - closest[1];
      const dz = point[2] - closest[2];
      return { t, distance: Math.sqrt(dx * dx + dy * dy + dz * dz) };
    };

    const kept = [];
    let dropped = 0;
    const a = [0, 0, 0];
    const b = [0, 0, 0];
    const c = [0, 0, 0];

    for (let i = 0; i < indices.getCount(); i += 3) {
      const ia = indices.getScalar(i);
      const ib = indices.getScalar(i + 1);
      const ic = indices.getScalar(i + 2);
      position.getElement(ia, a);
      position.getElement(ib, b);
      position.getElement(ic, c);

      const centroid = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
      const { t, distance } = measure(centroid);

      const isString = distance < radius && t > TIP_MARGIN && t < 1 - TIP_MARGIN;
      if (isString) dropped += 1;
      else kept.push(ia, ib, ic);
    }

    const total = indices.getCount() / 3;
    const percent = ((dropped / total) * 100).toFixed(1);
    console.log(`triangles: ${total}  removed: ${dropped} (${percent}%)`);

    if (dropped === 0) {
      console.log('nothing matched the string — leaving the mesh alone');
      continue;
    }
    if (dropped / total > 0.35) {
      console.log('that is too much to be a string — refusing to write');
      process.exit(1);
    }

    indices.setArray(new Uint32Array(kept));
  }
}

await io.write(bowPath, document);
console.log(`wrote ${bowPath}`);
