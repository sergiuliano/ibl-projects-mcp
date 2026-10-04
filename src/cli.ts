#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { MCP_VERSION } from './contract.js';
import { createMcpServer } from './server.js';
import { BridgeError } from './config.js';
import { AccountService, CONNECT_ACCOUNT_TOOL } from './account.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const setup = args.includes('--setup'), readOnly = args.includes('--read-only');
  if (args.length > (setup && readOnly ? 2 : 1) || args.some(arg => !['--setup', '--read-only', '--help', '-h', '--version', '-v'].includes(arg)) || (readOnly && !setup)) {
    throw new BridgeError('CLI_ARGUMENTS', 'Unsupported arguments. Use --help.');
  }
  if (args[0] === '--version' || args[0] === '-v') { process.stdout.write(`${MCP_VERSION}\n`); return; }
  if (args[0] === '--help' || args[0] === '-h') {
    process.stdout.write('MadDots MCP\n\nRun without arguments from an MCP host using stdio. Ask the host to call connect_account, then approve its code in MadDots.\n--setup: show an account approval code, wait for approval, and verify tool discovery without a project operation. Existing authorization is reused. Add --read-only to request only kanban:read for a new approval.\n--version: print the client version.\n\nOptional PM_MCP_URL defaults to https://maddots.app/mcp.\nPM_MCP_STATE_DIR overrides the private credential directory outside this checkout.\nAdvanced: PM_MCP_TOKEN or PM_MCP_TOKEN_FILE supplies an existing token instead.\nSee docs/install.md for secure installation and local development.\n');
    return;
  }
  let server: ReturnType<typeof createMcpServer> | undefined;
  const account = new AccountService(process.env, {
    confirmReconnect: async signal => {
      if (!server?.getClientCapabilities()?.elicitation?.form) return undefined;
      const response = await server.elicitInput({
        mode: 'form',
        message: 'Replace the current MadDots account connection? A new approval code will be required before project operations can continue.',
        requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean', title: 'Replace current connection', default: false } }, required: ['confirm'] },
      }, { signal });
      return response.action === 'accept' && response.content?.confirm === true;
    },
  });
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await server?.close().catch(() => {});
    await account.close();
  };
  process.once('SIGINT', () => { void close(); });
  process.once('SIGTERM', () => { void close(); });
  try {
    if (setup) {
      const persistence = await account.setup(pending => {
        process.stdout.write(`Open ${pending.verificationUri}\nEnter code: ${pending.userCode}\nApprove access for your account. This code expires at ${pending.expiresAt}. Waiting for approval...\n`);
      }, readOnly);
      if (persistence.notice) process.stdout.write(`${persistence.notice}\n`);
      process.stdout.write('MadDots MCP is authenticated and its tool contract matches. No tool operation was submitted.\n');
      await close();
      return;
    }
    // Host initialization and discovery must never wait for browser approval.
    server = createMcpServer(account, [CONNECT_ACCOUNT_TOOL]);
    server.onclose = () => { void account.close(); };
    await server.connect(new StdioServerTransport());
  } catch (error) {
    await close();
    throw error;
  }
}

void main().catch(error => {
  const message = error instanceof BridgeError ? `${error.code}: ${error.message}` : 'The MCP client could not start. Check the installation and configuration.';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
