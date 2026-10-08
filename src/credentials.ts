import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mcpConfig, BridgeError, readPrivateFile, supportsPrivateFiles, validateToken } from './config.js';

export type Scope = 'kanban:read' | 'kanban:write';
export type Account = { id: string; name: string };
export type Credential = { endpoint: string; secret: string; account: Account; scopes: Scope[]; expiresAt: string };
export type Persistence = { persisted: boolean; notice?: string };

const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
export function parseCredential(value: unknown, endpoint: URL): Credential {
  const data = record(value), account = record(data?.account);
  const text = (input: unknown, max: number): input is string => typeof input === 'string' && input.length > 0 && input.length <= max && ![...input].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
  if (!data || data.endpoint !== endpoint.href || typeof data.secret !== 'string' || !account || !text(account.id, 100) || !text(account.name, 200) ||
      typeof data.expiresAt !== 'string' || !Number.isFinite(Date.parse(data.expiresAt)) || !Array.isArray(data.scopes) || !data.scopes.includes('kanban:read') ||
      data.scopes.length > 2 || new Set(data.scopes).size !== data.scopes.length || data.scopes.some(scope => !['kanban:read', 'kanban:write'].includes(String(scope)))) {
    throw new BridgeError('CREDENTIAL_INVALID', 'The account credential is invalid or belongs to another endpoint. Connect the account again.');
  }
  const secret = validateToken(data.secret);
  if (account.name.includes(secret) || account.id.includes(secret)) throw new BridgeError('CREDENTIAL_INVALID', 'The account credential contains invalid display information.');
  return { endpoint: endpoint.href, secret, account: { id: account.id, name: account.name }, scopes: data.scopes as Scope[], expiresAt: new Date(data.expiresAt).toISOString() };
}

export class CredentialStore {
  readonly directory: string;
  readonly path: string;
  constructor(private readonly endpoint: URL, env: NodeJS.ProcessEnv = process.env, private readonly supported = supportsPrivateFiles()) {
    const configured = mcpConfig(env, 'STATE_DIR') || join(homedir(), '.config', 'ibl-projects-mcp');
    if (!isAbsolute(configured)) throw new BridgeError('CONFIG_ERROR', 'MADDOTS_MCP_STATE_DIR must be an absolute private directory outside the client checkout.');
    this.directory = resolve(configured);
    const installRoot = mcpConfig(env, 'INSTALL_ROOT');
    for (const packageRoot of [resolve(dirname(fileURLToPath(import.meta.url)), '..'), ...(installRoot ? [resolve(installRoot)] : [])]) {
      const distance = relative(packageRoot, this.directory);
      if (!distance || (!distance.startsWith(`..${sep}`) && !isAbsolute(distance))) throw new BridgeError('CONFIG_ERROR', 'Account credentials must be stored outside the client checkout.');
    }
    this.path = join(this.directory, createHash('sha256').update(endpoint.href).digest('hex') + '.json');
  }
  private async directoryReady(create: boolean): Promise<boolean> {
    if (!this.supported) return false;
    if (create) await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let stat;
    try { stat = await lstat(this.directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || (stat.mode & 0o777) !== 0o700 || await realpath(this.directory) !== this.directory) {
      throw new BridgeError('CREDENTIAL_STORE_UNSAFE', 'The account credential directory must be owned by this user, use permissions 0700, and have no symlink path components.');
    }
    return true;
  }
  async load(): Promise<Credential | undefined> {
    if (!await this.directoryReady(false)) return;
    try { await lstat(this.path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw new BridgeError('CREDENTIAL_STORE_UNAVAILABLE', 'Cannot inspect saved account credentials.'); }
    try {
      const stored = JSON.parse(await readPrivateFile(this.path)) as Record<string, unknown>;
      if (stored.version !== 1) throw new Error();
      const credential = parseCredential(stored, this.endpoint);
      return Date.parse(credential.expiresAt) > Date.now() ? credential : undefined;
    } catch {
      throw new BridgeError('CREDENTIAL_STORE_UNSAFE', 'Saved account credentials could not be read safely. Check the private directory and file permissions, or connect again for this session.');
    }
  }
  async remove(): Promise<void> {
    if (!await this.directoryReady(false)) return;
    try {
      // Refuse unsafe files rather than following a link or changing its target.
      await readPrivateFile(this.path);
      await unlink(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      // readPrivateFile deliberately redacts underlying filesystem errors, so
      // distinguish an absent credential without exposing its private path.
      try { await lstat(this.path); }
      catch (inspection) { if ((inspection as NodeJS.ErrnoException).code === 'ENOENT') return; }
      throw new BridgeError('CREDENTIAL_STORE_UNSAFE', 'Saved account credentials could not be removed safely. Check the private directory and file permissions.');
    }
  }
  async save(value: Credential): Promise<Persistence> {
    if (!this.supported) return { persisted: false, notice: 'Connected for this session. Secure credential files are unavailable on this platform; approve a new code after restarting the client.' };
    let temporary: string | undefined;
    try {
      const credential = parseCredential(value, this.endpoint);
      await this.directoryReady(true);
      try { await lstat(this.path); await readPrivateFile(this.path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      temporary = join(this.directory, `.${randomUUID()}.tmp`);
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(JSON.stringify({ version: 1, ...credential }) + '\n'); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, this.path);
      temporary = undefined;
      return { persisted: true };
    } catch {
      return { persisted: false, notice: 'Connected for this session. Credentials could not be saved safely; check the private configuration directory before the next launch.' };
    } finally { if (temporary) await unlink(temporary).catch(() => {}); }
  }
}
