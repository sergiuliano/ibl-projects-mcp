import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { promisify } from 'node:util';
import process from 'node:process';
import { launch } from '../dist/cli.js';
import { MCP_VERSION } from '../dist/contract.js';
import { accessToken } from '../dist/config.js';
import { CredentialStore } from '../dist/credentials.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = promisify(execFile);
const cleanEnv = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key, value]) => !key.startsWith('PM_MCP_') && !key.startsWith('MADDOTS_MCP_') && typeof value === 'string')), PM_MCP_AUTO_UPDATE: '0' });
const options = { repository: 'sergiuliano/ibl-projects-mcp', version: '1', bundledRoot: '/fixture/bootstrap', env: {} };
async function directory(t) { const value = await realpath(await mkdtemp(join(tmpdir(), 'maddots-launcher-'))); t.after(() => rm(value, { recursive: true, force: true })); return value; }

test('a pinned bootstrap checks before loading the selected runtime or authentication', async () => {
  const events = [];
  await launch(['--setup'], { options, check: async () => { events.push('check'); }, select: async () => { events.push('select'); return { root: '/fixture/new', version: '2' }; }, run: async (args, context) => {
    events.push('runtime'); assert.deepEqual(args, ['--setup']);
    assert.equal(context.bootstrapRoot, options.bundledRoot); assert.equal(context.runtimeRoot, '/fixture/new'); assert.equal(context.options.version, '1'); assert.equal(context.runtimeVersion, '2');
  } });
  assert.deepEqual(events, ['check', 'select', 'runtime']);
});

test('startup rolls a failed selected runtime back and uses its previous verified release', async () => {
  const calls = []; let selected = { root: '/fixture/bad', commit: 'b'.repeat(40), version: '2' };
  await launch([], { options, check: async () => {}, select: async () => selected, rollback: async commit => { calls.push(commit); selected = { root: '/fixture/previous', commit: 'a'.repeat(40), version: '1' }; }, run: async (_args, context) => { calls.push(context.runtimeRoot); if (context.runtimeRoot.endsWith('/bad')) throw new Error('startup'); } });
  assert.deepEqual(calls, ['/fixture/bad', 'b'.repeat(40), '/fixture/previous']);
});

test('setup authorization is never retried or rolled back after an uncertain failure', async () => {
  let calls = 0, rollbacks = 0;
  await assert.rejects(launch(['--setup'], { options, check: async () => {}, select: async () => ({ root: '/fixture/prepared', commit: 'b'.repeat(40) }), rollback: async () => { rollbacks++; }, run: async () => { calls++; throw new Error('authorization'); } }));
  assert.equal(calls, 1); assert.equal(rollbacks, 0);
});

test('setup reconnect accepts every flag order and forwards one explicit authorization attempt', async () => {
  const variants = [
    ['--setup', '--reconnect'], ['--reconnect', '--setup'],
    ['--setup', '--reconnect', '--read-only'], ['--setup', '--read-only', '--reconnect'],
    ['--reconnect', '--setup', '--read-only'], ['--reconnect', '--read-only', '--setup'],
    ['--read-only', '--setup', '--reconnect'], ['--read-only', '--reconnect', '--setup'],
  ];
  for (const args of variants) {
    let calls = 0, rollbacks = 0;
    await launch(args, { options, check: async () => {}, select: async () => ({ root: '/fixture/prepared', commit: 'b'.repeat(40) }), rollback: async () => { rollbacks++; }, run: async actual => { calls++; assert.deepEqual(actual, args); } });
    assert.equal(calls, 1);
    assert.equal(rollbacks, 0);
  }
});

test('reconnect cannot run outside setup or alongside unrelated or duplicate flags', async () => {
  for (const args of [
    ['--reconnect'], ['--reconnect', '--read-only'], ['--read-only'],
    ['--setup', '--reconnect', '--reconnect'], ['--setup', '--setup'],
    ['--setup', '--reconnect', '--status'], ['--setup', '--reconnect', '--update'],
    ['--setup', '--reconnect', '--self-test'], ['--setup', '--help'],
  ]) {
    await assert.rejects(launch(args, {
      options, check: async () => { assert.fail('Invalid arguments cannot start update checks.'); },
      select: async () => { assert.fail('Invalid arguments cannot select a runtime.'); },
      run: async () => { assert.fail('Invalid arguments cannot start authorization.'); },
    }), error => error.code === 'CLI_ARGUMENTS');
  }
});

test('setup reconnect authorization is never retried after a failed runtime', async () => {
  let calls = 0, rollbacks = 0;
  await assert.rejects(launch(['--setup', '--reconnect'], { options, check: async () => {}, select: async () => ({ root: '/fixture/prepared', commit: 'b'.repeat(40) }), rollback: async () => { rollbacks++; }, run: async () => { calls++; throw new Error('Uncertain replacement outcome.'); } }));
  assert.equal(calls, 1);
  assert.equal(rollbacks, 0);
});

test('disabling automatic checks still permits a verified cached runtime', async () => {
  let checked = false, selected = false;
  await launch([], { options: { ...options, env: { PM_MCP_AUTO_UPDATE: '0' } }, check: async () => { checked = true; }, select: async () => ({ root: '/fixture/cached' }), run: async () => { selected = true; } });
  assert.equal(checked, false); assert.equal(selected, true);
});

test('self-test bypasses selection and updates and only loads its own candidate', async () => {
  await launch(['--self-test'], { options, check: async () => { assert.fail('network check'); }, select: async () => { assert.fail('cache selection'); }, run: async (_args, context) => { assert.equal(context.runtimeRoot, options.bundledRoot); } });
});

test('an npm bin symlink runs version and local self-test without credentials', async t => {
  const path = await directory(t); const bin = join(path, 'maddots'); await symlink(join(root, 'dist/cli.js'), bin);
  const env = { ...cleanEnv(), PM_MCP_STATE_DIR: join(path, 'unused-credentials'), PM_MCP_UPDATE_DIR: join(path, 'unused-updates') };
  const version = await run(process.execPath, [bin, '--version'], { env, timeout: 15_000 }); assert.equal(version.stdout, MCP_VERSION + '\n'); assert.equal(version.stderr, '');
  const result = await run(process.execPath, [bin, '--self-test'], { env, timeout: 15_000 }); assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
});

test('original bootstrap root remains a forbidden credential location after selecting a cache runtime', async t => {
  const path = await directory(t); const install = join(path, 'installed'); await mkdir(install);
  const token = join(install, 'token'); await writeFile(token, 'pm_fixture_only_token_123456789', { mode: 0o600 });
  await assert.rejects(accessToken({ PM_MCP_TOKEN_FILE: token, PM_MCP_INSTALL_ROOT: install }), /outside this repository/);
  assert.throws(() => new CredentialStore(new URL('https://example.test/mcp'), { PM_MCP_STATE_DIR: join(install, 'state'), PM_MCP_INSTALL_ROOT: install }), /outside the client checkout/);
});

test('a slow startup update continues in background without delaying the host indefinitely', async () => {
  let complete; const pending = new Promise(resolve => { complete = resolve; });
  const start = Date.now(); let context;
  await launch([], { options, check: () => pending, select: async () => ({ root: options.bundledRoot }), run: async (_args, value) => { context = value; } });
  assert.ok(Date.now() - start < 4_000); assert.ok(context.startupCheck);
  complete(); await context.startupCheck;
});
