#!/usr/bin/env node
/** Static guard for the four session-diff runtime entries. */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entries = [
  'lib/session-diff/main.cjs',
  'lib/session-diff/agent.mjs',
  'lib/session-diff/renderer.mjs',
  'views/session.html',
];

const forbidden = [
  ['dynamic import', /\bimport\s*\(/],
  ['eval', /\beval\s*\(/],
  ['Function constructor', /\bnew\s+Function\s*\(/],
  ['non-literal require', /\brequire\s*\(\s*(?!['"`])/],
  ['host app.asar', /app\.asar/i],
  ['private host data directory', /\.pi-desktop[\\/]+data[\\/](?:scratch|sessions|store)/i],
  ['private review-changes store', /review-changes/i],
];

export function checkSessionRuntime() {
  for (const entry of entries) {
    const file = join(root, entry);
    let text = readFileSync(file, 'utf8');
    if (entry.endsWith('.html')) {
      const scripts = [...text.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => match[1]).join('\n');
      const markup = text.replace(/<script(?:\s[^>]*)?>[\s\S]*?<\/script>/gi, '<script></script>');
      if (!scripts.trim()) throw new Error(`${entry}: no inline script found`);
      if (/<script\b[^>]*\bsrc\s*=/i.test(markup)) throw new Error(`${entry}: external script reference is not allowed`);
      if (/<link\b[^>]*\brel\s*=\s*["']stylesheet/i.test(markup)) throw new Error(`${entry}: external stylesheet reference is not allowed`);
      if (/\bhref\s*=/i.test(markup)) throw new Error(`${entry}: external href is not allowed`);
      if (!/data-surface="session"/.test(text) || !/会话修改/.test(text)) throw new Error(`${entry}: session surface marker is missing`);
      text = scripts;
    }
    for (const [name, pattern] of forbidden) {
      if (pattern.test(text)) throw new Error(`${entry}: forbidden runtime pattern (${name})`);
    }
    process.stdout.write(`  checked ${entry}\n`);
  }
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  checkSessionRuntime();
  process.stdout.write('session runtime check passed\n');
}
