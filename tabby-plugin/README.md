# tabby-serial-mcp (Tabby plugin)

This directory **is** the Tabby plugin package. Tabby loads user plugins with
`require()` from `<userData>/plugins/node_modules/<name>`, so there is no build
step: copy this folder there (keeping the name `tabby-serial-mcp`) and restart
Tabby.

See the [repository README](../README.md) for installation, tools and the MCP
endpoint.

- Entry point: `index.js` — NgModule (Angular metadata applied by hand) that
  registers the settings page and boots the bridge from `APP_INITIALIZER`.
- MCP endpoint: `http://127.0.0.1:3002/mcp` (streamable HTTP, JSON responses).
- Config: `<userData>/serial-mcp.json`; log: `<userData>/serial-mcp.log`.
