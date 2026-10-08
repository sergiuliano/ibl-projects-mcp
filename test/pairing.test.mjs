import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { setImmediate, setTimeout } from 'node:timers';
import { promisify } from 'node:util';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import test from 'node:test';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from '../dist/server.js';
import { TOOL_DEFINITIONS, ALL_WORKSPACE_TOOL_DEFINITIONS } from '../dist/contract.js';
import { AccountService, CONNECT_ACCOUNT_TOOL } from '../dist/account.js';
import { CredentialStore } from '../dist/credentials.js';
import { PairingFlow } from '../dist/pairing.js';
import { accessToken, BridgeError } from '../dist/config.js';

const run = promisify(execFile);
const cli = resolve(dirname(fileURLToPath(import.meta.url)), '../dist/cli.js');
const url = new URL('https://example.test/mcp');
const secret = 'pm_test_only_pairing_secret_123456789';
const deviceCode = 'd'.repeat(43);
const userCode = 'ABCD2345';
const scopes = ['kanban:read', 'kanban:write'];
const cleanEnv = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key, value]) => !key.startsWith('PM_MCP_') && typeof value === 'string')), PM_MCP_AUTO_UPDATE: '0' });
const credential = (endpoint = url, name = 'Fixture User') => ({ endpoint: endpoint.href, secret, account: { id: 'fixture-account', name }, scopes, expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
const response = (data, status = 200, headers = {}) => new globalThis.Response(JSON.stringify({ data }), { status, headers });
const issue = (now, endpoint = url) => ({ deviceCode, userCode, expiresAt: new Date(now + 300_000).toISOString(), expiresIn: 300, interval: 3, verificationUri: new URL('/integrations', endpoint.origin).href });
const approved = (endpoint = url) => { const item = credential(endpoint); return { status: 'connected', secret, account: item.account, token: { scopes: item.scopes, expiresAt: item.expiresAt } }; };
const safeOutput = value => { const text = JSON.stringify(value); assert.ok(!text.includes(secret)); assert.ok(!text.includes(deviceCode)); };
async function directory(t) {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'ibl-pairing-test-')));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
function virtualFlow(replies, { instructions, sleep: onSleep } = {}) {
  let now = Date.now();
  const waits = [], requests = [];
  const timing = { now: () => now, sleep: async (ms, signal) => { waits.push(ms); now += ms; if (signal.aborted) throw new BridgeError('PAIRING_CANCELLED', 'Cancelled.'); await onSleep?.(ms, signal); } };
  const flow = new PairingFlow(url, timing, async (address, init) => {
    requests.push({ address: address.href, init });
    assert.equal(init.redirect, 'error');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.headers.Authorization, undefined);
    if (requests.length === 1) return response({ ...issue(now), ...instructions });
    const next = replies.shift();
    return typeof next === 'function' ? next() : next ?? response({ status: 'pending' });
  });
  return { flow, waits, requests };
}

test('pairing returns only a code/link and claims one credential after bounded polling', async () => {
  const fixture = virtualFlow([response({ status: 'pending' }), response(approved())]);
  const pending = await fixture.flow.start(scopes);
  assert.equal(pending.userCode, userCode);
  assert.equal(pending.verificationUri, 'https://example.test/integrations');
  safeOutput(pending);
  const saved = await fixture.flow.wait();
  assert.equal(saved.secret, secret);
  assert.deepEqual(fixture.waits, [3000, 3000]);
  assert.deepEqual(fixture.requests.slice(1).map(item => JSON.parse(item.init.body)), [{ deviceCode }, { deviceCode }]);
});

test('poll throttling honors Retry-After without polling faster than the advertised interval', async () => {
  const fixture = virtualFlow([response({}, 429, { 'Retry-After': '12' }), response({}, 429, { 'Retry-After': '1' }), response(approved())]);
  await fixture.flow.start(scopes); await fixture.flow.wait();
  assert.deepEqual(fixture.waits, [3000, 12000, 3000]);
});

test('invalid, denied, expired or claimed approval ends without creating another pairing', async () => {
  const fixture = virtualFlow([new globalThis.Response('untrusted body ' + secret, { status: 400 })]);
  await fixture.flow.start(scopes);
  await assert.rejects(fixture.flow.wait(), error => { safeOutput({ message: error.message }); return error.code === 'PAIRING_ENDED'; });
  assert.equal(fixture.requests.length, 2);
});

test('pending approval expires in five minutes and stops polling', async () => {
  const fixture = virtualFlow([]);
  await fixture.flow.start(scopes);
  await assert.rejects(fixture.flow.wait(), error => error.code === 'PAIRING_EXPIRED');
  assert.equal(fixture.waits.reduce((sum, wait) => sum + wait, 0), 300_000);
  assert.equal(fixture.requests.length, 100);
});

test('cancelling approval aborts the wait without submitting a poll', async () => {
  let abortWait;
  const flow = new PairingFlow(url, { now: Date.now, sleep: (_ms, signal) => new Promise((_resolve, reject) => {
    abortWait = () => reject(new BridgeError('PAIRING_CANCELLED', 'Cancelled.'));
    signal.addEventListener('abort', abortWait, { once: true });
  }) }, async () => response(issue(Date.now())));
  await flow.start(scopes);
  flow.cancel();
  await assert.rejects(flow.wait(), error => error.code === 'PAIRING_CANCELLED');
  assert.ok(abortWait);
});

test('untrusted approval links and malformed codes are rejected before polling', async () => {
  for (const instructions of [{ verificationUri: 'https://attacker.test/integrations' }, { userCode: 'abcdefgh' }, { deviceCode: 'too-short' }, { verificationUri: 'https://example.test/integrations?secret=' + secret }]) {
    const fixture = virtualFlow([], { instructions });
    await assert.rejects(fixture.flow.start(scopes), error => { safeOutput({ message: error.message }); return error.code === 'PAIRING_RESPONSE_INVALID'; });
    assert.equal(fixture.requests.length, 1);
  }
});

