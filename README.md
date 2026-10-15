# MadDots MCP client

Plan capability revision 2 adds eleven workspace plan tools, including named plans and card, milestone and module blockers for Admin and PM users, plus member-safe `get_my_plan` for every active workspace member. They need a server with the matching catalog, which maddots.app has. The package keeps its `0.6.3` identity and updates through signed commit releases. The 25 existing project tools retain their schemas.

Version 0.6.3 retains the preferred `maddots-mcp` executable and source package name. The `ibl-projects-mcp` executable remains an alias for existing host commands. Prefer `MADDOTS_MCP_*` configuration variables; matching `PM_MCP_*` names remain supported, and the preferred spelling wins when both are set. Saved approvals remain in `~/.config/ibl-projects-mcp/` by default so existing connections survive the rename. Keep the same endpoint and credential directory. The signed runtime archive deliberately retains the legacy `ibl-projects-mcp` package identity so older verified updaters can accept this bridge release. The public repository, signing key and exact Sigstore workflow identity remain `sergiuliano/ibl-projects-mcp`; this compatibility channel will be retired only after a separately verified migration. No new npm registry package is published.

If the installed bootstrap is older than 0.6.2, keep its `PM_MCP_*` settings until you manually install the current 0.6.3 bootstrap and restart the host. A cached runtime update does not replace that bootstrap: its startup updater, `--status` and `--rollback` still read the legacy names. To introduce a branded setting during this transition, set both matching names to the same value, especially `PM_MCP_AUTO_UPDATE` / `MADDOTS_MCP_AUTO_UPDATE` and `PM_MCP_UPDATE_DIR` / `MADDOTS_MCP_UPDATE_DIR`. Remove the legacy spelling only after the installed executable reports 0.6.2 or newer with `--version`.

Connect an MCP host to your MadDots account through a local stdio client. Ask the host to call `connect_account`, open https://maddots.app/integrations, and approve the eight-character code in MadDots. You do not need to copy a token. The client shows the code through host form elicitation when supported, keeping it out of tool results; otherwise it returns the code to your MCP host. It checks for approval in the background for up to five minutes.

During browser approval, choose all accessible workspaces (including ones you gain access to later) or restrict the connection to the selected workspace. Existing credentials keep their approved scope until you explicitly reconnect and approve a replacement. You can request read-only or read/write account access; the server continues to enforce your current project permissions. Sharing and membership administration stay in the MadDots interface.

This client requires an MCP-enabled MadDots server with account pairing enabled. The default endpoint is `https://maddots.app/mcp`; availability depends on the operator's separate server deployment. Publishing or installing this client does not deploy or enable that service. The application server, database, private implementation, and deployment configuration are not included.

Follow [the installation guide](docs/install.md) to install the version-pinned `v0.6.3` bootstrap from GitHub or build the signed source tag. The package is not published to the npm registry and remains `private: true`.

For npm and npx, use the GitHub release tarball URL, including its version. These commands depend on that release having been published:

```sh
npm install --global --ignore-scripts https://github.com/sergiuliano/ibl-projects-mcp/releases/download/v0.6.3/client-update.tgz
maddots-mcp --setup
```

```sh
npx --yes --ignore-scripts --package=https://github.com/sergiuliano/ibl-projects-mcp/releases/download/v0.6.3/client-update.tgz maddots-mcp --setup
```

