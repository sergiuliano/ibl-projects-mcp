import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cache = await mkdtemp(join(tmpdir(), 'ibl-projects-pack-'));
const modules = new Set(['contract', 'server', 'remote', 'cli', 'config', 'account', 'credentials', 'pairing', 'runtime', 'worker', 'supervisor', 'updater', 'npm']);
try {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.private, true, 'npm publication must remain disabled.');
  const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts', '--cache', cache], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000,
  }))[0];
  const paths = new Set();
  for (const { path } of packed.files) {
    const match = /^dist\/([a-z-]+)\.(?:js|d\.ts)$/.exec(path);
    assert.ok((match && modules.has(match[1])) || ['package.json', 'README.md', 'LICENSE', 'docs/install.md', 'npm-shrinkwrap.json'].includes(path), `Unexpected package file: ${path}`);
    assert.ok((await lstat(join(root, path))).isFile(), `Package entry must be a regular file: ${path}`);
    paths.add(path);
    if (path.endsWith('.js')) {
      const code = await readFile(join(root, path), 'utf8');
      const executableScan = path === 'dist/cli.js' ? code.replace("import(pathToFileURL(resolve(selected.root, 'dist/runtime.js')).href)", 'APPROVED_VERIFIED_RUNTIME_IMPORT') : code;
      assert.doesNotMatch(executableScan, /\b(?:require\s*\(|import\s*\()/, `Unreviewed dynamic import in ${path}`);
      for (const match of code.matchAll(/(?:\bfrom\s*|\bimport\s*)(['"])([^'"]+)\1/g)) {
        const name = match[2];
        const local = /^\.\/([a-z-]+)\.js$/.exec(name);
        assert.ok(name.startsWith('node:') || name.startsWith('@modelcontextprotocol/sdk/') || ['sigstore', 'tar', 'make-fetch-happen'].includes(name) || (local && modules.has(local[1])), `Unreviewed backend or dependency import in ${path}: ${name}`);
      }
    }
  }
  assert.equal(pkg.license, 'MIT', 'The reusable public client must preserve its MIT license.');
  assert.ok(paths.has('LICENSE'), 'The package must include its license.');
  for (const name of modules) assert.ok(paths.has(`dist/${name}.js`), `Missing client module: ${name}`);
  process.stdout.write(JSON.stringify({ package: pkg.name, files: paths.size, boundary: 'passed', npmPublication: false }) + '\n');
} finally { await rm(cache, { recursive: true, force: true }); }