test('approval cannot broaden the requested account scope or leak secrets in display metadata', async () => {
  for (const data of [approved(), { ...approved(), account: { id: 'fixture', name: secret } }, { ...approved(), account: { id: 'fixture', name: deviceCode } }]) {
    const fixture = virtualFlow([response(data)]);
    await fixture.flow.start(['kanban:read']);
    await assert.rejects(fixture.flow.wait(), error => { safeOutput({ message: error.message }); return ['PAIRING_RESPONSE_INVALID', 'CREDENTIAL_INVALID'].includes(error.code); });
  }
});

test('network errors and oversized server bodies have bounded, redacted errors', async () => {
  const broken = virtualFlow([() => { throw new Error('server body with ' + secret + deviceCode); }]);
  await broken.flow.start(scopes);
  await assert.rejects(broken.flow.wait(), error => { safeOutput({ message: error.message }); return error.code === 'PAIRING_CONNECTION_FAILED'; });
  const large = virtualFlow([response({ status: 'pending', oversized: 'x'.repeat(20_000) })]);
  await large.flow.start(scopes);
  await assert.rejects(large.flow.wait(), error => error.code === 'PAIRING_RESPONSE_INVALID');
});

test('credential storage is private, endpoint-bound, and reusable', async t => {
  const directoryPath = await directory(t);
  const store = new CredentialStore(url, { PM_MCP_STATE_DIR: directoryPath });
  assert.equal(await store.load(), undefined);
  assert.deepEqual(await store.save(credential()), { persisted: true });
  assert.equal((await stat(store.path)).mode & 0o777, 0o600);
  assert.equal((await stat(directoryPath)).mode & 0o777, 0o700);
  assert.equal((await store.load()).secret, secret);
  const other = new CredentialStore(new URL('https://example.test/other-mcp'), { PM_MCP_STATE_DIR: directoryPath });
  assert.notEqual(store.path, other.path);
  assert.equal(await other.load(), undefined);
  await writeFile(other.path, await readFile(store.path), { mode: 0o600 });
  await assert.rejects(other.load(), /safely/);
});

test('credential files reject unsafe permissions, symlinks, corrupt state and in-checkout directories', async t => {
  const directoryPath = await directory(t);
  const store = new CredentialStore(url, { PM_MCP_STATE_DIR: directoryPath });
  await store.save(credential());
  await chmod(store.path, 0o644);
  await assert.rejects(store.load(), /safely/);
  assert.equal((await store.save(credential())).persisted, false);
  await chmod(store.path, 0o600);
  await writeFile(store.path, 'corrupt state');
  await assert.rejects(store.load(), /safely/);
  await rm(store.path);
  const target = join(await directory(t), 'outside');
  await writeFile(target, secret, { mode: 0o600 });
  await symlink(target, store.path);
  await assert.rejects(store.load(), /safely/);
  assert.equal((await store.save(credential())).persisted, false);
  assert.equal(await readFile(target, 'utf8'), secret);
  await chmod(directoryPath, 0o755);
  await assert.rejects(store.load(), /0700/);
  assert.throws(() => new CredentialStore(url, { PM_MCP_STATE_DIR: resolve(dirname(cli), '../credentials') }), /outside/);
});

test('confirmed disconnect deletes only the credential for the selected endpoint and is idempotent', async t => {
  const env = { PM_MCP_STATE_DIR: await directory(t) };
  const current = new CredentialStore(url, env);
  const otherUrl = new URL('https://example.test/other-mcp');
  const other = new CredentialStore(otherUrl, env);
  await current.save(credential()); await other.save(credential(otherUrl));
  // Select the same endpoint whose saved credential must be removed.
  const selected = new AccountService({ ...env, PM_MCP_URL: url.href }, { remote: { initialize: async () => {}, close: async () => {}, callTool: async () => ({ content: [] }) } });
  t.after(() => selected.close());
  await selected.callTool('list_projects', {});
  assert.equal((await selected.callTool('connect_account', { action: 'disconnect' })).structuredContent.status, 'confirmation_required');
  assert.equal((await current.load()).secret, secret);
  assert.equal((await selected.callTool('connect_account', { action: 'disconnect', confirm: true })).structuredContent.status, 'disconnected');
  assert.equal(await current.load(), undefined);
  assert.equal((await other.load()).secret, secret);
  assert.equal((await selected.callTool('list_projects', {})).structuredContent.error.code, 'AUTH_REQUIRED');
  assert.equal((await selected.callTool('connect_account', { action: 'disconnect', confirm: true })).structuredContent.status, 'disconnected');
  assert.match(CONNECT_ACCOUNT_TOOL.description, /disconnect.*explicit user request/i);
});

test('disconnect waits for an already claimed credential save before removing it', async t => {
  let finishSave;
  const events = [];
  const saveBarrier = new Promise(resolve => { finishSave = resolve; });
  const account = new AccountService({}, {
    makeRemote: () => ({ initialize: async () => {}, close: async () => {}, callTool: async () => ({ content: [] }) }),
    store: { load: async () => undefined, save: async () => { await saveBarrier; events.push('save'); return { persisted: true }; }, remove: async () => { events.push('remove'); } },
    makeFlow: () => ({ start: async () => ({}), snapshot: () => ({ status: 'pending' }), wait: async () => credential(), cancel: () => {} }),
  });
  t.after(() => account.close());
  await account.callTool('connect_account', {}); await settle();
  const disconnect = account.callTool('connect_account', { action: 'disconnect', confirm: true });
  await settle(); assert.deepEqual(events, []);
  finishSave();
  assert.equal((await disconnect).structuredContent.status, 'disconnected');
  assert.deepEqual(events, ['save', 'remove']);
  assert.equal((await account.callTool('connect_account', { action: 'status' })).structuredContent.status, 'not_connected');
});

