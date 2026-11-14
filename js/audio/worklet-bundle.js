// Joins the worklet's modules into one script with no imports, for hosts
// that will not load the worklet from its URL: a module loaded from a blob
// cannot resolve relative imports. Dependencies come first, each module
// once, so shared state (the random stream) stays a single instance.
//
// This is text surgery, not a parser, so the worklet's modules keep to a
// plain style: only `import { a, b } from './x.js';`, only `export` in front
// of a top-level const, let, function or class, and no two modules declaring
// the same top-level name. `node tools/check-bundle.mjs` (part of `npm test`)
// renders through the bundle and fails if any of that is broken.
//
// read(url) returns a module's source text.

const IMPORT = /^import\s*\{[^}]*\}\s*from\s*'([^']+)';[ \t]*\r?\n/gm;
const EXPORT = /^export (?=(?:const|let|function|class) )/gm;

export async function bundleWorklet(entryUrl, read) {
  const seen = new Set();
  const parts = [];
  const add = async (url) => {
    if (seen.has(url)) return;
    seen.add(url);
    const deps = [];
    let src = (await read(url)).replace(IMPORT, (_, spec) => {
      deps.push(new URL(spec, url).href);
      return '';
    });
    for (const d of deps) await add(d);
    src = src.replace(EXPORT, '');
    if (/^(?:import|export)\b/m.test(src)) throw new Error('worklet bundle: unsupported import or export in ' + url);
    parts.push(src);
  };
  await add(entryUrl);
  return parts.join('\n');
}
