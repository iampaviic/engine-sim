// The app's fallback for hosts that refuse the worklet's URL joins its
// modules into one script (js/audio/worklet-bundle.js). This renders the same
// few seconds through the modules and through that script and fails unless
// the two are identical, sample for sample.
//   node tools/check-bundle.mjs
import { readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { render } from './render.mjs';
import { bundleWorklet } from '../js/audio/worklet-bundle.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = pathToFileURL(path.join(root, 'js/audio/engine-worklet.js')).href;
const src = await bundleWorklet(entry, (url) => readFile(fileURLToPath(url), 'utf8'));
if (/^\s*(?:import|export)\b/m.test(src)) throw new Error('the bundle still has an import or export');
const file = path.join(os.tmpdir(), `engine-worklet-bundle-${process.pid}.mjs`);
await writeFile(file, src);
try {
  const opts = { duration: 6 };
  const a = await render('i6-turbo', 'rev', opts);
  const b = await render('i6-turbo', 'rev', { ...opts, worklet: pathToFileURL(file).href });
  let diff = 0;
  for (let i = 0; i < a.L.length; i++) if (a.L[i] !== b.L[i] || a.R[i] !== b.R[i]) diff++;
  if (diff) throw new Error(`bundle and modules differ in ${diff} of ${a.L.length} samples`);
  console.log(`worklet bundle: ${src.split('\n').length} lines, identical to the modules over ${a.L.length} samples`);
} finally {
  await rm(file, { force: true });
}
