import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { accessToken, BridgeError, endpoint } from './config.js';
import { CredentialStore, type Credential, type Persistence, type Scope } from './credentials.js';
import { PairingFlow, type PendingPairing } from './pairing.js';
import { failure, RemoteService } from './remote.js';

export const CONNECT_ACCOUNT_TOOL: Tool = {
  name: 'connect_account',
  description: 'Connect this MCP client to your IBL Projects account. Returns an approval code and browser link immediately, then waits in the background for your approval. The connection covers all projects your account can access, with current project permissions enforced by the server. Use status to check progress, cancel to stop waiting, or reconnect to approve another account or replace expired authorization. Never ask the user to copy a token.',
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      action: { type: 'string', enum: ['connect', 'status', 'cancel', 'reconnect'], default: 'connect' },
      access: { type: 'string', enum: ['read_only', 'read_write'], default: 'read_write', description: 'Account access requested for a new approval. Existing project permissions still apply.' },
    },
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
};

const accountAccess = 'This connection covers all projects the approved account can access, including future accessible projects. The server enforces the account’s current project permissions.';
const result = (value: Record<string, unknown>): CallToolResult => ({ structuredContent: value, content: [{ type: 'text', text: JSON.stringify(value) }] });
const safeError = (error: unknown): BridgeError => error instanceof BridgeError ? error : new BridgeError('CONNECTION_FAILED', 'The account connection could not complete. Use connect_account to request a new code explicitly.');
type Remote = Pick<RemoteService, 'initialize' | 'callTool' | 'close'>;
type Store = Pick<CredentialStore, 'load' | 'save'>;
type Flow = Pick<PairingFlow, 'start' | 'wait' | 'snapshot' | 'cancel'>;

