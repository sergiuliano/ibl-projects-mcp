// npm is discovered independently of Node. Managed launchers may put them in different prefixes.
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { access, readFile, realpath } from 'node:fs/promises';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export interface NpmCommand { command: string; args: string[] }
export function installEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(environment)) {
    if (/^(PATH|HOME|USERPROFILE|SYSTEMROOT|WINDIR|TEMP|TMP|TMPDIR|LOCALAPPDATA|APPDATA|USER|LOGNAME|SHELL|VOLTA_HOME|ASDF_DIR|ASDF_DATA_DIR|NVM_DIR|FNM_DIR|MISE_DATA_DIR|MISE_CONFIG_DIR|NPM_TOKEN|NODE_AUTH_TOKEN|NODE_EXTRA_CA_CERTS|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/i.test(key) || /^npm_config_/i.test(key)) result[key] = value;
  }
  result.PATH = dirname(process.execPath) + delimiter + (result.PATH || result.Path || '');
  // Command-line flags repeat these settings so project configuration cannot override them.
  result.npm_config_ignore_scripts = 'true';
  result.npm_config_audit = 'false';
  result.npm_config_fund = 'false';
  return result;
}
export async function discoverNpm(environment: NodeJS.ProcessEnv, node = process.execPath, platform = process.platform): Promise<NpmCommand> {
  const candidates: string[] = [];
  const hint = environment.npm_execpath || environment.NPM_EXECPATH;
  if (hint && /^(npm-cli|npm)\.[cm]?js$/.test(basename(hint))) candidates.push(resolve(hint));
  const prefixes = new Set([dirname(node)]);
  try { prefixes.add(dirname(await realpath(node))); } catch { /* The caller may supply a fixture executable. */ }
  for (const prefix of prefixes) candidates.push(join(prefix, 'node_modules/npm/bin/npm-cli.js'), resolve(prefix, '../lib/node_modules/npm/bin/npm-cli.js'));
  const executables: string[] = [];
  for (const prefix of (environment.PATH || environment.Path || '').split(platform === 'win32' ? ';' : delimiter).filter(Boolean)) {
    for (const name of platform === 'win32' ? ['npm.cmd', 'npm.exe', 'npm'] : ['npm']) {
      const executable = resolve(prefix, name);
      try {
        await access(executable, constants.F_OK);
        const actual = await realpath(executable);
        if (/^npm-cli\.[cm]?js$/.test(basename(actual))) candidates.push(actual);
        candidates.push(resolve(dirname(actual), 'node_modules/npm/bin/npm-cli.js'), resolve(dirname(actual), '../lib/node_modules/npm/bin/npm-cli.js'));
        if (platform !== 'win32' || actual.endsWith('.exe')) executables.push(executable);
      } catch { /* Continue across independent PATH entries and manager shims. */ }
    }
  }
  for (const candidate of new Set(candidates)) {
    try { await access(candidate, constants.R_OK); return { command: node, args: [candidate] }; } catch { /* Next layout. */ }
  }
  for (const executable of executables) {
    try { await access(executable, constants.X_OK); return { command: executable, args: [] }; } catch { /* Next manager. */ }
  }
  throw new Error('NPM_UNAVAILABLE');
}
export interface PackageInfrastructure { env: NodeJS.ProcessEnv; npm: NpmCommand; proxy?: string; noProxy?: string; ca?: string; strictSSL: boolean; offline: boolean; projectConfig?: string }
export async function packageInfrastructure(environment: NodeJS.ProcessEnv, root: string, signal?: AbortSignal): Promise<PackageInfrastructure> {
  const env = installEnvironment(environment), npm = await discoverNpm(environment);
  // Include only variables referenced by configured npmrc files, supporting managed registries with custom token names.
  // Application credentials are never passed to package installation, even if accidentally referenced by npmrc.
  const copyReferenced = (text: string): void => {
    for (const match of text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) if (!match[1].startsWith('PM_MCP_') && !match[1].startsWith('MADDOTS_MCP_') && environment[match[1]] !== undefined) env[match[1]] = environment[match[1]];
  };
  const home = environment.HOME || environment.USERPROFILE || homedir();
  const configPaths = new Set([
    join(root, '.npmrc'), environment.npm_config_userconfig || environment.NPM_CONFIG_USERCONFIG || join(home, '.npmrc'),
    environment.npm_config_globalconfig || environment.NPM_CONFIG_GLOBALCONFIG,
    resolve(dirname(process.execPath), '..', 'etc', 'npmrc'),
    ...(npm.args[0] ? [resolve(dirname(npm.args[0]), '..', '..', '..', '..', 'etc', 'npmrc')] : []),
  ].filter((value): value is string => Boolean(value)));
  for (const path of configPaths) { try { copyReferenced(await readFile(path, 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
  // Read npm's effective configuration, including explicit user/global config files. It never reaches diagnostics.
  const output = await exec(npm.command, [...npm.args, 'config', 'list', '--json'], { cwd: root, env, timeout: 15000, maxBuffer: 2 * 1024 * 1024, signal, windowsHide: true });
  const config = JSON.parse(output.stdout) as Record<string, unknown>;
  for (const name of ['userconfig', 'globalconfig']) if (typeof config[name] === 'string') {
    env['npm_config_' + name] = resolve(root, config[name] as string);
    try { copyReferenced(await readFile(config[name] as string, 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const string = (name: string): string | undefined => typeof config[name] === 'string' && config[name] ? config[name] as string : undefined;
  const proxy = string('https-proxy') || string('proxy') || environment.HTTPS_PROXY || environment.https_proxy || environment.HTTP_PROXY || environment.http_proxy;
  const noProxy = (Array.isArray(config.noproxy) ? config.noproxy.join(',') : string('noproxy')) || environment.NO_PROXY || environment.no_proxy;
  let ca = Array.isArray(config.ca) ? config.ca.join('\n') : string('ca');
  const caFile = string('cafile');
  if (caFile) { ca = await readFile(resolve(root, caFile), 'utf8'); env.NODE_EXTRA_CA_CERTS = resolve(root, caFile); env.npm_config_cafile = resolve(root, caFile); }
  if (proxy) { env.HTTPS_PROXY = proxy; env.https_proxy = proxy; env.HTTP_PROXY = proxy; env.http_proxy = proxy; }
  if (noProxy) { env.NO_PROXY = noProxy; env.no_proxy = noProxy; }
  let projectConfig: string | undefined;
  try { projectConfig = await readFile(join(root, '.npmrc'), 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return { env, npm, proxy, noProxy, ca, strictSSL: config['strict-ssl'] !== false, offline: config.offline === true, projectConfig };
}
