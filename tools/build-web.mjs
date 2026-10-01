// Copies the web app into www/ for the native shells (Capacitor's webDir).
// The source runs as-is in a browser; the copy only adds the Capacitor
// runtime, which talks to the native plugins when the app runs on a phone.
//   node tools/build-web.mjs
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'www');

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const dir of ['css', 'js', 'fonts']) await cp(path.join(root, dir), path.join(out, dir), { recursive: true });
await mkdir(path.join(out, 'js/vendor'), { recursive: true });
await cp(path.join(root, 'node_modules/@capacitor/core/dist/capacitor.js'), path.join(out, 'js/vendor/capacitor.js'));

// classic script, so window.Capacitor exists before the modules run
let html = await readFile(path.join(root, 'index.html'), 'utf8');
const tag = '    <script type="module" src="js/main.js"></script>';
if (!html.includes(tag)) throw new Error('index.html: main.js script tag not found');
html = html.replace(tag, '    <script src="js/vendor/capacitor.js"></script>\n' + tag);
await writeFile(path.join(out, 'index.html'), html);
console.log('www/ ready');
