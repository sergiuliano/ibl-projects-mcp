import { mcpConfig } from './config.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ElicitRequestSchema, ErrorCode, McpError, ResultSchema, type ServerCapabilities } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { resolve } from 'node:path';
import { checkForUpdate, rollbackRelease, selectRelease, startUpdateChecks, type UpdateOptions } from './updater.js';
import type { RuntimeContext } from './runtime.js';

export const SUPERVISOR_VERSION = 1;
export const WORKER_PROTOCOL = 1;
export interface WorkerState {
  version: string;
  supervisorVersion: number;
  supervisorDigest: string;
  workerProtocol: number;
  account: { safe: boolean; reason?: string };
}
export interface Worker {
  root: string;
  client: Client;
  protocolVersion: string;
  inspect(): Promise<WorkerState>;
  configureHost(elicitation: boolean): Promise<void>;
  close(): Promise<void>;
}
export interface PreparedRelease {
  root: string;
  commit?: string;
  version?: string;
  supervisorVersion?: number;
  workerProtocol?: number;
}
export interface SupervisorDependencies {
  createWorker?: (root: string) => Promise<Worker>;
  check?: (force?: boolean) => Promise<unknown>;
  select?: () => Promise<PreparedRelease>;
  rollback?: (commit: string) => Promise<unknown>;
  now?: () => number;
  idleMs?: number;
  automaticChecks?: boolean;
  startupCheck?: Promise<unknown>;
  stopStartupCheck?: () => void;
}
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
function diagnostic(value: unknown): Record<string, unknown> | undefined {
  const result = record(value);
  if (result?.isError !== true) return;
  return record(record(result.structuredContent)?.error);
}
function parseState(value: unknown): WorkerState {
  const data = record(value), account = record(data?.account);
  if (!data || typeof data.version !== 'string' || !Number.isSafeInteger(data.supervisorVersion) || !Number.isSafeInteger(data.workerProtocol) || typeof data.supervisorDigest !== 'string' || !/^[a-f0-9]{64}$/.test(data.supervisorDigest) || typeof account?.safe !== 'boolean') {
    throw new Error('Worker did not provide a valid runtime handshake');
  }
  return { version: data.version, supervisorDigest: data.supervisorDigest, supervisorVersion: data.supervisorVersion as number, workerProtocol: data.workerProtocol as number,
    account: { safe: account.safe, ...(typeof account.reason === 'string' ? { reason: account.reason.slice(0, 500) } : {}) } };
}

export async function createWorker(root: string, environment: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<Worker> {
  const env = Object.fromEntries(Object.entries({ ...environment, PM_MCP_AUTO_UPDATE: '0', MADDOTS_MCP_AUTO_UPDATE: '0', PM_MCP_WORKER: '1' })
    .filter((entry): entry is [string, string] => entry[1] !== undefined));
  const client = new Client({ name: 'maddots-supervisor', version: String(SUPERVISOR_VERSION) }, { capabilities: { elicitation: { form: {} } } });
  let protocolVersion = '';
  const transport = Object.assign(new StdioClientTransport({
    command: process.execPath, args: [resolve(root, 'dist/worker.js')], env, stderr: 'pipe',
  }), { setProtocolVersion(version: string) { protocolVersion = version; } });
  // Child diagnostics may include untrusted HTTP response data. Drain without logging.
  transport.stderr?.on('data', () => {});
  const abort = () => { void client.close().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) throw new Error('Supervisor closed');
    await client.connect(transport, { timeout: 30_000 });
    if (signal?.aborted) throw new Error('Supervisor closed');
    return {
      root, client, protocolVersion,
      async inspect() { return parseState(await client.request({ method: 'maddots/runtime' }, ResultSchema, { timeout: 5_000 })); },
      async configureHost(elicitation) { await client.request({ method: 'maddots/host', params: { elicitation } }, ResultSchema, { timeout: 5_000 }); },
      async close() { signal?.removeEventListener('abort', abort); await client.close(); },
    };
  } catch (error) {
    signal?.removeEventListener('abort', abort);
    await client.close().catch(() => {});
    throw error;
  }
}

