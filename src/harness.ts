import type { AiHarness } from './pairing.js';

const names = new Map<string, AiHarness>([
  // Source: https://github.com/cline/cline/blob/83ea9a41d11d733015adc63f47f7363098db2231/apps/vscode/src/services/mcp/McpHub.ts#L466
  ['cline', 'cline'], // Client name: "Cline".
  // Source: https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/core/context/mcp/MCPConnection.ts#L82
  ['continue-client', 'continue'],
  // Source: https://github.com/google-gemini/gemini-cli/blob/42c51822084ac25cd5d97ac0023822c5235f88c8/packages/core/src/tools/mcp-client.ts
  ['gemini-cli-mcp-client', 'gemini-cli'],
  // Sources: https://github.com/anomalyco/opencode/blob/5aabb619c0d98e238ada03f4d763d36d36539a99/packages/server/src/routes.ts
  // https://github.com/anomalyco/opencode/blob/5aabb619c0d98e238ada03f4d763d36d36539a99/packages/core/src/mcp/client.ts#L152
  ['opencode', 'opencode'],
  // Source: https://github.com/can1357/oh-my-pi/blob/b91db66e9b0b65a2c977e6a5bc74b0f4b1d58d1c/packages/coding-agent/src/mcp/client.ts#L45
  ['omp-coding-agent', 'oh-my-pi'],
  // Source: https://github.com/openclaw/openclaw/blob/c0e841b421cffa7daa312dbdfb273c1598d8d7d4/src/agents/agent-bundle-mcp-runtime.ts#L649
  ['openclaw-bundle-mcp', 'openclaw'],
  // Source: Claude Code 2.1.295 macOS binary, stdio MCP client: new Client({ name: "claude-code", title: "Claude Code", version: "2.1.295" }).
  ['claude-code', 'claude-code'],
]);

export function detectHarness(clientName: unknown): AiHarness | undefined {
  if (typeof clientName !== 'string') return undefined;
  const name = clientName.trim().toLowerCase();
  // Source: https://github.com/openai/codex/blob/cb03f28a4034b6ee901885808d27182ac586830a/codex-rs/codex-mcp/src/rmcp_client.rs
  // The confirmed name is "codex-mcp-client"; CORE-15 also permits the Codex prefix.
  if (name.startsWith('codex')) return 'codex';
  // Source: Cursor 3.24.12, commit 37b865941ccb31e2fc90c685157534efca87f960,
  // /Applications/Cursor.app/Contents/Resources/app/out/vs/code/electron-utility/mcpProcess/mcpProcessMain.js:488 (createSdkClient).
  // Corroboration: https://forum.cursor.com/t/doubts-regarding-the-capabalities-negotiations/147888/5
  // CORE-15 permits the Cursor prefix after confirming this client identity.
  if (name.startsWith('cursor')) return 'cursor';
  // Source: https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-mcp/src/servers.rs
  // Official Grok CLI constructs "grok-shell-" + server_name, not "grok-cli".
  if (name.startsWith('grok-shell-')) return 'grok-cli';
  return names.get(name);
}