For a bootstrap verified against the existing source signing key, follow [the signature and artifact verification steps](docs/install.md#verify-the-bootstrap-artifact) before installing the downloaded archive. A source checkout remains supported:

```sh
git clone --branch v0.6.3 --depth 1 https://github.com/sergiuliano/ibl-projects-mcp.git &&
cd ibl-projects-mcp &&
git config gpg.ssh.allowedSignersFile /ABSOLUTE/PATH/allowed_signers &&
git verify-tag v0.6.3 &&
npm ci --ignore-scripts &&
npm run build &&
node dist/cli.js --setup
```

Configure [release signing trust](docs/install.md#trust-the-release-signing-key) first. Stop if the signed tag is absent or verification fails. Do not accept an unsigned replacement.

Version 0.5.1 introduces a stable local supervisor and verified runtime updates. It checks at startup and every five minutes, then switches a compatible worker only after 60 seconds without a tool call and with no active requests. Calls are never replayed. A supervisor or protocol change requires reconnecting the host; pending account changes, in-memory credentials or an uncertain call can also defer a switch. See [update controls and recovery](docs/install.md#automatic-runtime-updates).

Existing installations older than 0.5.1 need one manual upgrade to this bootstrap and a host restart. Keep the endpoint, saved credentials and host environment. Automatic updates cannot retrofit a supervisor into a client that predates it. Hosted HTTP connections consume the deployed server directly; host-managed plugins use their host's update mechanism.

For an existing source checkout with release signing trust already configured:

```sh
git fetch origin tag v0.6.3 &&
git verify-tag v0.6.3 &&
git checkout --detach v0.6.3 &&
npm ci --ignore-scripts &&
npm run build &&
node dist/cli.js --setup
```


`--setup` verifies and reuses a valid existing login. Without one, it shows the approval code, waits for browser approval, and verifies authentication and the shared tool contract. Use `--setup --reconnect` to explicitly start a replacement browser approval, optionally adding `--read-only`. The old live and saved login remain in place until the replacement is verified and saved. It never calls a project tool. You can instead add the client directly to your MCP host and use `connect_account` there. Stdio initialization does not wait for account approval.

The terminal `--setup --reconnect` flag requires a 0.6.1 or newer bootstrap. Upgrade an older installed bootstrap for this flag, or request reconnect through the host account tool. A runtime update alone does not change the bootstrap argument parser.

For independent host approvals, give each host its own absolute `MADDOTS_MCP_STATE_DIR`. The default directory shares credentials by exact endpoint, so installing another host may reuse an existing approval. Existing configurations are not silently migrated.

For Claude Code with a stable source installation:

```sh
claude mcp add --env MADDOTS_MCP_STATE_DIR=/ABSOLUTE/PATH/maddots-claude-code \
  --transport stdio --scope user maddots \
  -- /ABSOLUTE/PATH/node /ABSOLUTE/PATH/maddots-mcp/dist/cli.js
```

Replace the paths with your absolute paths. Keep at least one other option between the variadic `--env` option and the server name, as shown by `--transport` and `--scope`, and `--` before the executable. Use the same directory for terminal setup or reconnect:

```sh
MADDOTS_MCP_STATE_DIR=/ABSOLUTE/PATH/maddots-claude-code \
  /ABSOLUTE/PATH/node /ABSOLUTE/PATH/maddots-mcp/dist/cli.js --setup

MADDOTS_MCP_STATE_DIR=/ABSOLUTE/PATH/maddots-claude-code \
  /ABSOLUTE/PATH/node /ABSOLUTE/PATH/maddots-mcp/dist/cli.js --setup --reconnect
```

Approve the displayed code yourself at https://maddots.app/integrations and choose **All accessible workspaces** for broad access. After setup or a configuration change, reconnect from Claude's `/mcp` menu or restart the session to reload the saved credential and tool catalog. A separate terminal process does not refresh an already running MCP connection. See [Claude setup details](docs/install.md#claude-code-and-separate-host-approvals).

Reconnect and disconnect use host confirmation when form elicitation is supported. `confirm: true` never bypasses that confirmation. A cancelled confirmation is the host's returned outcome, not evidence that the user declined or that the desktop automatically declines. Preserve the existing connection and wait for an explicit new request; do not automatically retry or bypass confirmation.

On supported POSIX systems, approved credentials are remembered in a private configuration directory outside the checkout and bound to the exact MCP endpoint. Systems without the required file ownership and no-follow checks keep the login for the current client session only. No OS Keychain or password manager is accessed. Advanced installations can still use `MADDOTS_MCP_TOKEN` or `MADDOTS_MCP_TOKEN_FILE` instead. Paired credentials expire after 30 days; call `connect_account` with `action: "reconnect"` to approve a replacement.

The client verifies the opt-in Plan 38-tool catalogs, the scoped or broad 27-tool catalogs, and the legacy restricted 25-tool or broad 26-tool catalogs. Current services offer `list_workspaces` and `resolve_link` within either approved access mode. It adds one local `connect_account` tool. Before authorization it advertises the restricted schemas; after verification it refreshes the host catalog. A fresh process verifies the saved credential before advertising broad tools. The local account tool is not sent to the hosted MCP service. Failed project operations are never automatically retried. If a mutation's response is lost, inspect project state before repeating it.

For an all-workspaces grant, omitting `workspaceId` uses the workspace selected during the original approval while your membership there remains active. If that membership is no longer active, the server selects your earliest active membership by `createdAt`, breaking ties by `workspaceId`. This rule is independent of the order returned by `list_workspaces`; pass an explicit `workspaceId` whenever the user specifies a workspace.

For quicker workflows, use `list_tasks` directly for task searches and `get_overview` for progress. `list_projects` returns columns, active existing members and the current board version, allowing task creation after one lookup. Task lists and board mutation replies contain complete compact card summaries with IDs, versions, dates, assignment, priority and checklist counts. Use `get_task` for descriptions and checklist items, or `get_board` for the full board. Successful writes already confirm the change and return versions for the next edit. For all-workspaces access, call `list_workspaces` to resolve the requested name, clarify ambiguous matches, then pass `workspaceId` to each project or task operation. The deterministic default is a convenience, not an access boundary. Version 0.4.0 adds structured comment mentions, so this client requires the matching hosted tool catalog. An older client rejects the changed schema before submitting work.

To request a review with a real Inbox notification, use `add_comment` with optional `mentions: [{userId, start, end}]`. Resolve the responsible person from the active board members returned by `list_projects`, include their exact `@Name` in the body, and use UTF-16 offsets around that name. The server checks current membership and the selected text. Plain `@Name` text without spans stays ordinary text. One comment creates at most one Inbox notification per person, and a retry with the same idempotency key creates no duplicate notification.

When automation tags the account owner, the owner receives the Inbox item even though the connection posts under that account. Browser self-mentions keep their existing behavior and do not notify. Mention enrichment is restricted to the trusted hosted MCP transport; raw bearer REST requests cannot use it. Private notification reads and read-state changes remain available only in the signed-in application. Optional emails still follow each recipient's verified address, settings, and existing limits.

Run `npm test` and `npm run pack:check` for development checks. `node scripts/prepare-release.mjs --output /ABSOLUTE/PATH/release` prepares and clean-installs the exact runtime archive with locked dependencies and no install scripts. Tests use synthetic credentials and isolated local fixtures. The reusable client is available under the [MIT License](LICENSE). The package's `private: true` setting prevents accidental npm publication; it does not restrict use under that license. Hosted service access remains subject to account and project permissions.

Version 0.4.2 requires confirmation for reconnect and disconnect, preserves existing credentials when cancelling a pending approval, and identifies user content in all successful project tool results. The default endpoint remains `https://maddots.app/mcp`; saved credentials stay scoped to their approved endpoint. After pairing with maddots.app, revoke the old pm.ibl.ro connection in Integrations.

## Compatibility with the hosted service

The current client includes the optional `dueAt` UTC deadline in `create_task` and `update_task`, matching the hosted catalog. Version 0.4.1 predates those schema fields and cannot pass discovery against that catalog, including before a read. Tool discovery still validates every input and output schema; it never bypasses a mismatch.

If a saved approval fails with `REMOTE_CONTRACT_MISMATCH`, check `--status`, then use `--update` and reconnect the MCP host if requested. For a pre-0.5.1 bootstrap, perform the one-time manual upgrade above. The local tool list alone does not verify remote compatibility. Keep the existing endpoint and credential directory: a valid saved approval is reused. Run `node dist/cli.js --setup` to check authentication and catalog compatibility, then ask the host to call `list_projects`. Pair again if authorization has expired or been revoked, or when you explicitly want to replace the account or approved scope.

Version 0.6.0 adds explicitly approved multi-workspace pairing and strict dual-catalog verification. An upgrade alone never broadens a legacy grant. Request `connect_account` with `action: "reconnect"` only when the user authorizes reapproval, then choose all accessible workspaces in the browser. The current live and saved connection is preserved on cancellation, denial, network failure or catalog mismatch. A replacement becomes active only after authenticated catalog verification and successful atomic credential storage. Hosts must reconnect once when this release changes their initial catalog capability or instructions; signature and compatibility checks remain enforced.

Choose **All accessible workspaces** in the browser to approve a broad connection. Legacy credentials cover every project you can access in the workspace selected when you approved the connection, including projects shared with you later in that workspace. They retain their restricted authorization until explicit reapproval.


### Refresh access and use copied links

On services supporting client 0.6.3, `list_workspaces` refreshes the current workspace names and roles without reconnecting your account. A restricted connection returns only its approved workspace. An all-workspace connection includes new active memberships automatically. Board access and removed memberships take effect on the next operation. Expanding a restricted approval requires explicit new consent.

Use `resolve_link` with a copied MadDots board or task URL to obtain authorized context, IDs and versions directly. Follow-up operations use the returned IDs and current versions. Only this configured service's links are accepted. Links never grant access, and private Inbox and public-share links are unavailable. The bridge accepts older service catalogs during rollout and refreshes discovery when the service adds capabilities. Ask your host to refresh its tool list if it caches schemas; no account approval is needed for a catalog refresh.

Native HTTP clients can read copied URLs through standard MCP resources: discover `resources/templates/list`, then call `resources/read` with the copied URL. Read `maddots://workspace-access` for current approved workspace access. Tools-only native clients opt into the current catalog with `x-maddots-mcp-contract: 1` or `params._meta: {"maddots/contract":"1"}` on each relevant request. Existing header-less clients retain their exact legacy tool catalogs.

`list_ready_tasks` reads `GET /api/plan/readiness` with the existing plan, board, module, milestone and assignee filters. It returns startable tasks in plan order, with Now tasks before Queued tasks. Backlog, later stages, future not-before dates and checkpoints are excluded. Each task adds `readiness: {state: 'can_start' | 'queued', now: boolean, flags}`. Scheduling ranks remain private. Tool names, input schemas, Plan capability revision 2 and the 0.6.3 client identity stay unchanged; the reviewed wording change does not alter canonical catalog validation.

Deprecated `GET /api/plan/ready`: Frozen. Uses the pre-Wave 4 rule (a Backlog card can be ready). Use /api/plan/readiness. Removal needs a reviewed golden change.

`get_my_plan` retains `readyNow`, `comingUp`, `waitingOnOthers`, `cardHints` and the existing `status` enum. Startable tasks, including capacity-queued work, are in `readyNow`; In progress and Later tasks are in `comingUp`; Waiting tasks are in `waitingOnOthers`. Every task and hint adds `readiness: {state, waitingFor, laterBecause, laterFrom, flags}`. States are `in_progress`, `can_start`, `waiting`, `later` and `done`; waiting reasons are `dependency`, `checkpoint` and `decision`; later reasons are `not_before`, `stage`, `backlog` or null. The member-safe result never exposes Now, Queued, capacity or ranks, even when its caller is a PM. A commitment name, ID or plan name is visible only if the reader can read a board covered by that commitment's plan; otherwise it is anonymous other work.

Workspace plan tools are `list_plans`, `upsert_plan`, `get_plan`, `list_ready_tasks`, `set_task_plan`, `link_tasks`, `unlink_tasks`, `upsert_milestone`, `upsert_module` and `take_baseline`. They require a current Admin or PM workspace role. Every Admin and PM can view every plan, with board content redacted to current read access. Only listed plan managers and Admins edit a plan and its commitments, baselines and task plan fields; any Admin or PM can create a plan and becomes its first manager. Managers must be active workspace PMs or Admins. The PM role retains explicit board permissions; inherited-only access grants read and plan writes within managed plans. Calendar changes are Admin-only and capacity changes are allowed for managers of any plan.

Resolve a named plan with `list_plans`, then pass its `planId` to the eight plan-scoped tools. Omit it to use the default plan. `upsert_plan` creates with `name`, updates with `planId` and the plan `expectedVersion`, or archives with `planId`, `archived=true`, `expectedVersion` and no edit fields. Optional metadata includes `description`, `color`, `position`, `boardScope`, `boards`, `managers` and `viewSettings`. The default plan always covers all boards and cannot be archived. Boards may belong to several plans. Read `get_plan` for task plan versions and the workspace-wide revision used by dependency and baseline writes, then use updated versions returned by successful writes.

Dependencies follow the dependent task: managers can link a readable task on their plan boards to a card, milestone or module in any active plan in the workspace. For card links, omit `blockerKind` or use `card`, and supply `blockerCardId`. For commitment links, use `blockerKind=milestone|module` and `blockerCommitmentId`; omit the unused blocker ID or set it to null. A commitment finishes when all its cards finish. Membership and dependency cycles return `PLAN_CYCLE`. Link and unlink results return the normalized kind and both nullable blocker IDs. `unlink_tasks` removes any kind by `dependencyId`. External commitment references include their title, plan and expected window without health or member-card details; unreadable blocker cards stay redacted. Card plan fields are stored once, and module and milestone references may come from any plan that includes the card's board. Forecasts and capacity are computed once per workspace, then sliced by plan, with one hop of external dependencies. Unreadable cards remain locked placeholders with forecast windows only. Baselines belong to one plan; daily snapshots remain workspace-wide. User-written plan names, titles, descriptions, keys, view settings and baseline names are untrusted data. Plan capability revision 2 remains unreleased until a reviewed client export and server rollout.

`get_my_plan` reads your next assigned work as `readyNow`, `comingUp` and `waitingOnOthers`, with expected windows, module and milestone purpose names and suggested personal Calendar dates. Hidden card blockers and commitments in unreadable plans remain anonymous; readable commitment blockers expose only their name, plan and expected window. The member-safe result never includes health, buffer, capacity or other people’s workload. All other plan tools require Admin or PM access. Plan capability revision 2 remains an unreleased source snapshot until a reviewed matching server and client release is published.

Commitment writes (`upsert_milestone`, `upsert_module`) accept an optional `reason` of up to 200 characters. The reason is stored with the workspace activity entry, together with the old and new date for date changes. Baseline names are trimmed and unique within their plan, ignoring ASCII case; a duplicate returns `PLAN_BASELINE_NAME`. Capacity updates accept 0.5 to 8 streams in increments of 0.5.

The authenticated UI can preview a date change with `POST /api/plan/milestones/:id/impact` or `/api/plan/modules/:id/impact`, using `{planId?, proposedDate, expectedVersion}`. A milestone date is required; a module date may be null. These previews require the same manager or Admin permission as an edit, persist nothing, and return commitment health and buffer before and after, plus affected cards grouped by plan. Affected cards include the commitment scope, downstream dependents and any changed forecast windows from workspace capacity levelling. Cards may appear in several covering plans. Unreadable cards expose only their opaque ID and forecast windows. Preview results are never retained as mutation replays. The active workspace people list at `GET /api/plan/people` supports capacity and manager selection for Admins and PMs. The MCP tool catalog remains unchanged.

Plan capability revision 2 adds eleven Plan tools to the unchanged live catalog, giving 38 hosted tools for either approved workspace mode. Native callers select `x-maddots-mcp-contract: 2` or `params._meta: {"maddots/contract":"2"}` on each relevant request. This bridge sends revision 1 in the header and lists main tools without metadata. It requests revision 2 only after the authenticated service signals Plan access for the selected workspace. The default server switch is off; disabled workspaces and members without Plan data retain the main catalog. Header-less catalogs remain 25/26 tools and revision 1 remains 27. Exact schema validation applies to all six supported catalogs, and discovery never changes the approved scope.

## Personal starred tasks capability

A service advertising `maddots/stars` supports `list_starred_tasks`, `star_task` and `unstar_task`. This source client automatically negotiates the advertised capability during authenticated discovery and preserves existing approvals. Older servers and clients retain their exact catalogs. Refresh host discovery to see newly available tools. These source changes do not publish or replace a signed client release.

Stars belong only to the authenticated account, including for admins. A broad connection lists stars across active workspaces when `workspaceId` is omitted; supply it to filter. Restricted connections stay in their approved workspace. Star writes use `taskId` and optional `workspaceId`, require approved `kanban:write` scope, and are available to board viewers with read access. Completed tasks stay visible; archived or unreadable tasks are hidden. Results contain compact summaries and untrusted user content.

`star_task` and `unstar_task` set personal state, with no shared task edits or version requirement. Optional `idempotencyKey` values are validated but never replay a stored result. Every retry rechecks access; repeated stars preserve their timestamp. The bridge does not automatically retry writes. Native HTTP clients opt in with `x-maddots-mcp-stars: 1` or `params._meta: {"maddots/stars":true}` alongside their existing contract revision.

## Plan agent capability

A service advertising `maddots/plan-agent` supports five additional tools: `list_tasks_by_plan_ref`, `add_dependency`, `remove_dependency`, `list_plan_stages` and `promote_stage`. The bridge sends `x-maddots-mcp-plan-agent: 1`, negotiates the advertised capability during authenticated discovery, and verifies the matching workspace catalog. Native clients can also opt in with `params._meta: {"maddots/plan-agent":true}`. Plan access is required, independently of the contract revision and personal stars. Existing approvals and catalogs stay unchanged when the service does not offer the capability. The client identity stays 0.6.3 and updates use signed commit releases.

`list_tasks_by_plan_ref` finds readable tasks by exact, case-sensitive import refs, scoped by the manifest source name when supplied. Omit `refs` to list every readable task with an active ref. Completed tasks are included by default; archived tasks require `includeArchived`. Refs never grant access. Under the opt-in, imported tasks in `list_tasks`, `get_task` and `get_board` also carry `planRefs: [{source,ref}]`, most recent import first. Participating tasks carry `plan` readiness and blockers when the service supports that output field. Tasks without active refs omit `planRefs`; tasks without applicable Plan data omit `plan`. Other tool results keep their existing shape.

`add_dependency` and `remove_dependency` set up to 100 links in one transaction, using task IDs or import refs and optional `source`. Existing links return `created:false`; missing links return `deleted:false`. Supply `expectedPlanVersion` only when requiring an unchanged plan revision. Admins and listed plan managers can write links with read access to the blocked tasks.

`list_plan_stages` reads stage status, counts and promotion availability. Admins and PMs can read stages and preview `promote_stage` with `dryRun:true`; applying needs an Admin or a manager of the stage's plan. Review the preview, then apply with `dryRun:false`, its `previewHash` as `expectedPreviewHash`, and an `idempotencyKey`. A stale preview requires a fresh review. Human-placed tasks need an explicit manager choice. The bridge never retries automatically; automatic mode, opening stages early, parking and undo stay in the app.
