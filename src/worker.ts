import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { MCP_VERSION } from './contract.js';
import { createMcpServer } from './server.js';
import { AccountService, CONNECT_ACCOUNT_TOOL } from './account.js';
import { BridgeError } from './config.js';

export const SUPERVISOR_VERSION = 1;
export const WORKER_PROTOCOL = 1;

export async function runWorker(): Promise<void> {
  let hostElicitation = false;
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const digest = createHash('sha256');
  // Hash the actual supervising implementation, not merely a declared revision.
  // These fixed paths cannot read credentials or arbitrary package files.
  for (const name of ['cli', 'runtime', 'supervisor', 'updater', 'npm']) {
    digest.update(name + '\0'); digest.update(await readFile(resolve(root, `dist/${name}.js`)));
  }
  const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
  digest.update(JSON.stringify(Object.entries(manifest.dependencies || {}).sort(([a], [b]) => a.localeCompare(b))));
  const supervisorDigest = digest.digest('hex');
  const account = new AccountService(process.env, {
    confirmReconnect: async (signal, action) => {
      if (!hostElicitation) return undefined;
      const response = await server.elicitInput({
        mode: 'form',
        message: action === 'disconnect' ? 'Disconnect the current MadDots account and delete its saved credential for this endpoint?' : 'Replace the current MadDots account connection? A new approval code will be required before project operations can continue.',
        requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean', title: action === 'disconnect' ? 'Disconnect current connection' : 'Replace current connection', default: false } }, required: ['confirm'] },
      }, { signal });
      return response.action === 'accept' && response.content?.confirm === true;
    },
    presentPairing: async (pending, signal) => {
      if (!hostElicitation) return false;
      await server.elicitInput({
        mode: 'form',
        message: `Open ${pending.verificationUri} and enter code ${pending.userCode}. Sign in to the intended account and review the requested connection. The code expires at ${pending.expiresAt}.`,
        requestedSchema: { type: 'object', properties: { acknowledged: { type: 'boolean', title: 'I have seen the approval code', default: false } }, required: ['acknowledged'] },
      }, { signal });
      return true;
    },
  });
  const server = createMcpServer(account, [CONNECT_ACCOUNT_TOOL]);
  // These methods exist only between the local supervisor and its child. They
  // are not tools and the supervisor never forwards them from the MCP host.
  server.fallbackRequestHandler = async request => {
    if (request.method === 'maddots/runtime') return {
      version: MCP_VERSION, supervisorDigest, supervisorVersion: SUPERVISOR_VERSION, workerProtocol: WORKER_PROTOCOL,
      account: account.updateSafety(),
    };
    if (request.method === 'maddots/host') {
      hostElicitation = request.params?.elicitation === true;
      return {};
    }
    throw new McpError(ErrorCode.MethodNotFound, 'Unknown method');
  };
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await server.close().catch(() => {});
    await account.close();
  };
  process.once('SIGINT', () => { void close(); });
  process.once('SIGTERM', () => { void close(); });
  server.onclose = () => { void close(); };
  try { await server.connect(new StdioServerTransport()); }
  catch (error) { await close(); throw error; }
}

// Workers are only launched as dedicated child entry points.
if (process.env.PM_MCP_WORKER === '1') {
  void runWorker().catch(error => {
    process.stderr.write(error instanceof BridgeError ? `${error.code}: ${error.message}\n` : 'The MCP worker could not start.\n');
    process.exitCode = 1;
  });
}
