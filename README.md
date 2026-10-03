# IBL Projects MCP client

Connect an MCP host to the authenticated IBL Projects Kanban service through a local stdio bridge. Project operations run on the hosted application and retain the permissions of the user who issued the token. Sharing and membership administration are excluded.

This client requires an MCP-enabled IBL Projects server and a user-issued token. The default endpoint is `https://pm.ibl.ro/mcp`; availability depends on the operator's server deployment. Publishing or installing this client does not deploy or enable the hosted service. The application server, database, private implementation and deployment configuration are not part of this client.

Follow [the installation guide](docs/install.md). Installation uses a source checkout, Node.js and `npm ci`; the package is not published to npm. Run `node dist/cli.js --setup` to verify authentication and the shared tool contract without invoking any tool.

```sh
git clone https://github.com/sergiuliano/ibl-projects-mcp.git
cd ibl-projects-mcp
npm ci
npm run build
```

Configure your token before running the setup check. See the guide for a token-file example and MCP host configuration.

Credentials are supplied by `PM_MCP_TOKEN` or `PM_MCP_TOKEN_FILE`. Keep them outside the checkout. The client never enrolls anonymously, automatically retries failed operations, or updates itself. If a mutation's response is lost, inspect the project state before repeating it.

For development, run `npm test` and `npm run pack:check`. Tests use an isolated local service with a synthetic token. The reusable client is available under the [MIT License](LICENSE). `private: true` in the package metadata prevents accidental npm publication; it does not restrict use under that license. Access to a hosted PM service remains subject to that service's account and project permissions.
