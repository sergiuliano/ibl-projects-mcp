# MadDots MCP client

Connect an MCP host to your MadDots account through a local stdio client. Ask the host to call `connect_account`, open the returned browser link, and approve the eight-character code in MadDots. You do not need to copy a token. The client shows the code through host form elicitation when supported, keeping it out of tool results; otherwise it returns the code to your MCP host. It checks for approval in the background for up to five minutes.

During browser approval, choose all accessible workspaces (including ones you gain access to later) or restrict the connection to the selected workspace. Existing credentials keep their approved scope until you explicitly reconnect and approve a replacement. You can request read-only or read/write account access; the server continues to enforce your current project permissions. Sharing and membership administration stay in the MadDots interface.

This client requires an MCP-enabled MadDots server with account pairing enabled. The default endpoint is `https://maddots.app/mcp`; availability depends on the operator's separate server deployment. Publishing or installing this client does not deploy or enable that service. The application server, database, private implementation, and deployment configuration are not included.

Follow [the installation guide](docs/install.md) to install the version-pinned `v0.6.0` bootstrap from GitHub or build the signed source tag. The package is not published to the npm registry and remains `private: true`.

For npm and npx, use the GitHub release tarball URL, including its version. These commands depend on that release having been published:

```sh
npm install --global --ignore-scripts https://github.com/sergiuliano/ibl-projects-mcp/releases/download/v0.6.0/client-update.tgz
ibl-projects-mcp --setup
```

```sh
npx --yes --ignore-scripts --package=https://github.com/sergiuliano/ibl-projects-mcp/releases/download/v0.6.0/client-update.tgz ibl-projects-mcp --setup
```

