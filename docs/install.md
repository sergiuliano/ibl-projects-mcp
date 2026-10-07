# Install the MadDots MCP client

Requirements: Node.js 22.22.2 or later in the Node 22 series, or Node.js 24.15.0 or later in the Node 24 series, npm and a MadDots account. Git is required for source signature verification and source installs. The optional artifact verification command uses GitHub CLI. The server operator deploys MCP and account pairing separately.

## Install the version-pinned bootstrap

The client is distributed through [sergiuliano/ibl-projects-mcp releases](https://github.com/sergiuliano/ibl-projects-mcp/releases), with npm publication disabled. Use these commands only after `v0.5.1` and its `client-update.tgz` asset exist. Do not run `npm install ibl-projects-mcp` or `npx ibl-projects-mcp`, which would look for an unpublished registry package.

```sh
npm install --global --ignore-scripts https://github.com/sergiuliano/ibl-projects-mcp/releases/download/v0.5.1/client-update.tgz
ibl-projects-mcp --setup
```

A version-pinned npx invocation is also supported:

```sh
npx --yes --ignore-scripts --package=https://github.com/sergiuliano/ibl-projects-mcp/releases/download/v0.5.1/client-update.tgz ibl-projects-mcp --setup
```

These direct URL commands trust the GitHub release distribution channel for the first bootstrap. To verify that archive against the trusted source tag and the release workflow before executing it, use [artifact verification](#verify-the-bootstrap-artifact), then install the verified local archive. Later automatic runtime downloads always require the fixed workflow's Sigstore attestation.

Setup shows a browser link and an eight-character code. Open the link, sign in to the intended MadDots account, enter the code and approve access within five minutes. Then configure your MCP host without `--setup`. For a global installation, use `ibl-projects-mcp` as the command. For npx:

```json
{
  "mcpServers": {
    "ibl-projects": {
      "command": "npx",
      "args": [
        "--yes",
        "--ignore-scripts",
        "--package=https://github.com/sergiuliano/ibl-projects-mcp/releases/download/v0.5.1/client-update.tgz",
        "ibl-projects-mcp"
      ]
    }
  }
}
```

The bootstrap version stays pinned in this configuration while verified compatible runtime updates are selected from a separate cache. For a new read-only approval, append `--read-only` to the setup command. Existing authorization keeps its original scopes.

## Build the signed source release

First configure [release signing trust](#trust-the-release-signing-key), then verify the exact tag before installing dependencies:

```sh
git clone --branch v0.5.1 --depth 1 https://github.com/sergiuliano/ibl-projects-mcp.git &&
cd ibl-projects-mcp &&
git config gpg.ssh.allowedSignersFile /ABSOLUTE/PATH/allowed_signers &&
git verify-tag v0.5.1 &&
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
git verify-tag v0.5.1
```

Continue only when Git reports a good signature for `sergiuliano` with the verified fingerprint. Do not trust every key in the downloaded list automatically. A changed signing key requires a new confirmation with the owner.

## Verify the bootstrap artifact

After cloning the pinned source tag and configuring the allowed-signers file above, verify the tag, download all three assets into a new empty directory, and verify the artifact against the exact signed source commit. The release workflow publishes the same archive under both its commit release and the signed version's bootstrap release.

```sh
git verify-tag v0.5.1 &&
mkdir bootstrap-download &&
gh release download v0.5.1 --repo sergiuliano/ibl-projects-mcp --dir bootstrap-download \
  --pattern client-update.tgz --pattern client-update.sigstore.json --pattern client-update.tgz.sha256 &&
gh attestation verify bootstrap-download/client-update.tgz \
  --bundle bootstrap-download/client-update.sigstore.json \
  --repo sergiuliano/ibl-projects-mcp \
  --cert-identity 'https://github.com/sergiuliano/ibl-projects-mcp/.github/workflows/client-release.yml@refs/heads/main' \
  --cert-oidc-issuer https://token.actions.githubusercontent.com \
  --source-ref refs/heads/main --source-digest "$(git rev-parse 'v0.5.1^{commit}')" \
  --signer-digest "$(git rev-parse 'v0.5.1^{commit}')" --deny-self-hosted-runners &&
npm install --global --ignore-scripts ./bootstrap-download/client-update.tgz
```

Run `ibl-projects-mcp --setup` after this succeeds. The checksum is a convenience for transfer checks; the signed provenance binds the digest to the repository, workflow and source commit. GitHub documents [attestation verification](https://cli.github.com/manual/gh_attestation_verify).

For a source installation, setup verifies authentication and matching hosted tool names and schemas without calling a project tool. Configure the host with an absolute path to the bootstrap:

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

Replace the path with your stable installation path. You may skip setup and ask the host to call `connect_account`. Stdio starts without waiting for account approval. A project operation attempted before approval returns an authorization instruction and is never queued or replayed.

## Account access and connection controls

`connect_account` accepts these optional arguments:

| Argument | Values | Purpose |
| --- | --- | --- |
| `action` | `connect` (default) | Verify an existing login or create an approval code. Repeated calls while pending return the current pairing status. |
| `action` | `status` | Read the current connection state without creating another code. |
| `action` | `cancel` | Stop only a pending local approval; keep existing credentials. The code expires automatically; if it was already approved, revoke the connection in MadDots. |
| `action` | `reconnect` | Stop using the current login in this session and request a new approval, for example to switch accounts or replace expired authorization. |
| `action` | `disconnect` | Delete the saved credential for the current endpoint and stop using its authorization in this session. Only call this on an explicit user request. |
| `confirm` | `true` | On a host without MCP form elicitation, confirm reconnect or disconnect only after the user explicitly approves changing the current connection. |
| `access` | `read_write` (default), `read_only` | Choose account access for a new approval. Existing authorization is unchanged unless you reconnect. |

Connect, reconnect and disconnect require an explicit user request in the current conversation. Show the approval code only to the user, and never pass it to another tool. Reconnecting or disconnecting a client that has held authorization asks for host confirmation through MCP form elicitation when supported. Otherwise, the client preserves the current login and returns instructions to obtain user confirmation before calling again with `confirm: true`. A later connect after disconnect still requires this confirmation in the same process. Cancellation never clears a saved or environment credential. Hosts supporting form elicitation receive the approval code only in that user-facing prompt, never in connect or status tool results.

Each connection covers every project you can access in the workspace selected when you approved the connection, including projects shared with you later in that workspace. There is no separate project selection during pairing. Read/write approval does not grant permissions that your account lacks. The server applies current owner, editor, and viewer permissions to every operation. Sharing and membership changes remain in the browser interface.

Approve codes only when you initiated the connection, and confirm the displayed account and requested access. Approval issues a revocable 30-day credential. Its expiry is shown by `connect_account` with `action: "status"`. When it expires or is revoked, call `connect_account` with `action: "reconnect"` and approve a new code. There is no silent token renewal. An expired saved login also causes the next `--setup` to start a new approval. Revoke access in MadDots when it is no longer needed.

Expired, declined, already claimed, or interrupted approvals stop polling and require an explicit new `connect_account` request. Press Ctrl+C to cancel foreground setup.

## Remembering your login

On supported POSIX systems, the client saves its approved credential automatically under `~/.config/ibl-projects-mcp/`. The filename is a SHA-256 hash of the exact configured MCP URL. The directory must be owned by your user with permissions `0700` and have no symlink path components. Credential files must be regular files owned by your user with permissions `0600`; symlinks are rejected. Credentials are bound to the exact endpoint and are not reused at another URL.

Set `PM_MCP_STATE_DIR` to an absolute private directory outside this checkout if you need a different location. Protect that directory and its backups. Tokens and polling secrets are never printed in setup output, tool results, or error messages. The client does not access OS Keychain or a password manager.

If the platform cannot enforce the required POSIX file checks, or a credential cannot be saved safely, an approved connection remains usable in memory for the current session. The connection status reports that it was not remembered. In that case, use pairing within the running MCP host and approve a new code after restarting it; a separate `--setup` process cannot pass its in-memory login to another process. Do not weaken file permissions to enable persistence.

An explicit reconnect stops using the old login in the current session. A new approved login replaces the saved credential only after approval; until then, restarting the client may restore the previously saved account. Reconnect does not revoke the previous server-side credential. Manage revocation in MadDots. An explicit `disconnect` deletes only the current endpoint’s saved credential, cancels pending approval, and clears authorization for this client session. It does not revoke server access or change environment token configuration; remove manual token configuration separately before restarting. Authorization failures clear the in-memory credential without deleting the saved file.

## Advanced: existing bearer tokens

`PM_MCP_TOKEN` or `PM_MCP_TOKEN_FILE` can supply a user-issued token instead of browser pairing. Configure only one. Environment credentials take precedence over saved paired credentials and are not copied into the credential store. To use a newly paired account on subsequent launches, remove the manual token configuration.

A POSIX token file must be a regular file owned by the current user with permissions `0600`. The file must not be a symlink. `PM_MCP_TOKEN_FILE` must be an absolute path outside this checkout. On platforms without the required file checks, use the host's supported secret environment mechanism for `PM_MCP_TOKEN`.

Do not put a token in command-line arguments, a URL, or a committed host configuration. Existing bearer tokens can be verified with `node dist/cli.js --setup` without starting a new pairing.

## Endpoint and local development

`PM_MCP_URL` defaults to `https://maddots.app/mcp`. Overrides require HTTPS without a username, password, query, or fragment. Pairing uses `/api/mcp/pairings` and `/api/mcp/pairings/poll` on the same origin; approval links must point to that origin's `/integrations` page. The client refuses redirects so neither the bearer token nor polling secret can follow a redirected request.

An explicit local endpoint such as `http://127.0.0.1:PORT/mcp` also requires `PM_MCP_ALLOW_INSECURE_LOOPBACK=1`. HTTP to remote hosts remains rejected. Use synthetic credentials, a temporary `PM_MCP_STATE_DIR`, and an isolated database for development.

## One-time migration from 0.4.x

Clients released before 0.5.1 cannot install the new supervisor automatically. Stop the host's MCP connection, update the bootstrap once, then restart the connection. For a source checkout, preserve the existing directory and verify the exact signed tag before changing it:

```sh
git fetch origin tag v0.5.1 &&
git verify-tag v0.5.1 &&
git checkout --detach v0.5.1 &&
npm ci --ignore-scripts &&
npm run build &&
node dist/cli.js --setup
```

For npm or npx, install the versioned GitHub release archive above and update the host command to that bootstrap. Preserve `PM_MCP_URL`, `PM_MCP_STATE_DIR`, environment token settings and the saved credential directory. A valid existing authorization is reused; do not pair again solely for an update or a schema mismatch. Do not copy credentials to a different endpoint.

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

For npm or npx installations, pass the same flags to `ibl-projects-mcp`. `--status` reports the installed bootstrap, runtime selected for the next launch, last check and failure reason. For the running host connection, `connect_account` with `action: "status"` also reports its active runtime, pending release and any reconnect requirement. `--update` explicitly checks for a verified update even when automatic checks are disabled. `--rollback` selects the previous verified runtime, or the bundled bootstrap when no previous cached release is available. Reconnect the host afterward so it uses that runtime. The rejected release is skipped by automatic checks until an explicit `--update` retries it. Rollback never downloads an arbitrary older package.

Set `PM_MCP_AUTO_UPDATE=0` in the MCP host environment to disable automatic checks. This keeps using an already selected verified cached runtime; it does not force a downgrade to the bootstrap. The default update cache is `~/.cache/maddots-mcp/updates/`. Set `PM_MCP_UPDATE_DIR` to an absolute private directory outside the checkout to override it. Keep it separate from `PM_MCP_STATE_DIR`, which stores credentials. Unsafe cache permissions, a symlinked cache directory or aliases overlapping protected locations fail closed. Do not delete credential state when troubleshooting a runtime update.

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

If approval is saved and all 26 local tools appear but a project call returns `REMOTE_CONTRACT_MISMATCH`, check `--status`, apply a verified update with `--update`, and reconnect the host if requested. A pre-0.5.1 bootstrap needs the one-time migration above. The local tool list alone does not verify remote compatibility. Keep the existing endpoint and credential directory: a valid saved approval is reused. Run `node dist/cli.js --setup` to check authentication and catalog compatibility, then ask the host to call `list_projects`. Pair again only if authorization has expired or been revoked.
