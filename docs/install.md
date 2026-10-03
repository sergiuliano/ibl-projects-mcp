# Install the IBL Projects MCP client

Requirements: Node.js 22.22.1 or later in the Node 22 or 24 series, npm, Git, and access to an IBL Projects account permitted to use Kanban on an MCP-enabled server. The hosted server must be deployed and enabled separately. These client installation steps do not establish that the default endpoint is already available.

1. Clone [sergiuliano/ibl-projects-mcp](https://github.com/sergiuliano/ibl-projects-mcp) into a stable local directory.
2. Run `npm ci` and then `npm run build` in that directory.
3. Create a user-scoped MCP token in the IBL Projects interface. Its permissions follow your account and board access. Store it outside the checkout.
4. Set either `PM_MCP_TOKEN` or `PM_MCP_TOKEN_FILE` in the environment used to launch the client. Do not set both.
5. Run `node dist/cli.js --setup` with that environment. Success confirms authentication and matching tool names and schemas. Setup never calls a business tool.
6. Configure your MCP host to run `node` with the absolute path to `dist/cli.js`, without `--setup`.

```sh
git clone https://github.com/sergiuliano/ibl-projects-mcp.git
cd ibl-projects-mcp
npm ci
npm run build
```

Once the server operator has enabled MCP access and you have configured your token, verify the connection:

```sh
node dist/cli.js --setup
```

A POSIX token file must be a regular file, owned by the current user, with permissions `0600`. The file itself must not be a symlink. `PM_MCP_TOKEN_FILE` must be an absolute path. Protect its containing directory and backups. On systems without POSIX ownership and no-follow checks, supply `PM_MCP_TOKEN` through the host's supported secret environment mechanism.

An example host configuration using a token file:

```json
{
  "mcpServers": {
    "ibl-projects": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/ibl-projects-mcp/dist/cli.js"],
      "env": {
        "PM_MCP_TOKEN_FILE": "/ABSOLUTE/PRIVATE/PATH/pm-mcp-token"
      }
    }
  }
}
```

Replace the paths with your own. Do not put the token value in command-line arguments or commit a host configuration containing it. Revoke a token in IBL Projects when it is no longer needed. The bridge does not copy or persist a supplied token.

## Endpoint and local development

`PM_MCP_URL` defaults to `https://pm.ibl.ro/mcp`. Overrides require HTTPS, with no username, password, query, or fragment. The client refuses redirects so credentials cannot follow a redirected request.

An explicit local development endpoint such as `http://127.0.0.1:PORT/mcp` also requires `PM_MCP_ALLOW_INSECURE_LOOPBACK=1`. HTTP to remote hosts remains rejected. Use synthetic credentials and an isolated database for development.

## Updates and failures

Update this checkout from its reviewed release, run `npm ci` and `npm run build`, rerun `--setup`, then restart the MCP connection. Version 0.1 does not update itself. A mismatched tool contract fails setup before any operation is submitted.

The bridge preserves hosted tool results. Connection failures are reported without printing credentials or raw server error pages. Failed mutations are not retried automatically because their outcome can be unknown. Inspect existing project state before repeating a change. Sharing and membership operations are not exposed.

## Data flow

The client sends tool names, arguments and its user bearer token to the configured endpoint over HTTPS. Returned project data is passed to your MCP host. The bridge does not create a local project cache or activity log. Your MCP host may retain conversation or tool history according to its own configuration.

## License and distribution

This reusable client is licensed under [MIT](../LICENSE). It is installed from its public GitHub source repository. npm publication and hosted server deployment are separate actions and are not performed by these instructions.