test('token files inside the package checkout are rejected through direct and symlink-parent paths', async t => {
  const packageRoot = resolve(dirname(cli), '..');
  const tokenPath = join(packageRoot, '.hardening-token-test');
  await writeFile(tokenPath, secret, { mode: 0o600 });
  t.after(() => rm(tokenPath, { force: true }));
  const alias = join(await directory(t), 'checkout');
  await symlink(packageRoot, alias);
  for (const path of [tokenPath, join(alias, '.hardening-token-test')]) {
    await assert.rejects(accessToken({ PM_MCP_TOKEN_FILE: path }), /absolute path outside this repository/);
  }
  const outside = join(await directory(t), 'token');
  await writeFile(outside, secret, { mode: 0o600 });
  assert.equal(await accessToken({ PM_MCP_TOKEN_FILE: outside }), secret);
});

test('unsupported platforms keep live pairing in memory without writing credentials', async t => {
  const directoryPath = await directory(t);
  const store = new CredentialStore(url, { PM_MCP_STATE_DIR: directoryPath }, false);
  const outcome = await store.save(credential());
  assert.equal(outcome.persisted, false);
  assert.match(outcome.notice, /this session/);
  assert.equal(await store.load(), undefined);
  await assert.rejects(stat(store.path), error => error.code === 'ENOENT');
});

test('expired saved credentials are not restored', async t => {
  const store = new CredentialStore(url, { PM_MCP_STATE_DIR: await directory(t) });
  await store.save({ ...credential(), expiresAt: new Date(Date.now() - 1000).toISOString() });
  assert.equal(await store.load(), undefined);
});

function accountFixture(options = {}) {
  const calls = [], initialized = [], saved = [], removed = [];
  let accept, reject, started = 0;
  const remote = { initialize: async token => { initialized.push(token); }, close: async () => {}, callTool: async (name, args) => { calls.push({ name, args }); return { content: [], structuredContent: { ok: true } }; } };
  const store = { load: async () => options.credential, save: async value => { saved.push(value); return { persisted: true }; }, remove: async () => { removed.push(true); } };
  const makeFlow = () => {
    started++;
    const done = new Promise((resolve, fail) => { accept = resolve; reject = fail; });
    void done.catch(() => {});
    const pending = { status: 'pending', ...issue(Date.now()), scopes }; delete pending.deviceCode;
    return { start: async () => pending, wait: () => done, snapshot: () => pending, cancel: () => reject(new BridgeError('PAIRING_CANCELLED', 'Cancelled.')) };
  };
  const account = new AccountService({}, { remote, makeRemote: () => ({ ...remote }), store, makeFlow, confirmReconnect: options.confirmReconnect });
  return { account, calls, saved, removed, initialized, started: () => started, accept: value => accept(value), reject: error => reject(error) };
}
async function settle() { await new Promise(resolve => setImmediate(resolve)); }

test('unconnected business calls do not dispatch and repeated connect calls share one approval', async t => {
  const fixture = accountFixture(); t.after(() => fixture.account.close());
  const denied = await fixture.account.callTool('create_project', { name: 'Never submitted' });
  assert.equal(denied.structuredContent.error.code, 'AUTH_REQUIRED');
  assert.equal(fixture.calls.length, 0);
  const responses = await Promise.all([fixture.account.callTool('connect_account', {}), fixture.account.callTool('connect_account', {})]);
  assert.equal(fixture.started(), 1);
  for (const value of responses) { assert.equal(value.structuredContent.status, 'pending'); safeOutput(value); }
  fixture.accept(credential()); await settle();
  const connected = await fixture.account.callTool('connect_account', { action: 'status' });
  assert.equal(connected.structuredContent.status, 'connected'); safeOutput(connected);
  assert.match(connected.structuredContent.accountAccess, /every project.*workspace selected/);
  assert.equal(fixture.saved.length, 1);
  await fixture.account.callTool('list_projects', {});
  assert.equal(fixture.calls.length, 1);
});

test('cancel and terminal failures require an explicit new connection and never replay work', async t => {
  const fixture = accountFixture(); t.after(() => fixture.account.close());
  await fixture.account.callTool('connect_account', {});
  await fixture.account.callTool('connect_account', { action: 'cancel' });
  await settle();
  assert.equal((await fixture.account.callTool('connect_account', { action: 'status' })).structuredContent.error.code, 'PAIRING_CANCELLED');
  await fixture.account.callTool('create_project', { name: 'Still never submitted' });
  assert.equal(fixture.started(), 1);
  assert.equal(fixture.calls.length, 0);
  await fixture.account.callTool('connect_account', {});
  fixture.reject(new BridgeError('PAIRING_ENDED', 'Expired or declined.')); await settle();
  assert.equal((await fixture.account.callTool('connect_account', { action: 'status' })).structuredContent.error.code, 'PAIRING_ENDED');
  assert.equal(fixture.started(), 2);
});

test('reconnect requires explicit confirmation without dropping a saved or live credential', async t => {
  for (const connected of [false, true]) {
    const fixture = accountFixture({ credential: credential() }); t.after(() => fixture.account.close());
    if (connected) await fixture.account.callTool('list_projects', {});
    const response = await fixture.account.callTool('connect_account', { action: 'reconnect' });
    assert.equal(response.structuredContent.status, 'confirmation_required');
    assert.match(response.structuredContent.instructions, /confirm: true/);
    assert.equal(fixture.started(), 0);
    await fixture.account.callTool('list_projects', {});
    assert.equal(fixture.calls.length, connected ? 2 : 1);
    assert.equal((await fixture.account.callTool('connect_account', { action: 'reconnect', confirm: true })).structuredContent.status, 'pending');
    assert.equal(fixture.started(), 1);
  }
});

