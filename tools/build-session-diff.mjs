#!/usr/bin/env node
/** Build the session-change subsystem from the pinned upstream source snapshot. */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSessionRuntime } from './check-session-runtime.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vendor = join(root, 'vendor', 'pi-diff-view');
const require = createRequire(join(vendor, 'package.json'));
const { build } = require('esbuild');

const read = (file) => readFileSync(join(vendor, file), 'utf8');
const write = (file, text) => {
  const target = join(root, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text, 'utf8');
  process.stdout.write(`wrote ${file} (${(Buffer.byteLength(text) / 1024).toFixed(1)} KB)\n`);
};

const common = { bundle: true, sourcemap: false, logLevel: 'warning', target: 'es2022' };

await build({
  ...common,
  entryPoints: [join(vendor, 'src/main.ts')],
  outfile: join(root, 'lib/session-diff/main.cjs'),
  platform: 'node',
  format: 'cjs',
  external: ['original-fs'],
});

await build({
  ...common,
  entryPoints: [join(vendor, 'src/agent/capture.ts')],
  outfile: join(root, 'lib/session-diff/agent.mjs'),
  platform: 'node',
  format: 'esm',
});

const renderer = await build({
  ...common,
  entryPoints: [join(vendor, 'src/renderer/index.tsx')],
  outfile: join(root, 'lib/session-diff/renderer.mjs'),
  platform: 'browser',
  format: 'esm',
  minify: true,
  jsx: 'transform',
  jsxFactory: 'React.createElement',
  jsxFragment: 'React.Fragment',
  tsconfigRaw: { compilerOptions: { jsx: 'react' } },
  external: ['react', 'react-dom', 'react-dom/client'],
  metafile: true,
});
const hostModules = new Set(['react', 'react-dom', 'react-dom/client']);
for (const output of Object.values(renderer.metafile.outputs)) {
  for (const imported of output.imports) {
    if (imported.external && !hostModules.has(imported.path)) throw new Error(`Renderer imports a module absent from the host import map: ${imported.path}`);
  }
}

const viewScript = join(root, 'lib/session-diff/session-view.js');
const viewCss = join(root, 'lib/session-diff/session-view.css');
await build({
  ...common,
  entryPoints: [join(vendor, 'src/view/index.tsx')],
  outfile: viewScript,
  platform: 'browser',
  format: 'iife',
  minify: true,
  jsx: 'automatic',
});
if (!existsSync(viewCss)) throw new Error('The session view produced no CSS output');

const js = readFileSync(viewScript, 'utf8').replace(/<\/script/gi, '<\\/script');
const css = readFileSync(viewCss, 'utf8');
const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="pi-plugin-chrome" content="v2" />
  <title>会话修改 · Git Master</title>
  <style>
html,body{margin:0;width:100%;height:100%}
html,body{color:var(--ds-text-primary,#20252b);background:var(--ds-bg-dock,#fafafa)}
html[data-base=dark] body{color:var(--ds-text-primary,#eee);background:var(--ds-bg-dock,#212121)}
#root{min-width:0;height:100%}
  </style>
  <style>
${css}
  </style>
</head>
<body data-surface="session"><div id="root"></div><script>
${js}
</script></body>
</html>
`;
write('views/session.html', html);
rmSync(viewScript, { force: true });
rmSync(viewCss, { force: true });

checkSessionRuntime();
process.stdout.write('wrote lib/session-diff/{main.cjs,agent.mjs,renderer.mjs} and views/session.html\n');
