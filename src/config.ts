import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

export class BridgeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'BridgeError';
  }
}

export function endpoint(env: NodeJS.ProcessEnv): URL {
  let url: URL;
  try { url = new URL(env.PM_MCP_URL || 'https://pm.ibl.ro/mcp'); }
  catch { throw new BridgeError('CONFIG_ERROR', 'PM_MCP_URL must be a valid HTTPS endpoint.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const development = env.PM_MCP_ALLOW_INSECURE_LOOPBACK === '1' && loopback && url.protocol === 'http:';
  if ((url.protocol !== 'https:' && !development) || url.username || url.password || url.search || url.hash) {
    throw new BridgeError('CONFIG_ERROR', 'Use HTTPS without URL credentials, a query, or a fragment. Local HTTP also requires PM_MCP_ALLOW_INSECURE_LOOPBACK=1.');
  }
  return url;
}

function validateToken(value: string): string {
  const token = value.trim();
  if (token.length < 16 || token.length > 4096 || !/^[A-Za-z0-9._~+/-]+=*$/.test(token)) {
    throw new BridgeError('CONFIG_ERROR', 'The MCP token has an invalid format. Create a token in IBL Projects and configure it again.');
  }
  return token;
}

export async function accessToken(env: NodeJS.ProcessEnv): Promise<string> {
  if (env.PM_MCP_TOKEN && env.PM_MCP_TOKEN_FILE) {
    throw new BridgeError('CONFIG_ERROR', 'Set PM_MCP_TOKEN or PM_MCP_TOKEN_FILE, not both.');
  }
  if (env.PM_MCP_TOKEN) return validateToken(env.PM_MCP_TOKEN);
  const path = env.PM_MCP_TOKEN_FILE;
  if (!path) throw new BridgeError('CONFIG_ERROR', 'Set PM_MCP_TOKEN or PM_MCP_TOKEN_FILE to a user token created in IBL Projects.');
  if (!isAbsolute(path)) throw new BridgeError('CONFIG_ERROR', 'PM_MCP_TOKEN_FILE must be an absolute path outside this repository.');
  if (typeof process.getuid !== 'function' || !constants.O_NOFOLLOW) {
    throw new BridgeError('CONFIG_ERROR', 'Secure token-file checks require a POSIX system. Use PM_MCP_TOKEN on this platform.');
  }
  // Open first with no-follow, then validate the same descriptor that is read.
  // This avoids a check/read race and refuses a symlink as the token file.
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || stat.size > 8192) {
      throw new BridgeError('CONFIG_ERROR', 'The token file must be a regular file owned by the current user with permissions 0600.');
    }
    const buffer = Buffer.alloc(8193);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 8192) throw new BridgeError('CONFIG_ERROR', 'The token file is too large.');
    return validateToken(buffer.subarray(0, bytesRead).toString('utf8'));
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError('CONFIG_ERROR', 'Cannot read the token file. Check its location, ownership, permissions, and that it is not a symlink.');
  } finally { await file?.close(); }
}
