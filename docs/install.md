# Install the IBL Projects MCP client

Requirements: Node.js 22.22.1 or later in the Node 22 or 24 series, npm, Git, and an IBL Projects account. The server operator must deploy and enable MCP and account pairing separately. These installation steps do not establish that the default service is already available.

1. Clone [sergiuliano/ibl-projects-mcp](https://github.com/sergiuliano/ibl-projects-mcp) into a stable local directory.
2. Run `npm ci` and `npm run build` there.
3. Run `node dist/cli.js --setup`. Open the displayed link, sign in to the intended IBL Projects account, enter the eight-character code, and approve the connection. The code expires after five minutes.
4. Configure your MCP host to run `node` with the absolute path to `dist/cli.js`, without `--setup`.

```sh
git clone https://github.com/sergiuliano/ibl-projects-mcp.git
cd ibl-projects-mcp
npm ci
npm run build
node dist/cli.js --setup
```

Setup waits for your approval, then verifies authentication and matching hosted tool names and schemas. It does not call a project tool. You may skip the setup command and connect from your MCP host instead:

```json
{
  "mcpServers": {
    "ibl-projects": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/ibl-projects-mcp/dist/cli.js"]
    }
  }
}
```

Replace the path with your own stable installation path. The client starts immediately even without saved authorization. Ask your MCP host to call `connect_account`, then follow the returned link and code. After approval, project tools work in the same client session. A project operation attempted before approval returns an authorization instruction and is not queued or replayed.

## Account access and connection controls

`connect_account` accepts these optional arguments:

| Argument | Values | Purpose |
| --- | --- | --- |
| `action` | `connect` (default) | Verify an existing login or create an approval code. Repeated calls while pending return the current code. |
| `action` | `status` | Read the current connection state without creating another code. |
| `action` | `cancel` | Stop local polling. The code expires automatically; if it was already approved, revoke the connection in IBL Projects. |
| `action` | `reconnect` | Stop using the current login in this session and request a new approval, for example to switch accounts or replace expired authorization. |
| `access` | `read_write` (default), `read_only` | Choose account access for a new approval. Existing authorization is unchanged unless you reconnect. |

Each connection covers all projects the approved account can access, including future accessible projects. There is no separate project selection during pairing. Read/write approval does not grant permissions that your account lacks. The server applies current owner, editor, and viewer permissions to every operation. Sharing and membership changes remain in the browser interface.

Approve codes only when you initiated the connection, and confirm the displayed account and requested access. Approval issues a revocable 30-day credential. Its expiry is shown by `connect_account` with `action: "status"`. When it expires or is revoked, call `connect_account` with `action: "reconnect"` and approve a new code. There is no silent token renewal. An expired saved login also causes the next `--setup` to start a new approval. Revoke access in IBL Projects when it is no longer needed.

Expired, declined, already claimed, or interrupted approvals stop polling and require an explicit new `connect_account` request. Press Ctrl+C to cancel foreground setup.

## Remembering your login

On supported POSIX systems, the client saves its approved credential automatically under `~/.config/ibl-projects-mcp/`. The filename is a SHA-256 hash of the exact configured MCP URL. The directory must be owned by your user with permissions `0700` and have no symlink path components. Credential files must be regular files owned by your user with permissions `0600`; symlinks are rejected. Credentials are bound to the exact endpoint and are not reused at another URL.

Set `PM_MCP_STATE_DIR` to an absolute private directory outside this checkout if you need a different location. Protect that directory and its backups. Tokens and polling secrets are never printed in setup output, tool results, or error messages. The client does not access OS Keychain or a password manager.

If the platform cannot enforce the required POSIX file checks, or a credential cannot be saved safely, an approved connection remains usable in memory for the current session. The connection status reports that it was not remembered. In that case, use pairing within the running MCP host and approve a new code after restarting it; a separate `--setup` process cannot pass its in-memory login to another process. Do not weaken file permissions to enable persistence.

An explicit reconnect stops using the old login in the current session. A new approved login replaces the saved credential only after approval; until then, restarting the client may restore the previously saved account. Reconnect does not revoke the previous server-side credential. Manage revocation in IBL Projects.

## Advanced: existing bearer tokens

`PM_MCP_TOKEN` or `PM_MCP_TOKEN_FILE` can supply a user-issued token instead of browser pairing. Configure only one. Environment credentials take precedence over saved paired credentials and are not copied into the credential store. To use a newly paired account on subsequent launches, remove the manual token configuration.

A POSIX token file must be a regular file owned by the current user with permissions `0600`. The file must not be a symlink. `PM_MCP_TOKEN_FILE` must be an absolute path outside this checkout. On platforms without the required file checks, use the host's supported secret environment mechanism for `PM_MCP_TOKEN`.

Do not put a token in command-line arguments, a URL, or a committed host configuration. Existing bearer tokens can be verified with `node dist/cli.js --setup` without starting a new pairing.

## Endpoint and local development

`PM_MCP_URL` defaults to `https://pm.ibl.ro/mcp`. Overrides require HTTPS without a username, password, query, or fragment. Pairing uses `/api/mcp/pairings` and `/api/mcp/pairings/poll` on the same origin; approval links must point to that origin's `/integrations` page. The client refuses redirects so neither the bearer token nor polling secret can follow a redirected request.

An explicit local endpoint such as `http://127.0.0.1:PORT/mcp` also requires `PM_MCP_ALLOW_INSECURE_LOOPBACK=1`. HTTP to remote hosts remains rejected. Use synthetic credentials, a temporary `PM_MCP_STATE_DIR`, and an isolated database for development.

## Updates, failures, and data flow

Update the checkout from its reviewed release, run `npm ci` and `npm run build`, rerun `--setup`, and restart the MCP connection. The client does not update itself. A mismatched hosted tool contract prevents project operations.

The client sends tool names, arguments, and its bearer token to the configured endpoint over HTTPS. Returned project data is passed to your MCP host. Setup and background pairing do not invoke project tools. Connection failures are reported without raw server error pages. Failed mutations are not retried because their outcome can be unknown; inspect existing project state before repeating a change.

The client keeps no local project cache or activity log. Your MCP host may retain conversation and tool history according to its configuration. The approval code and link are intentionally visible there; the device polling secret and resulting bearer credential are not.

## License and distribution

This reusable client is licensed under [MIT](../LICENSE) and installed from its public GitHub source repository. npm publication and hosted server deployment are separate actions and are not performed by these instructions.
