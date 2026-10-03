import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { MCP_VERSION, TOOL_DEFINITIONS } from '../dist/contract.js';
import { accessToken, endpoint } from '../dist/config.js';
import { RemoteService, verifyCatalog } from '../dist/remote.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = promisify(execFile);
const syntheticToken = 'pm_test_only_not_a_real_credential_123456789';
const cli = join(root, 'dist/cli.js');
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key, value]) => !key.startsWith('PM_MCP_') && typeof value === 'string'));

async function fixture(t, { catalog = TOOL_DEFINITIONS, disconnect = false, redirectTo } = {}) {
  const calls = [];
  let authenticated = 0;
  const http = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${syntheticToken}`) {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end(`Untrusted error page with ${req.headers.authorization || 'no token'}`);
      return;
    }
    authenticated++;
    if (redirectTo) { res.writeHead(307, { Location: redirectTo }); res.end(); return; }
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); res.end(); return; }
    const parts = [];
    for await (const part of req) parts.push(part);
    const input = JSON.parse(Buffer.concat(parts).toString('utf8'));
    if (input.method === 'tools/call') {
      calls.push(input.params);
      if (disconnect) { res.destroy(); return; }
    }
    const server = new Server({ name: 'fixture', version: MCP_VERSION }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: catalog }));
    server.setRequestHandler(CallToolRequestSchema, async request => ({ content: [{ type: 'text', text: JSON.stringify({ name: request.params.name, args: request.params.arguments }) }], structuredContent: { fixture: true } }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, input);
    } finally { await server.close(); }
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(async () => { http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); });
  const env = {
    ...cleanEnv(), PM_MCP_URL: `http://127.0.0.1:${http.address().port}/mcp`,
    PM_MCP_ALLOW_INSECURE_LOOPBACK: '1', PM_MCP_TOKEN: syntheticToken,
  };
  return { env, calls, authenticated: () => authenticated };
}

test('endpoint requires HTTPS and explicit local HTTP opt-in', () => {
  assert.equal(endpoint({}).href, 'https://pm.ibl.ro/mcp');
  for (const value of ['http://example.com/mcp', 'http://127.0.0.1/mcp', 'https://user:secret@example.com/mcp', 'https://example.com/mcp?token=secret', 'https://example.com/mcp#token']) {
    assert.throws(() => endpoint({ PM_MCP_URL: value }), /HTTPS|Local HTTP/);
  }
  assert.equal(endpoint({ PM_MCP_URL: 'http://127.0.0.1:1234/mcp', PM_MCP_ALLOW_INSECURE_LOOPBACK: '1' }).protocol, 'http:');
  assert.throws(() => endpoint({ PM_MCP_URL: 'http://example.com/mcp', PM_MCP_ALLOW_INSECURE_LOOPBACK: '1' }));
});

test('token file rejects loose permissions, symlinks, directories and ambiguous configuration', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pm-mcp-token-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'token');
  await writeFile(path, syntheticToken + '\n', { mode: 0o600 });
  assert.equal(await accessToken({ PM_MCP_TOKEN_FILE: path }), syntheticToken);
  await chmod(path, 0o644);
  await assert.rejects(accessToken({ PM_MCP_TOKEN_FILE: path }), /0600/);
  await chmod(path, 0o600);
  const link = join(directory, 'link');
  await symlink(path, link);
  await assert.rejects(accessToken({ PM_MCP_TOKEN_FILE: link }), /symlink/);
  await mkdir(join(directory, 'folder'));
  await assert.rejects(accessToken({ PM_MCP_TOKEN_FILE: join(directory, 'folder') }));
  await assert.rejects(accessToken({ PM_MCP_TOKEN: syntheticToken, PM_MCP_TOKEN_FILE: path }), /not both/);
  await assert.rejects(accessToken({ PM_MCP_TOKEN: syntheticToken + '\nInjected: invalid' }), /invalid format/);
});

test('catalog checks all tools and validation schemas before forwarding operations', () => {
  assert.ok(TOOL_DEFINITIONS.length > 0);
  verifyCatalog(globalThis.structuredClone(TOOL_DEFINITIONS));
  const descriptions = globalThis.structuredClone(TOOL_DEFINITIONS);
  descriptions[0].inputSchema.description = 'Changed prose only';
  verifyCatalog(descriptions);
  assert.throws(() => verifyCatalog(TOOL_DEFINITIONS.slice(1)), /tool list/);
  const changed = globalThis.structuredClone(TOOL_DEFINITIONS);
  changed[0].inputSchema.properties = { ...(changed[0].inputSchema.properties || {}), unexpected: { type: 'boolean' } };
  assert.throws(() => verifyCatalog(changed), /schemas/);
});

