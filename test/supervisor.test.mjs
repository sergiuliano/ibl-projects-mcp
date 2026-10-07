import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ElicitRequestSchema, ListToolsRequestSchema, ResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { Supervisor } from '../dist/supervisor.js';
import { AccountService } from '../dist/account.js';

const bundled = '/fixture/bundled', next = '/fixture/next';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const answer = value => ({ content: [{ type: 'text', text: value }], structuredContent: { value } });
async function fixture(t, settings = {}) {
  let now = 0;
  let selected = { root: bundled };
  const calls = [], workers = [], rollbacks = [];
  const factory = async root => {
    if (root === next) await settings.beforeCandidate?.();
    const config = root === next ? settings.candidate || {} : settings.current || {};
    if (config.fail) throw new Error('Candidate failed before becoming usable');
    const server = new Server({ name: 'fixture', version: root === next ? '2' : '1' }, { capabilities: config.capabilities || { tools: {} }, instructions: config.instructions });
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      if (config.failDiscovery) throw new Error('Bad discovery');
      return { tools: config.tools || [{ name: 'work', inputSchema: { type: 'object' } }, { name: 'connect_account', inputSchema: { type: 'object' } }] };
    });
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      calls.push({ root, request });
      if (request.params.arguments?.elicit) return answer((await server.elicitInput({ mode: 'form', message: 'Approve fixture?', requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean' } } } }, { signal: extra.signal })).action);
      return settings.call ? settings.call(root, request, extra) : answer(root);
    });
    const client = new Client({ name: 'fixture-supervisor-client', version: '1' }, { capabilities: { elicitation: { form: {} } } });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await client.connect(clientTransport);
    const worker = {
      root, client, protocolVersion: config.protocolVersion || '2025-11-25', closed: false, configured: [],
      async inspect() { return { version: root === next ? '2' : '1', supervisorVersion: config.supervisorVersion || 1, supervisorDigest: config.supervisorDigest || 'a'.repeat(64), workerProtocol: config.workerProtocol || 1, account: settings.account?.() || { safe: true } }; },
      async configureHost(value) { worker.configured.push(value); },
      async close() { worker.closed = true; await client.close(); await server.close(); },
    };
    workers.push(worker); return worker;
  };
  const supervisor = await Supervisor.create({ repository: 'sergiuliano/ibl-projects-mcp', version: '1', bundledRoot: bundled, env: { PM_MCP_AUTO_UPDATE: '0' } }, {
    createWorker: factory, check: async () => {}, select: async () => selected, rollback: async commit => { rollbacks.push(commit); },
    now: () => now, idleMs: 60_000, automaticChecks: false,
  });
  const host = new Client({ name: 'fixture-host', version: '1' }, { capabilities: { elicitation: { form: {} } }, listChanged: settings.listChanged });
  const [hostTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await supervisor.connect(serverTransport); await host.connect(hostTransport);
  t.after(async () => { await host.close(); await supervisor.close(); });
  return { host, supervisor, calls, workers, rollbacks, hostTransport,
    time(value) { now = value; }, prepare(metadata = {}) { selected = { root: next, commit: 'b'.repeat(40), version: '2', ...metadata }; },
  };
}

test('swap requires a complete 60 seconds idle after the last tool, preserving host transport', async t => {
  const f = await fixture(t);
  await f.host.callTool({ name: 'work', arguments: {} });
  f.prepare(); f.time(59_999); await f.supervisor.checkNow();
  assert.equal(f.supervisor.workerRoot, bundled);
  f.time(60_000); await f.supervisor.applyIfIdle();
  assert.equal(f.supervisor.workerRoot, next);
  assert.equal(f.host.transport, f.hostTransport);
  assert.equal(f.workers[0].closed, true);
  assert.equal((await f.host.callTool({ name: 'work', arguments: {} })).structuredContent.value, next);
  assert.equal(f.calls.length, 2);
  const status = await f.host.callTool({ name: 'connect_account', arguments: { action: 'status' } });
  assert.equal(status.structuredContent.clientRuntime.bootstrap.root, bundled);
  assert.equal(status.structuredContent.clientRuntime.runtime.root, next);
});

test('active calls finish on their original worker and are never replayed', async t => {
  const started = deferred(), finish = deferred();
  const f = await fixture(t, { call: async root => { started.resolve(); await finish.promise; return answer(root); } });
  const call = f.host.callTool({ name: 'work', arguments: {} }); await started.promise;
  f.time(120_000); f.prepare(); await f.supervisor.checkNow();
  assert.equal(f.supervisor.activeRequests, 1); assert.equal(f.workers.length, 1);
  finish.resolve(); assert.equal((await call).structuredContent.value, bundled);
  f.time(179_999); await f.supervisor.applyIfIdle(); assert.equal(f.supervisor.workerRoot, bundled);
  f.time(180_000); await f.supervisor.applyIfIdle(); assert.equal(f.supervisor.workerRoot, next);
  assert.equal(f.calls.length, 1);
});

test('a call arriving while candidate initializes postpones the swap', async t => {
  const starting = deferred(), release = deferred();
  const f = await fixture(t, { beforeCandidate: async () => { starting.resolve(); await release.promise; } });
  f.prepare(); f.time(60_000);
  const check = f.supervisor.checkNow(); await starting.promise;
  await f.host.callTool({ name: 'work', arguments: {} });
  release.resolve(); await check;
  assert.equal(f.supervisor.workerRoot, bundled);
  assert.equal(f.workers[1].closed, true);
  f.time(120_000); await f.supervisor.applyIfIdle(); assert.equal(f.supervisor.workerRoot, next);
  assert.equal(f.calls.length, 1);
});

test('unknown write outcomes keep their worker and do not replay the call', async t => {
  const f = await fixture(t, { call: async () => ({ isError: true, content: [], structuredContent: { error: { outcomeUncertain: true, automaticRetryPerformed: false } } }) });
  await f.host.callTool({ name: 'work', arguments: {} });
  f.prepare(); f.time(120_000); await f.supervisor.checkNow(); await f.supervisor.applyIfIdle();
  assert.equal(f.calls.length, 1); assert.equal(f.workers.length, 1);
  assert.equal(f.supervisor.status().reconnectRequired, true);
});

test('cancelled calls are never replayed or cut off by an update', async t => {
  const started = deferred(), finish = deferred();
  const f = await fixture(t, { call: async () => { started.resolve(); await finish.promise; return answer('completed'); } });
  const controller = new globalThis.AbortController();
  const call = f.host.callTool({ name: 'work', arguments: {} }, undefined, { signal: controller.signal });
  await started.promise; controller.abort(); await assert.rejects(call);
  await new Promise(resolve => setImmediate(resolve));
  f.prepare(); f.time(120_000); await f.supervisor.checkNow();
  assert.equal(f.supervisor.workerRoot, bundled); assert.equal(f.calls.length, 1);
  assert.equal(f.supervisor.status().reconnectRequired, true);
  finish.resolve();
});

test('candidate startup and discovery failures roll back without losing the live worker', async t => {
  for (const candidate of [{ fail: true }, { failDiscovery: true }]) {
    await t.test(JSON.stringify(candidate), async t => {
      const f = await fixture(t, { candidate }); f.prepare(); f.time(60_000); await f.supervisor.checkNow();
      assert.deepEqual(f.rollbacks, ['b'.repeat(40)]); assert.equal(f.supervisor.workerRoot, bundled);
      assert.equal((await f.host.callTool({ name: 'work', arguments: {} })).structuredContent.value, bundled);
    });
  }
});

test('supervisor, worker protocol, MCP protocol and capabilities changes require reconnect', async t => {
  for (const candidate of [{ supervisorVersion: 2 }, { supervisorDigest: 'b'.repeat(64) }, { workerProtocol: 2 }, { protocolVersion: 'other' }, { capabilities: { tools: { listChanged: true } } }]) {
    await t.test(JSON.stringify(candidate), async t => {
      const f = await fixture(t, { candidate }); f.prepare(); f.time(60_000); await f.supervisor.checkNow();
      assert.equal(f.supervisor.workerRoot, bundled); assert.equal(f.supervisor.status().reconnectRequired, true);
      assert.equal(f.rollbacks.length, 0); assert.equal(f.workers[1].closed, true);
    });
  }
});

test('release metadata can require reconnect without launching an incompatible worker', async t => {
  const f = await fixture(t); f.prepare({ supervisorVersion: 2 }); f.time(60_000); await f.supervisor.checkNow();
  assert.equal(f.workers.length, 1); assert.equal(f.supervisor.status().reconnectRequired, true);
});

test('pending or session-only account state defers the swap until safe', async t => {
  let safe = false;
  const f = await fixture(t, { account: () => ({ safe, reason: 'Approval is still pending' }) });
  f.prepare(); f.time(60_000); await f.supervisor.checkNow();
  assert.equal(f.workers.length, 1); assert.equal(f.supervisor.status().reconnectRequired, true);
  safe = true; await f.supervisor.applyIfIdle(); assert.equal(f.supervisor.workerRoot, next);
});

test('host elicitation continues through the supervisor before and after a swap', async t => {
  const f = await fixture(t); let requests = 0;
  f.host.setRequestHandler(ElicitRequestSchema, async () => { requests++; return { action: 'accept', content: { confirm: true } }; });
  assert.equal((await f.host.callTool({ name: 'work', arguments: { elicit: true } })).structuredContent.value, 'accept');
  f.prepare(); f.time(60_000); await f.supervisor.checkNow();
  assert.equal((await f.host.callTool({ name: 'work', arguments: { elicit: true } })).structuredContent.value, 'accept');
  assert.equal(requests, 2); assert.deepEqual(f.workers[1].configured, [true]);
});

test('host cannot access internal runtime/account handshake methods', async t => {
  const f = await fixture(t);
  await assert.rejects(f.host.request({ method: 'maddots/runtime' }, ResultSchema), error => error.code === -32601);
  assert.equal(f.calls.length, 0);
});

test('a stopped worker requires reconnect without replay or automatic reauthorization', async t => {
  const f = await fixture(t);
  await f.workers[0].close();
  await assert.rejects(f.host.callTool({ name: 'work', arguments: {} }), /Reconnect/);
  assert.equal(f.calls.length, 0); assert.equal(f.workers.length, 1); assert.equal(f.supervisor.status().reconnectRequired, true);
});

const secret = 'pm_fixture_authorization_only_123456789';
const credential = { endpoint: 'https://example.test/mcp', secret, account: { id: 'fixture', name: 'Fixture' }, scopes: ['kanban:read'], expiresAt: '2099-01-01T00:00:00.000Z' };
const remote = () => ({ async initialize() {}, async close() {}, async callTool() { return answer('ok'); } });
test('account safety distinguishes durable, memory-only, disconnected and env-reconnected sessions', async t => {
  for (const persisted of [true, false]) {
    const complete = deferred();
    const account = new AccountService({ PM_MCP_URL: credential.endpoint }, {
      remote: remote(), store: { async load() {}, async save() { return { persisted }; }, async remove() {} },
      makeFlow: () => ({ async start() { return { status: 'pending', userCode: 'ABCD1234' }; }, snapshot() { return { status: 'pending' }; }, wait: () => complete.promise, cancel() { complete.resolve(credential); } }),
    });
    assert.equal(account.updateSafety().safe, true);
    await account.callTool('connect_account', {}); assert.equal(account.updateSafety().safe, false);
    complete.resolve(credential); await new Promise(resolve => setImmediate(resolve));
    assert.equal(account.updateSafety().safe, persisted);
    await account.callTool('connect_account', { action: 'disconnect', confirm: true }); assert.equal(account.updateSafety().safe, false);
    await account.close();
  }
  const replacement = new AccountService({ PM_MCP_URL: credential.endpoint, PM_MCP_TOKEN: secret }, {
    remote: remote(), store: { async load() {}, async save() { return { persisted: true }; }, async remove() {} },
    makeFlow: () => ({ async start() { return { status: 'pending' }; }, snapshot() { return { status: 'pending' }; }, async wait() { return credential; }, cancel() {} }),
  });
  t.after(() => replacement.close());
  await replacement.callTool('connect_account', {}); assert.equal(replacement.updateSafety().safe, true);
  await replacement.callTool('connect_account', { action: 'reconnect', confirm: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(replacement.updateSafety().safe, false);
  assert.match(replacement.updateSafety().reason, /Environment/);
});


test('SDK hosts automatically refresh tool schemas after a compatible worker swap', { timeout: 5_000 }, async t => {
  const changed = deferred();
  const updatedTools = [{ name: 'work', inputSchema: { type: 'object', properties: { newField: { type: 'string' } } } }, { name: 'new_tool', inputSchema: { type: 'object' } }];
  const f = await fixture(t, {
    candidate: { tools: updatedTools },
    listChanged: { tools: { debounceMs: 0, autoRefresh: true, onChanged: (error, tools) => changed.resolve({ error, tools }) } },
  });
  assert.deepEqual(f.workers[0].client.getServerCapabilities().tools, {});
  assert.equal(f.host.getServerCapabilities().tools.listChanged, true);
  f.prepare(); f.time(60_000); await f.supervisor.checkNow();
  const refreshed = await changed.promise;
  assert.equal(refreshed.error, null); assert.deepEqual(refreshed.tools, updatedTools);
  assert.equal(f.supervisor.workerRoot, next); assert.equal(f.host.transport, f.hostTransport);
});

test('changed initialization instructions require reconnect without exposing new tools under stale guidance', async t => {
  const original = 'Require explicit approval before every write.';
  const f = await fixture(t, { current: { instructions: original }, candidate: { instructions: 'Writes require a new confirmation procedure.' } });
  f.prepare(); f.time(60_000); await f.supervisor.checkNow();
  assert.equal(f.supervisor.workerRoot, bundled); assert.equal(f.host.getInstructions(), original);
  assert.equal(f.supervisor.status().reconnectRequired, true); assert.match(f.supervisor.status().reason, /instructions/);
  assert.equal(f.workers[1].closed, true); assert.equal(f.rollbacks.length, 0);
});
