import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { MCP_VERSION, TOOL_DEFINITIONS, ALL_WORKSPACE_TOOL_DEFINITIONS, LIVE_TOOL_DEFINITIONS, LIVE_ALL_WORKSPACE_TOOL_DEFINITIONS, MCP_CONTRACT_HEADER, MCP_LIVE_CONTRACT_VERSION } from './contract.js';
import { accessToken, BridgeError, endpoint } from './config.js';

// Ignore descriptive metadata, but retain all validation and default semantics.
function canonical(value: unknown, mode: 'schema' | 'map' | 'data' = 'schema'): unknown {
  if (Array.isArray(value)) return value.map(item => canonical(item, mode));
  if (!value || typeof value !== 'object') return value;
  const object = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(object).sort().flatMap(key => {
    if (mode === 'schema' && ['description', 'title', '$schema', '$comment', 'examples'].includes(key)) return [];
    let childMode: 'schema' | 'map' | 'data' = mode === 'map' ? 'schema' : mode;
    if (mode === 'schema') {
      if (['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas', 'dependencies'].includes(key)) childMode = 'map';
      else if (['default', 'const', 'enum', 'required'].includes(key)) childMode = 'data';
    }
    let child = canonical(object[key], childMode);
    if (mode === 'schema' && ['enum', 'required'].includes(key) && Array.isArray(child)) {
      child = child.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    }
    return [[key, child]];
  }));
}

export type WorkspaceAccess = 'workspace' | 'all';

export function verifyCatalog(actual: Tool[]): WorkspaceAccess {
  const live = actual.some(tool => tool.name === 'resolve_link');
  const mode = live ? (actual.find(tool=>tool.name==='list_projects')?.inputSchema.properties?.workspaceId ? 'all' : 'workspace') : (actual.length === ALL_WORKSPACE_TOOL_DEFINITIONS.length ? 'all' : 'workspace');
  const expected = new Map((live ? (mode === 'all' ? LIVE_ALL_WORKSPACE_TOOL_DEFINITIONS : LIVE_TOOL_DEFINITIONS) : (mode === 'all' ? ALL_WORKSPACE_TOOL_DEFINITIONS : TOOL_DEFINITIONS)).map(tool => [tool.name, tool]));
  const names = new Set(actual.map(tool => tool.name));
  if (actual.length !== expected.size || names.size !== expected.size || actual.some(tool => !expected.has(tool.name))) {
    throw new BridgeError('REMOTE_CONTRACT_MISMATCH', `The hosted MCP tool list differs from client ${MCP_VERSION}. Install the compatible signed release from https://maddots.app/docs/mcp and restart the MCP connection. No project operation was submitted.`);
  }
  for (const tool of actual) {
    const local = expected.get(tool.name)!;
    for (const schema of ['inputSchema', 'outputSchema'] as const) {
      if (JSON.stringify(canonical(local[schema])) !== JSON.stringify(canonical(tool[schema]))) {
        throw new BridgeError('REMOTE_CONTRACT_MISMATCH', `The hosted MCP schemas differ for ${local.name} (${schema}) from client ${MCP_VERSION}. Install the compatible signed release from https://maddots.app/docs/mcp and restart the MCP connection. No project operation was submitted.`);
      }
    }
  }
  return mode;
}

export function failure(code: string, message: string, outcomeUncertain = false): CallToolResult {
  const value = { error: { code, message, outcomeUncertain, automaticRetryPerformed: false } };
  return { isError: true, structuredContent: value, content: [{ type: 'text', text: JSON.stringify(value) }] };
}

