import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { READ_CONTENT_NOTICE } from './contract.js';
import { mcpConfig, accessToken, BridgeError, endpoint } from './config.js';
import { CredentialStore, type Credential, type Persistence, type Scope } from './credentials.js';
import { PairingFlow, type PendingPairing } from './pairing.js';
import { failure, RemoteService, type WorkspaceAccess } from './remote.js';

export const CONNECT_ACCOUNT_TOOL: Tool = {
  name: 'connect_account',
  description: 'Connect this MCP client to your MadDots account. Shows an approval code through host elicitation when supported, otherwise returns it with the browser link, then waits in the background for your approval. Browser approval lets you choose all accessible workspaces, including future accessible workspaces, or a restricted workspace. Existing connections keep their approved scope. When list_workspaces is available, resolve the workspace name first, ask the user about ambiguous matches, and pass workspaceId to subsequent tools. Current membership, project permissions and read/write scopes are enforced by the server. Use status to check progress, cancel to stop waiting, reconnect to approve another account or replace expired authorization, or disconnect to delete the saved login for this endpoint. Connect, reconnect and disconnect may only be called on an explicit user request in this conversation. Show the approval code only to the user; never pass it to any other tool. Never ask the user to copy a token.' + ' ' + READ_CONTENT_NOTICE,
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      action: { type: 'string', enum: ['connect', 'status', 'cancel', 'reconnect', 'disconnect'], default: 'connect' },
      confirm: { type: 'boolean', description: 'For hosts without MCP elicitation, set true only after the user explicitly confirms changing the current connection.' },
      access: { type: 'string', enum: ['read_only', 'read_write'], default: 'read_write', description: 'Account access requested for a new approval. Existing project permissions still apply.' },
    },
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
};

const restrictedAccess = 'This connection covers every project you can access in the workspace selected when you approved the connection, including projects shared with you later in that workspace. The server enforces the account’s current project permissions.';
const result = (value: Record<string, unknown>): CallToolResult => ({ structuredContent: value, content: [{ type: 'text', text: JSON.stringify(value) }] });
const safeError = (error: unknown): BridgeError => error instanceof BridgeError ? error : new BridgeError('CONNECTION_FAILED', 'The account connection could not complete. Use connect_account to request a new code explicitly.');
type Remote = Pick<RemoteService, 'callTool' | 'close'> & { initialize(credential?: string): Promise<WorkspaceAccess | void> };
type Store = Pick<CredentialStore, 'load' | 'save' | 'remove'>;
type Flow = Pick<PairingFlow, 'start' | 'wait' | 'snapshot' | 'cancel'>;
type Confirmation = boolean | 'cancelled' | 'not_confirmed' | undefined;

export class AccountService {
  private remote: Remote;
  private readonly makeRemote: () => Remote;
  private readonly onCatalogChanged?: () => void;
  private mode: WorkspaceAccess = 'workspace';
  private promoting = false;
  private activeCalls = 0;
  private readonly retired = new Set<Remote>();
  private readonly store: Store;
  private readonly makeFlow: () => Flow;
  private readonly confirmReconnect?: (signal?: AbortSignal, action?: 'reconnect' | 'disconnect') => Promise<Confirmation>;
  private readonly presentPairing?: (pending: PendingPairing, signal?: AbortSignal) => Promise<boolean>;
  private hadCredential = false;
  private privatePairingCode = false;
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

  constructor(private readonly env: NodeJS.ProcessEnv = process.env, dependencies: { remote?: Remote; makeRemote?: () => Remote; onCatalogChanged?: () => void; store?: Store; makeFlow?: () => Flow; confirmReconnect?: (signal?: AbortSignal, action?: 'reconnect' | 'disconnect') => Promise<Confirmation>; presentPairing?: (pending: PendingPairing, signal?: AbortSignal) => Promise<boolean> } = {}) {
    this.confirmReconnect = dependencies.confirmReconnect;
    this.presentPairing = dependencies.presentPairing;
    const url = endpoint(env);
    this.makeRemote = dependencies.makeRemote ?? (() => new RemoteService(env));
    this.remote = dependencies.remote ?? this.makeRemote();
    this.onCatalogChanged = dependencies.onCatalogChanged;
    this.store = dependencies.store ?? new CredentialStore(url, env);
    this.makeFlow = dependencies.makeFlow ?? (() => new PairingFlow(url));
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    if (!this.loading) {
      this.loading = (async () => {
        if (mcpConfig(this.env, 'TOKEN') || mcpConfig(this.env, 'TOKEN_FILE')) this.secret = await accessToken(this.env);
        else {
          this.credential = await this.store.load();
          this.secret = this.credential?.secret;
          this.persistence = { persisted: !!this.credential };
        }
        this.hadCredential ||= !!this.secret;
        this.loaded = true;
      })().finally(() => { this.loading = undefined; });
    }
    await this.loading;
  }