test('host elicitation confirmation cannot be bypassed and a decline preserves authorization', async t => {
  let accepted = false, confirmations = 0;
  const fixture = accountFixture({ credential: credential(), confirmReconnect: async () => { confirmations++; return accepted; } });
  t.after(() => fixture.account.close());
  assert.equal((await fixture.account.callTool('connect_account', { action: 'reconnect', confirm: true })).structuredContent.status, 'reconnect_cancelled');
  assert.equal(fixture.started(), 0);
  await fixture.account.callTool('list_projects', {});
  assert.equal(fixture.calls.length, 1);
  accepted = true;
  assert.equal((await fixture.account.callTool('connect_account', { action: 'reconnect' })).structuredContent.status, 'pending');
  assert.equal(confirmations, 2);
});

test('confirmation outcomes stay distinct and cannot be overridden by confirm true', async t => {
  for (const action of ['reconnect', 'disconnect']) {
    for (const [outcome, confirmation] of [[false, 'declined'], ['cancelled', 'cancelled'], ['not_confirmed', 'not_confirmed']]) {
      const fixture = accountFixture({ credential: credential(), confirmReconnect: async () => outcome });
      t.after(() => fixture.account.close());
      await fixture.account.callTool('list_projects', {});
      const response = await fixture.account.callTool('connect_account', { action, confirm: true });
      assert.equal(response.structuredContent.status, action + '_cancelled');
      assert.equal(response.structuredContent.confirmation, confirmation);
      if (confirmation === 'declined') assert.match(response.structuredContent.instructions, /declined/i);
      else assert.doesNotMatch(response.structuredContent.instructions, /user declined/i);
      safeOutput(response);
      assert.equal(fixture.started(), 0);
      assert.equal(fixture.saved.length, 0);
      assert.equal(fixture.removed.length, 0);
      assert.equal((await fixture.account.callTool('list_projects', {})).structuredContent.ok, true);
      assert.equal((await fixture.account.callTool('connect_account', { action: 'status' })).structuredContent.account.name, 'Fixture User');
    }
  }
});

test('elicitation failure preserves authorization and does not fall back to confirm true', async t => {
  const fixture = accountFixture({ credential: credential(), confirmReconnect: async () => { throw new Error('Untrusted host error ' + secret); } });
  t.after(() => fixture.account.close());
  const response = await fixture.account.callTool('connect_account', { action: 'reconnect', confirm: true });
  assert.equal(response.isError, true);
  safeOutput(response);
  assert.equal(fixture.started(), 0);
  assert.equal(fixture.saved.length, 0);
  assert.equal(fixture.removed.length, 0);
  assert.equal((await fixture.account.callTool('list_projects', {})).structuredContent.ok, true);
});

test('first-time connect does not request reconnect confirmation and tool guidance protects approval codes', async t => {
  const fixture = accountFixture({ confirmReconnect: () => { throw new Error('First connection must not request confirmation.'); } });
  t.after(() => fixture.account.close());
  assert.equal((await fixture.account.callTool('connect_account', {})).structuredContent.status, 'pending');
  assert.match(CONNECT_ACCOUNT_TOOL.description, /explicit user request/);
  assert.match(CONNECT_ACCOUNT_TOOL.description, /only to the user/);
  assert.match(CONNECT_ACCOUNT_TOOL.description, /never pass it to any other tool/i);
});

test('reconnect keeps the current account usable until the replacement is approved and verified', async t => {
  const fixture = accountFixture(); t.after(() => fixture.account.close());
  await fixture.account.callTool('connect_account', {});
  fixture.accept(credential(url, 'First Account')); await settle();
  await fixture.account.callTool('connect_account', { action: 'reconnect', confirm: true });
  assert.equal((await fixture.account.callTool('list_projects', {})).structuredContent.ok, true);
  fixture.accept(credential(url, 'Second Account')); await settle();
  const state = await fixture.account.callTool('connect_account', { action: 'status' });
  assert.equal(state.structuredContent.account.name, 'Second Account');
  assert.equal(fixture.started(), 2);
  assert.equal(fixture.calls.length, 1);
});

test('failed contract validation discards the candidate before saving or submitting business operations', async () => {
  let saved = false, calls = 0;
  const flow = { start: async () => ({}), snapshot: () => ({ status: 'pending' }), wait: async () => credential(), cancel: () => {} };
  const account = new AccountService({}, {
    makeRemote: () => ({ initialize: async () => { assert.equal(saved, false); throw new BridgeError('REMOTE_CONTRACT_MISMATCH', 'Contract differs.'); }, close: async () => {}, callTool: async () => { calls++; return { content: [] }; } }),
    store: { load: async () => undefined, save: async () => { saved = true; return { persisted: true }; } }, makeFlow: () => flow,
  });
  await assert.rejects(account.setup(() => {}), error => error.code === 'REMOTE_CONTRACT_MISMATCH');
  assert.equal(calls, 0);
  assert.equal(saved, false);
  assert.equal((await account.callTool('connect_account', { action: 'status' })).structuredContent.error.code, 'REMOTE_CONTRACT_MISMATCH');
  await account.close();
});