test('setup authenticates and verifies the contract without calling a tool', async t => {
  const server = await fixture(t);
  const result = await run(process.execPath, [cli, '--setup'], { env: server.env, timeout: 15_000 });
  assert.match(result.stdout, /No tool operation was submitted/);
  assert.equal(result.stderr, '');
  assert.equal(server.calls.length, 0);
  assert.ok(server.authenticated() >= 2);
});

test('mismatched hosted contract fails setup before tools are called', async t => {
  const server = await fixture(t, { catalog: [] });
  await assert.rejects(run(process.execPath, [cli, '--setup'], { env: server.env, timeout: 15_000 }), error => {
    assert.match(error.stderr, /REMOTE_CONTRACT_MISMATCH/);
    assert.equal(error.stdout, '');
    assert.ok(!error.stderr.includes(syntheticToken));
    return true;
  });
  assert.equal(server.calls.length, 0);
});

test('stdio discovery adds only the local account tool and stdout remains protocol clean', async t => {
  const server = await fixture(t);
  const client = new Client({ name: 'stdio-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli], env: server.env, stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk.toString(); });
  t.after(() => client.close());
  await client.connect(transport);
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map(tool => tool.name).sort(), [...TOOL_DEFINITIONS.map(tool => tool.name), 'connect_account'].sort());
  assert.equal(server.calls.length, 0);
  const result = await client.callTool({ name: 'list_projects', arguments: {} });
  assert.deepEqual(result.structuredContent, { fixture: true });
  assert.deepEqual(server.calls, [{ name: 'list_projects', arguments: {} }]);
  assert.equal(stderr, '');
});

test('bridge forwards one operation once and preserves its structured result', async t => {
  const server = await fixture(t);
  const remote = new RemoteService(server.env);
  t.after(() => remote.close());
  await remote.initialize();
  const tool = TOOL_DEFINITIONS[0];
  const result = await remote.callTool(tool.name, { fixtureArgument: 'value' });
  assert.deepEqual(result.structuredContent, { fixture: true });
  assert.deepEqual(server.calls, [{ name: tool.name, arguments: { fixtureArgument: 'value' } }]);
  const denied = await remote.callTool('unpublished_membership_action', {});
  assert.equal(denied.isError, true);
  assert.equal(server.calls.length, 1);
});

test('lost write response stays uncertain and is never automatically replayed', async t => {
  const mutation = TOOL_DEFINITIONS.find(tool => tool.annotations?.readOnlyHint !== true);
  assert.ok(mutation, 'The Kanban contract must include an explicit mutation.');
  const server = await fixture(t, { disconnect: true });
  const remote = new RemoteService(server.env);
  t.after(() => remote.close());
  await remote.initialize();
  const result = await remote.callTool(mutation.name, {});
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.outcomeUncertain, true);
  assert.equal(result.structuredContent.error.automaticRetryPerformed, false);
  assert.equal(server.calls.length, 1);
});

test('authentication failure redacts token and untrusted server response from stderr', async t => {
  const server = await fixture(t);
  const wrongToken = syntheticToken + '_wrong';
  await assert.rejects(run(process.execPath, [cli, '--setup'], { env: { ...server.env, PM_MCP_TOKEN: wrongToken }, timeout: 15_000 }), error => {
    assert.match(error.stderr, /AUTH_REQUIRED/);
    assert.equal(error.stdout, '');
    assert.ok(!error.stderr.includes(wrongToken));
    assert.ok(!error.stderr.includes('Untrusted error page'));
    return true;
  });
  assert.equal(server.calls.length, 0);
});

test('redirects cannot forward the token to another endpoint', async t => {
  let redirectedRequests = 0;
  const target = createServer((_req, res) => { redirectedRequests++; res.writeHead(401); res.end(); });
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
  t.after(async () => { target.closeAllConnections(); await new Promise(resolve => target.close(resolve)); });
  const server = await fixture(t, { redirectTo: `http://127.0.0.1:${target.address().port}/mcp` });
  await assert.rejects(run(process.execPath, [cli, '--setup'], { env: server.env, timeout: 15_000 }), error => {
    assert.match(error.stderr, /REMOTE_CONNECTION_FAILED/);
    assert.ok(!error.stderr.includes(syntheticToken));
    return true;
  });
  assert.equal(redirectedRequests, 0);
});

test('help and version do not need credentials and unknown arguments fail without echoing them', async () => {
  const env = cleanEnv();
  const version = await run(process.execPath, [cli, '--version'], { env });
  assert.equal(version.stdout.trim(), MCP_VERSION);
  const help = await run(process.execPath, [cli, '--help'], { env });
  assert.match(help.stdout, /PM_MCP_TOKEN_FILE/);
  await assert.rejects(run(process.execPath, [cli, '--token=' + syntheticToken], { env }), error => {
    assert.ok(!error.stderr.includes(syntheticToken));
    assert.equal(error.stdout, '');
    return true;
  });
});