For a bootstrap verified against the existing source signing key, follow [the signature and artifact verification steps](docs/install.md#verify-the-bootstrap-artifact) before installing the downloaded archive. A source checkout remains supported:

```sh
git clone --branch v0.6.0 --depth 1 https://github.com/sergiuliano/ibl-projects-mcp.git &&
cd ibl-projects-mcp &&
git config gpg.ssh.allowedSignersFile /ABSOLUTE/PATH/allowed_signers &&
git verify-tag v0.6.0 &&
npm ci --ignore-scripts &&
npm run build &&
node dist/cli.js --setup
```

Configure [release signing trust](docs/install.md#trust-the-release-signing-key) first. Stop if the signed tag is absent or verification fails. Do not accept an unsigned replacement.

Version 0.5.1 introduces a stable local supervisor and verified runtime updates. It checks at startup and every five minutes, then switches a compatible worker only after 60 seconds without a tool call and with no active requests. Calls are never replayed. A supervisor or protocol change requires reconnecting the host; pending account changes, in-memory credentials or an uncertain call can also defer a switch. See [update controls and recovery](docs/install.md#automatic-runtime-updates).

Existing installations older than 0.5.1 need one manual upgrade to this bootstrap and a host restart. Keep the endpoint, saved credentials and host environment. Automatic updates cannot retrofit a supervisor into a client that predates it. Hosted HTTP connections consume the deployed server directly; host-managed plugins use their host's update mechanism.

For an existing source checkout with release signing trust already configured:

```sh
git fetch origin tag v0.6.0 &&
git verify-tag v0.6.0 &&
git checkout --detach v0.6.0 &&
npm ci --ignore-scripts &&
npm run build &&
node dist/cli.js --setup
```


`--setup` shows the approval code, waits for browser approval, and verifies authentication and the shared tool contract. It never calls a project tool. You can instead add the client directly to your MCP host and use `connect_account` there. Stdio initialization does not wait for account approval.

On supported POSIX systems, approved credentials are remembered in a private configuration directory outside the checkout and bound to the exact MCP endpoint. Systems without the required file ownership and no-follow checks keep the login for the current client session only. No OS Keychain or password manager is accessed. Advanced installations can still use `PM_MCP_TOKEN` or `PM_MCP_TOKEN_FILE` instead. Paired credentials expire after 30 days; call `connect_account` with `action: "reconnect"` to approve a replacement.

The client accepts two exact authenticated catalogs: 25 project tools for a restricted credential, or 26 tools including `list_workspaces` for an all-workspaces grant. It adds one local `connect_account` tool. Before authorization it advertises the restricted schemas; after verification it refreshes the host catalog. A fresh process verifies the saved credential before advertising broad tools. The local account tool is not sent to the hosted MCP service. Failed project operations are never automatically retried. If a mutation's response is lost, inspect project state before repeating it.

For an all-workspaces grant, omitting `workspaceId` uses the workspace selected during the original approval while your membership there remains active. If that membership is no longer active, the server selects your earliest active membership by `createdAt`, breaking ties by `workspaceId`. This rule is independent of the order returned by `list_workspaces`; pass an explicit `workspaceId` whenever the user specifies a workspace.

For quicker workflows, use `list_tasks` directly for task searches and `get_overview` for progress. `list_projects` returns columns, active existing members and the current board version, allowing task creation after one lookup. Task lists and board mutation replies contain complete compact card summaries with IDs, versions, dates, assignment, priority and checklist counts. Use `get_task` for descriptions and checklist items, or `get_board` for the full board. Successful writes already confirm the change and return versions for the next edit. For all-workspaces access, call `list_workspaces` to resolve the requested name, clarify ambiguous matches, then pass `workspaceId` to each project or task operation. The deterministic default is a convenience, not an access boundary. Version 0.4.0 adds structured comment mentions, so this client requires the matching hosted tool catalog. An older client rejects the changed schema before submitting work.

To request a review with a real Inbox notification, use `add_comment` with optional `mentions: [{userId, start, end}]`. Resolve the responsible person from the active board members returned by `list_projects`, include their exact `@Name` in the body, and use UTF-16 offsets around that name. The server checks current membership and the selected text. Plain `@Name` text without spans stays ordinary text. One comment creates at most one Inbox notification per person, and a retry with the same idempotency key creates no duplicate notification.

When automation tags the account owner, the owner receives the Inbox item even though the connection posts under that account. Browser self-mentions keep their existing behavior and do not notify. Mention enrichment is restricted to the trusted hosted MCP transport; raw bearer REST requests cannot use it. Private notification reads and read-state changes remain available only in the signed-in application. Optional emails still follow each recipient's verified address, settings, and existing limits.

Run `npm test` and `npm run pack:check` for development checks. `node scripts/prepare-release.mjs --output /ABSOLUTE/PATH/release` prepares and clean-installs the exact runtime archive with locked dependencies and no install scripts. Tests use synthetic credentials and isolated local fixtures. The reusable client is available under the [MIT License](LICENSE). The package's `private: true` setting prevents accidental npm publication; it does not restrict use under that license. Hosted service access remains subject to account and project permissions.

Version 0.4.2 requires confirmation for reconnect and disconnect, preserves existing credentials when cancelling a pending approval, and identifies user content in all successful project tool results. The default endpoint remains `https://maddots.app/mcp`; saved credentials stay scoped to their approved endpoint. After pairing with maddots.app, revoke the old pm.ibl.ro connection in Integrations.

## Compatibility with the hosted service

The current client includes the optional `dueAt` UTC deadline in `create_task` and `update_task`, matching the hosted catalog. Version 0.4.1 predates those schema fields and cannot pass discovery against that catalog, including before a read. Tool discovery still validates every input and output schema; it never bypasses a mismatch.

If a saved approval fails with `REMOTE_CONTRACT_MISMATCH`, check `--status`, then use `--update` and reconnect the MCP host if requested. For a pre-0.5.1 bootstrap, perform the one-time manual upgrade above. The local tool list alone does not verify remote compatibility. Keep the existing endpoint and credential directory: a valid saved approval is reused. Run `node dist/cli.js --setup` to check authentication and catalog compatibility, then ask the host to call `list_projects`. Pair again only if authorization has expired or been revoked.

Version 0.6.0 adds explicitly approved multi-workspace pairing and strict dual-catalog verification. An upgrade alone never broadens a legacy grant. Request `connect_account` with `action: "reconnect"` only when the user authorizes reapproval, then choose all accessible workspaces in the browser. The current live and saved connection is preserved on cancellation, denial, network failure or catalog mismatch. A replacement becomes active only after authenticated catalog verification and successful atomic credential storage. Hosts must reconnect once when this release changes their initial catalog capability or instructions; signature and compatibility checks remain enforced.

Choose **All accessible workspaces** in the browser to approve a broad connection. Legacy credentials cover every project you can access in the workspace selected when you approved the connection, including projects shared with you later in that workspace. They keep the restricted catalog until explicit reapproval.