export class RemoteService {
  private client?: Client;
  private live = false;
  private refreshing?: Promise<WorkspaceAccess>;
  private catalogError?: BridgeError;
  private workspaceAccess: WorkspaceAccess = 'workspace';
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async initialize(credential?: string): Promise<WorkspaceAccess> {
    const url = endpoint(this.env);
    const token = credential ?? await accessToken(this.env);
    const client = new Client({ name: 'maddots-mcp-bridge', version: MCP_VERSION });
    this.client = client;
    try {
      await client.connect(new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: `Bearer ${token}`, [MCP_CONTRACT_HEADER]: MCP_LIVE_CONTRACT_VERSION }, redirect: 'error' },
        // The SDK's standalone SSE GET does not inherit requestInit.
        fetch: async (requestUrl, init) => {
          if (new URL(requestUrl).origin !== url.origin) {
            throw new BridgeError('REMOTE_CONNECTION_FAILED', 'Hosted MCP requests must stay on the configured endpoint origin.');
          }
          return fetch(requestUrl, { ...init, redirect: 'error' });
        },
      }));
      const tools: Tool[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined);
        tools.push(...page.tools);
        cursor = page.nextCursor;
        if (++pages > 100 || tools.length > 1000) throw new BridgeError('REMOTE_CONTRACT_MISMATCH', 'The hosted MCP catalog exceeded the supported size.');
      } while (cursor);
      this.workspaceAccess = verifyCatalog(tools);
      this.catalogError=undefined;
      this.live = tools.some(tool=>tool.name==='resolve_link');
      return this.workspaceAccess;
    } catch (error) {
      await this.close();
      if (error instanceof BridgeError) throw error;
      if (error instanceof StreamableHTTPError && error.code === 401) throw new BridgeError('AUTH_REQUIRED', 'Account authorization is missing, expired, or revoked. Call connect_account with action reconnect. No tool operation was submitted.');
      // SDK transport errors can include untrusted response bodies. Do not log them.
      throw new BridgeError('REMOTE_CONNECTION_FAILED', 'Cannot initialize the hosted MCP. Check the endpoint, token access, and service availability. No tool operation was submitted.');
    }
  }

  liveAccess(): boolean { return this.live; }

  async refreshCatalog(): Promise<WorkspaceAccess> {
    if(!this.client)throw new BridgeError('NOT_CONNECTED','Initialize the MCP connection before refreshing access.');
    if(!this.refreshing)this.refreshing=(async()=>{
      const tools:Tool[]=[];let cursor:string|undefined,pages=0;
      do {const page=await this.client!.listTools(cursor?{cursor}:undefined);tools.push(...page.tools);cursor=page.nextCursor;if(++pages>100||tools.length>1000)throw new BridgeError('REMOTE_CONTRACT_MISMATCH','The hosted MCP catalog exceeded the supported size.');}while(cursor);
      this.workspaceAccess=verifyCatalog(tools);this.catalogError=undefined;this.live=tools.some(tool=>tool.name==='resolve_link');return this.workspaceAccess;
    })().catch(error=>{this.catalogError=error instanceof BridgeError?error:error instanceof StreamableHTTPError&&error.code===401?new BridgeError('AUTH_REQUIRED','Account authorization expired or was revoked. No tool operation was submitted.'):new BridgeError('REMOTE_CONNECTION_FAILED','Cannot refresh hosted MCP capabilities. No project operation was submitted.');throw this.catalogError;}).finally(()=>{this.refreshing=undefined;});
    return this.refreshing;
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
    if(this.catalogError)return failure(this.catalogError.code,this.catalogError.message);
    const definition = (this.live ? (this.workspaceAccess === 'all' ? LIVE_ALL_WORKSPACE_TOOL_DEFINITIONS : LIVE_TOOL_DEFINITIONS) : (this.workspaceAccess === 'all' ? ALL_WORKSPACE_TOOL_DEFINITIONS : TOOL_DEFINITIONS)).find(tool => tool.name === name);
    if (!definition) return failure('TOOL_UNAVAILABLE', 'This tool is unavailable in the client contract.', false);
    if (!this.client) return failure('NOT_CONNECTED', 'Initialize the MCP connection before calling tools.', false);
    if (signal?.aborted) return failure('CANCELLED', 'The call was cancelled before submission.', false);
    try {
      return await this.client.callTool({ name, arguments: args }, undefined, { signal, timeout: 120_000 }) as CallToolResult;
    } catch (error) {
      if (error instanceof StreamableHTTPError && error.code === 401) return failure('AUTH_REQUIRED', 'Account authorization expired or was revoked. Call connect_account with action reconnect. The rejected operation was not retried.');
      const uncertain = definition.annotations?.readOnlyHint !== true;
      return failure('REMOTE_REQUEST_FAILED', uncertain
        ? 'The request did not complete and its outcome is unknown. Inspect current project state before repeating the change. No automatic retry was performed.'
        : 'The retrieval did not complete. No automatic retry was performed.', uncertain);
    }
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    await client?.close().catch(() => {});
  }
}