  private async ensureConnected(): Promise<void> {
    await this.load();
    if (this.closed) throw new BridgeError('CANCELLED', 'The client is closing.');
    if (this.ready) return;
    if (!this.secret) throw new BridgeError('AUTH_REQUIRED', this.flow ? 'Approve the code from connect_account in MadDots, then retry this operation explicitly.' : 'Call connect_account, open its browser link, and approve the displayed code in your MadDots account. No project operation was submitted.');
    if (!this.initialization) {
      const remote = this.remote;
      this.initialization = remote.initialize(this.secret).then(mode => {
        if (remote !== this.remote || this.closed) throw new BridgeError('CANCELLED', 'Account connection changed before the operation was submitted.');
        this.ready = true;
        this.setMode(mode ?? 'workspace');
      }).catch(error => {
        if (remote === this.remote && error instanceof BridgeError && error.code === 'AUTH_REQUIRED') { this.secret = undefined; this.credential = undefined; this.setMode('workspace'); }
        throw error;
      }).finally(() => { this.initialization = undefined; });
    }
    await this.initialization;
  }

  private setMode(mode: WorkspaceAccess): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.onCatalogChanged?.();
  }

  // A stored label never authorizes a wider catalog. Verify the authenticated
  // remote contract again on every fresh process before advertising it.
  async workspaceAccess(): Promise<boolean> {
    try { await this.ensureConnected(); return this.mode === 'all'; }
    catch { return false; }
  }

  private async closeRetired(): Promise<void> {
    if (this.activeCalls) return;
    const remotes = [...this.retired];
    this.retired.clear();
    await Promise.all(remotes.map(remote => remote.close()));
  }

  private status(): CallToolResult {
    const accountAccess = this.mode === 'all' ? 'This connection covers all workspaces you can currently access, including workspaces shared with you later. Use list_workspaces to resolve names, clarify ambiguous matches, and pass workspaceId to each operation. Current membership, project permissions and approved read/write scopes still apply.' : restrictedAccess;
    const environmentOverride = !!this.credential && this.generation > 0 && !!(mcpConfig(this.env, 'TOKEN') || mcpConfig(this.env, 'TOKEN_FILE'));
    const persistenceNotice = [this.persistence.notice, ...(environmentOverride ? ['The current session uses the newly approved account. The host environment still overrides saved authorization after a restart. Remove or update MADDOTS_MCP_TOKEN or MADDOTS_MCP_TOKEN_FILE through your host configuration before reconnecting; never paste credentials into chat.'] : [])].filter(Boolean).join(' ');
    const pending = this.flow?.snapshot();
    if (pending) {
      const { userCode, ...details } = pending;
      return result({ ...details, ...(this.privatePairingCode ? {} : { userCode }), instructions: this.privatePairingCode ? 'Use the approval code shown in your host’s private prompt. Approve it in MadDots, then check status.' : 'Open the verification link, sign in to the intended account, enter this code, and approve access. Then call connect_account with action status or request your project operation.', accountAccess });
    }
    if (this.ready) return result({ status: 'connected', workspaceAccess: this.mode, remoteToolCount: this.mode === 'all' ? 26 : 25, ...(this.terminal ? { replacementError: { code: this.terminal.code, message: this.terminal.message } } : {}), ...(this.credential ? { account: this.credential.account, scopes: this.credential.scopes, expiresAt: this.credential.expiresAt } : { credentialSource: 'environment' }), remembered: this.persistence.persisted, ...(persistenceNotice ? { notice: persistenceNotice } : {}), accountAccess });
    if (this.terminal) return failure(this.terminal.code, this.terminal.message);
    return result({ status: this.secret ? 'configured' : 'not_connected', instructions: 'Call connect_account with action connect to verify existing authorization or obtain an approval code.', accountAccess });
  }

  private async begin(scopes: Scope[], signal?: AbortSignal): Promise<CallToolResult> {
    if (this.closed || signal?.aborted) return failure('CANCELLED', 'Account connection was cancelled before starting.');
    if (this.starting) return this.starting;
    if (this.flow) return this.status();
    // Finish disposal or promotion of the previous candidate before issuing
    // another approval. The current account remains usable during this wait.
    await this.pairingTask;
    if (this.closed || signal?.aborted) return failure('CANCELLED', 'Account connection was cancelled before starting.');
    this.terminal = undefined;
    const generation = this.generation;
    const flow = this.makeFlow();
    this.flow = flow;
    this.privatePairingCode = !!this.presentPairing;
    const cancel = () => flow.cancel();
    signal?.addEventListener('abort', cancel, { once: true });
    this.starting = (async () => {
      try {
        const pending = await flow.start(scopes);
        if (generation !== this.generation || this.closed || signal?.aborted) { flow.cancel(); return failure('PAIRING_CANCELLED', 'Account connection was cancelled.'); }
        this.pairingTask = (async () => {
          const credential = await flow.wait();
          if (generation !== this.generation || this.closed) return;
          const candidate = this.makeRemote();
          let promoted = false;
          try {
            const mode = await candidate.initialize(credential.secret);
            await this.initialization?.catch(() => {});
            if (generation !== this.generation || this.closed) return;
            // Once an atomic save starts, control actions wait for its commit.
            // Before this point cancellation discards the candidate entirely.
            this.promoting = true;
            const persistence = await this.store.save(credential);
            if (!persistence.persisted && this.secret) throw new BridgeError('CREDENTIAL_STORE_UNAVAILABLE', 'The replacement could not be saved safely. Your existing connection is unchanged. Check private configuration storage before requesting another approval.');
            const previous = this.remote;
            this.remote = candidate;
            promoted = true;
            this.credential = credential;
            this.secret = credential.secret;
            this.hadCredential = true;
            this.loaded = true;
            this.persistence = persistence;
            this.ready = true;
            this.flow = undefined;
            this.terminal = undefined;
            this.setMode(mode ?? 'workspace');
            this.retired.add(previous);
            await this.closeRetired();
          } finally {
            this.promoting = false;
            if (!promoted) await candidate.close();
          }
        })().catch(error => {
          if (generation === this.generation && !this.closed) { this.flow = undefined; this.terminal = safeError(error); }
        });
        if (this.presentPairing) {
          // Hide the code before awaiting host UI, including concurrent status calls.
          this.privatePairingCode = true;
          this.privatePairingCode = await this.presentPairing(pending, signal);
        } else this.privatePairingCode = false;
        return this.status();
      } catch (error) {
        flow.cancel();
        if (generation === this.generation) { this.flow = undefined; this.terminal = safeError(error); }
        return failure(safeError(error).code, safeError(error).message);
      } finally { signal?.removeEventListener('abort', cancel); this.starting = undefined; }
    })();
    return this.starting;
  }

  private async confirmation(action: 'reconnect' | 'disconnect', args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult | undefined> {
    if (!this.hadCredential && !this.secret) return;
    const confirmed = await this.confirmReconnect?.(signal, action);
    if (confirmed === false || confirmed === 'cancelled' || confirmed === 'not_confirmed') {
      const confirmation = confirmed === false ? 'declined' : confirmed;
      const explanation = confirmation === 'declined' ? 'The host returned a declined confirmation.'
        : confirmation === 'cancelled' ? 'The host returned a cancelled confirmation. This does not establish why the dialog was cancelled.'
        : 'The host did not return an affirmative confirmation.';
      return result({ status: action + '_cancelled', confirmation, instructions: explanation + ' The current authorization is unchanged. Do not automatically retry or change credential folders. Retry only on a new explicit user request.' });
    }
    if (confirmed === undefined && args.confirm !== true) return result({ status: 'confirmation_required', instructions: `Ask the user to explicitly confirm ${action === 'disconnect' ? 'disconnecting' : 'replacing'} the current connection. Only after their confirmation, call connect_account again with action ${action} and confirm: true. Show approval codes only to the user and never pass them to other tools.` });
  }

  private async connect(args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
    const action = args.action ?? 'connect';
    if (this.promoting && action !== 'status') await this.pairingTask;
    if (action === 'cancel') {
      await this.load();
      if (!this.flow && !this.starting) return this.status();
      ++this.generation;
      this.flow?.cancel(); this.flow = undefined;
      this.terminal = new BridgeError('PAIRING_CANCELLED', 'Stopped waiting for account approval. The code expires automatically. If it was already approved, revoke its access in MadDots.');
      return this.ready ? this.status() : failure(this.terminal.code, this.terminal.message);
    }
    if (action === 'reconnect' || action === 'disconnect') {
      await this.load();
      const confirmation = await this.confirmation(action, args, signal);
      if (confirmation) return confirmation;
      if (this.closed || signal?.aborted) return failure('CANCELLED', 'Account reconnection was cancelled before starting.');
      ++this.generation;
      this.flow?.cancel(); this.flow = undefined;
      await this.starting;
      await this.pairingTask;
      this.terminal = undefined;
      if (action === 'reconnect') return this.begin(args.access === 'read_only' ? ['kanban:read'] : ['kanban:read', 'kanban:write'], signal);
      this.reconnecting = true;
      try {
        await this.initialization?.catch(() => {});
        await this.store.remove();
        this.loaded = true; this.secret = undefined; this.credential = undefined;
        this.ready = false;
        this.persistence = { persisted: false };
        this.setMode('workspace');
        this.retired.add(this.remote);
        this.remote = this.makeRemote();
        await this.closeRetired();
        return result({ status: 'disconnected', instructions: 'Deleted this endpoint’s saved account credential and stopped using its authorization in this session. This does not revoke server access. Revoke the connection in MadDots if needed. Environment token configuration, if present, must be removed separately before restarting.' });
      } finally { this.reconnecting = false; }
    }
    if (action === 'status') { await this.load(); return this.status(); }
    if (this.flow || this.starting) return this.starting ?? this.status();
    await this.load();
    if (this.secret) { await this.ensureConnected(); return this.status(); }
    const confirmation = await this.confirmation('reconnect', args, signal);
    if (confirmation) return confirmation;
    return this.begin(args.access === 'read_only' ? ['kanban:read'] : ['kanban:read', 'kanban:write'], signal);
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
    try {
      if (name === 'connect_account') {
        if (args.action === 'status') return await this.connect(args, signal);
        if (args.action === 'cancel' && !this.promoting) { ++this.generation; this.flow?.cancel(); }
        const operation = this.control.then(() => this.connect(args, signal));
        this.control = operation.then(() => {}, () => {});
        return await operation;
      }
      await this.ensureConnected();
      const remote = this.remote;
      let response: CallToolResult;
      this.activeCalls++;
      try { response = await remote.callTool(name, args, signal); }
      finally { this.activeCalls--; await this.closeRetired(); }
      if (remote === this.remote && (response.structuredContent?.error as { code?: string } | undefined)?.code === 'AUTH_REQUIRED') {
        this.ready = false; this.secret = undefined; this.credential = undefined;
        this.setMode('workspace');
        await this.remote.close();
      }
      return !response.isError && response.structuredContent?.untrustedContent !== true ? { ...response, content: [{ type: 'text', text: READ_CONTENT_NOTICE }, ...response.content] } : response;
    } catch (error) { const safe = safeError(error); return failure(safe.code, safe.message); }
  }

  // Only durable, unchanged authorization can be reconstructed by a new worker.
  // Never expose credential or pairing material through the supervisor handshake.
  updateSafety(): { safe: boolean; reason?: string } {
    if (this.closed || this.loading || this.initialization || this.reconnecting || this.promoting || this.starting || this.flow) {
      return { safe: false, reason: 'Account authorization is in progress. Keep this connection until it completes.' };
    }
    if (this.terminal || (this.loaded && !this.secret && (this.hadCredential || this.generation > 0))) {
      return { safe: false, reason: 'Account authorization changed in this session. Reconnect the MCP host to apply the update.' };
    }
    if (this.generation > 0 && (mcpConfig(this.env, 'TOKEN') || mcpConfig(this.env, 'TOKEN_FILE'))) {
      return { safe: false, reason: 'Environment authorization was replaced in this session. Update that configuration and reconnect the MCP host to apply the update.' };
    }
    if (this.secret && this.credential && !this.persistence.persisted) {
      return { safe: false, reason: 'Authorization is stored only in memory. Reconnect the MCP host and approve the account again to apply the update.' };
    }
    return { safe: true };
  }

  async setup(display: (pending: PendingPairing) => void, readOnly = false, reconnect = false): Promise<Persistence> {
    await this.load();
    if (this.secret && !reconnect) { await this.ensureConnected(); return this.persistence; }
    // The explicit CLI flag authorizes a new browser approval, while retaining
    // the previous credential until the replacement is verified and saved.
    const response = await this.begin(readOnly ? ['kanban:read'] : ['kanban:read', 'kanban:write']);
    if (response.isError) throw this.terminal ?? new BridgeError('PAIRING_CANCELLED', 'Account connection was cancelled.');
    const pending = this.flow?.snapshot();
    if (pending) display(pending);
    await this.pairingTask;
    if (this.terminal) throw this.terminal;
    if (!this.ready) throw new BridgeError('PAIRING_CANCELLED', 'Account connection was cancelled.');
    return this.persistence;
  }

  async close(): Promise<void> {
    if (this.promoting) await this.pairingTask;
    this.closed = true; ++this.generation;
    this.flow?.cancel(); this.flow = undefined;
    await this.remote.close();
    await this.control;
    await this.starting;
    await this.remote.close();
    await this.pairingTask;
    await this.initialization?.catch(() => {});
    await this.remote.close();
    await this.closeRetired();
    this.secret = undefined; this.credential = undefined;
  }
}
