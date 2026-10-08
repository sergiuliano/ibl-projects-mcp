// Build one reviewed runtime artifact, then install and exercise those exact bytes.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import { access, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import process from 'node:process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--output'), 'Usage: prepare-release.mjs [--output DIRECTORY]');
const output = resolve(args[1] || join(root, 'release'));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
assert.equal(pkg.name, 'maddots-mcp');
assert.equal(pkg.private, true, 'npm publication must remain disabled.');
assert.equal(pkg.license, 'MIT');
assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
assert.deepEqual(pkg.bin, { 'maddots-mcp': 'dist/cli.js', 'ibl-projects-mcp': 'dist/cli.js' });
assert.deepEqual(pkg.maddotsMcp, { supervisorVersion: 1, workerProtocol: 1 });
assert.deepEqual(pkg.repository, { type: 'git', url: 'git+https://github.com/sergiuliano/ibl-projects-mcp.git' });
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
assert.equal(lock.lockfileVersion, 3, 'A reviewed npm v3 lockfile is required.');
assert.equal(lock.name, pkg.name);
assert.equal(lock.version, pkg.version);
assert.equal(lock.packages?.['']?.name, pkg.name);
assert.equal(lock.packages?.['']?.version, pkg.version);
assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies, 'Runtime dependencies must match the lockfile.');
for (const [path, dependency] of Object.entries(lock.packages)) {
  if (!path) continue;
  assert.ok(path.startsWith('node_modules/') && !path.split('/').includes('..'), 'Invalid locked dependency path.');
  assert.match(dependency.resolved, /^https:\/\/registry\.npmjs\.org\//, 'Dependencies must come from the reviewed registry lock.');
  assert.match(dependency.integrity, /^sha512-[A-Za-z0-9+/]+=*$/, 'Every dependency needs a locked integrity digest.');
}
// Existing bootstrap updaters accept only this package identity. Keep the signed
// bridge archive on that channel while the source package and executable use MadDots.
const runtimeName = 'ibl-projects-mcp';
const runtimeLock = JSON.parse(JSON.stringify(lock));
runtimeLock.name = runtimeName;
runtimeLock.packages[''].name = runtimeName;
const lockBytes = Buffer.from(JSON.stringify(runtimeLock, null, 2) + '\n');
const modules = new Set(['contract', 'server', 'remote', 'cli', 'config', 'account', 'credentials', 'pairing', 'runtime', 'worker', 'supervisor', 'updater', 'npm']);
const allowedPath = path => {
  if (['package.json', 'npm-shrinkwrap.json', 'LICENSE'].includes(path)) return true;
  const match = /^dist\/([a-z-]+)\.(?:js|d\.ts)$/.exec(path);
  return Boolean(match && modules.has(match[1]));
};
const exists = async path => {
  try { await access(path, constants.F_OK); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
};
const work = await mkdtemp(join(tmpdir(), 'maddots-client-release-'));
const stage = join(work, 'package');
const clean = join(work, 'clean');
const env = { ...process.env, PATH: dirname(process.execPath) + ':' + (process.env.PATH || ''), PM_MCP_AUTO_UPDATE: '0', MADDOTS_MCP_AUTO_UPDATE: '0', PM_MCP_STATE_DIR: join(work, 'unused-credentials'), MADDOTS_MCP_STATE_DIR: join(work, 'unused-credentials'), PM_MCP_UPDATE_DIR: join(work, 'unused-updates'), MADDOTS_MCP_UPDATE_DIR: join(work, 'unused-updates') };
for (const prefix of ['PM_MCP_', 'MADDOTS_MCP_']) for (const suffix of ['TOKEN', 'TOKEN_FILE', 'URL', 'ALLOW_INSECURE_LOOPBACK', 'INSTALL_ROOT', 'WORKER']) delete env[prefix + suffix];
const command = (program, commandArgs, cwd, timeout = 180_000) => execFileSync(program, commandArgs, {
  cwd, env, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
});

try {
  await mkdir(join(stage, 'dist'), { recursive: true });
  await copyFile(join(root, 'LICENSE'), join(stage, 'LICENSE'));
  const compiled = await readdir(join(root, 'dist'));
  for (const name of compiled) {
    const relative = 'dist/' + name;
    assert.ok(allowedPath(relative), 'Unexpected compiled client file: ' + relative);
    const source = join(root, relative);
    assert.ok((await lstat(source)).isFile(), 'Compiled client entries must be regular files.');
    await copyFile(source, join(stage, relative));
  }
  for (const module of modules) assert.ok(compiled.includes(module + '.js'), 'Missing runtime module: ' + module);
  const runtimePackage = {
    name: runtimeName, version: pkg.version, private: true, license: pkg.license,
    type: 'module', description: pkg.description, repository: pkg.repository,
    engines: pkg.engines, bin: pkg.bin, maddotsMcp: pkg.maddotsMcp,
    files: ['dist', 'npm-shrinkwrap.json', 'LICENSE'], dependencies: pkg.dependencies,
  };
  await writeFile(join(stage, 'package.json'), JSON.stringify(runtimePackage, null, 2) + '\n');
  await writeFile(join(stage, 'npm-shrinkwrap.json'), lockBytes);
  const packed = JSON.parse(command('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', work], stage));
  assert.equal(packed.length, 1);
  const artifact = join(work, packed[0].filename);
  for (const { path } of packed[0].files) assert.ok(allowedPath(path), 'Unexpected package file: ' + path);
  for (const path of ['package.json', 'npm-shrinkwrap.json', 'LICENSE']) assert.ok(packed[0].files.some(file => file.path === path), 'Missing runtime package file: ' + path);
  const entries = command('tar', ['-tzf', artifact], work).trim().split('\n');
  assert.equal(new Set(entries).size, entries.length, 'Duplicate archive entries are forbidden.');
  for (const entry of entries) assert.ok(entry.startsWith('package/') && allowedPath(entry.slice(8)), 'Unexpected archive entry: ' + entry);

  await mkdir(clean);
  command('tar', ['-xzf', artifact, '-C', clean], work);
  const installed = join(clean, 'package');
  command('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], installed);
  for (const [path, info] of Object.entries(lock.packages)) {
    if (info.dev === true) assert.equal(await exists(join(installed, path)), false, 'Development dependency in the runtime: ' + path);
  }
  assert.equal(command(process.execPath, [join(installed, 'dist/cli.js'), '--version'], installed, 15_000).trim(), pkg.version, 'The clean-installed client must report the release version.');
  command(process.execPath, [join(installed, 'dist/cli.js'), '--self-test'], installed, 15_000);
  assert.equal(await exists(env.PM_MCP_STATE_DIR), false, 'Release checks must not create credential state.');
  assert.equal(await exists(env.PM_MCP_UPDATE_DIR), false, 'Release checks must not create update state.');
  const digest = createHash('sha256').update(await readFile(artifact)).digest('hex');
  await mkdir(output, { recursive: true });
  const temporary = join(output, '.client-update-' + process.pid + '.tgz');
  await copyFile(artifact, temporary);
  await rename(temporary, join(output, 'client-update.tgz'));
  await writeFile(join(output, 'client-update.tgz.sha256'), digest + '  client-update.tgz\n');
  process.stdout.write(JSON.stringify({ artifact: join(output, 'client-update.tgz'), sha256: digest, package: runtimeName, sourcePackage: pkg.name, version: pkg.version, files: packed[0].files.length, cleanInstall: 'passed', selfTest: 'passed', npmPublication: false }) + '\n');
} finally {
  await rm(work, { recursive: true, force: true });
}
