import { BridgeError } from './config.js';
import { parseCredential, type Credential, type Scope } from './credentials.js';

export type PendingPairing = { status: 'pending'; userCode: string; verificationUri: string; expiresAt: string; expiresIn: number; scopes: Scope[] };
type Timing = { now: () => number; sleep: (ms: number, signal: AbortSignal) => Promise<void> };
const clock: Timing = {
  now: Date.now,
  sleep: (ms, signal) => new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new BridgeError('PAIRING_CANCELLED', 'Account connection was cancelled.')); return; }
    const abort = () => { clearTimeout(timer); reject(new BridgeError('PAIRING_CANCELLED', 'Account connection was cancelled.')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  }),
};
const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) throw new BridgeError('PAIRING_RESPONSE_INVALID', 'The account connection service returned an invalid response.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > 16_384) throw new BridgeError('PAIRING_RESPONSE_INVALID', 'The account connection response exceeded its size limit.');
      chunks.push(item.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const parsed = object(JSON.parse(new TextDecoder().decode(bytes)));
    const data = object(parsed?.data);
    if (!data) throw new Error();
    return data;
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof BridgeError) throw error;
    throw new BridgeError('PAIRING_RESPONSE_INVALID', 'The account connection service returned an invalid response.');
  } finally { reader.releaseLock(); }
}

export class PairingFlow {
  private readonly controller = new AbortController();
  private completion?: Promise<Credential>;
  private pending?: PendingPairing;
  constructor(private readonly endpoint: URL, private readonly timing: Timing = clock, private readonly request: typeof fetch = fetch) {}
  cancel(): void { this.controller.abort(); }
  snapshot(): PendingPairing | undefined { return this.pending && { ...this.pending, scopes: [...this.pending.scopes] }; }
  private async post(path: string, body: object, deadline?: number): Promise<Response> {
    if (this.controller.signal.aborted) throw new BridgeError('PAIRING_CANCELLED', 'Account connection was cancelled.');
    try {
      return await this.request(new URL(path, this.endpoint.origin), {
        method: 'POST', redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(Math.max(1, Math.min(15_000, deadline === undefined ? 15_000 : deadline - this.timing.now())))]),
      });
    } catch {
      if (this.controller.signal.aborted) throw new BridgeError('PAIRING_CANCELLED', 'Account connection was cancelled.');
      if (deadline !== undefined && this.timing.now() >= deadline) throw new BridgeError('PAIRING_EXPIRED', 'The approval code expired. Request a new code explicitly with connect_account.');
      throw new BridgeError('PAIRING_CONNECTION_FAILED', 'The account connection was interrupted. Request a new code explicitly with connect_account. No project operation was submitted.');
    }
  }
  async start(scopes: Scope[]): Promise<PendingPairing> {
    if (this.pending || this.completion) throw new BridgeError('PAIRING_IN_PROGRESS', 'This account connection has already started.');
    const response = await this.post('/api/mcp/pairings', { clientName: 'IBL Projects MCP', scopes });
    if (!response.ok) { await response.body?.cancel(); throw new BridgeError('PAIRING_UNAVAILABLE', 'Cannot start account connection. Check service availability and request a new code explicitly.'); }
    const data = await boundedJson(response);
    const now = this.timing.now();
    const expiry = typeof data.expiresAt === 'string' ? Date.parse(data.expiresAt) : NaN;
    if (typeof data.deviceCode !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(data.deviceCode) || typeof data.userCode !== 'string' || !/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(data.userCode) ||
        data.verificationUri !== new URL('/integrations', this.endpoint.origin).href || !Number.isFinite(expiry) || expiry <= now || data.expiresIn !== 300 ||
        typeof data.interval !== 'number' || !Number.isInteger(data.interval) || data.interval < 3 || data.interval > 30) {
      throw new BridgeError('PAIRING_RESPONSE_INVALID', 'The account connection service returned invalid approval instructions.');
    }
    const deadline = Math.min(expiry, now + 300_000);
    this.pending = { status: 'pending', userCode: data.userCode, verificationUri: data.verificationUri, expiresAt: new Date(deadline).toISOString(), expiresIn: Math.ceil((deadline - now) / 1000), scopes: [...scopes] };
    this.completion = this.poll(data.deviceCode, deadline, data.interval * 1000, scopes);
    void this.completion.catch(() => {});
    return this.snapshot()!;
  }
  async wait(): Promise<Credential> {
    if (!this.completion) throw new BridgeError('PAIRING_NOT_STARTED', 'Request an account connection code first.');
    return this.completion;
  }
  private async poll(deviceCode: string, deadline: number, interval: number, scopes: Scope[]): Promise<Credential> {
    let delay = interval;
    while (this.timing.now() < deadline) {
      await this.timing.sleep(Math.min(delay, deadline - this.timing.now()), this.controller.signal);
      if (this.controller.signal.aborted) throw new BridgeError('PAIRING_CANCELLED', 'Account connection was cancelled.');
      if (this.timing.now() >= deadline) break;
      const response = await this.post('/api/mcp/pairings/poll', { deviceCode }, deadline);
      if (response.status === 429) {
        const retry = response.headers.get('retry-after') || '';
        const retryMs = /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - this.timing.now();
        await response.body?.cancel();
        delay = Math.max(interval, Number.isFinite(retryMs) && retryMs > 0 ? Math.min(retryMs, 300_000) : interval);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new BridgeError(response.status === 400 ? 'PAIRING_ENDED' : 'PAIRING_CONNECTION_FAILED', response.status === 400
          ? 'This approval code is no longer available. It may have expired or been declined. Request a new code explicitly with connect_account.'
          : 'The account connection could not finish. Request a new code explicitly with connect_account. No project operation was submitted.');
      }
      const data = await boundedJson(response);
      if (data.status === 'pending') { delay = interval; continue; }
      if (data.status !== 'connected' || typeof data.secret !== 'string') throw new BridgeError('PAIRING_RESPONSE_INVALID', 'The account connection service returned an invalid approval response.');
      const token = object(data.token);
      const credential = parseCredential({ endpoint: this.endpoint.href, secret: data.secret, account: data.account, scopes: token?.scopes, expiresAt: token?.expiresAt }, this.endpoint);
      if (Date.parse(credential.expiresAt) <= this.timing.now() || credential.account.id.includes(deviceCode) || credential.account.name.includes(deviceCode) || credential.scopes.some(scope => !scopes.includes(scope))) {
        throw new BridgeError('PAIRING_RESPONSE_INVALID', 'The account connection service returned invalid account information.');
      }
      if (this.controller.signal.aborted) throw new BridgeError('PAIRING_CANCELLED', 'Account connection was cancelled.');
      if (this.timing.now() >= deadline) break;
      return credential;
    }
    throw new BridgeError('PAIRING_EXPIRED', 'The approval code expired. Request a new code explicitly with connect_account.');
  }
}
