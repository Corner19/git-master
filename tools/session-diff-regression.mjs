#!/usr/bin/env node
/** Structural + engine regression for the session-change integration. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSessionRuntime } from './check-session-runtime.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFileSync(join(root, file), 'utf8');
const manifest = JSON.parse(read('manifest.json'));

{
  assert.equal(manifest.version, '0.6.0');
  assert.equal(manifest.main, 'main.js');
  assert.equal(manifest.renderer, 'lib/session-diff/renderer.mjs');
  assert.deepEqual(manifest.rendererActions, ['plugin.call', 'composer.readDraft']);
  assert.equal(manifest.rendererCallMethods.length, 30, 'renderer method whitelist must stay under the host limit of 32');
  assert.deepEqual(manifest.contributes.agentExtensions, ['lib/session-diff/agent.mjs']);
  assert.ok(manifest.contributes.views.some(view => view.id === 'session' && view.entry === 'views/session.html'));
  assert.ok(manifest.contributes.commands.some(command => command.id === 'git-master.session-review'));
  assert.ok(manifest.activationEvents.includes('onCommand:git-master.session-review'));
  assert.deepEqual(manifest.contributes.settings.map(setting => setting.key), ['layout', 'wordWrap']);
  for (const permission of ['agent.extension', 'renderer.extension', 'desktop.control']) {
    assert.ok(manifest.permissions.includes(permission), `missing permission ${permission}`);
  }
  assert.equal(manifest.engines.piDesktop, '>=0.17.0');
  assert.match(manifest.safetyNotes, /桌面|私有数据|desktop\.control/);
  for (const file of [manifest.renderer, ...manifest.contributes.agentExtensions, ...manifest.contributes.views.map(view => view.entry)]) {
    if (file.endsWith('.html') || file.endsWith('.mjs')) assert.ok(existsSync(join(root, file)), `missing runtime file ${file}`);
  }
  assert.match(read('vendor/pi-diff-view/UPSTREAM.md'), /c1d94a8f8fe55b152ead69ba108dd4ded44a89ca/);
}

{
  const main = read('main.js');
  assert.match(main, /channel\.startsWith\("diff\."\)/);
  assert.match(main, /SESSION_DIFF_UNAVAILABLE/);
  assert.match(main, /pi\.ui\.revealView\(\{ viewId: "session" \}\)/);
  assert.match(main, /async function onRendererCall\(method, args = \{\}\)/);
}

{
  const html = read('views/session.html');
  const markup = html.replace(/<script(?:\s[^>]*)?>[\s\S]*?<\/script>/gi, '<script></script>');
  assert.match(html, /data-surface="session"/);
  assert.match(html, /会话修改/);
  assert.doesNotMatch(markup, /<script\b[^>]*\bsrc\s*=/i);
  assert.doesNotMatch(markup, /<link\b[^>]*\brel\s*=\s*["']stylesheet/i);
  assert.doesNotMatch(markup, /\bhref\s*=/i);
  assert.doesNotMatch(html, /<button[^>]*>本地 Git<\/button>/);
}

{
  const publish = join(root, 'dist-publish', manifest.id);
  assert.ok(existsSync(publish), 'run tools/make-publish-dir.mjs before this regression');
  for (const file of ['main.js', 'views/session.html', 'lib/session-diff/main.cjs', 'lib/session-diff/agent.mjs', 'lib/session-diff/renderer.mjs', 'licenses/pi-diff-view-LICENSE']) {
    assert.ok(existsSync(join(publish, file)), `publish directory is missing ${file}`);
  }
}

checkSessionRuntime();

// Engine check: session channels degrade structurally, Git channels still work.
const repo = mkdtempSync(join(tmpdir(), 'git-master-session-reg-'));
try {
  const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'regression@example.com']);
  git(['config', 'user.name', 'Regression']);
  writeFileSync(join(repo, 'README.md'), 'session regression\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'initial']);

  globalThis.pi = {
    workspace: { get: async () => ({ path: repo, name: 'session-regression' }) },
    commands: { register: async () => {}, unregister: async () => {} },
    ui: { openPanel: async () => {}, showToast: async () => {}, revealView: async () => {} },
    plugin: { getDataPath: async () => join(repo, '.data'), getSettings: async () => ({}), setSettings: async () => {} },
    events: { on: () => {}, off: () => {} },
    models: { list: async () => [] },
    agent: { complete: async () => ({ text: '' }) },
    app: { getAppearance: async () => ({ locale: 'zh-CN', base: 'light' }) },
    clipboard: { writeText: async () => {} },
    desktop: { listOperations: async () => [], invoke: async () => ({}) },
  };
  const plugin = createRequire(import.meta.url)(join(root, 'main.js'));
  assert.deepEqual(Object.keys(plugin).sort(), ['onLoad', 'onPanelInvoke', 'onRendererCall', 'onUnload', 'refreshWorkspace']);

  const unavailable = await plugin.onPanelInvoke('diff.review', {});
  assert.equal(unavailable.code, 'SESSION_DIFF_UNAVAILABLE');
  assert.equal(unavailable.ok, false);
  await assert.rejects(() => plugin.onRendererCall('sessionState', {}), error => error.code === 'SESSION_DIFF_UNAVAILABLE');

  const status = await plugin.onPanelInvoke('git/repo', {});
  assert.equal(status.ok, true, status.message ?? 'git/repo failed');
  assert.equal(status.available, true);
  assert.ok(status.branch && typeof status.branch.head === 'string');
} finally {
  rmSync(repo, { recursive: true, force: true });
}

process.stdout.write('session-diff regression passed\n');