export class Supervisor {
  readonly server: Server;
  private active: Worker;
  private activeState: WorkerState;
  private pending?: PreparedRelease;
  private count = 0;
  private lastToolActivity: number;
  private uncertain = false;
  private dead = false;
  private closed = false;
  private switching = false;
  private initialized = false;
  private hostReady: Promise<void> = Promise.resolve();
  private idleTimer?: NodeJS.Timeout;
  private stopChecks?: () => void;
  private reconnectReason?: string;
  private deferredReason?: string;
  private readonly reconnectRoots = new Set<string>();
  private readonly checkedRoots = new Set<string>();
  private readonly now: () => number;
  private readonly idleMs: number;
  private readonly capabilities: ServerCapabilities;
  private readonly instructions: string | undefined;

  private constructor(
    private readonly options: UpdateOptions,
    private readonly dependencies: SupervisorDependencies,
    worker: Worker,
    state: WorkerState,
    private readonly shutdown: AbortController,
    private readonly factory: (root: string) => Promise<Worker>,
    private readonly identity: Pick<RuntimeContext, 'bootstrapRoot' | 'bootstrapVersion' | 'runtimeRoot' | 'runtimeVersion'>,
  ) {
    this.active = worker; this.activeState = state;
    this.now = dependencies.now || Date.now; this.idleMs = dependencies.idleMs ?? 60_000;
    this.lastToolActivity = this.now();
    this.capabilities = worker.client.getServerCapabilities() || {};
    this.instructions = worker.client.getInstructions();
    this.server = new Server(worker.client.getServerVersion() || { name: 'maddots-mcp', version: state.version }, {
      // The stable supervisor emits catalog changes even when a worker does not.
      // Keep the unmodified worker capabilities separately for swap compatibility.
      capabilities: { ...this.capabilities, tools: { ...this.capabilities.tools, listChanged: true } }, instructions: this.instructions,
    });
    this.bind(worker);
    this.server.fallbackRequestHandler = async (request, extra) => {
      if (request.method.startsWith('maddots/')) throw new McpError(ErrorCode.MethodNotFound, 'Unknown method');
      if (this.closed || this.dead) throw new McpError(ErrorCode.InternalError, 'The client runtime stopped. Reconnect the MCP host. Submitted calls were not replayed.');
      const target = this.active;
      this.count++;
      if (request.method === 'tools/call') this.lastToolActivity = this.now();
      const cancelled = () => { this.uncertain = true; this.deferredReason = 'A request was cancelled or its outcome is unknown. Reconnect the MCP host to apply updates. No call was replayed.'; };
      extra.signal.addEventListener('abort', cancelled, { once: true });
      if (extra.signal.aborted) cancelled();
      try {
        await this.hostReady;
        const progressToken = request.params?._meta?.progressToken;
        const result = await target.client.request({ method: request.method, params: request.params }, ResultSchema, {
          signal: extra.signal, timeout: 130_000,
          ...(progressToken !== undefined ? { onprogress: progress => {
            void extra.sendNotification({ method: 'notifications/progress', params: { ...progress, progressToken } }).catch(() => {});
          } } : {}),
        });
        const error = diagnostic(result);
        if (error?.outcomeUncertain === true) cancelled();
        if (error?.code === 'REMOTE_CONTRACT_MISMATCH') this.checkCompatibility(target);
        if (request.method === 'tools/call' && request.params?.name === 'connect_account' && record(request.params.arguments)?.action === 'status') {
          return { ...result, structuredContent: { ...record(result.structuredContent), clientRuntime: this.status() },
            content: [...(Array.isArray(result.content) ? result.content : []), { type: 'text', text: JSON.stringify({ clientRuntime: this.status() }) }] };
        }
        return result;
      } catch (error) {
        // A transport failure cannot prove whether an operation reached the server.
        // Never retry it, nor destroy a worker which may still be completing it.
        cancelled();
        throw error;
      } finally {
        extra.signal.removeEventListener('abort', cancelled);
        this.count--;
        if (request.method === 'tools/call') this.lastToolActivity = this.now();
        this.scheduleIdle();
      }
    };
    this.server.fallbackNotificationHandler = async notification => {
      if (!this.closed && !this.dead && !notification.method.startsWith('maddots/')) {
        await this.active.client.notification(notification).catch(() => {});
      }
    };
    this.server.oninitialized = () => {
      this.initialized = true;
      this.hostReady = this.active.configureHost(!!this.server.getClientCapabilities()?.elicitation?.form);
      this.hostReady.catch(() => { this.reconnectReason = 'Host capability negotiation failed. Reconnect the MCP host.'; });
      if (dependencies.automaticChecks !== false) {
        this.stopChecks = startUpdateChecks({ ...options, signal: shutdown.signal, log: undefined }, () => this.acceptPrepared());
      }
    };
    this.server.onclose = () => { void this.close(); };
    void dependencies.startupCheck?.then(() => this.acceptPrepared()).catch(() => {});
  }

