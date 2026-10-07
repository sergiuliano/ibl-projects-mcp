import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import process from 'node:process';
import { join } from 'node:path';
import { test } from 'node:test';
import { URL } from 'node:url';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'maddots-release-test-'));
  await mkdir(join(directory, 'scripts'));
  await mkdir(join(directory, 'dist'));
  await copyFile(new URL('../scripts/prepare-release.mjs', import.meta.url), join(directory, 'scripts/prepare-release.mjs'));
  const pkg = {
    name: 'ibl-projects-mcp', version: '0.5.0', private: true, license: 'MIT', type: 'module',
    description: 'Synthetic release fixture', engines: { node: '>=22' },
    bin: { 'ibl-projects-mcp': 'dist/cli.js' },
    repository: { type: 'git', url: 'git+https://github.com/sergiuliano/ibl-projects-mcp.git' },
    maddotsMcp: { supervisorVersion: 1, workerProtocol: 1 }, dependencies: {},
    scripts: { install: 'node -e "process.exit(81)"', prepack: 'node -e "process.exit(82)"' },
  };
  await writeFile(join(directory, 'package.json'), JSON.stringify(pkg));
  await writeFile(join(directory, 'package-lock.json'), JSON.stringify({ name: pkg.name, version: pkg.version, lockfileVersion: 3, requires: true, packages: { '': { name: pkg.name, version: pkg.version, license: 'MIT', dependencies: {} } } }));
  await writeFile(join(directory, 'LICENSE'), 'Synthetic MIT license fixture\n');
  await writeFile(join(directory, '.env'), 'SYNTHETIC_SECRET=not-for-distribution\n');
  await writeFile(join(directory, 'private-source.ts'), 'export const privateFixture = true;\n');
  for (const name of ['contract', 'server', 'remote', 'config', 'account', 'credentials', 'pairing', 'runtime', 'worker', 'supervisor', 'updater', 'npm']) {
    await writeFile(join(directory, 'dist', name + '.js'), 'export {};\n');
  }
  await writeFile(join(directory, 'dist/cli.js'), `#!/usr/bin/env node
import assert from 'node:assert/strict';
assert.equal(process.env.PM_MCP_AUTO_UPDATE, '0');
assert.equal(process.env.PM_MCP_TOKEN, undefined);
assert.equal(process.env.PM_MCP_TOKEN_FILE, undefined);
if (process.argv[2] === '--version') process.stdout.write('0.5.0\\n');
else if (process.argv[2] === '--self-test') process.stdout.write('synthetic self-test passed\\n');
else process.exit(83);
`);
  return { directory, pkg, async close() { await rm(directory, { recursive: true, force: true }); } };
}
function prepare(fixture, output = 'release') {
  return spawnSync(process.execPath, [join(fixture.directory, 'scripts/prepare-release.mjs'), '--output', join(fixture.directory, output)], {
    cwd: fixture.directory, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, PM_MCP_TOKEN: 'synthetic-fixture-only', PM_MCP_TOKEN_FILE: join(fixture.directory, 'unused-token'), npm_config_offline: 'true' },
  });
}

test('release packs only runtime files, removes scripts and clean-installs the exact reproducible artifact', async () => {
  const f = await fixture();
  try {
    const first = prepare(f, 'release-one');
    assert.equal(first.status, 0, first.stderr);
    const result = JSON.parse(first.stdout);
    assert.equal(result.cleanInstall, 'passed');
    assert.equal(result.selfTest, 'passed');
    assert.equal(result.npmPublication, false);
    const artifact = join(f.directory, 'release-one/client-update.tgz');
    const entries = execFileSync('tar', ['-tzf', artifact], { encoding: 'utf8' }).trim().split('\n');
    assert.ok(entries.includes('package/npm-shrinkwrap.json'));
    assert.ok(entries.includes('package/dist/cli.js'));
    assert.ok(!entries.some(name => /private-source|\.env|node_modules|scripts|package-lock/.test(name)));
    const packed = JSON.parse(execFileSync('tar', ['-xOzf', artifact, 'package/package.json'], { encoding: 'utf8' }));
    assert.equal(packed.private, true);
    assert.equal(packed.scripts, undefined);
    assert.equal(packed.devDependencies, undefined);
    const second = prepare(f, 'release-two');
    assert.equal(second.status, 0, second.stderr);
    assert.equal(JSON.parse(second.stdout).sha256, result.sha256);
    assert.deepEqual(await readFile(artifact), await readFile(join(f.directory, 'release-two/client-update.tgz')));
    assert.equal(await readFile(join(f.directory, 'release-one/client-update.tgz.sha256'), 'utf8'), result.sha256 + '  client-update.tgz\n');
  } finally { await f.close(); }
});

test('release refuses a publishable package', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.directory, 'package.json'), JSON.stringify({ ...f.pkg, private: false }));
    const result = prepare(f);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /npm publication must remain disabled/);
  } finally { await f.close(); }
});

test('release refuses an unreviewed compiled module', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.directory, 'dist/private-service.js'), 'export {};\n');
    const result = prepare(f);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unexpected compiled client file/);
  } finally { await f.close(); }
});

test('release refuses a symlink masquerading as a runtime module', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    await rm(join(f.directory, 'dist/server.js'));
    await symlink(join(f.directory, 'private-source.ts'), join(f.directory, 'dist/server.js'));
    const result = prepare(f);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Compiled client entries must be regular files/);
  } finally { await f.close(); }
});