test('concurrent reconnects cannot let an earlier credential save overwrite the new account', async t => {
  let finishSave, claim, registrations = 0;
  const saved = [];
  const firstSave = new Promise(resolve => { finishSave = resolve; });
  const account = new AccountService({}, {
    makeRemote: () => ({ initialize: async () => {}, close: async () => {}, callTool: async () => ({ content: [] }) }),
    store: { load: async () => undefined, save: async value => {
      if (value.account.name === 'First Account') await firstSave;
      saved.push(value.account.name); return { persisted: true };
    } },
    makeFlow: () => {
      registrations++;
      const pending = { status: 'pending', ...issue(Date.now()), scopes }; delete pending.deviceCode;
      let reject;
      const completion = new Promise((resolve, fail) => { claim = resolve; reject = fail; }); void completion.catch(() => {});
      return { start: async () => pending, snapshot: () => pending, wait: () => completion, cancel: () => reject(new BridgeError('PAIRING_CANCELLED', 'Cancelled.')) };
    },
  });
  t.after(() => account.close());
  await account.callTool('connect_account', {});
  claim(credential(url, 'First Account')); await settle();
  const reconnect = account.callTool('connect_account', { action: 'reconnect', confirm: true });
  await settle(); assert.equal(registrations, 1);
  assert.equal((await account.callTool('create_project', { name: 'Must not use the previous account' })).structuredContent.error.code, 'AUTH_REQUIRED');
  finishSave(); await reconnect;
  claim(credential(url, 'Second Account')); await settle();
  assert.deepEqual(saved, ['First Account', 'Second Account']);
  assert.equal((await account.callTool('connect_account', { action: 'status' })).structuredContent.account.name, 'Second Account');
});

test('revoked authorization is rejected once and does not silently retry the operation', async t => {
  let calls = 0, initialized = 0, removed = 0;
  const account = new AccountService({}, {
    store: { load: async () => credential(), save: async () => ({ persisted: true }), remove: async () => { removed++; } },
    makeRemote: () => ({ initialize: async () => { initialized++; }, close: async () => {}, callTool: async () => {
      calls++; return { isError: true, content: [], structuredContent: { error: { code: 'AUTH_REQUIRED' } } };
    } }),
  });
  t.after(() => account.close());
  assert.equal((await account.callTool('create_project', { name: 'Revoked' })).structuredContent.error.code, 'AUTH_REQUIRED');
  assert.equal((await account.callTool('create_project', { name: 'Revoked' })).structuredContent.error.code, 'AUTH_REQUIRED');
  assert.equal(calls, 1);
  assert.equal(initialized, 1);
  assert.equal(removed, 0);
});

test('foreground setup reports when approval can only be kept for the current session', async () => {
  const account = new AccountService({}, {
    store: { load: async () => undefined, save: async () => ({ persisted: false, notice: 'Connected for this session only.' }) },
    makeRemote: () => ({ initialize: async () => {}, close: async () => {}, callTool: async () => { throw new Error('No project tool allowed during setup.'); } }),
    makeFlow: () => ({ start: async () => ({}), snapshot: () => ({ status: 'pending' }), wait: async () => credential(), cancel: () => {} }),
  });
  assert.equal((await account.setup(() => {})).notice, 'Connected for this session only.');
  await account.close();
});

async function httpFixture(t, requestedScopes = scopes, wide = false) {
  let registrations = 0, polls = 0, requests = 0;
  const calls = [];
  let endpoint;
  const http = createServer(async (req, res) => {
    requests++;
    const parts = []; for await (const part of req) parts.push(part);
    const body = parts.length ? JSON.parse(Buffer.concat(parts).toString()) : {};
    if (req.url === '/api/mcp/pairings') {
      registrations++;
      assert.equal(req.headers.authorization, undefined);
      assert.deepEqual(body.scopes, requestedScopes);
      assert.equal(body.workspaceAccess, 'all');
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: issue(Date.now(), endpoint) })); return;
    }
    if (req.url === '/api/mcp/pairings/poll') {
      polls++; assert.deepEqual(body, { deviceCode });
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: { ...approved(endpoint), token: { ...approved(endpoint).token, scopes: requestedScopes } } })); return;
    }
    if (req.headers.authorization !== `Bearer ${secret}`) { res.writeHead(401); res.end('untrusted ' + secret); return; }
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    const server = createMcpServer({ callTool: async (name, args) => { calls.push({ name, args }); return { content: [], structuredContent: { fixture: true } }; } }, [], undefined, { workspaceAccess: wide });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try { await server.connect(transport); await transport.handleRequest(req, res, body); }
    finally { await server.close(); }
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(async () => { http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); });
  endpoint = new URL(`http://127.0.0.1:${http.address().port}/mcp`);
  const env = { ...cleanEnv(), PM_MCP_URL: endpoint.href, PM_MCP_ALLOW_INSECURE_LOOPBACK: '1', PM_MCP_STATE_DIR: await directory(t) };
  return { env, calls, registrations: () => registrations, polls: () => polls, requests: () => requests };
}
async function stdio(t, env, elicitation, listChanged) {
  const client = new Client({ name: 'pairing-stdio-test', version: '1.0.0' }, { ...(elicitation ? { capabilities: { elicitation: { form: {} } } } : {}), ...(listChanged ? { listChanged } : {}) });
  if (elicitation) client.setRequestHandler(ElicitRequestSchema, elicitation);
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli], env, stderr: 'pipe' });
  let stderr = ''; transport.stderr?.on('data', chunk => { stderr += chunk.toString(); });
  t.after(() => client.close());
  await client.connect(transport);
  return { client, stderr: () => stderr };
}

