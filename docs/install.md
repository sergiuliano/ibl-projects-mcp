# Install the MadDots MCP client

Version 0.6.3 retains the preferred `maddots-mcp` executable and source package name. The `ibl-projects-mcp` executable remains an alias for existing host commands. Prefer `MADDOTS_MCP_*` configuration variables; matching `PM_MCP_*` names remain supported, and the preferred spelling wins when both are set. Saved approvals remain in `~/.config/ibl-projects-mcp/` by default so existing connections survive the rename. Keep the same endpoint and credential directory. The signed runtime archive deliberately retains the legacy `ibl-projects-mcp` package identity so older verified updaters can accept this bridge release. The public repository, signing key and exact Sigstore workflow identity remain `sergiuliano/ibl-projects-mcp`; this compatibility channel will be retired only after a separately verified migration. No new npm registry package is published.

If the installed bootstrap is older than 0.6.2, keep its `PM_MCP_*` settings until you manually install the current 0.6.3 bootstrap and restart the host. A cached runtime update does not replace that bootstrap: its startup updater, `--status` and `--rollback` still read the legacy names. To introduce a branded setting during this transition, set both matching names to the same value, especially `PM_MCP_AUTO_UPDATE` / `MADDOTS_MCP_AUTO_UPDATE` and `PM_MCP_UPDATE_DIR` / `MADDOTS_MCP_UPDATE_DIR`. Remove the legacy spelling only after the installed executable reports 0.6.2 or newer with `--version`.

Requirements: Node.js 22.22.2 or later in the Node 22 series, or Node.js 24.15.0 or later in the Node 24 series, npm and a MadDots account. Git is required for source signature verification and source installs. The optional artifact verification command uses GitHub CLI. The server operator deploys MCP and account pairing separately.

## Install the version-pinned bootstrap