  static async create(options: UpdateOptions, dependencies: SupervisorDependencies = {}, context?: Pick<RuntimeContext, 'bootstrapRoot' | 'bootstrapVersion' | 'runtimeRoot' | 'runtimeVersion'>): Promise<Supervisor> {
    const shutdown = new AbortController();
    const identity = context || { bootstrapRoot: options.bundledRoot, bootstrapVersion: options.version, runtimeRoot: options.bundledRoot, runtimeVersion: options.version };
    const factory = dependencies.createWorker || (root => createWorker(root, { ...options.env, PM_MCP_INSTALL_ROOT: identity.bootstrapRoot, MADDOTS_MCP_INSTALL_ROOT: identity.bootstrapRoot }, shutdown.signal));
    const worker = await factory(identity.runtimeRoot);
    try {
      await worker.client.listTools();
      const state = await worker.inspect();
      if (state.supervisorVersion !== SUPERVISOR_VERSION || state.workerProtocol !== WORKER_PROTOCOL) throw new Error('Worker is incompatible with this supervisor');
      return new Supervisor(options, dependencies, worker, state, shutdown, factory, identity);
    } catch (error) { await worker.close().catch(() => {}); throw error; }
  }

  get activeRequests(): number { return this.count; }
  get workerRoot(): string { return this.active.root; }
  status(): Record<string, unknown> {
    return {
      bootstrap: { root: this.identity.bootstrapRoot, version: this.identity.bootstrapVersion },
      runtime: { root: this.active.root, version: this.activeState.version, supervisorVersion: SUPERVISOR_VERSION, workerProtocol: WORKER_PROTOCOL, supervisorDigest: this.activeState.supervisorDigest, protocolVersion: this.active.protocolVersion },
      automaticUpdates: mcpConfig(this.options.env, 'AUTO_UPDATE') !== '0', activeRequests: this.count,
      ...(this.pending ? { prepared: { root: this.pending.root, version: this.pending.version, commit: this.pending.commit } } : {}),
      reconnectRequired: !!(this.reconnectReason || this.uncertain || this.dead || this.deferredReason),
      ...(this.reconnectReason || this.deferredReason ? { reason: this.reconnectReason || this.deferredReason } : {}),
    };
  }
  async connect(transport: Transport): Promise<void> { await this.server.connect(transport); }
  private bind(worker: Worker): void {
    worker.client.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
      if (this.active !== worker || !this.initialized || this.closed || !this.server.getClientCapabilities()?.elicitation?.form) {
        throw new McpError(ErrorCode.InvalidRequest, 'Host elicitation is unavailable');
      }
      this.count++;
      try { return await this.server.elicitInput(request.params, { signal: extra.signal }); }
      finally { this.count--; this.lastToolActivity = this.now(); this.scheduleIdle(); }
    });
    worker.client.fallbackNotificationHandler = async notification => {
      if (this.active === worker && this.initialized && !this.closed && !notification.method.startsWith('maddots/')) await this.server.notification(notification).catch(() => {});
    };
    worker.client.onclose = () => {
      if (this.active === worker && !this.closed) {
        this.dead = true;
        this.reconnectReason = 'The client runtime stopped. Reconnect the MCP host. Submitted calls were not replayed.';
      }
    };
  }
  private checkCompatibility(worker: Worker): void {
    if (this.closed || mcpConfig(this.options.env, 'AUTO_UPDATE') === '0' || this.checkedRoots.has(worker.root)) return;
    this.checkedRoots.add(worker.root);
    void this.checkNow(true).catch(() => {});
  }
  async checkNow(force = false): Promise<void> {
    if (this.closed) return;
    try {
      if (this.dependencies.check) await this.dependencies.check(force);
      else await checkForUpdate({ ...this.options, force, log: undefined, signal: this.shutdown.signal });
    } catch { /* An unavailable feed cannot interrupt a working session. */ }
    await this.acceptPrepared();
  }
  private async acceptPrepared(): Promise<void> {
    if (this.closed) return;
    try {
      const selected = await (this.dependencies.select || (() => selectRelease(this.options)))();
      if (selected.root !== this.active.root && selected.commit) {
        this.pending = selected;
        if ((selected.supervisorVersion !== undefined && selected.supervisorVersion !== SUPERVISOR_VERSION) ||
          (selected.workerProtocol !== undefined && selected.workerProtocol !== WORKER_PROTOCOL)) {
          this.reconnectRoots.add(selected.root);
          this.reconnectReason = 'The prepared release changes the supervisor or worker protocol. Reconnect the MCP host to activate it.';
        }
      } else { this.pending = undefined; }
      await this.applyIfIdle();
      this.scheduleIdle();
    } catch { /* Missing prepared releases cannot interrupt current calls. */ }
  }
  private idle(): boolean {
    return !this.closed && !this.dead && !this.uncertain && this.count === 0 && this.now() - this.lastToolActivity >= this.idleMs;
  }
  private scheduleIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (!this.pending || this.closed || this.dead || this.uncertain || this.count > 0 || this.reconnectRoots.has(this.pending.root)) return;
    this.idleTimer = setTimeout(() => { void this.applyIfIdle(); }, Math.max(this.deferredReason ? 5_000 : 1, this.idleMs - (this.now() - this.lastToolActivity)));
    this.idleTimer.unref();
  }
  async applyIfIdle(): Promise<void> {
    if (!this.pending || this.switching || this.reconnectRoots.has(this.pending.root) || !this.idle()) return;
    const pending = this.pending;
    this.switching = true;
    let candidate: Worker | undefined;
    let candidateStarted = false;
    try {
      const account = (await this.active.inspect()).account;
      if (!account.safe) { this.deferredReason = account.reason || 'Keep this account session and reconnect the MCP host to apply the update.'; return; }
      this.deferredReason = undefined;
      candidateStarted = true;
      candidate = await this.factory(pending.root);
      await candidate.client.listTools();
      const state = await candidate.inspect();
      if (!candidate.client.transport) throw new Error('Updated worker disconnected during preparation');
      if (state.supervisorVersion !== SUPERVISOR_VERSION || state.workerProtocol !== WORKER_PROTOCOL || state.supervisorDigest !== this.activeState.supervisorDigest ||
        candidate.protocolVersion !== this.active.protocolVersion || candidate.client.getInstructions() !== this.instructions ||
        canonical(candidate.client.getServerCapabilities() || {}) !== canonical(this.capabilities)) {
        this.reconnectRoots.add(pending.root);
        this.reconnectReason = 'The prepared release changes initialization instructions, negotiated capabilities or protocol. Reconnect the MCP host to activate it.';
        return;
      }
      this.bind(candidate);
      await candidate.configureHost(!!this.server.getClientCapabilities()?.elicitation?.form);
      // Calls and account transitions may arrive while the candidate starts.
      const currentAccount = (await this.active.inspect()).account;
      if (!this.idle() || this.pending !== pending || !currentAccount.safe) {
        if (!currentAccount.safe) this.deferredReason = currentAccount.reason || 'Account authorization changed. Reconnect the MCP host to apply the update.';
        return;
      }
      const previous = this.active;
      this.active = candidate; this.activeState = state; candidate = undefined;
      this.pending = undefined; this.reconnectReason = undefined; this.deferredReason = undefined;
      await previous.close().catch(() => {});
      if (this.initialized) await this.server.sendToolListChanged().catch(() => {});
      try { this.options.log?.(`Applied verified client update ${state.version} while idle.`); } catch { /* Logging is optional. */ }
    } catch {
      if (candidateStarted && pending.commit && !this.closed) {
        try { await (this.dependencies.rollback ? this.dependencies.rollback(pending.commit) : rollbackRelease(this.options, pending.commit)); } catch { /* Retain the live worker even if cache state is unavailable. */ }
        if (this.pending === pending) this.pending = undefined;
      } else this.deferredReason = 'The active account state could not be verified. Reconnect the MCP host to apply the update.';
    } finally {
      if (candidate) await candidate.close().catch(() => {});
      this.switching = false;
      this.scheduleIdle();
    }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true; this.stopChecks?.(); this.dependencies.stopStartupCheck?.();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.shutdown.abort();
    await this.active.close().catch(() => {});
    await this.server.close().catch(() => {});
  }
}

export const createSupervisor = (options: UpdateOptions, dependencies?: SupervisorDependencies, context?: Pick<RuntimeContext, 'bootstrapRoot' | 'bootstrapVersion' | 'runtimeRoot' | 'runtimeVersion'>): Promise<Supervisor> =>
  Supervisor.create(options, dependencies, context);
