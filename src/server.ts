import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { MCP_VERSION, TOOL_DEFINITIONS } from './contract.js';

export type McpService = { callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> };
export function createMcpServer(service: McpService, additionalTools: readonly Tool[] = []): Server {
  const tools = [...TOOL_DEFINITIONS, ...additionalTools];
  if (new Set(tools.map(tool => tool.name)).size !== tools.length) throw new Error('MCP tool names must be unique.');
  const pairingInstructions = additionalTools.some(tool => tool.name === 'connect_account') ? ' Use connect_account when the client requests account authorization.' : '';
  const server = new Server({ name: 'ibl-projects-mcp', version: MCP_VERSION }, { capabilities: { tools: {} }, instructions: 'Operate only on boards the authenticated user can access.' + pairingInstructions + ' Use returned task and board versions for writes. Sharing is available only in the PM App interface. Never automatically repeat a write after an uncertain failure.' });
  const validator = new AjvJsonSchemaValidator();
  const validators = new Map(tools.map(tool => [tool.name, validator.getValidator(tool.inputSchema)]));
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const validate = validators.get(request.params.name);
    const args = request.params.arguments ?? {};
    if (!validate || !validate(args).valid) return { isError: true, content: [{ type: 'text', text: 'Unknown tool or invalid input. Use the advertised tool schema.' }] };
    if (extra.signal.aborted) return { isError: true, content: [{ type: 'text', text: 'Request cancelled before submission.' }] };
    return service.callTool(request.params.name, args, extra.signal);
  });
  return server;
}
