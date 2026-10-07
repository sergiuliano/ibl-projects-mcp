// Backend fixtures exercise activation state transitions. They do not claim real hosted signing or host compatibility.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { URL } from 'node:url';
import fetch from 'make-fetch-happen';
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as immediate } from 'node:timers/promises';
import test from 'node:test';
import { checkForUpdate, createReleaseVerifier, diagnosticStatus, downloadRelease, releaseFromStatement, rollbackRelease, selectRelease, startUpdateChecks, UPDATE_CHECK_INTERVAL_MS, UPDATE_REPOSITORY, updateDirectory, verifyArtifactDigest, verifyReleaseBundle } from '../dist/updater.js';
import { discoverNpm, installEnvironment, packageInfrastructure } from '../dist/npm.js';
const digest = createHash('sha256').update('fixture artifact').digest('hex');
const commitA = 'a'.repeat(40), commitB = 'b'.repeat(40);
async function fixture(t, additional = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'maddots-updater-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'bootstrap'); await mkdir(root, { mode: 0o700 });
  const options = { version: '0.5.0', bundledRoot: root, env: { PM_MCP_UPDATE_DIR: join(directory, 'updates'), PM_MCP_STATE_DIR: join(directory, 'credentials') }, ...additional };
  return { directory, options };
}
function backend(commit = commitA, version = '0.6.0', hooks = {}) {
  return {
    async latest() { return { commit, sha256: digest }; },
    async prepare(_release, target) {
      await mkdir(join(target, 'dist'));
      await writeFile(join(target, 'package.json'), JSON.stringify({ name: 'ibl-projects-mcp', private: true, version, maddotsMcp: { supervisorVersion: 1, workerProtocol: 1 } }));
      await writeFile(join(target, 'dist/cli.js'), '// synthetic candidate, not executed');
      await writeFile(join(target, 'dist/worker.js'), '// synthetic candidate, not executed');
    },
    async validate() {}, ...hooks,
  };
}
function statement() {
  return { _type: 'https://in-toto.io/Statement/v1', predicateType: 'https://slsa.dev/provenance/v1', subject: [{ name: 'client-update.tgz', digest: { sha256: digest } }], predicate: { buildDefinition: { buildType: 'https://actions.github.io/buildtypes/workflow/v1', externalParameters: { workflow: { repository: 'https://github.com/' + UPDATE_REPOSITORY, ref: 'refs/heads/main', path: '.github/workflows/client-release.yml' } }, resolvedDependencies: [{ uri: 'git+https://github.com/' + UPDATE_REPOSITORY + '@refs/heads/main', digest: { gitCommit: commitA } }] } } };
}
test('provenance policy binds the exact repository, workflow, main ref, immutable source and single artifact', () => {
  assert.deepEqual(releaseFromStatement(UPDATE_REPOSITORY, statement()), { commit: commitA, sha256: digest });
  const changes = [
    x => x.predicate.buildDefinition.externalParameters.workflow.repository = 'https://github.com/other/repo',
    x => x.predicate.buildDefinition.externalParameters.workflow.path = '.github/workflows/other.yml',
    x => x.predicate.buildDefinition.externalParameters.workflow.ref = 'refs/pull/1/merge',
    x => x.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = 'main',
    x => x.subject[0].name = 'other.tgz', x => x.subject.push(x.subject[0]), x => x.subject[0].digest.sha256 = 'bad',
  ];
  for (const change of changes) { const value = statement(); change(value); assert.throws(() => releaseFromStatement(UPDATE_REPOSITORY, value)); }
  assert.throws(() => releaseFromStatement('other/repo', statement()));
});
test('unsigned and malformed signatures fail closed before statements are accepted', async () => {
  await assert.rejects(verifyReleaseBundle(UPDATE_REPOSITORY, { dsseEnvelope: { payloadType: 'application/vnd.in-toto+json', payload: Buffer.from(JSON.stringify(statement())).toString('base64') } }));
  await assert.rejects(verifyReleaseBundle(UPDATE_REPOSITORY, { verificationMaterial: { certificate: { rawBytes: 'invalid' } }, dsseEnvelope: { payloadType: 'application/vnd.in-toto+json', payload: Buffer.from(JSON.stringify(statement())).toString('base64'), signatures: [{ sig: 'invalid' }] } }));
});
test('only successful verification is cached in memory and checksum mismatches fail', async () => {
  let attempts = 0;
  const verifier = createReleaseVerifier(async (_repository, value) => { attempts++; if (value.invalid) throw new Error('INVALID_PROVENANCE'); return { commit: commitA, sha256: digest }; });
  const bytes = Buffer.from('{}'); await verifier(UPDATE_REPOSITORY, bytes); await verifier(UPDATE_REPOSITORY, bytes); assert.equal(attempts, 1);
  for (let index = 0; index < 2; index++) await assert.rejects(verifier(UPDATE_REPOSITORY, Buffer.from('{"invalid":true}')));
  assert.equal(attempts, 3);
  verifyArtifactDigest(Buffer.from('fixture artifact'), digest);
  assert.throws(() => verifyArtifactDigest(Buffer.from('modified artifact'), digest), /INVALID_CHECKSUM/);
});
test('simulated update keeps pinned npm bootstrap and credentials untouched, selecting separate compatible runtime', async t => {
  const { options } = await fixture(t); await mkdir(options.env.PM_MCP_STATE_DIR, { mode: 0o700 });
  await writeFile(join(options.env.PM_MCP_STATE_DIR, 'identity.json'), 'credential fixture');
  await writeFile(join(options.bundledRoot, 'package.json'), '{"version":"0.5.0"}');
  assert.equal((await selectRelease(options)).root, options.bundledRoot);
  assert.deepEqual(await checkForUpdate(options, backend()), { status: 'prepared', commit: commitA, version: '0.6.0' });
  const selected = await selectRelease(options);
  assert.equal(selected.commit, commitA); assert.equal(selected.supervisorVersion, 1); assert.equal(selected.workerProtocol, 1);
  assert.equal(await readFile(join(options.bundledRoot, 'package.json'), 'utf8'), '{"version":"0.5.0"}');
  assert.equal(await readFile(join(options.env.PM_MCP_STATE_DIR, 'identity.json'), 'utf8'), 'credential fixture');
  const status = await diagnosticStatus(options); assert.equal(status.bootstrap.version, '0.5.0'); assert.equal(status.selectedRuntime.version, '0.6.0'); assert.equal(status.lastCheck.status, 'prepared');
});
test('simulated failed network, verification, installation and startup keep working runtime and redact failure text', async t => {
  const { options } = await fixture(t); await checkForUpdate(options, backend());
  for (const phase of ['latest', 'prepare', 'validate']) {
    const failed = backend(commitB, '0.7.0', { [phase]: async () => { throw new Error('https://user:secret@example.test/token'); } });
    const result = await checkForUpdate({ ...options, force: true }, failed);
    assert.equal(result.status, 'failed'); assert.ok(!JSON.stringify(result).includes('secret'));
    assert.equal((await selectRelease(options)).commit, commitA);
  }
  const invalid = await checkForUpdate({ ...options, force: true }, backend(commitB, '0.7.0', { latest: async () => { throw new Error('INVALID_PROVENANCE'); } }));
  assert.equal(invalid.reason, 'INVALID_PROVENANCE');
  assert.ok(!JSON.stringify(await diagnosticStatus(options)).includes('secret'));
});
test('simulated rollback preserves prior runtime, blocks automatic same-release recovery, and manual check can retry', async t => {
  const { options } = await fixture(t); await checkForUpdate(options, backend()); await checkForUpdate({ ...options, force: true }, backend(commitB, '0.7.0'));
  assert.equal((await rollbackRelease(options)).status, 'rolled-back'); assert.equal((await selectRelease(options)).commit, commitA);
  const retry = await checkForUpdate(options, backend(commitB, '0.7.0')); assert.equal(retry.status, 'deferred'); assert.equal((await selectRelease(options)).commit, commitA);
  assert.equal((await checkForUpdate({ ...options, force: true }, backend(commitB, '0.7.0'))).status, 'prepared');
  await rollbackRelease(options, commitB); assert.equal((await selectRelease(options)).commit, commitA);
});
test('simulated downgrade is refused and disabled automatic checks still allow manual update and cached runtime', async t => {
  const { options } = await fixture(t); await checkForUpdate(options, backend());
  assert.equal((await checkForUpdate({ ...options, force: true }, backend(commitB, '0.5.1'))).reason, 'DOWNGRADE_REFUSED');
  const disabled = { ...options, env: { ...options.env, PM_MCP_AUTO_UPDATE: '0' } };
  assert.equal((await checkForUpdate(disabled, backend(commitB, '0.7.0'))).status, 'disabled'); assert.equal((await selectRelease(disabled)).commit, commitA);
  assert.equal((await checkForUpdate({ ...disabled, force: true }, backend(commitB, '0.7.0'))).status, 'prepared');
});
test('unwritable/unsafe cache fails safely, diagnostics survive in memory and read-only releases still select', async t => {
  const { directory, options } = await fixture(t); await checkForUpdate(options, backend());
  const path = updateDirectory(options); await chmod(path, 0o500); t.after(() => chmod(path, 0o700).catch(() => {}));
  assert.equal((await selectRelease(options)).commit, commitA);
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) assert.equal((await checkForUpdate({ ...options, force: true }, backend(commitB, '0.7.0'))).status, 'failed');
  await chmod(path, 0o700);
  const badPath = join(directory, 'not-a-directory'); await writeFile(badPath, 'fixture');
  const broken = { ...options, env: { ...options.env, PM_MCP_UPDATE_DIR: badPath } };
  assert.equal((await checkForUpdate(broken, backend())).reason, 'CACHE_UNAVAILABLE');
  const diagnostic = await diagnosticStatus(broken); assert.equal(diagnostic.lastCheck.status, 'failed'); assert.equal(diagnostic.cache.available, false);
  const link = join(directory, 'cache-link'); await symlink(path, link);
  assert.equal((await checkForUpdate({ ...options, env: { ...options.env, PM_MCP_UPDATE_DIR: link } }, backend())).reason, 'CACHE_UNSAFE');
});
test('cache cannot overlap installation, credential directory or a token file through aliases', async t => {
  const { directory, options } = await fixture(t);
  assert.throws(() => updateDirectory({ ...options, env: { ...options.env, PM_MCP_UPDATE_DIR: options.bundledRoot } }), /CACHE_UNSAFE/);
  assert.throws(() => updateDirectory({ ...options, env: { ...options.env, PM_MCP_UPDATE_DIR: options.env.PM_MCP_STATE_DIR } }), /CACHE_UNSAFE/);
  await mkdir(options.env.PM_MCP_UPDATE_DIR, { mode: 0o700 });
  const token = join(options.env.PM_MCP_UPDATE_DIR, 'token'); await writeFile(token, 'fixture secret');
  const alias = join(directory, 'token-link'); await symlink(token, alias);
  assert.equal((await checkForUpdate({ ...options, env: { ...options.env, PM_MCP_TOKEN_FILE: alias } }, backend())).reason, 'CACHE_UNSAFE');
});
test('update lock prevents simultaneous candidate installation; cooldown limits repeat checks', async t => {
  const { options } = await fixture(t); let finish, started;
  const gate = new Promise(resolve => { finish = resolve; }), entry = new Promise(resolve => { started = resolve; });
  const first = checkForUpdate(options, backend(commitA, '0.6.0', { latest: async () => { started(); await gate; return { commit: commitA, sha256: digest }; } }));
  await entry; assert.equal((await checkForUpdate({ ...options, force: true }, backend(commitB, '0.7.0'))).status, 'busy'); finish(); await first;
  assert.equal((await checkForUpdate(options, backend(commitB, '0.7.0'))).status, 'deferred');
});
test('automatic checks run on startup and each five-minute interval and stop cleanly', async t => {
  const { options } = await fixture(t); options.env.PM_MCP_UPDATE_DIR = options.bundledRoot;
  t.mock.timers.enable({ apis: ['setInterval'] }); let checks = 0;
  const stop = startUpdateChecks(options, () => { checks++; });
  for (let i = 0; i < 20 && checks < 1; i++) await immediate(); assert.equal(checks, 1);
  t.mock.timers.tick(UPDATE_CHECK_INTERVAL_MS - 1); await immediate(); assert.equal(checks, 1);
  t.mock.timers.tick(1); for (let i = 0; i < 20 && checks < 2; i++) await immediate(); assert.equal(checks, 2);
  stop(); t.mock.timers.tick(UPDATE_CHECK_INTERVAL_MS); await immediate(); assert.equal(checks, 2);
});
test('npm discovery supports npm_execpath, symlinked separate PATH npm, node prefixes and manager shims', async t => {
  const { directory } = await fixture(t); const node = join(directory, 'node-prefix/bin/node'); await mkdir(join(directory, 'node-prefix/bin'), { recursive: true });
  const custom = join(directory, 'npm-cli.js'); await writeFile(custom, '// fixture');
  assert.deepEqual(await discoverNpm({ npm_execpath: custom, PATH: '' }, node), { command: node, args: [custom] });
  const path = join(directory, 'separate/bin'); await mkdir(path, { recursive: true }); await symlink(custom, join(path, 'npm'));
  assert.equal((await discoverNpm({ PATH: path }, node)).args[0], custom);
  await rm(join(path, 'npm')); await writeFile(join(path, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  assert.deepEqual(await discoverNpm({ PATH: path }, node), { command: join(path, 'npm'), args: [] });
  const local = join(directory, 'node-prefix/lib/node_modules/npm/bin/npm-cli.js'); await mkdir(join(directory, 'node-prefix/lib/node_modules/npm/bin'), { recursive: true }); await writeFile(local, '// fixture');
  assert.equal((await discoverNpm({ PATH: '' }, node)).args[0], local);
  await rm(local); await assert.rejects(discoverNpm({ PATH: '' }, node), /NPM_UNAVAILABLE/);
});
test('npm infrastructure honors custom registry/proxy/CA/config references without passing MCP credentials', async t => {
  const { directory, options } = await fixture(t); const npm = join(directory, 'npm-cli.js'), userconfig = join(directory, 'custom.npmrc'), ca = join(directory, 'ca.pem');
  await writeFile(ca, 'fixture CA'); await writeFile(userconfig, '//registry.example.test/:_authToken=${ARTIFACTORY_TOKEN}\n');
  await writeFile(join(options.bundledRoot, '.npmrc'), 'registry=https://registry.example.test/\n//registry.example.test/:_authToken=${PROJECT_TOKEN}\n');
  await writeFile(npm, 'process.stdout.write(JSON.stringify({registry:"https://registry.example.test/", "https-proxy":"https://proxy.example.test", cafile:process.env.FIXTURE_CA, userconfig:process.env.npm_config_userconfig, offline:true, "strict-ssl":true}));');
  // npm_config_ is intentionally supported for configured package infrastructure, not copied to diagnostics.
  const environment = { ...process.env, npm_execpath: npm, npm_config_userconfig: userconfig, ARTIFACTORY_TOKEN: 'fixture-one', PROJECT_TOKEN: 'fixture-two', PM_MCP_TOKEN: 'app-secret', PROVIDER_SECRET: 'provider-secret', npm_config_cafile: ca };
  await writeFile(npm, (await readFile(npm, 'utf8')).replace('process.env.FIXTURE_CA', 'process.env.npm_config_cafile'));
  const infra = await packageInfrastructure(environment, options.bundledRoot);
  assert.equal(infra.env.ARTIFACTORY_TOKEN, 'fixture-one'); assert.equal(infra.env.PROJECT_TOKEN, 'fixture-two'); assert.equal(infra.env.PM_MCP_TOKEN, undefined); assert.equal(infra.env.PROVIDER_SECRET, undefined);
  assert.equal(infra.proxy, 'https://proxy.example.test'); assert.equal(infra.ca, 'fixture CA'); assert.equal(infra.offline, true); assert.equal(infra.env.NODE_EXTRA_CA_CERTS, ca);
  assert.equal(installEnvironment(environment).npm_config_userconfig, userconfig);
});

test('aged ownerless locks are reclaimed while fresh incomplete locks remain busy', async t => {
  const { options } = await fixture(t); const directory = updateDirectory(options);
  await mkdir(directory, { mode: 0o700 }); await mkdir(join(directory, 'update.lock'), { mode: 0o700 });
  assert.equal((await checkForUpdate(options, backend())).status, 'busy');
  const old = new Date(Date.now() - 11 * 60 * 1000); await utimes(join(directory, 'update.lock'), old, old);
  assert.equal((await checkForUpdate(options, backend())).status, 'prepared');
  await mkdir(join(directory, 'update.lock'), { mode: 0o700 });
  await writeFile(join(directory, 'update.lock/owner.json'), JSON.stringify({ pid: process.pid, createdAt: old.getTime(), token: 'live-owner' }));
  await utimes(join(directory, 'update.lock'), old, old);
  assert.equal((await checkForUpdate({ ...options, force: true }, backend(commitB, '0.7.0'))).status, 'busy');
});
test('selection, rollback and diagnostics reject parent-symlink cache aliases into protected directories', async t => {
  const { directory, options } = await fixture(t); await checkForUpdate(options, backend());
  const protectedRoot = join(directory, 'protected'); await mkdir(protectedRoot, { mode: 0o700 });
  const movedCache = join(protectedRoot, 'cache');
  await rename(updateDirectory(options), movedCache);
  const alias = join(directory, 'alias'); await symlink(protectedRoot, alias);
  const unsafe = { ...options, env: { ...options.env, PM_MCP_AUTO_UPDATE: '0', PM_MCP_UPDATE_DIR: join(alias, 'cache'), PM_MCP_STATE_DIR: protectedRoot } };
  assert.equal((await selectRelease(unsafe)).root, options.bundledRoot);
  assert.equal((await rollbackRelease(unsafe)).status, 'failed');
  assert.equal((await diagnosticStatus(unsafe)).cache.available, false);
  const pointer = JSON.parse(await readFile(join(movedCache, 'current.json'), 'utf8')); assert.equal(pointer.current, commitA);
});
test('one immutable source commit cannot silently change its attested artifact digest', async t => {
  const { options } = await fixture(t); await checkForUpdate(options, backend());
  const result = await checkForUpdate({ ...options, force: true }, backend(commitA, '0.6.0', { latest: async () => ({ commit: commitA, sha256: 'f'.repeat(64) }) }));
  assert.equal(result.reason, 'INVALID_CHECKSUM'); assert.equal((await selectRelease(options)).commit, commitA);
});

test('nonexistent state and token paths cannot later enter the cache through existing parent aliases', async t => {
  const { directory, options } = await fixture(t); await checkForUpdate(options, backend());
  const alias = join(directory, 'private-alias'); await symlink(updateDirectory(options), alias);
  for (const key of ['PM_MCP_STATE_DIR', 'PM_MCP_TOKEN_FILE']) {
    const protectedPath = join(alias, 'not-created');
    const unsafe = { ...options, env: { ...options.env, [key]: protectedPath } };
    assert.equal((await selectRelease(unsafe)).root, options.bundledRoot);
    assert.equal((await checkForUpdate({ ...unsafe, force: true }, backend(commitB, '0.7.0'))).reason, 'CACHE_UNSAFE');
    assert.equal((await rollbackRelease(unsafe)).status, 'failed');
    await assert.rejects(readFile(protectedPath), error => error.code === 'ENOENT');
  }
  assert.equal((await selectRelease(options)).commit, commitA);
});

async function downloadFixture(t, handle) {
  const server = createServer(handle);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const address = `http://127.0.0.1:${server.address().port}`;
  return {
    async fetch(url, options) {
      assert.equal(options.size, undefined, 'maximum byte count must not become make-fetch-happen exact integrity size');
      assert.equal(options.headers.authorization, undefined);
      const response = await fetch(address + new URL(url).pathname, { ...options, proxy: undefined, noProxy: '127.0.0.1' });
      // This adapter changes only test transport routing. Production still requires credential-free HTTPS responses.
      return { ok: response.ok, url, body: response.body };
    },
  };
}
const downloadInfrastructure = { env: {}, npm: { command: 'unused', args: [] }, strictSSL: true, offline: false };
test('real make-fetch-happen accepts release bytes smaller than the maximum and exactly at the limit', async t => {
  const bytes = Buffer.from('signed fixture body');
  const adapter = await downloadFixture(t, (_req, res) => { res.writeHead(200, { 'Content-Length': bytes.length }); res.end(bytes); });
  assert.deepEqual(await downloadRelease('https://release.example.test/artifact', 1024, downloadInfrastructure, undefined, adapter), bytes);
  assert.deepEqual(await downloadRelease('https://release.example.test/artifact', bytes.length, downloadInfrastructure, undefined, adapter), bytes);
});
test('real make-fetch-happen streams enforce a maximum and close oversized transfers', async t => {
  let closed;
  const disconnected = new Promise(resolve => { closed = resolve; });
  const adapter = await downloadFixture(t, (_req, res) => { res.on('close', closed); res.writeHead(200); res.write(Buffer.alloc(64)); });
  await assert.rejects(downloadRelease('https://release.example.test/artifact', 32, downloadInfrastructure, undefined, adapter), /ARTIFACT_TOO_LARGE/);
  await disconnected;
});
test('real make-fetch-happen transport failures are redacted and partial bodies are rejected', async t => {
  const adapter = await downloadFixture(t, (req, res) => {
    if (req.url === '/status') { res.writeHead(503); res.end('untrusted diagnostic with fixture-secret'); return; }
    res.writeHead(200, { 'Content-Length': 50 }); res.write('partial'); res.socket.destroy();
  });
  for (const path of ['/status', '/broken']) await assert.rejects(downloadRelease('https://release.example.test' + path, 1024, downloadInfrastructure, undefined, adapter), error => error.message === 'NETWORK_UNAVAILABLE');
});
test('real make-fetch-happen full-body deadline and caller abort stop stalled streams', async t => {
  let closed = 0;
  const adapter = await downloadFixture(t, (_req, res) => { res.on('close', () => { closed++; }); res.writeHead(200); res.write('begin'); });
  await assert.rejects(downloadRelease('https://release.example.test/artifact', 1024, downloadInfrastructure, undefined, { ...adapter, timeoutMs: 50 }), /NETWORK_UNAVAILABLE/);
  const controller = new globalThis.AbortController();
  const pending = downloadRelease('https://release.example.test/artifact', 1024, downloadInfrastructure, controller.signal, adapter);
  controller.abort(); await assert.rejects(pending, /NETWORK_UNAVAILABLE/);
  for (let index = 0; index < 20 && closed < 1; index++) await immediate();
  assert.ok(closed >= 1, 'timed-out response closed');
});
test('release download requires HTTPS without URL credentials and honors offline mode before fetching', async () => {
  let requests = 0; const adapter = { fetch: async () => { requests++; throw new Error('must not run'); } };
  for (const url of ['http://release.example.test/artifact', 'https://user:fixture-secret@release.example.test/artifact']) await assert.rejects(downloadRelease(url, 1024, downloadInfrastructure, undefined, adapter), /NETWORK_UNAVAILABLE/);
  await assert.rejects(downloadRelease('https://release.example.test/artifact', 1024, { ...downloadInfrastructure, offline: true }, undefined, adapter), /NETWORK_OFFLINE/);
  assert.equal(requests, 0);
});
