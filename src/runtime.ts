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
  const env = { ...context.options.env, PM_MCP_INSTALL_ROOT: context.bootstrapRoot };
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
      }, args.includes('--read-only'));
      if (persistence.notice) process.stdout.write(`${persistence.notice}\n`);
      process.stdout.write('MadDots MCP is authenticated and its tool contract matches. No tool operation was submitted.\n');
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