test('stdio starts without credentials, pairs in the background, and reuses a saved account', { timeout: 15_000 }, async t => {
  const fixture = await httpFixture(t);
  const first = await stdio(t, fixture.env);
  assert.equal((await first.client.listTools()).tools.length, TOOL_DEFINITIONS.length + 1);
  assert.equal(fixture.requests(), 0);
  assert.equal((await first.client.callTool({ name: 'list_projects', arguments: {} })).structuredContent.error.code, 'AUTH_REQUIRED');
  assert.equal(fixture.requests(), 0);
  const start = Date.now();
  const pending = await first.client.callTool({ name: 'connect_account', arguments: {} });
  assert.equal(pending.structuredContent.userCode, userCode); safeOutput(pending);
  assert.ok(Date.now() - start < 2000, 'Tool returns before the three-second background poll.');
  let status;
  for (let attempt = 0; attempt < 50; attempt++) {
    status = await first.client.callTool({ name: 'connect_account', arguments: { action: 'status' } });
    if (status.structuredContent.status === 'connected') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(status.structuredContent.status, 'connected'); safeOutput(status);
  assert.equal(status.structuredContent.remembered, true);
  assert.equal(fixture.calls.length, 0);
  assert.deepEqual((await first.client.callTool({ name: 'list_projects', arguments: {} })).structuredContent, { fixture: true });
  assert.equal(fixture.calls.length, 1);
  await first.client.close();
  const second = await stdio(t, fixture.env);
  assert.deepEqual((await second.client.callTool({ name: 'list_projects', arguments: {} })).structuredContent, { fixture: true });
  assert.equal(fixture.registrations(), 1);
  assert.equal(fixture.polls(), 1);
  assert.equal(first.stderr() + second.stderr(), '');
});

test('stdio distinguishes host confirmation outcomes and preserves the stored account until acceptance', { timeout: 10_000 }, async t => {
  const fixture = await httpFixture(t);
  const store = new CredentialStore(new URL(fixture.env.PM_MCP_URL), fixture.env);
  await store.save(credential(new URL(fixture.env.PM_MCP_URL)));
  const original = await readFile(store.path, 'utf8');
  let answer = { action: 'cancel' }, prompts = 0;
  const host = await stdio(t, fixture.env, async request => {
    if (request.params.requestedSchema.required.includes('acknowledged')) { assert.match(request.params.message, /ABCD2345/); return { action: 'accept', content: { acknowledged: true } }; }
    prompts++;
    assert.equal(request.params.mode, 'form');
    assert.deepEqual(request.params.requestedSchema.required, ['confirm']);
    assert.equal(request.params.requestedSchema.properties.confirm.type, 'boolean');
    assert.equal(request.params.requestedSchema.properties.confirm.default, false);
    return answer;
  });
  for (const [response, confirmation] of [
    [{ action: 'cancel' }, 'cancelled'],
    [{ action: 'decline' }, 'declined'],
    [{ action: 'accept', content: { confirm: false } }, 'not_confirmed'],
  ]) {
    answer = response;
    const denied = await host.client.callTool({ name: 'connect_account', arguments: { action: 'reconnect', confirm: true } });
    assert.equal(denied.structuredContent.status, 'reconnect_cancelled');
    assert.equal(denied.structuredContent.confirmation, confirmation);
    safeOutput(denied);
    assert.equal(fixture.registrations(), 0);
    assert.equal(await readFile(store.path, 'utf8'), original);
    await host.client.callTool({ name: 'list_projects', arguments: {} });
  }
  assert.equal(fixture.calls.length, 3);
  answer = { action: 'accept', content: { confirm: true } };
  assert.equal((await host.client.callTool({ name: 'connect_account', arguments: { action: 'reconnect' } })).structuredContent.status, 'pending');
  assert.equal(fixture.registrations(), 1);
  assert.equal(prompts, 4);
});

test('interactive setup shows code and link, remembers approval, and never calls a business tool', { timeout: 15_000 }, async t => {
  const fixture = await httpFixture(t);
  const output = await run(process.execPath, [cli, '--setup'], { env: fixture.env, timeout: 10_000 });
  assert.match(output.stdout, /ABCD2345/);
  assert.match(output.stdout, /\/integrations/);
  assert.match(output.stdout, /No tool operation was submitted/);
  safeOutput(output);
  assert.equal(output.stderr, '');
  assert.equal(fixture.calls.length, 0);
  const again = await run(process.execPath, [cli, '--setup'], { env: fixture.env, timeout: 5000 });
  assert.doesNotMatch(again.stdout, /Enter code/);
  assert.equal(fixture.registrations(), 1);
  assert.equal(fixture.calls.length, 0);
});

test('setup --read-only requests and persists only kanban:read', { timeout: 10_000 }, async t => {
  const fixture = await httpFixture(t, ['kanban:read']);
  const output = await run(process.execPath, [cli, '--setup', '--read-only'], { env: fixture.env, timeout: 8000 });
  assert.match(output.stdout, /No tool operation was submitted/);
  assert.equal(output.stderr, '');
  const stored = await new CredentialStore(new URL(fixture.env.PM_MCP_URL), fixture.env).load();
  assert.deepEqual(stored.scopes, ['kanban:read']);
  assert.equal(fixture.calls.length, 0);
  assert.equal(fixture.registrations(), 1);
});

test('terminal setup reconnect replaces an existing saved approval and ordinary setup reuses it', { timeout: 15_000 }, async t => {
  const fixture = await httpFixture(t, ['kanban:read']);
  const store = new CredentialStore(new URL(fixture.env.PM_MCP_URL), fixture.env);
  await store.save(credential(new URL(fixture.env.PM_MCP_URL), 'Original account'));
  const oldHost = await stdio(t, fixture.env);
  const originalStatus = await oldHost.client.callTool({ name: 'connect_account', arguments: { action: 'status' } });
  assert.equal(originalStatus.structuredContent.account.name, 'Original account');
  const output = await run(process.execPath, [cli, '--read-only', '--reconnect', '--setup'], { env: fixture.env, timeout: 10_000 });
  assert.match(output.stdout, /Enter code: ABCD2345/);
  assert.match(output.stdout, /reconnect|restart/i);
  assert.match(output.stdout, /No tool operation was submitted/);
  assert.equal(output.stderr, '');
  safeOutput(output);
  assert.equal(fixture.registrations(), 1);
  assert.equal(fixture.polls(), 1);
  assert.equal(fixture.calls.length, 0);
  const stored = await store.load();
  assert.equal(stored.account.name, 'Fixture User');
  assert.deepEqual(stored.scopes, ['kanban:read']);
  const stillRunning = await oldHost.client.callTool({ name: 'connect_account', arguments: { action: 'status' } });
  assert.equal(stillRunning.structuredContent.account.name, 'Original account');
  await oldHost.client.close();
  const freshHost = await stdio(t, fixture.env);
  const freshStatus = await freshHost.client.callTool({ name: 'connect_account', arguments: { action: 'status' } });
  assert.equal(freshStatus.structuredContent.account.name, 'Fixture User');
  const reused = await run(process.execPath, [cli, '--setup'], { env: fixture.env, timeout: 5000 });
  assert.doesNotMatch(reused.stdout, /Enter code/);
  safeOutput(reused);
  assert.equal(fixture.registrations(), 1);
  assert.equal(fixture.polls(), 1);
  assert.equal(fixture.calls.length, 0);
});

test('setup reconnect reports replacement failure while preserving the ready original account', async t => {
  for (const outcome of ['contract', 'storage', 'denied']) {
    let saved = credential(url, 'Original'), claim, reject, registrations = 0;
    const original = saved;
    const writes = [], calls = [];
    const expectedCode = { contract: 'REMOTE_CONTRACT_MISMATCH', storage: 'CREDENTIAL_STORE_UNAVAILABLE', denied: 'PAIRING_ENDED' }[outcome];
    const account = new AccountService({}, {
      store: { load: async () => saved, save: async value => { writes.push(value); if (outcome === 'storage') return { persisted: false }; saved = value; return { persisted: true }; }, remove: async () => { assert.fail('Reconnect cannot delete the original credential.'); } },
      makeRemote: () => {
        let identity;
        return {
          initialize: async token => { identity = token; if (token !== secret && outcome === 'contract') throw new BridgeError('REMOTE_CONTRACT_MISMATCH', 'Mismatch.'); return token === secret ? 'workspace' : 'all'; },
          close: async () => {},
          callTool: async () => { calls.push(identity); return { content: [], structuredContent: { ok: true } }; },
        };
      },
      makeFlow: () => {
        registrations++;
        const done = new Promise((resolve, fail) => { claim = resolve; reject = fail; }); void done.catch(() => {});
        return { start: async () => ({}), snapshot: () => ({ status: 'pending' }), wait: () => done, cancel: () => reject(new BridgeError('PAIRING_CANCELLED', 'Cancelled.')) };
      },
    });
    t.after(() => account.close());
    assert.equal(await account.workspaceAccess(), false);
    const replacement = account.setup(() => {}, false, true);
    const failure = assert.rejects(replacement, error => error.code === expectedCode);
    await settle();
    assert.equal(registrations, 1);
    assert.equal((await account.callTool('list_projects', {})).structuredContent.ok, true);
    if (outcome === 'denied') reject(new BridgeError('PAIRING_ENDED', 'Denied.'));
    else claim({ ...credential(url, 'Replacement'), secret: 'pm_candidate_test_only_1234567890' });
    await failure;
    assert.equal(saved, original);
    assert.equal(writes.length, outcome === 'storage' ? 1 : 0);
    const status = await account.callTool('connect_account', { action: 'status' });
    assert.equal(status.structuredContent.status, 'connected');
    assert.equal(status.structuredContent.account.name, 'Original');
    assert.equal(status.structuredContent.replacementError.code, expectedCode);
    assert.equal((await account.callTool('list_projects', {})).structuredContent.ok, true);
    assert.deepEqual(calls, [secret, secret]);
    safeOutput(status);
  }
});

test('pairing HTTP redirects cannot forward the polling secret', async t => {
  let redirected = 0;
  const target = createServer((_req, res) => { redirected++; res.writeHead(200); res.end(); });
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
  t.after(async () => { target.closeAllConnections(); await new Promise(resolve => target.close(resolve)); });
  let endpoint;
  const source = createServer((req, res) => {
    if (req.url === '/api/mcp/pairings') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: issue(Date.now(), endpoint) })); }
    else { res.writeHead(307, { Location: `http://127.0.0.1:${target.address().port}/leak` }); res.end(); }
  });
  await new Promise(resolve => source.listen(0, '127.0.0.1', resolve));
  t.after(async () => { source.closeAllConnections(); await new Promise(resolve => source.close(resolve)); });
  endpoint = new URL(`http://127.0.0.1:${source.address().port}/mcp`);
  const flow = new PairingFlow(endpoint, { now: Date.now, sleep: async () => {} });
  await flow.start(scopes);
  await assert.rejects(flow.wait(), error => error.code === 'PAIRING_CONNECTION_FAILED');
  assert.equal(redirected, 0);
});

