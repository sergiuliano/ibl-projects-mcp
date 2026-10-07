// Release discovery is untrusted until Sigstore verifies the fixed workflow identity and signed digest.
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import fetch, { type FetchOptions } from 'make-fetch-happen';
import { verify } from 'sigstore';
import * as tar from 'tar';
import { packageInfrastructure, type PackageInfrastructure } from './npm.js';
const exec = promisify(execFile);
export const UPDATE_REPOSITORY = 'sergiuliano/ibl-projects-mcp';
export const UPDATE_WORKFLOW = '.github/workflows/client-release.yml';
export const UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const ARTIFACT = 'client-update.tgz';
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
export interface UpdateOptions {
  repository?: string;
  version: string;
  bundledRoot: string;
  env: NodeJS.ProcessEnv;
  log?: (message: string) => unknown;
  signal?: AbortSignal;
  force?: boolean;
}
export interface SelectedRelease { root: string; commit?: string; version?: string; supervisorVersion?: number; workerProtocol?: number }
export interface SignedRelease { commit: string; sha256: string }
export interface UpdateResult { status: 'disabled' | 'busy' | 'current' | 'prepared' | 'failed' | 'deferred' | 'rolled-back'; commit?: string; version?: string; reason?: string }
interface Pointer { current: string; previous?: string }
interface Ready extends SignedRelease { repository: string; version: string; supervisorVersion: number; workerProtocol: number }
interface CheckStatus { checkedAt?: string; finishedAt?: string; status: UpdateResult['status']; reason?: string; commit?: string; version?: string }
const lastStatuses = new Map<string, CheckStatus>();
const record = (value: unknown): Record<string, any> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : undefined;
const within = (parent: string, child: string): boolean => { const distance = relative(parent, child); return !distance || (!distance.startsWith(`..${sep}`) && distance !== '..' && !isAbsolute(distance)); };
function repository(options: UpdateOptions): string {
  if (options.repository !== undefined && options.repository !== UPDATE_REPOSITORY) throw new Error('REPOSITORY_NOT_ALLOWED');
  return UPDATE_REPOSITORY;
}
export function updateDirectory(options: UpdateOptions): string {
  repository(options);
  const directory = options.env.PM_MCP_UPDATE_DIR || join(homedir(), '.cache', 'maddots-mcp', 'updates');
  if (!isAbsolute(directory)) throw new Error('CACHE_UNSAFE');
  const root = resolve(directory), install = resolve(options.bundledRoot);
  const state = resolve(options.env.PM_MCP_STATE_DIR || join(homedir(), '.config', 'ibl-projects-mcp'));
  if (within(install, root) || within(root, install) || within(state, root) || within(root, state)) throw new Error('CACHE_UNSAFE');
  return root;
}
async function canonicalLocation(path: string): Promise<string> {
  let ancestor = resolve(path); const missing: string[] = [];
  for (;;) {
    try { return join(await realpath(ancestor), ...missing); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(ancestor); if (parent === ancestor) throw error;
      missing.unshift(basename(ancestor)); ancestor = parent;
    }
  }
}
async function validateCacheLocation(options: UpdateOptions, directory: string): Promise<void> {
  const actual = await canonicalLocation(directory);
  for (const protectedPath of [options.bundledRoot, options.env.PM_MCP_STATE_DIR || join(homedir(), '.config', 'ibl-projects-mcp'), options.env.PM_MCP_TOKEN_FILE]) if (protectedPath) {
    // Resolve existing parents even before a state directory or token exists. This check creates no credentials or directories.
    const protectedReal = await canonicalLocation(protectedPath);
    if (within(actual, protectedReal) || within(protectedReal, actual)) throw new Error('CACHE_UNSAFE');
  }
}
async function privateDirectory(directory: string, create = false, writable = create): Promise<void> {
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (typeof process.getuid === 'function' && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0))) throw new Error('CACHE_UNSAFE');
  // On systems with canonical temporary/home aliases the parent may be a symlink. The leaf itself may not be.
  await access(directory, constants.R_OK | (writable ? constants.W_OK : 0));
}
async function regular(path: string): Promise<void> { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) throw new Error('CACHE_UNSAFE'); }
async function json(path: string): Promise<any> {
  await regular(path);
  const info = await lstat(path);
  if (info.size > 64 * 1024) throw new Error('CACHE_UNSAFE');
  return JSON.parse(await readFile(path, 'utf8'));
}
async function atomic(directory: string, name: string, value: unknown): Promise<void> {
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  try { await writeFile(temporary, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 }); await rename(temporary, join(directory, name)); }
  finally { await rm(temporary, { force: true }).catch(() => {}); }
}
function compare(a: string, b: string): number {
  if (!/^\d+\.\d+\.\d+$/.test(a) || !/^\d+\.\d+\.\d+$/.test(b)) throw new Error('INVALID_MANIFEST');
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}
async function readPointer(directory: string): Promise<Pointer | undefined> {
  try { const value = await json(join(directory, 'current.json')); if (SHA.test(value.current) && (value.previous === undefined || SHA.test(value.previous))) return value; } catch { /* Bundled startup remains available. */ }
  return undefined;
}
function metadata(manifest: any): { version: string; supervisorVersion: number; workerProtocol: number } {
  const compatibility = record(manifest?.maddotsMcp);
  if (manifest?.name !== 'ibl-projects-mcp' || manifest.private !== true || typeof manifest.version !== 'string' ||
      !compatibility || !Number.isSafeInteger(compatibility.supervisorVersion) || compatibility.supervisorVersion < 1 || !Number.isSafeInteger(compatibility.workerProtocol) || compatibility.workerProtocol < 1) throw new Error('INVALID_MANIFEST');
  compare(manifest.version, manifest.version);
  return { version: manifest.version, supervisorVersion: compatibility.supervisorVersion, workerProtocol: compatibility.workerProtocol };
}
async function ready(options: UpdateOptions, commit: string): Promise<Ready | undefined> {
  if (!SHA.test(commit)) return;
  try {
    const root = join(updateDirectory(options), 'releases', commit);
    await privateDirectory(root);
    const value = await json(join(root, '.ready.json')) as Ready;
    const manifest = metadata(await json(join(root, 'package.json')));
    if (value.repository !== repository(options) || value.commit !== commit || !DIGEST.test(value.sha256) ||
        value.version !== manifest.version || value.supervisorVersion !== manifest.supervisorVersion || value.workerProtocol !== manifest.workerProtocol || compare(value.version, options.version) < 0) return;
    await regular(join(root, 'dist/cli.js')); await regular(join(root, 'dist/worker.js'));
    return value;
  } catch { return; }
}
export async function selectRelease(options: UpdateOptions): Promise<SelectedRelease> {
  try {
    const directory = updateDirectory(options);
    await privateDirectory(directory); await validateCacheLocation(options, directory); await privateDirectory(join(directory, 'releases'));
    const pointer = await readPointer(directory);
    for (const commit of [pointer?.current, pointer?.previous]) {
      const release = commit && await ready(options, commit);
      if (release) return { root: join(directory, 'releases', commit!), commit: commit!, version: release.version, supervisorVersion: release.supervisorVersion, workerProtocol: release.workerProtocol };
    }
  } catch { /* An optional cache never prevents the bundled client from launching. */ }
  return { root: options.bundledRoot, version: options.version };
}
// Called only after cryptographic verification. The statement may not redirect to another repository/workflow.
export function releaseFromStatement(source: string, statement: unknown): SignedRelease {
  if (source !== UPDATE_REPOSITORY) throw new Error('REPOSITORY_NOT_ALLOWED');
  const s = record(statement), definition = s?.predicate?.buildDefinition, workflow = definition?.externalParameters?.workflow;
  const url = 'https://github.com/' + source, subject = s?.subject;
  if (s?._type !== 'https://in-toto.io/Statement/v1' || s?.predicateType !== 'https://slsa.dev/provenance/v1' ||
      definition?.buildType !== 'https://actions.github.io/buildtypes/workflow/v1' || workflow?.repository !== url || workflow?.ref !== 'refs/heads/main' || workflow?.path !== UPDATE_WORKFLOW ||
      !Array.isArray(subject) || subject.length !== 1 || subject[0]?.name !== ARTIFACT || !DIGEST.test(subject[0]?.digest?.sha256)) throw new Error('INVALID_PROVENANCE');
  const dependencies = definition?.resolvedDependencies;
  const dependency = Array.isArray(dependencies) ? dependencies.find(item => item?.uri === 'git+' + url + '@refs/heads/main') : undefined;
  const commit = dependency?.digest?.gitCommit;
  if (!SHA.test(commit)) throw new Error('INVALID_PROVENANCE');
  return { commit, sha256: subject[0].digest.sha256 };
}
export async function verifyReleaseBundle(source: string, bundle: any, tufCachePath?: string): Promise<SignedRelease> {
  if (source !== UPDATE_REPOSITORY) throw new Error('REPOSITORY_NOT_ALLOWED');
  if ((!bundle?.verificationMaterial?.certificate && !bundle?.verificationMaterial?.x509CertificateChain) || bundle?.dsseEnvelope?.payloadType !== 'application/vnd.in-toto+json') throw new Error('INVALID_PROVENANCE');
  const identity = 'https://github.com/' + source + '/' + UPDATE_WORKFLOW + '@refs/heads/main';
  await verify(bundle, { certificateIssuer: 'https://token.actions.githubusercontent.com', certificateIdentityURI: '^' + identity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', tlogThreshold: 1, ctLogThreshold: 1, tufCachePath, retry: 0, timeout: 20000 });
  return releaseFromStatement(source, JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, 'base64').toString('utf8')));
}
export function verifyArtifactDigest(bytes: Buffer, sha256: string): void {
  if (!DIGEST.test(sha256) || createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error('INVALID_CHECKSUM');
}
export function createReleaseVerifier(verifier: typeof verifyReleaseBundle = verifyReleaseBundle): (source: string, bytes: Buffer) => Promise<SignedRelease> {
  const known = new Map<string, { digest: string; release: SignedRelease }>();
  return async (source, bytes) => {
    if (source !== UPDATE_REPOSITORY) throw new Error('REPOSITORY_NOT_ALLOWED');
    const digest = createHash('sha256').update(bytes).digest('hex'), cached = known.get(source);
    if (cached?.digest === digest) return { ...cached.release };
    const release = await verifier(source, JSON.parse(bytes.toString('utf8')));
    known.set(source, { digest, release: { ...release } });
    return release;
  };
}
async function download(url: string, limit: number, infrastructure: PackageInfrastructure, signal?: AbortSignal): Promise<Buffer> {
  if (infrastructure.offline) throw new Error('NETWORK_OFFLINE');
  const fetchOptions: FetchOptions & { signal?: AbortSignal } = { signal, timeout: 30000, retry: 0, size: limit, proxy: infrastructure.proxy, noProxy: infrastructure.noProxy, ca: infrastructure.ca, strictSSL: infrastructure.strictSSL, redirect: 'follow', follow: 5, headers: { 'user-agent': 'MadDots-MCP-updater' } };
  const response = await fetch(url, fetchOptions);
  if (!response.ok || !response.url.startsWith('https://')) throw new Error('NETWORK_UNAVAILABLE');
  const bytes = await response.buffer();
  if (bytes.length > limit) throw new Error('ARTIFACT_TOO_LARGE');
  return bytes;
}
// Isolate verification network options and secrets from the MCP process. npm's proxy/CA settings also apply to Sigstore TUF.
async function configuredVerification(options: UpdateOptions, bytes: Buffer, infrastructure: PackageInfrastructure): Promise<SignedRelease> {
  const bundle = JSON.parse(bytes.toString('utf8'));
  const verifyEnv = Object.fromEntries(Object.entries(infrastructure.env).filter(([name]) => /^(PATH|HOME|USERPROFILE|SYSTEMROOT|WINDIR|TEMP|TMP|TMPDIR|LOCALAPPDATA|APPDATA|NODE_EXTRA_CA_CERTS|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/i.test(name)));
  // Inline npm CA configuration also applies to the isolated verifier, without changing process-wide TLS settings.
  if (infrastructure.ca && !verifyEnv.NODE_EXTRA_CA_CERTS) {
    const path = join(updateDirectory(options), 'configured-ca.pem');
    await writeFile(path, infrastructure.ca, { mode: 0o600 }); verifyEnv.NODE_EXTRA_CA_CERTS = path;
  }
  const script = `import {verifyReleaseBundle} from ${JSON.stringify(import.meta.url)};let input='';for await(const chunk of process.stdin){input+=chunk}const data=JSON.parse(input);try{process.stdout.write(JSON.stringify(await verifyReleaseBundle(data.repository,data.bundle,data.cache)))}catch{process.exitCode=1}`;
  return new Promise((resolveValue, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: verifyEnv, cwd: options.bundledRoot, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, signal: options.signal });
    let output = '', complete = false;
    const timer = setTimeout(() => { child.kill(); fail(); }, 60000);
    function fail(): void { if (!complete) { complete = true; clearTimeout(timer); child.kill(); reject(new Error('INVALID_PROVENANCE')); } }
    child.on('error', fail); child.stdin.on('error', fail);
    child.stderr.on('data', () => {});
    child.stdout.on('data', chunk => { output += chunk.toString(); if (output.length > 8192) { child.kill(); fail(); } });
    child.on('close', code => {
      if (complete) return;
      if (code !== 0) return fail();
      try { const value = JSON.parse(output); if (!SHA.test(value.commit) || !DIGEST.test(value.sha256)) return fail(); complete = true; clearTimeout(timer); resolveValue(value); } catch { fail(); }
    });
    child.stdin.end(JSON.stringify({ repository: repository(options), bundle, cache: join(updateDirectory(options), 'sigstore-cache') }));
  });
}
const verifiedBundles = new Map<string, { digest: string; release: SignedRelease }>();
async function signedLatest(options: UpdateOptions, infrastructure: PackageInfrastructure): Promise<SignedRelease> {
  const bytes = await download('https://github.com/' + repository(options) + '/releases/latest/download/client-update.sigstore.json', 1024 * 1024, infrastructure, options.signal);
  const key = updateDirectory(options), digest = createHash('sha256').update(bytes).digest('hex'), cached = verifiedBundles.get(key);
  if (cached?.digest === digest) return { ...cached.release };
  const release = await configuredVerification(options, bytes, infrastructure);
  verifiedBundles.set(key, { digest, release: { ...release } });
  return release;
}
async function prepareSigned(options: UpdateOptions, release: SignedRelease, target: string, infrastructure: PackageInfrastructure): Promise<void> {
  const bytes = await download('https://github.com/' + repository(options) + '/releases/download/client-' + release.commit + '/' + ARTIFACT, 24 * 1024 * 1024, infrastructure, options.signal);
  verifyArtifactDigest(bytes, release.sha256);
  const file = join(target, ARTIFACT); await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
  let safe = true, total = 0, count = 0; const paths = new Set<string>();
  await tar.t({ file, strict: true, onReadEntry: entry => {
    const path = entry.path;
    total += entry.size; count++;
    if (!['File', 'Directory'].includes(entry.type) || !path.startsWith('package/') || path.includes('\\') || path.split('/').includes('..') || path.split('/').includes('.') || paths.has(path) || total > 80 * 1024 * 1024 || count > 10000 || /^package\/(?:node_modules|\.npmrc|\.ready\.json)(?:\/|$)/.test(path)) safe = false;
    paths.add(path);
  } });
  if (!safe) throw new Error('UNSAFE_ARCHIVE');
  await tar.x({ file, cwd: target, strip: 1, strict: true, preservePaths: false, noChmod: true, noMtime: true });
  await rm(file); await regular(join(target, 'npm-shrinkwrap.json'));
}
async function validateConnection(options: UpdateOptions, target: string, infrastructure: PackageInfrastructure): Promise<void> {
  // This internal mode must initialize/list tools locally without account setup, pairing or a data operation.
  await exec(process.execPath, [join(target, 'dist/cli.js'), '--self-test'], { cwd: target, env: { ...infrastructure.env, PM_MCP_AUTO_UPDATE: '0' }, timeout: 30000, maxBuffer: 1024 * 1024, signal: options.signal, windowsHide: true });
}
async function validateInstalled(options: UpdateOptions, target: string, infrastructure: PackageInfrastructure): Promise<void> {
  const config = join(target, '.npmrc');
  try {
    // Preserve an installation-local registry configuration only during npm ci. Never ship/cache it in a release.
    if (infrastructure.projectConfig !== undefined) await writeFile(config, infrastructure.projectConfig, { flag: 'wx', mode: 0o600 });
    const { npm } = infrastructure;
    await exec(npm.command, [...npm.args, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', join(updateDirectory(options), 'npm-cache')], { cwd: target, env: infrastructure.env, timeout: 120000, maxBuffer: 4 * 1024 * 1024, signal: options.signal, windowsHide: true });
  } catch { throw new Error('INSTALL_FAILED'); }
  finally { await rm(config, { force: true }).catch(() => {}); }
  try { await validateConnection(options, target, infrastructure); } catch { throw new Error('CANDIDATE_FAILED'); }
}
interface UpdateLock { assertHeld(): Promise<void>; release(): Promise<void> }
async function acquire(directory: string): Promise<UpdateLock | undefined> {
  const path = join(directory, 'update.lock'), token = randomUUID();
  try { await mkdir(path, { mode: 0o700 }); }
  catch {
    try {
      await privateDirectory(path);
      const snapshot = await lstat(path), now = Date.now();
      // A process may die after mkdir but before writing owner.json. Fresh incomplete locks stay untouched.
      if (now - snapshot.mtimeMs < 600000) return;
      let owner: Record<string, unknown> | undefined;
      try { owner = await json(join(path, 'owner.json')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return; }
      if (owner) {
        if (!Number.isSafeInteger(owner.pid) || (owner.pid as number) <= 0 || !Number.isFinite(owner.createdAt) || now - (owner.createdAt as number) < 600000) return;
        try { process.kill(owner.pid as number, 0); return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return; }
      }
      // Give this stale generation an atomic, complete recovery marker. A retained nonempty tombstone prevents
      // another contender that observed this generation from renaming a newly acquired holder out of the way.
      const marker = join(path, '.recovery.json'), temporary = join(path, '.' + randomUUID() + '.claim');
      try {
        await writeFile(temporary, JSON.stringify({ token: randomUUID() }), { flag: 'wx', mode: 0o600 });
        try { await link(temporary, marker); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      } finally { await rm(temporary, { force: true }).catch(() => {}); }
      const recovery = await json(marker);
      if (typeof recovery.token !== 'string' || !/^[a-f0-9-]{36}$/.test(recovery.token)) return;
      const observed = await lstat(path);
      if (observed.dev !== snapshot.dev || observed.ino !== snapshot.ino) return;
      const stale = join(directory, 'stale-lock-' + recovery.token);
      await rename(path, stale);
      // Keep this tiny tombstone. Removing it reopens the stale-contender race with a later holder.
      await mkdir(path, { mode: 0o700 });
    } catch { return; }
  }
  await writeFile(join(path, 'owner.json'), JSON.stringify({ token, pid: process.pid, createdAt: Date.now() }), { flag: 'wx', mode: 0o600 });
  return {
    async assertHeld() { const owner = await json(join(path, 'owner.json')); if (owner.token !== token) throw new Error('UPDATE_LOCK_LOST'); },
    async release() { const owner = await json(join(path, 'owner.json')); if (owner.token === token) await rm(path, { recursive: true, force: true }); },
  };
}
const knownReasons = new Set(['CACHE_UNSAFE', 'NPM_UNAVAILABLE', 'NETWORK_OFFLINE', 'NETWORK_UNAVAILABLE', 'INVALID_PROVENANCE', 'INVALID_CHECKSUM', 'UNSAFE_ARCHIVE', 'INVALID_MANIFEST', 'INSTALL_FAILED', 'CANDIDATE_FAILED', 'DOWNGRADE_REFUSED', 'UPDATE_LOCK_LOST', 'REPOSITORY_NOT_ALLOWED', 'ARTIFACT_TOO_LARGE']);
function safeReason(error: unknown, phase: string): string { return error instanceof Error && knownReasons.has(error.message) ? error.message : phase; }
async function remember(options: UpdateOptions, status: CheckStatus): Promise<void> {
  lastStatuses.set(resolve(options.bundledRoot), status);
  try { const directory = updateDirectory(options); await privateDirectory(directory); await validateCacheLocation(options, directory); await atomic(directory, 'last-check.json', status); } catch { /* In-memory status survives an unwritable cache. */ }
}
export async function rollbackRelease(options: UpdateOptions, commit?: string): Promise<UpdateResult> {
  let lock: UpdateLock | undefined;
  try {
    const directory = updateDirectory(options); await privateDirectory(directory, false, true); await validateCacheLocation(options, directory);
    lock = await acquire(directory); if (!lock) return { status: 'busy' };
    const pointer = await readPointer(directory);
    if (!pointer || (commit && pointer.current !== commit)) return { status: 'current' };
    await lock.assertHeld();
    await atomic(directory, 'rejected.json', { commit: pointer.current, retryAfter: Date.now() + 15 * 60 * 1000, manual: commit === undefined });
    let version = options.version;
    const previous = pointer.previous && await ready(options, pointer.previous);
    if (previous) { await atomic(directory, 'current.json', { current: previous.commit }); version = previous.version; }
    else await rm(join(directory, 'current.json'), { force: true });
    const result: UpdateResult = { status: 'rolled-back', version, reason: commit ? 'CANDIDATE_FAILED' : 'MANUAL_ROLLBACK' };
    await remember(options, { ...result, finishedAt: new Date().toISOString() });
    return result;
  } catch { return { status: 'failed', reason: 'ROLLBACK_UNAVAILABLE' }; }
  finally { await lock?.release().catch(() => {}); }
}
// Injection has no environment/CLI hook. It makes failure-path tests deterministic and never weakens production verification.
export interface UpdateBackend { latest(): Promise<SignedRelease>; prepare(release: SignedRelease, target: string): Promise<void>; validate(target: string): Promise<void> }
export async function checkForUpdate(options: UpdateOptions, fixture?: UpdateBackend): Promise<UpdateResult> {
  if (options.env.PM_MCP_AUTO_UPDATE === '0' && !options.force) return { status: 'disabled' };
  let lock: UpdateLock | undefined, staging: string | undefined, checkedAt: string | undefined;
  let phase = 'CACHE_UNAVAILABLE';
  const finish = async (result: UpdateResult): Promise<UpdateResult> => { await remember(options, { ...result, checkedAt, finishedAt: new Date().toISOString() }); return result; };
  try {
    const directory = updateDirectory(options); await validateCacheLocation(options, directory); await privateDirectory(directory, true); await privateDirectory(join(directory, 'releases'), true);
    await validateCacheLocation(options, directory);
    lock = await acquire(directory); if (!lock) return { status: 'busy' };
    if (!options.force) {
      try { const previous = await json(join(directory, 'last-check.json')); const elapsed = Date.now() - Date.parse(previous.checkedAt); if (elapsed >= 0 && elapsed < UPDATE_CHECK_INTERVAL_MS) return { status: 'deferred' }; } catch { /* First check. */ }
    }
    checkedAt = new Date().toISOString(); await remember(options, { checkedAt, status: 'busy' });
    phase = 'NPM_CONFIGURATION_UNAVAILABLE';
    const infrastructure = fixture ? undefined : await packageInfrastructure(options.env, options.bundledRoot, options.signal);
    const backend: UpdateBackend = fixture || { latest: () => signedLatest(options, infrastructure!), prepare: (release, target) => prepareSigned(options, release, target, infrastructure!), validate: target => validateInstalled(options, target, infrastructure!) };
    phase = 'NETWORK_UNAVAILABLE';
    const release = await backend.latest();
    if (!SHA.test(release.commit) || !DIGEST.test(release.sha256)) throw new Error('INVALID_PROVENANCE');
    const pointer = await readPointer(directory), existing = await ready(options, release.commit);
    if (existing && existing.sha256 !== release.sha256) throw new Error('INVALID_CHECKSUM');
    if (pointer?.current === release.commit && existing) return finish({ status: 'current', commit: release.commit, version: existing.version });
    let retryRejected = false;
    try {
      const rejected = await json(join(directory, 'rejected.json'));
      if (rejected.commit === release.commit) {
        if (!options.force && (rejected.manual || rejected.retryAfter > Date.now())) return finish({ status: 'deferred', commit: release.commit, reason: 'RELEASE_ROLLED_BACK' });
        retryRejected = true;
      }
    } catch { /* No rejected candidate. */ }
    const current = pointer?.current && await ready(options, pointer.current);
    const floor = current && compare(current.version, options.version) >= 0 ? current.version : options.version;
    let selected = existing;
    if (existing && compare(existing.version, floor) < 0) throw new Error('DOWNGRADE_REFUSED');
    if (existing && retryRejected) {
      phase = 'CANDIDATE_FAILED';
      const target = join(directory, 'releases', release.commit);
      if (fixture) await fixture.validate(target);
      else await validateConnection(options, target, infrastructure!);
    }
    if (!existing) {
      staging = await mkdtemp(join(directory, 'staging-')); phase = 'ARTIFACT_UNAVAILABLE';
      await backend.prepare(release, staging);
      phase = 'INVALID_MANIFEST'; const manifest = metadata(await json(join(staging, 'package.json')));
      if (compare(manifest.version, floor) < 0) throw new Error('DOWNGRADE_REFUSED');
      phase = 'CANDIDATE_FAILED'; await backend.validate(staging);
      await regular(join(staging, 'dist/cli.js')); await regular(join(staging, 'dist/worker.js'));
      selected = { repository: repository(options), ...release, ...manifest };
      await atomic(staging, '.ready.json', selected); await lock.assertHeld();
      await rename(staging, join(directory, 'releases', release.commit)); staging = undefined;
    }
    await lock.assertHeld();
    await atomic(directory, 'current.json', { current: release.commit, ...(pointer?.current && pointer.current !== release.commit ? { previous: pointer.current } : {}) });
    await rm(join(directory, 'rejected.json'), { force: true });
    try { options.log?.('Verified client update ' + selected!.version + ' is ready for safe activation.'); } catch { /* Logging cannot alter activation. */ }
    return finish({ status: 'prepared', commit: release.commit, version: selected!.version });
  } catch (error) { return finish({ status: 'failed', reason: safeReason(error, phase) }); }
  finally { if (staging) await rm(staging, { recursive: true, force: true }).catch(() => {}); await lock?.release().catch(() => {}); }
}
export async function diagnosticStatus(options: UpdateOptions): Promise<{ bootstrap: { version: string; root: string }; selectedRuntime: SelectedRelease; automaticUpdates: boolean; checkIntervalMs: number; lastCheck: CheckStatus | null; cache: { directory?: string; available: boolean; reason?: string } }> {
  let directory: string | undefined, available = false, reason: string | undefined;
  let lastCheck = lastStatuses.get(resolve(options.bundledRoot));
  try { directory = updateDirectory(options); await privateDirectory(directory); await validateCacheLocation(options, directory); available = true; const saved = await json(join(directory, 'last-check.json')); if (saved && typeof saved.status === 'string' && (!lastCheck || Date.parse(saved.finishedAt || saved.checkedAt) > Date.parse(lastCheck.finishedAt || lastCheck.checkedAt || ''))) lastCheck = { status: saved.status, checkedAt: saved.checkedAt, finishedAt: saved.finishedAt, ...(saved.reason && /^[A-Z_]{1,64}$/.test(saved.reason) ? { reason: saved.reason } : {}), ...(SHA.test(saved.commit) ? { commit: saved.commit } : {}), ...(typeof saved.version === 'string' && /^\d+\.\d+\.\d+$/.test(saved.version) ? { version: saved.version } : {}) }; }
  catch { if (!available) reason = 'CACHE_UNAVAILABLE'; }
  return { bootstrap: { version: options.version, root: options.bundledRoot }, selectedRuntime: await selectRelease(options), automaticUpdates: options.env.PM_MCP_AUTO_UPDATE !== '0', checkIntervalMs: UPDATE_CHECK_INTERVAL_MS, lastCheck: lastCheck || null, cache: { directory, available, reason } };
}
export function startUpdateChecks(options: UpdateOptions, onChecked?: (result: UpdateResult) => void | Promise<void>): () => void {
  if (options.env.PM_MCP_AUTO_UPDATE === '0') return () => {};
  const controller = new AbortController(); let running = false;
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const check = async () => {
    if (running || signal.aborted) return; running = true;
    try { const result = await checkForUpdate({ ...options, signal, force: false, log: undefined }); if (!signal.aborted) await onChecked?.(result); }
    catch { /* Optional checks never interrupt the host. */ }
    finally { running = false; }
  };
  void check(); const timer = setInterval(() => { void check(); }, UPDATE_CHECK_INTERVAL_MS); timer.unref();
  return () => { clearInterval(timer); controller.abort(); };
}
