# IBL Projects MCP client

Connect an MCP host to your IBL Projects account through a local stdio client. Ask the host to call `connect_account`, open the returned browser link, and approve the eight-character code in IBL Projects. You do not need to copy a token. The client returns the code immediately and checks for approval in the background for up to five minutes.

The approved connection covers all projects your account can access, including future accessible projects. You can request read-only or read/write account access; the server continues to enforce your current project permissions. Sharing and membership administration stay in the IBL Projects interface.

This client requires an MCP-enabled IBL Projects server with account pairing enabled. The default endpoint is `https://pm.ibl.ro/mcp`; availability depends on the operator's separate server deployment. Publishing or installing this client does not deploy or enable that service. The application server, database, private implementation, and deployment configuration are not included.

Follow [the installation guide](docs/install.md). Installation uses a source checkout, Node.js, and npm. The package is not published to npm.

```sh
git clone --branch v0.3.0 --depth 1 https://github.com/sergiuliano/ibl-projects-mcp.git
cd ibl-projects-mcp
npm ci
npm run build
node dist/cli.js --setup
```

Installation targets release `v0.3.0`. Use these commands only after the owner has published that release. Unsigned lightweight tags cannot be verified by this procedure; the owner must create and publish a signed release tag before the update procedure below can succeed.

To update, verify the specific release tag before checking it out or building:

```sh
git fetch origin tag v0.3.0 &&
git verify-tag v0.3.0 &&
git checkout --detach v0.3.0 &&
npm ci &&
npm run build &&
node dist/cli.js --setup
```

Stop if fetching or signature verification fails, including when the tag is absent, unsigned, or signed by a key you do not trust. Confirm the signing key with the repository owner through a trusted channel. Restart your MCP connection after a successful update.

`--setup` shows the approval code, waits for browser approval, and verifies authentication and the shared tool contract. It never calls a project tool. You can instead add the client directly to your MCP host and use `connect_account` there. Stdio initialization does not wait for account approval.

On supported POSIX systems, approved credentials are remembered in a private configuration directory outside the checkout and bound to the exact MCP endpoint. Systems without the required file ownership and no-follow checks keep the login for the current client session only. No OS Keychain or password manager is accessed. Advanced installations can still use `PM_MCP_TOKEN` or `PM_MCP_TOKEN_FILE` instead. Paired credentials expire after 30 days; call `connect_account` with `action: "reconnect"` to approve a replacement.

The client exposes 25 project tools and one local `connect_account` tool. The local account tool is not sent to the hosted MCP service. Failed project operations are never automatically retried. If a mutation's response is lost, inspect project state before repeating it.

For quicker workflows, use `list_tasks` directly for task searches and `get_overview` for progress. `list_projects` returns columns, active existing members and the current board version, allowing task creation after one lookup. Task lists and board mutation replies contain complete compact card summaries with IDs, versions, dates, assignment, priority and checklist counts. Use `get_task` for descriptions and checklist items, or `get_board` for the full board. Successful writes already confirm the change and return versions for the next edit. Tool names and schemas remain compatible with version 0.2.0.

Run `npm test` and `npm run pack:check` for development checks. Tests use synthetic credentials and isolated local fixtures. The reusable client is available under the [MIT License](LICENSE). The package's `private: true` setting prevents accidental npm publication; it does not restrict use under that license. Hosted service access remains subject to account and project permissions.
