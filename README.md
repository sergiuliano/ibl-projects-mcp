# MadDots MCP client

Connect an MCP host to your MadDots account through a local stdio client. Ask the host to call `connect_account`, open the returned browser link, and approve the eight-character code in MadDots. You do not need to copy a token. The client shows the code through host form elicitation when supported, keeping it out of tool results; otherwise it returns the code to your MCP host. It checks for approval in the background for up to five minutes.

The approved connection covers every project you can access in the workspace selected when you approved the connection, including projects shared with you later in that workspace. You can request read-only or read/write account access; the server continues to enforce your current project permissions. Sharing and membership administration stay in the MadDots interface.

This client requires an MCP-enabled MadDots server with account pairing enabled. The default endpoint is `https://maddots.app/mcp`; availability depends on the operator's separate server deployment. Publishing or installing this client does not deploy or enable that service. The application server, database, private implementation, and deployment configuration are not included.

Follow [the installation guide](docs/install.md). Installation uses a source checkout, Node.js, and npm. The package is not published to npm. Configure [release signing trust](docs/install.md#trust-the-release-signing-key) before verifying the tag or installing dependencies.

```sh
git clone --branch v0.4.2 --depth 1 https://github.com/sergiuliano/ibl-projects-mcp.git &&
cd ibl-projects-mcp &&
git config gpg.ssh.allowedSignersFile /ABSOLUTE/PATH/allowed_signers &&
git verify-tag v0.4.2 &&
npm ci &&
npm run build &&
node dist/cli.js --setup
```

Installation targets release `v0.4.2`. Use these commands only after the owner has published that release. Unsigned lightweight tags cannot be verified by this procedure; the owner must create and publish a signed release tag before the update procedure below can succeed.

To update, verify the specific release tag before checking it out or building:

```sh
git fetch origin tag v0.4.2 &&
git verify-tag v0.4.2 &&
git checkout --detach v0.4.2 &&
npm ci &&
npm run build &&
node dist/cli.js --setup
```

Stop if fetching or signature verification fails, including when the tag is absent, unsigned, or signed by a key you do not trust. Confirm the signing key with the repository owner through a trusted channel. Restart your MCP connection after a successful update.

`--setup` shows the approval code, waits for browser approval, and verifies authentication and the shared tool contract. It never calls a project tool. You can instead add the client directly to your MCP host and use `connect_account` there. Stdio initialization does not wait for account approval.

On supported POSIX systems, approved credentials are remembered in a private configuration directory outside the checkout and bound to the exact MCP endpoint. Systems without the required file ownership and no-follow checks keep the login for the current client session only. No OS Keychain or password manager is accessed. Advanced installations can still use `PM_MCP_TOKEN` or `PM_MCP_TOKEN_FILE` instead. Paired credentials expire after 30 days; call `connect_account` with `action: "reconnect"` to approve a replacement.

The client exposes 25 project tools and one local `connect_account` tool. The local account tool is not sent to the hosted MCP service. Failed project operations are never automatically retried. If a mutation's response is lost, inspect project state before repeating it.

For quicker workflows, use `list_tasks` directly for task searches and `get_overview` for progress. `list_projects` returns columns, active existing members and the current board version, allowing task creation after one lookup. Task lists and board mutation replies contain complete compact card summaries with IDs, versions, dates, assignment, priority and checklist counts. Use `get_task` for descriptions and checklist items, or `get_board` for the full board. Successful writes already confirm the change and return versions for the next edit. Tool names remain unchanged. Version 0.4.0 adds structured comment mentions, so this client requires the matching hosted tool catalog. An older client rejects the changed schema before submitting work.

To request a review with a real Inbox notification, use `add_comment` with optional `mentions: [{userId, start, end}]`. Resolve the responsible person from the active board members returned by `list_projects`, include their exact `@Name` in the body, and use UTF-16 offsets around that name. The server checks current membership and the selected text. Plain `@Name` text without spans stays ordinary text. One comment creates at most one Inbox notification per person, and a retry with the same idempotency key creates no duplicate notification.

When automation tags the account owner, the owner receives the Inbox item even though the connection posts under that account. Browser self-mentions keep their existing behavior and do not notify. Mention enrichment is restricted to the trusted hosted MCP transport; raw bearer REST requests cannot use it. Private notification reads and read-state changes remain available only in the signed-in application. Optional emails still follow each recipient's verified address, settings, and existing limits.

Run `npm test` and `npm run pack:check` for development checks. Tests use synthetic credentials and isolated local fixtures. The reusable client is available under the [MIT License](LICENSE). The package's `private: true` setting prevents accidental npm publication; it does not restrict use under that license. Hosted service access remains subject to account and project permissions.

Version 0.4.2 requires confirmation for reconnect and disconnect, preserves existing credentials when cancelling a pending approval, and identifies user content in all successful project tool results. The default endpoint remains `https://maddots.app/mcp`; saved credentials stay scoped to their approved endpoint. After pairing with maddots.app, revoke the old pm.ibl.ro connection in Integrations.

## Compatibility with the hosted service

Release 0.4.2 includes the optional `dueAt` UTC deadline in `create_task` and `update_task`, matching the hosted catalog. Version 0.4.1 predates those schema fields and cannot pass discovery against that catalog, including before a read. Tool discovery still validates every input and output schema; it never bypasses a mismatch.

If approval is saved and all 26 local tools appear but a project call returns `REMOTE_CONTRACT_MISMATCH`, update this same installation to the signed release above, rebuild it, and restart the MCP host connection. The local tool list alone does not verify remote compatibility. Keep the existing endpoint and credential directory: a valid saved approval is reused. Run `node dist/cli.js --setup` to check authentication and catalog compatibility, then ask the host to call `list_projects`. Pair again only if authorization has expired or been revoked.