export class AccountService {
  private readonly remote: Remote;
  private readonly store: Store;
  private readonly makeFlow: () => Flow;
  private credential?: Credential;
  private secret?: string;
  private persistence: Persistence = { persisted: false };
  private loaded = false;
  private loading?: Promise<void>;
  private initialization?: Promise<void>;
  private ready = false;
  private flow?: Flow;
  private starting?: Promise<CallToolResult>;
  private pairingTask?: Promise<void>;
  private control: Promise<void> = Promise.resolve();
  private terminal?: BridgeError;
  private generation = 0;
  private closed = false;
  private reconnecting = false;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env, dependencies: { remote?: Remote; store?: Store; makeFlow?: () => Flow } = {}) {
    const url = endpoint(env);
    this.remote = dependencies.remote ?? new RemoteService(env);
    this.store = dependencies.store ?? new CredentialStore(url, env);
    this.makeFlow = dependencies.makeFlow ?? (() => new PairingFlow(url));
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    if (!this.loading) {
      this.loading = (async () => {
        if (this.env.PM_MCP_TOKEN || this.env.PM_MCP_TOKEN_FILE) this.secret = await accessToken(this.env);
        else {
          this.credential = await this.store.load();
          this.secret = this.credential?.secret;
          this.persistence = { persisted: !!this.credential };
        }
        this.loaded = true;
      })().finally(() => { this.loading = undefined; });
    }
    await this.loading;
  }

  private async ensureConnected(): Promise<void> {
    await this.load();
    if (this.closed) throw new BridgeError('CANCELLED', 'The client is closing.');
    if (this.reconnecting) throw new BridgeError('AUTH_REQUIRED', 'Account reconnection is in progress. Approve the new code before requesting a project operation.');
    if (this.ready) return;
    if (!this.secret) throw new BridgeError('AUTH_REQUIRED', this.flow ? 'Approve the code from connect_account in IBL Projects, then retry this operation explicitly.' : 'Call connect_account, open its browser link, and approve the displayed code in your IBL Projects account. No project operation was submitted.');
    if (!this.initialization) {
      const generation = this.generation;
      this.initialization = this.remote.initialize(this.secret).then(() => {
        if (generation !== this.generation || this.closed) throw new BridgeError('CANCELLED', 'Account connection changed before the operation was submitted.');
        this.ready = true;
      }).catch(error => {
        if (error instanceof BridgeError && error.code === 'AUTH_REQUIRED') { this.secret = undefined; this.credential = undefined; }
        throw error;
      }).finally(() => { this.initialization = undefined; });
    }
    await this.initialization;
  }

  private status(): CallToolResult {
    if (this.flow?.snapshot()) return result({ ...this.flow.snapshot(), instructions: 'Open the verification link, sign in to the intended account, enter this code, and approve access. Then call connect_account with action status or request your project operation.', accountAccess });
    if (this.ready) return result({ status: 'connected', ...(this.credential ? { account: this.credential.account, scopes: this.credential.scopes, expiresAt: this.credential.expiresAt } : { credentialSource: 'environment' }), remembered: this.persistence.persisted, ...(this.persistence.notice ? { notice: this.persistence.notice } : {}), accountAccess });
    if (this.terminal) return failure(this.terminal.code, this.terminal.message);
    return result({ status: this.secret ? 'configured' : 'not_connected', instructions: 'Call connect_account with action connect to verify existing authorization or obtain an approval code.', accountAccess });
  }

  private async begin(scopes: Scope[], signal?: AbortSignal): Promise<CallToolResult> {
    if (this.closed || signal?.aborted) return failure('CANCELLED', 'Account connection was cancelled before starting.');
    if (this.starting) return this.starting;
    if (this.flow) return this.status();
    // A previous cancelled approval may have finished its single claim and be
    // saving it. Finish that save before another approval can replace it.
    await this.pairingTask;
    if (this.closed || signal?.aborted) return failure('CANCELLED', 'Account connection was cancelled before starting.');
    this.terminal = undefined;
    const generation = this.generation;
    const flow = this.makeFlow();
    this.flow = flow;
    const cancel = () => flow.cancel();
    signal?.addEventListener('abort', cancel, { once: true });
    this.starting = (async () => {
      try {
        await flow.start(scopes);
        if (generation !== this.generation || this.closed || signal?.aborted) { flow.cancel(); return failure('PAIRING_CANCELLED', 'Account connection was cancelled.'); }
        this.pairingTask = (async () => {
          const credential = await flow.wait();
          if (generation !== this.generation || this.closed) return;
          this.credential = credential;
          this.secret = credential.secret;
          this.loaded = true;
          // Preserve the single-claim credential before discovery so a temporary
          // service or contract mismatch does not discard an approved login.
          this.persistence = await this.store.save(credential);
          if (generation !== this.generation || this.closed) return;
          this.flow = undefined;
          await this.ensureConnected();
        })().catch(error => {
          if (generation === this.generation && !this.closed) { this.flow = undefined; this.terminal = safeError(error); }
        });
        return this.status();
      } catch (error) {
        if (generation === this.generation) { this.flow = undefined; this.terminal = safeError(error); }
        return failure(safeError(error).code, safeError(error).message);
      } finally { signal?.removeEventListener('abort', cancel); this.starting = undefined; }
    })();
    return this.starting;
  }

  private async connect(args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
    const action = args.action ?? 'connect';
    if (action === 'cancel') {
      ++this.generation;
      this.flow?.cancel(); this.flow = undefined;
      if (!this.ready) { this.secret = undefined; this.credential = undefined; }
      this.terminal = new BridgeError('PAIRING_CANCELLED', 'Stopped waiting for account approval. The code expires automatically. If it was already approved, revoke its access in IBL Projects.');
      return this.ready ? this.status() : failure(this.terminal.code, this.terminal.message);
    }
    if (action === 'reconnect') {
      ++this.generation;
      this.reconnecting = true;
      this.ready = false;
      try {
        this.flow?.cancel(); this.flow = undefined;
        await this.starting;
        await this.loading?.catch(() => {});
        await this.remote.close();
        await this.pairingTask;
        await this.initialization?.catch(() => {});
        this.loaded = true; this.secret = undefined; this.credential = undefined;
        this.persistence = { persisted: false };
        return await this.begin(args.access === 'read_only' ? ['kanban:read'] : ['kanban:read', 'kanban:write'], signal);
      } finally { this.reconnecting = false; }
    }
    if (action === 'status') { await this.load(); return this.status(); }
    if (this.flow || this.starting) return this.starting ?? this.status();
    await this.load();
    if (this.secret) { await this.ensureConnected(); return this.status(); }
    return this.begin(args.access === 'read_only' ? ['kanban:read'] : ['kanban:read', 'kanban:write'], signal);
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
    try {
      if (name === 'connect_account') {
        if (args.action === 'status') return await this.connect(args, signal);
        if (args.action === 'cancel' || args.action === 'reconnect') this.flow?.cancel();
        const operation = this.control.then(() => this.connect(args, signal));
        this.control = operation.then(() => {}, () => {});
        return await operation;
      }
      await this.ensureConnected();
      const response = await this.remote.callTool(name, args, signal);
      if ((response.structuredContent?.error as { code?: string } | undefined)?.code === 'AUTH_REQUIRED') {
        this.ready = false; this.secret = undefined; this.credential = undefined;
        await this.remote.close();
      }
      return response;
    } catch (error) { const safe = safeError(error); return failure(safe.code, safe.message); }
  }

  async setup(display: (pending: PendingPairing) => void): Promise<Persistence> {
    await this.load();
    if (this.secret) { await this.ensureConnected(); return this.persistence; }
    const response = await this.begin(['kanban:read', 'kanban:write']);
    if (response.isError) throw this.terminal ?? new BridgeError('PAIRING_CANCELLED', 'Account connection was cancelled.');
    const pending = this.flow?.snapshot();
    if (pending) display(pending);
    await this.pairingTask;
    if (!this.ready) throw this.terminal ?? new BridgeError('PAIRING_CANCELLED', 'Account connection was cancelled.');
    return this.persistence;
  }

  async close(): Promise<void> {
    this.closed = true; ++this.generation;
    this.flow?.cancel(); this.flow = undefined;
    await this.remote.close();
    await this.control;
    await this.starting;
    await this.remote.close();
    await this.pairingTask;
    await this.initialization?.catch(() => {});
    await this.remote.close();
    this.secret = undefined; this.credential = undefined;
  }
}
