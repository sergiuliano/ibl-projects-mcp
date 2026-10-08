#!/usr/bin/env node
import { mcpConfig } from './config.js';
// This entry point remains at the configured path, including an npm bin symlink.
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MCP_VERSION } from './contract.js';
import { checkForUpdate, diagnosticStatus, rollbackRelease, selectRelease, type UpdateOptions } from './updater.js';
import type { RuntimeContext } from './runtime.js';

const REPOSITORY = 'sergiuliano/ibl-projects-mcp';
export interface LaunchDependencies {
  options?: UpdateOptions;
  check?: () => Promise<unknown>;
  select?: () => ReturnType<typeof selectRelease>;
  rollback?: (commit: string) => Promise<unknown>;
  run?: (args: string[], context: RuntimeContext) => Promise<void>;
}
const help = 'MadDots MCP\n\nRun without arguments from an MCP host using stdio. Ask the host to call connect_account, then approve its code in MadDots.\n--setup: show an account approval code, wait for approval, and verify tool discovery without a project operation. Existing authorization is reused. Add --read-only to request only kanban:read for a new approval. Add --reconnect to request replacement browser approval while preserving the current login until the replacement is verified and saved. Reconnect the MCP host afterward to load the replacement.\n--version: print the installed bootstrap version.\n--status: show bootstrap, selected runtime and update status without authenticating.\n--update: verify and prepare the latest release.\n--rollback: select the previous verified release for the next connection.\n--self-test: verify local worker initialization and discovery without authentication.\n\nOptional MADDOTS_MCP_URL defaults to https://maddots.app/mcp.\nMADDOTS_MCP_STATE_DIR overrides the private credential directory outside this checkout.\nAdvanced: MADDOTS_MCP_TOKEN or MADDOTS_MCP_TOKEN_FILE supplies an existing token instead.\nMADDOTS_MCP_AUTO_UPDATE=0 disables automatic updates. MADDOTS_MCP_UPDATE_DIR overrides the private update cache.\nLegacy PM_MCP_* names remain supported; MADDOTS_MCP_* takes precedence when both are set. The existing credential directory is retained.\nUpdates are checked before authentication and every five minutes. Compatible workers switch after 60 seconds without tool activity and with no active requests. Pending authorization, uncertain outcomes and incompatible protocols require keeping the current session or reconnecting the host. Calls are never replayed.\nSee docs/install.md for secure installation and local development.\n';

