#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { MCP_VERSION } from './contract.js';
import { createMcpServer } from './server.js';
import { BridgeError } from './config.js';
import { RemoteService } from './remote.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args[0] && !['--setup', '--help', '-h', '--version', '-v'].includes(args[0]))) {
    throw new BridgeError('CLI_ARGUMENTS', 'Unsupported arguments. Use --help.');
  }
  if (args[0] === '--version' || args[0] === '-v') { process.stdout.write(`${MCP_VERSION}\n`); return; }
  if (args[0] === '--help' || args[0] === '-h') {
    process.stdout.write('IBL Projects MCP\n\nRun without arguments from an MCP host using stdio.\n--setup: verify authentication and tool discovery without invoking tools.\n--version: print the client version.\n\nSet PM_MCP_TOKEN or PM_MCP_TOKEN_FILE to a user token from IBL Projects.\nOptional PM_MCP_URL defaults to https://pm.ibl.ro/mcp.\nSee docs/install.md for secure installation and local development.\n');
    return;
  }
  const remote = new RemoteService();
  try {
    await remote.initialize();
    if (args[0] === '--setup') {
      process.stdout.write('IBL Projects MCP is authenticated and its tool contract matches. No tool operation was submitted.\n');
      await remote.close();
      return;
    }
    const server = createMcpServer(remote);
    server.onclose = () => { void remote.close(); };
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      await server.close().catch(() => {});
      await remote.close();
    };
    process.once('SIGINT', () => { void close(); });
    process.once('SIGTERM', () => { void close(); });
    await server.connect(new StdioServerTransport());
  } catch (error) {
    await remote.close();
    throw error;
  }
}

void main().catch(error => {
  const message = error instanceof BridgeError ? `${error.code}: ${error.message}` : 'The MCP client could not start. Check the installation and configuration.';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
