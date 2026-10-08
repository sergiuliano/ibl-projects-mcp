import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { UpdateOptions } from './updater.js';
import { AccountService } from './account.js';
import { createSupervisor, createWorker } from './supervisor.js';

export interface RuntimeContext {
  options: UpdateOptions;
  bootstrapRoot: string;
  bootstrapVersion: string;
  runtimeRoot: string;
  runtimeVersion: string;
  startupCheck?: Promise<unknown>;
  stopStartupCheck?: () => void;
}

// A verified selected release owns its supervisor, worker and future update code.
// The original bootstrap root remains the credential exclusion boundary.
export async function run(args: string[], context: RuntimeContext): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...context.options.env, PM_MCP_INSTALL_ROOT: context.bootstrapRoot };
  if (args[0] === '--self-test') {
    const worker = await createWorker(context.runtimeRoot, env);
    try { await worker.client.listTools(); await worker.inspect(); }
    finally { await worker.close(); }
    return;
  }
  if (args.includes('--setup')) {
    const account = new AccountService(env);
    const close = () => { void account.close(); };
    process.once('SIGINT', close); process.once('SIGTERM', close);
    try {
      const persistence = await account.setup(pending => {
        process.stdout.write(`Open ${pending.verificationUri}\nEnter code: ${pending.userCode}\nApprove access for your account. This code expires at ${pending.expiresAt}. Waiting for approval...\n`);
      }, args.includes('--read-only'), args.includes('--reconnect'));
      if (persistence.notice) process.stdout.write(`${persistence.notice}\n`);
      process.stdout.write('MadDots MCP is authenticated and its tool contract matches. No tool operation was submitted.\n');
      process.stdout.write(args.includes('--reconnect')
        ? persistence.persisted
          ? 'The replacement approval is saved for this client configuration. Reconnect or restart the MCP host using the same credential directory to load it and refresh its tools.\n'
          : 'The replacement approval could not be remembered. Use pairing inside your running MCP host; restarting this setup process cannot transfer its in-memory approval.\n'
        : 'Existing authorization is reused when available. Use --setup --reconnect only to request replacement browser approval. Reconnect or restart an already running MCP host after setup or configuration changes.\n');
      if (env.PM_MCP_TOKEN || env.PM_MCP_TOKEN_FILE) process.stdout.write('Environment token configuration takes precedence over saved approval on the next host launch. Update that configuration before restarting to retain the replacement.\n');
    } finally {
      context.stopStartupCheck?.();
      process.removeListener('SIGINT', close); process.removeListener('SIGTERM', close);
      await account.close();
    }
    return;
  }
  const supervisor = await createSupervisor({ ...context.options, env }, { startupCheck: context.startupCheck, stopStartupCheck: context.stopStartupCheck }, context);
  const close = () => { void supervisor.close(); };
  process.once('SIGINT', close); process.once('SIGTERM', close);
  try { await supervisor.connect(new StdioServerTransport()); }
  catch (error) { await supervisor.close(); throw error; }
}