test('cancel, rejection, contract failure and persistence failure preserve the old live and durable account', async t => {
  for (const outcome of ['cancel', 'denied', 'contract', 'storage']) {
    let saved = credential(url, 'Original'), claim, reject;
    const writes = [], calls = [];
    const account = new AccountService({}, {
      store: { load: async () => saved, save: async value => { writes.push(value); if (outcome === 'storage') return { persisted: false }; saved = value; return { persisted: true }; }, remove: async () => {} },
      makeRemote: () => {
        let identity;
        return { initialize: async token => { identity = token; if (token !== secret && outcome === 'contract') throw new BridgeError('REMOTE_CONTRACT_MISMATCH', 'Mismatch.'); return token === secret ? 'workspace' : 'all'; }, close: async () => {}, callTool: async () => { calls.push(identity); return { content: [], structuredContent: { ok: true } }; } };
      },
      makeFlow: () => {
        const done = new Promise((resolve, fail) => { claim = resolve; reject = fail; }); void done.catch(() => {});
        return { start: async () => ({}), snapshot: () => ({ status: 'pending' }), wait: () => done, cancel: () => reject(new BridgeError('PAIRING_CANCELLED', 'Cancelled.')) };
      },
    });
    t.after(() => account.close());
    assert.equal(await account.workspaceAccess(), false);
    await account.callTool('connect_account', { action: 'reconnect', confirm: true });
    assert.equal((await account.callTool('list_projects', {})).structuredContent.ok, true);
    if (outcome === 'cancel') await account.callTool('connect_account', { action: 'cancel' });
    else if (outcome === 'denied') reject(new BridgeError('PAIRING_ENDED', 'Denied.'));
    else claim({ ...credential(url, 'Replacement'), secret: 'pm_candidate_test_only_1234567890' });
    await settle();
    assert.equal((await account.callTool('connect_account', { action: 'status' })).structuredContent.account.name, 'Original');
    assert.equal((await account.callTool('list_projects', {})).structuredContent.ok, true);
    assert.equal(saved.account.name, 'Original');
    assert.deepEqual(calls, [secret, secret]);
    assert.equal(writes.length, outcome === 'storage' ? 1 : 0);
    assert.equal(await account.workspaceAccess(), false);
  }
});