The client is distributed through [sergiuliano/ibl-projects-mcp releases](https://github.com/sergiuliano/ibl-projects-mcp/releases), with npm publication disabled. Use these commands only after `v0.6.3` and its `client-update.tgz` asset exist. Do not run `npm install maddots-mcp` or `npx maddots-mcp`, which would look for an unpublished registry package.

```sh
npm install --global --ignore-scripts https://github.com/sergiuliano/ibl-projects-mcp/releases/download/v0.6.3/client-update.tgz
maddots-mcp --setup
```

A version-pinned npx invocation is also supported:

```sh
npx --yes --ignore-scripts --package=https://github.com/sergiuliano/ibl-projects-mcp/releases/download/v0.6.3/client-update.tgz maddots-mcp --setup
```

These direct URL commands trust the GitHub release distribution channel for the first bootstrap. To verify that archive against the trusted source tag and the release workflow before executing it, use [artifact verification](#verify-the-bootstrap-artifact), then install the verified local archive. Later automatic runtime downloads always require the fixed workflow's Sigstore attestation.

When no valid credential exists, setup shows a browser link and an eight-character code. Open https://maddots.app/integrations, sign in to the intended MadDots account, enter the code and approve access within five minutes. Choose **All accessible workspaces** if you want access across your workspaces. A valid existing credential is verified and reused by `--setup` without another browser approval. Then configure your MCP host without `--setup`. For a global installation, use `maddots-mcp` as the command. For npx:

```json
{
  "mcpServers": {
    "maddots": {
      "command": "npx",
      "args": [
        "--yes",
        "--ignore-scripts",
        "--package=https://github.com/sergiuliano/ibl-projects-mcp/releases/download/v0.6.3/client-update.tgz",
        "maddots-mcp"
      ]
    }
  }
}
```

The bootstrap version stays pinned in this configuration while verified compatible runtime updates are selected from a separate cache. For a new read-only approval, append `--read-only` to the setup command. Existing authorization keeps its original scopes. To explicitly replace an existing approval, use `--setup --reconnect`, optionally with `--read-only`.

## Build the signed source release

First configure [release signing trust](#trust-the-release-signing-key), then verify the exact tag before installing dependencies:

```sh
git clone --branch v0.6.3 --depth 1 https://github.com/sergiuliano/ibl-projects-mcp.git &&
cd ibl-projects-mcp &&
git config gpg.ssh.allowedSignersFile /ABSOLUTE/PATH/allowed_signers &&
git verify-tag v0.6.3 &&
npm ci --ignore-scripts &&
npm run build &&
node dist/cli.js --setup
```

Unsigned lightweight tags cannot be verified by this procedure. Stop when fetching or signature verification fails. Never replace signature verification with a checksum alone.

## Trust the release signing key

Obtain the repository owner's public SSH keys from [github.com/sergiuliano.keys](https://github.com/sergiuliano.keys) and save them outside the checkout. Inspect their fingerprints with `ssh-keygen -lf /ABSOLUTE/PATH/owner-public-keys`. Confirm the release signing key with the owner through a trusted channel. Its expected fingerprint is `SHA256:SJc+HpF3Z0k4kBgVo7q5/YH+wzR/w7liTK03a7FgVoQ`.

Compare the fingerprint and full allowed-signers line with the independent [MadDots release signing key page](https://maddots.app/docs/mcp#release-signing-key), also shown in the signed-in Integrations page. Save only this verified key in an allowed-signers file outside the checkout:

```text
sergiuliano namespaces="git" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGlM+Qk7rP8G3Fpok8tushEc6sZBSQwCddmTt4fS+EFu
```

Configure this checkout to use the file:

```sh
git config gpg.ssh.allowedSignersFile /ABSOLUTE/PATH/allowed_signers
git verify-tag v0.6.3
```

Continue only when Git reports a good signature for `sergiuliano` with the verified fingerprint. Do not trust every key in the downloaded list automatically. A changed signing key requires a new confirmation with the owner.

## Verify the bootstrap artifact

After cloning the pinned source tag and configuring the allowed-signers file above, verify the tag, download all three assets into a new empty directory, and verify the artifact against the exact signed source commit. The release workflow publishes the same archive under both its commit release and the signed version's bootstrap release.

```sh
git verify-tag v0.6.3 &&
mkdir bootstrap-download &&
gh release download v0.6.3 --repo sergiuliano/ibl-projects-mcp --dir bootstrap-download \
  --pattern client-update.tgz --pattern client-update.sigstore.json --pattern client-update.tgz.sha256 &&
gh attestation verify bootstrap-download/client-update.tgz \
  --bundle bootstrap-download/client-update.sigstore.json \
  --repo sergiuliano/ibl-projects-mcp \
  --cert-identity 'https://github.com/sergiuliano/ibl-projects-mcp/.github/workflows/client-release.yml@refs/heads/main' \
  --cert-oidc-issuer https://token.actions.githubusercontent.com \
  --source-ref refs/heads/main --source-digest "$(git rev-parse 'v0.6.3^{commit}')" \
  --signer-digest "$(git rev-parse 'v0.6.3^{commit}')" --deny-self-hosted-runners &&
npm install --global --ignore-scripts ./bootstrap-download/client-update.tgz
```

Run `maddots-mcp --setup` after this succeeds. The checksum is a convenience for transfer checks; the signed provenance binds the digest to the repository, workflow and source commit. GitHub documents [attestation verification](https://cli.github.com/manual/gh_attestation_verify).

For a source installation, setup verifies authentication and matching hosted tool names and schemas without calling a project tool. Configure the host with an absolute path to the bootstrap:

```json
{
  "mcpServers": {
    "maddots": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/maddots-mcp/dist/cli.js"]
    }
  }
}
```

Replace the path with your stable installation path. You may skip setup and ask the host to call `connect_account`. Stdio starts without waiting for account approval. A project operation attempted before approval returns an authorization instruction and is never queued or replayed.

The terminal `--setup --reconnect` flag requires a 0.6.1 or newer bootstrap. An older pinned bootstrap needs a manual upgrade for this flag even when its runtime is current; otherwise request reconnect through the host account tool.

## Claude Code and separate host approvals

The default credential directory is shared by endpoint, so two MCP hosts using the same directory and URL can reuse the same saved approval. For independent approvals, configure a separate absolute `MADDOTS_MCP_STATE_DIR` for each host. Existing configurations keep their current directory; installing or updating the client does not migrate their credentials.

For Claude Code with a stable source installation, register the server with its own credential directory:

```sh
claude mcp add --env MADDOTS_MCP_STATE_DIR=/ABSOLUTE/PATH/maddots-claude-code \
  --transport stdio --scope user maddots \
  -- /ABSOLUTE/PATH/node /ABSOLUTE/PATH/maddots-mcp/dist/cli.js
```

Replace the paths with absolute paths for your credential directory, Node executable and client installation. For example, a private directory under your user's `.config` can hold Claude's credentials. Keep at least one other option between `--env` and the server name, as shown by `--transport` and `--scope`, because `--env` accepts multiple values. Use `--` before the executable. For an existing `maddots` registration, update its command and environment in your Claude MCP configuration.

Use exactly the same credential directory for terminal setup:

```sh
MADDOTS_MCP_STATE_DIR=/ABSOLUTE/PATH/maddots-claude-code \
  /ABSOLUTE/PATH/node /ABSOLUTE/PATH/maddots-mcp/dist/cli.js --setup
```

To explicitly request a replacement browser approval, including broader workspace access:

```sh
MADDOTS_MCP_STATE_DIR=/ABSOLUTE/PATH/maddots-claude-code \
  /ABSOLUTE/PATH/node /ABSOLUTE/PATH/maddots-mcp/dist/cli.js --setup --reconnect
```

Append `--read-only` for a read-only replacement. `--setup` alone reuses a valid login. `--setup --reconnect` starts a new browser approval and preserves the old live and saved login until the replacement has been verified and saved. Approve the displayed code yourself at https://maddots.app/integrations and choose **All accessible workspaces** when that is the intended scope.

After terminal setup or a host configuration change, reconnect the server from Claude's `/mcp` menu or restart the Claude session. A running MCP process retains its current connection; a separate setup process cannot refresh it. Reconnecting reloads the saved credential and tool catalog. The current service has 28 local tools, including `connect_account` and `list_workspaces`.

If a host returns a cancelled confirmation, treat it as the host's returned outcome. It does not establish that the user declined or that the desktop automatically declines. Do not automatically retry or bypass host confirmation. `confirm: true` is only the explicit confirmation path for hosts without supported form elicitation; it never bypasses a supported host's confirmation.

## Account access and connection controls

`connect_account` accepts these optional arguments:

| Argument | Values | Purpose |
| --- | --- | --- |
| `action` | `connect` (default) | Verify an existing login or create an approval code. Repeated calls while pending return the current pairing status. |
| `action` | `status` | Read the current connection state without creating another code. |
| `action` | `cancel` | Stop only a pending local approval; keep existing credentials. The code expires automatically; if it was already approved, revoke the connection in MadDots. |
| `action` | `reconnect` | Keep the current login while requesting a new approval, for example to switch accounts, replace expired authorization, or explicitly approve all-workspaces access. |
| `action` | `disconnect` | Delete the saved credential for the current endpoint and stop using its authorization in this session. Only call this on an explicit user request. |
| `confirm` | `true` | On a host without MCP form elicitation, confirm reconnect or disconnect only after the user explicitly approves changing the current connection. It never bypasses confirmation on a host that supports form elicitation. |
| `access` | `read_write` (default), `read_only` | Choose account access for a new approval. Existing authorization is unchanged unless you reconnect. |

Connect, reconnect and disconnect require an explicit user request in the current conversation. Show the approval code only to the user, and never pass it to another tool. Reconnecting or disconnecting a client that has held authorization asks for host confirmation through MCP form elicitation when supported. Otherwise, the client preserves the current login and returns instructions to obtain user confirmation before calling again with `confirm: true`. A later connect after disconnect still requires this confirmation in the same process. Cancellation never clears a saved or environment credential. Hosts supporting form elicitation receive the approval code only in that user-facing prompt, never in connect or status tool results.

New browser approvals let you choose all accessible workspaces, including future accessible workspaces, or a restricted selected workspace. Existing credentials remain restricted until explicit reapproval. An all-workspaces grant exposes `list_workspaces`; resolve workspace names first, clarify ambiguous matches, and pass `workspaceId` to subsequent tools. The default workspace is deterministic and does not grant permissions. There is no separate project selection during pairing. Read/write approval does not grant permissions that your account lacks. The server applies current owner, editor, and viewer permissions to every operation. Sharing and membership changes remain in the browser interface.

For an all-workspaces grant, omitting `workspaceId` uses the workspace selected during the original approval while your membership there remains active. If that membership is no longer active, the server selects your earliest active membership by `createdAt`, breaking ties by `workspaceId`. This rule is independent of the order returned by `list_workspaces`; pass an explicit `workspaceId` whenever the user specifies a workspace.

Approve codes only when you initiated the connection, and confirm the displayed account and requested access. Approval issues a revocable 30-day credential. Its expiry is shown by `connect_account` with `action: "status"`. When it expires or is revoked, call `connect_account` with `action: "reconnect"` and approve a new code. There is no silent token renewal. An expired saved login also causes the next `--setup` to start a new approval. Revoke access in MadDots when it is no longer needed.

Expired, declined, already claimed, or interrupted approvals stop polling and require an explicit new connection request. Press Ctrl+C to cancel foreground setup. A cancelled host confirmation preserves the existing connection and must not trigger an automatic retry.

## Remembering your login

On supported POSIX systems, the client saves its approved credential automatically under `~/.config/ibl-projects-mcp/`. The filename is a SHA-256 hash of the exact configured MCP URL. The directory must be owned by your user with permissions `0700` and have no symlink path components. Credential files must be regular files owned by your user with permissions `0600`; symlinks are rejected. Credentials are bound to the exact endpoint and are not reused at another URL.

Set `MADDOTS_MCP_STATE_DIR` to an absolute private directory outside this checkout if you need a different location. Separate per-host directories are recommended when each host should receive its own approval. Hosts using the default directory share the saved credential for the same exact endpoint; no automatic migration changes existing configurations. Protect that directory and its backups. Tokens and polling secrets are never printed in setup output, tool results, or error messages. The client does not access OS Keychain or a password manager.

If the platform cannot enforce the required POSIX file checks, or a credential cannot be saved safely, an approved connection remains usable in memory for the current session. The connection status reports that it was not remembered. In that case, use pairing within the running MCP host and approve a new code after restarting it; a separate `--setup` process cannot pass its in-memory login to another process. Do not weaken file permissions to enable persistence.

An explicit reconnect, through `connect_account` or `--setup --reconnect`, preserves the old live and saved login while approval is pending. The client verifies the new credential against one exact supported remote catalog before atomically replacing the saved credential and switching the live connection. Cancellation, denial, expiry, network errors, incompatible catalogs and replacement storage failure preserve the previous connection. In-flight operations finish on their original connection and are never replayed. Reconnect does not revoke the previous server-side credential. Manage revocation in MadDots. An explicit `disconnect` deletes only the current endpoint’s saved credential, cancels pending approval, and clears authorization for this client session. It does not revoke server access or change environment token configuration; remove manual token configuration separately before restarting. Authorization failures clear the in-memory credential without deleting the saved file.

## Advanced: existing bearer tokens

`MADDOTS_MCP_TOKEN` or `MADDOTS_MCP_TOKEN_FILE` can supply a user-issued token instead of browser pairing. Configure only one. Environment credentials take precedence over saved paired credentials and are not copied into the credential store. To use a newly paired account on subsequent launches, remove the manual token configuration.

A POSIX token file must be a regular file owned by the current user with permissions `0600`. The file must not be a symlink. `MADDOTS_MCP_TOKEN_FILE` must be an absolute path outside this checkout. On platforms without the required file checks, use the host's supported secret environment mechanism for `MADDOTS_MCP_TOKEN`.

Do not put a token in command-line arguments, a URL, or a committed host configuration. Existing bearer tokens can be verified with `node dist/cli.js --setup` without starting a new pairing.

## Endpoint and local development

`MADDOTS_MCP_URL` defaults to `https://maddots.app/mcp`. Overrides require HTTPS without a username, password, query, or fragment. Pairing uses `/api/mcp/pairings` and `/api/mcp/pairings/poll` on the same origin; approval links must point to that origin's `/integrations` page. The client refuses redirects so neither the bearer token nor polling secret can follow a redirected request.

An explicit local endpoint such as `http://127.0.0.1:PORT/mcp` also requires `MADDOTS_MCP_ALLOW_INSECURE_LOOPBACK=1`. HTTP to remote hosts remains rejected. Use synthetic credentials, a temporary `MADDOTS_MCP_STATE_DIR`, and an isolated database for development.

## One-time migration from 0.4.x

Clients released before 0.5.1 cannot install the new supervisor automatically. Stop the host's MCP connection, update the bootstrap once, then restart the connection. For a source checkout, preserve the existing directory and verify the exact signed tag before changing it:

```sh
git fetch origin tag v0.6.3 &&
git verify-tag v0.6.3 &&
git checkout --detach v0.6.3 &&
npm ci --ignore-scripts &&
npm run build &&
node dist/cli.js --setup
```

For npm or npx, install the versioned GitHub release archive above and update the host command to that bootstrap. Preserve `MADDOTS_MCP_URL`, `MADDOTS_MCP_STATE_DIR`, environment token settings and the saved credential directory. A valid existing authorization is reused; do not pair again solely for an update or a schema mismatch. Do not copy credentials to a different endpoint.

## Automatic runtime updates

Version 0.5.1 corrects the initial 0.5.0 download reader. If you installed 0.5.0, perform the one-time manual upgrade too: its automatic downloader cannot fetch the correction. Signed 0.5.0 tags and artifacts are retained unchanged.

The 0.5.1 bootstrap runs a stable supervisor and an isolated runtime worker. On startup and every five minutes, it checks the public `sergiuliano/ibl-projects-mcp` release channel. Every runtime archive must have a valid Sigstore bundle with GitHub SLSA provenance from `.github/workflows/client-release.yml` on `refs/heads/main` in that exact repository. The verified source commit selects the immutable `client-<commit>` asset URL; the verified digest must match the downloaded archive. An unsigned release, an unrelated signer, a changed digest or an invalid package is rejected.

The updater stages the archive separately from your checkout, installs its locked production dependencies with lifecycle scripts disabled and checks the candidate before selecting it. The live supervisor switches a compatible worker only after 60 seconds without a tool call, with no active requests. It does not terminate or replay a running operation to apply an update. When a worker can switch safely, the host's connection remains open.

A supervisor or worker-protocol change requires a host reconnect. Pending pairing, in-memory authorization, an account transition or an uncertain operation can also defer a switch. Read `--status`, finish pending account work, then reconnect the host when requested. A release requiring a newer bootstrap needs the version-pinned manual installation procedure as well. Credentials and host configuration are preserved by runtime updates.

Use the same bootstrap command and environment as the MCP host for these controls. For a source installation:

```sh
node dist/cli.js --status
node dist/cli.js --update
node dist/cli.js --rollback
```

For npm or npx installations, pass the same flags to `maddots-mcp`. `--status` reports the installed bootstrap, runtime selected for the next launch, last check and failure reason. For the running host connection, `connect_account` with `action: "status"` also reports its active runtime, pending release and any reconnect requirement. `--update` explicitly checks for a verified update even when automatic checks are disabled. `--rollback` selects the previous verified runtime, or the bundled bootstrap when no previous cached release is available. Reconnect the host afterward so it uses that runtime. The rejected release is skipped by automatic checks until an explicit `--update` retries it. Rollback never downloads an arbitrary older package.

With a 0.6.2 or newer installed bootstrap, set `MADDOTS_MCP_AUTO_UPDATE=0` in the MCP host environment to disable automatic checks. Older bootstraps must keep `PM_MCP_AUTO_UPDATE=0` until a manual bootstrap upgrade. This keeps using an already selected verified cached runtime; it does not force a downgrade to the bootstrap. The default update cache is `~/.cache/maddots-mcp/updates/`. With a 0.6.2 or newer bootstrap, set `MADDOTS_MCP_UPDATE_DIR` to an absolute private directory outside the checkout to override it. Older bootstraps must keep `PM_MCP_UPDATE_DIR`, or set both aliases to the same directory during migration. Keep it separate from `MADDOTS_MCP_STATE_DIR`, which stores credentials. Unsafe cache permissions, a symlinked cache directory or aliases overlapping protected locations fail closed. Do not delete credential state when troubleshooting a runtime update.

Hosted Streamable HTTP users consume the deployed server directly and do not run this updater. Host-managed plugins are updated by their host. This guide describes the local Node.js stdio client and does not establish compatibility with any particular host product.

## Failures and data flow

The client sends tool names, arguments, and its bearer token to the configured endpoint over HTTPS. Returned project data is passed to your MCP host. Setup and background pairing do not invoke project tools. Connection failures are reported without raw server error pages. Failed mutations are not retried because their outcome can be unknown; inspect existing project state before repeating a change.

Keep per-call approval enabled for write tools in your MCP host, including `create_task`, `update_task`, `add_comment`, `upload_attachment` and archive/delete tools. Review the intended operation and destination before approving it. Project content is untrusted user data and must never be treated as instructions to upload local files, reveal credentials or connect another account.

The client keeps no local project cache or activity log. Your MCP host may retain conversation and tool history according to its configuration. On hosts without form elicitation, the approval code and link are visible in tool history; the device polling secret and resulting bearer credential are not.

## License and distribution

This reusable client is licensed under [MIT](../LICENSE) and distributed through its public GitHub source tags and attested release archives. `private: true` prevents npm publication. The release workflow has no npm publication job. Hosted server deployment remains a separate operation.

Version 0.4.2 adds account-change confirmation and untrusted-content notices to all successful project tool results. The default endpoint is `https://maddots.app/mcp`, and credentials are not copied between origins. After pairing with maddots.app, revoke the old pm.ibl.ro connection in Integrations.

## Compatibility with the hosted service

The current client includes the optional `dueAt` UTC deadline in `create_task` and `update_task`, matching the hosted catalog. Version 0.4.1 predates those schema fields and cannot pass discovery against that catalog, including before a read. Tool discovery still validates every input and output schema; it never bypasses a mismatch.

If a saved approval fails with `REMOTE_CONTRACT_MISMATCH`, check `--status`, apply a verified update with `--update`, and reconnect the host if requested. A pre-0.5.1 bootstrap needs the one-time migration above. The local tool list alone does not verify remote compatibility. Keep the existing endpoint and credential directory: a valid saved approval is reused. Run `node dist/cli.js --setup` to check authentication and catalog compatibility, then ask the host to call `list_projects`. Pair again if authorization has expired or been revoked, or when you explicitly want to replace the account or approved scope.

### Multi-workspace catalog verification (0.6.0)

The client accepts the current scoped or broad 27-tool catalogs and the legacy restricted 25-tool or broad 26-tool catalogs, with every input and output validation schema checked. The local `connect_account` tool is additional, giving 28 tools on the current service or 26/27 on older services. Partial, mixed and unknown catalogs are rejected before a business operation. Saved display metadata never determines authorization: every fresh process verifies the authenticated remote catalog. Catalog changes emit `notifications/tools/list_changed` through the supervisor so hosts refresh cached schemas. Reconnect hosts that cannot refresh their tool catalog.

Moving from an older runtime to 0.6.0 changes its initial capabilities and instructions, so the existing supervisor may require a host reconnect instead of swapping a worker live. The signed update checks, endpoint, existing credential store and explicit browser approval boundary remain unchanged. Never edit a stored credential to claim broader access.

Choose **All accessible workspaces** in the browser to approve a broad connection. Legacy credentials cover every project you can access in the workspace selected when you approved the connection, including projects shared with you later in that workspace. They retain their restricted authorization until explicit reapproval.

If the host sets `MADDOTS_MCP_TOKEN` or `MADDOTS_MCP_TOKEN_FILE`, that configuration takes precedence over saved pairing after a fresh launch. A successful reconnect uses the replacement in the current session and reports this override in its status. Remove or update the host environment through its configuration before restarting to retain the replacement account. Never copy secret values into chat.


### Refresh access and use copied links

On services supporting client 0.6.3, `list_workspaces` refreshes the current workspace names and roles without reconnecting your account. A restricted connection returns only its approved workspace. An all-workspace connection includes new active memberships automatically. Board access and removed memberships take effect on the next operation. Expanding a restricted approval requires explicit new consent.

Use `resolve_link` with a copied MadDots board or task URL to obtain authorized context, IDs and versions directly. Follow-up operations use the returned IDs and current versions. Only this configured service's links are accepted. Links never grant access, and private Inbox and public-share links are unavailable. The bridge accepts older service catalogs during rollout and refreshes discovery when the service adds capabilities. Ask your host to refresh its tool list if it caches schemas; no account approval is needed for a catalog refresh.

Native HTTP clients can read copied URLs through standard MCP resources: discover `resources/templates/list`, then call `resources/read` with the copied URL. Read `maddots://workspace-access` for current approved workspace access. Tools-only native clients opt into the current catalog with `x-maddots-mcp-contract: 1` or `params._meta: {"maddots/contract":"1"}` on each relevant request. Existing header-less clients retain their exact legacy tool catalogs.