export async function launch(args: string[] = process.argv.slice(2), dependencies: LaunchDependencies = {}): Promise<void> {
  const setup = args.includes('--setup'), readOnly = args.includes('--read-only'), reconnect = args.includes('--reconnect');
  const supported = ['--setup', '--read-only', '--reconnect', '--help', '-h', '--version', '-v', '--update', '--rollback', '--status', '--self-test'];
  if (args.length > (setup ? 1 + Number(readOnly) + Number(reconnect) : 1) || new Set(args).size !== args.length || args.some(arg => !supported.includes(arg)) || ((readOnly || reconnect) && !setup)) {
    throw Object.assign(new Error('Unsupported arguments. Use --help.'), { code: 'CLI_ARGUMENTS' });
  }
  if (args[0] === '--version' || args[0] === '-v') { process.stdout.write(`${MCP_VERSION}\n`); return; }
  if (args[0] === '--help' || args[0] === '-h') { process.stdout.write(help); return; }
  const options: UpdateOptions = dependencies.options || {
    repository: REPOSITORY, version: MCP_VERSION,
    bundledRoot: realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..')),
    env: process.env,
    log: message => { process.stderr.write(`MadDots MCP: ${message}\n`); },
  };
  const select = dependencies.select || (() => selectRelease(options));
  if (args[0] === '--update' || args[0] === '--rollback') {
    const result = args[0] === '--update' ? await checkForUpdate({ ...options, force: true }) : await rollbackRelease(options);
    process.stdout.write(JSON.stringify(result) + '\n');
    if (result.status === 'failed') process.exitCode = 1;
    return;
  }
  if (args[0] === '--status') {
    const selected = await select();
    process.stdout.write(JSON.stringify({ bootstrap: { root: options.bundledRoot, version: options.version }, selectedRuntime: selected, update: await diagnosticStatus(options) }) + '\n');
    return;
  }
  let startupCheck: Promise<unknown> | undefined;
  let stopStartupCheck: (() => void) | undefined;
  async function runSelected(selected: Awaited<ReturnType<typeof selectRelease>>): Promise<void> {
    const context: RuntimeContext = {
      options, startupCheck, stopStartupCheck,
      bootstrapRoot: options.bundledRoot, bootstrapVersion: options.version,
      runtimeRoot: selected.root, runtimeVersion: selected.version || options.version,
    };
    if (dependencies.run) { await dependencies.run(args, context); return; }
    // selectRelease returns only the bundled root or a verified, immutable cache
    // release. No URL, user input or package contents chooses the imported path.
    const runtime = await import(pathToFileURL(resolve(selected.root, 'dist/runtime.js')).href);
    if (typeof runtime.run !== 'function') throw new Error('Prepared runtime has no entry point');
    await runtime.run(args, context);
  }
  if (args[0] === '--self-test') {
    await runSelected({ root: options.bundledRoot, version: options.version });
    return;
  }
  // Do this before importing the account runtime, even for a pinned bootstrap.
  if (mcpConfig(options.env, 'AUTO_UPDATE') !== '0') {
    const controller = new AbortController();
    stopStartupCheck = () => controller.abort();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    startupCheck = (dependencies.check ? dependencies.check() : checkForUpdate({ ...options, signal })).catch(() => {});
    // Slow networks or installation cannot hold the MCP host's initialize open.
    // The selected supervisor owns this check after the bounded startup wait.
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([startupCheck, new Promise<void>(done => { timer = setTimeout(done, 1_500); })]);
    if (timer) clearTimeout(timer);
  }
  // Setup can perform a one-time authorization claim. Never repeat it on failure.
  if (setup) {
    try { await runSelected(await select()); return; }
    catch (error) { stopStartupCheck?.(); throw error; }
  }
  const attempted = new Set<string>();
  let failure: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const selected = await select();
    if (attempted.has(selected.root)) break;
    attempted.add(selected.root);
    try { await runSelected(selected); return; }
    catch (error) {
      failure = error;
      if (!selected.commit) break;
      try { await (dependencies.rollback ? dependencies.rollback(selected.commit) : rollbackRelease(options, selected.commit)); }
      catch { break; }
    }
  }
  if (!attempted.has(options.bundledRoot)) {
    try { await runSelected({ root: options.bundledRoot, version: options.version }); return; }
    catch (error) { stopStartupCheck?.(); throw error; }
  }
  stopStartupCheck?.();
  throw failure;
}

function isEntryPoint(): boolean {
  if (!process.argv[1]) return false;
  try { return pathToFileURL(realpathSync(resolve(process.argv[1]))).href === import.meta.url; }
  catch { return false; }
}
if (isEntryPoint()) {
  void launch().catch(error => {
    // Never emit an untrusted loader, URL, HTTP response, or filesystem error.
    const code = error?.code;
    const safeCodes = new Set(['CLI_ARGUMENTS', 'CONFIG_ERROR', 'AUTH_REQUIRED', 'REMOTE_CONTRACT_MISMATCH', 'REMOTE_CONNECTION_FAILED', 'PAIRING_CANCELLED', 'PAIRING_ENDED', 'PAIRING_EXPIRED', 'PAIRING_CONNECTION_FAILED', 'PAIRING_RESPONSE_INVALID', 'PAIRING_UNAVAILABLE', 'CREDENTIAL_STORE_UNSAFE', 'CREDENTIAL_STORE_UNAVAILABLE']);
    const message = safeCodes.has(code) && typeof error.message === 'string' ? `${code}: ${error.message}` : 'The MCP client could not start. Check the installation and configuration.';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