test('a replacement does not close or replay an in-flight operation on the original connection', async t => {
  let complete, claim, oldClosed = false, instance = 0;
  const pending = new Promise(resolve => { complete = resolve; });
  const account = new AccountService({}, {
    store: { load: async () => credential(), save: async () => ({ persisted: true }), remove: async () => {} },
    makeRemote: () => {
      const original = instance++ === 0;
      return { initialize: async () => original ? 'workspace' : 'all', close: async () => { if (original) oldClosed = true; }, callTool: async () => { assert.equal(original, true); await pending; return { content: [], structuredContent: { original: true } }; } };
    },
    makeFlow: () => ({ start: async () => ({}), snapshot: () => ({ status: 'pending' }), wait: () => new Promise(resolve => { claim = resolve; }), cancel: () => {} }),
  });
  t.after(() => account.close());
  const operation = account.callTool('create_project', {}); await settle();
  await account.callTool('connect_account', { action: 'reconnect', confirm: true });
  claim(credential(url, 'Replacement')); await settle();
  assert.equal(await account.workspaceAccess(), true);
  assert.equal(oldClosed, false);
  complete(); assert.equal((await operation).structuredContent.original, true);
  assert.equal(oldClosed, true);
});

test('verified broad catalog refreshes the host and survives a fresh process without another approval', { timeout: 15_000 }, async t => {
  const fixture = await httpFixture(t, scopes, true);
  let changes = 0, cachedTools = [];
  const first = await stdio(t, fixture.env, undefined, { tools: { debounceMs: 0, autoRefresh: true, onChanged: (error, tools) => { assert.equal(error, null); changes++; cachedTools = tools; } } });
  assert.equal((await first.client.listTools()).tools.some(tool => tool.name === 'list_workspaces'), false);
  await first.client.callTool({ name: 'connect_account', arguments: {} });
  for (let attempt = 0; attempt < 60; attempt++) {
    if ((await first.client.callTool({ name: 'connect_account', arguments: { action: 'status' } })).structuredContent.status === 'connected') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const tools = (await first.client.listTools()).tools;
  assert.equal(tools.length, ALL_WORKSPACE_TOOL_DEFINITIONS.length + 1);
  for (let attempt = 0; attempt < 100 && !cachedTools.some(tool => tool.name === 'list_workspaces'); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(changes > 0, 'Worker catalog change reaches the supervisor and host.');
  assert.equal(cachedTools.length, ALL_WORKSPACE_TOOL_DEFINITIONS.length + 1, 'The host refreshes its cached schemas automatically.');
  assert.equal(tools.find(tool => tool.name === 'list_projects').inputSchema.properties.workspaceId.type, 'string');
  const args = { workspaceId: '11111111-1111-4111-8111-111111111111' };
  await first.client.callTool({ name: 'list_projects', arguments: args });
  assert.deepEqual(fixture.calls.at(-1), { name: 'list_projects', args });
  await first.client.close();
  const second = await stdio(t, fixture.env);
  assert.equal((await second.client.listTools()).tools.length, ALL_WORKSPACE_TOOL_DEFINITIONS.length + 1);
  assert.equal((await second.client.callTool({ name: 'connect_account', arguments: { action: 'status' } })).structuredContent.workspaceAccess, 'all');
  assert.equal(fixture.registrations(), 1);
  assert.equal(fixture.polls(), 1);
  await second.client.callTool({ name: 'connect_account', arguments: { action: 'disconnect', confirm: true } });
  assert.equal((await second.client.listTools()).tools.some(tool => tool.name === 'list_workspaces'), false);
});

test('a late authorization failure from the old initializer cannot erase the promoted account', async t => {
  let releaseSave, rejectOld, instance = 0;
  const saveBarrier = new Promise(resolve => { releaseSave = resolve; });
  const oldInitialization = new Promise((_resolve, reject) => { rejectOld = reject; });
  const account = new AccountService({}, {
    store: { load: async () => credential(), save: async () => { await saveBarrier; return { persisted: true }; }, remove: async () => {} },
    makeRemote: () => {
      const original = instance++ === 0;
      return { initialize: async () => original ? oldInitialization : 'all', close: async () => {}, callTool: async () => ({ content: [], structuredContent: { replacement: true } }) };
    },
    makeFlow: () => ({ start: async () => ({}), snapshot: () => ({ status: 'pending' }), wait: async () => credential(url, 'Replacement'), cancel: () => {} }),
  });
  t.after(() => account.close());
  await account.callTool('connect_account', { action: 'reconnect', confirm: true });
  await settle();
  const oldCall = account.callTool('list_projects', {}); await settle();
  releaseSave(); await settle();
  rejectOld(new BridgeError('AUTH_REQUIRED', 'Old authorization expired.'));
  assert.equal((await oldCall).structuredContent.error.code, 'AUTH_REQUIRED');
  assert.equal((await account.callTool('connect_account', { action: 'status' })).structuredContent.account.name, 'Replacement');
  assert.equal(await account.workspaceAccess(), true);
  assert.equal((await account.callTool('list_projects', {})).structuredContent.replacement, true);
});
