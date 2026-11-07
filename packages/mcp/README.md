<p><img src="https://raw.githubusercontent.com/Tamloot-cc/Retainer/main/packages/web/public/favicon.svg" alt="Retainer logo" width="80" height="80" /></p>

# @retainer/mcp

stdio bridge to a [Retainer](https://github.com/Tamloot-cc/Retainer) server's
MCP endpoint, for MCP clients that start servers as local processes. It
relays messages unchanged between stdin/stdout and the server's `/mcp`
endpoint; the tools are defined on the server.

```json
{
  "mcpServers": {
    "retainer": {
      "command": "npx",
      "args": ["-y", "@retainer/mcp"],
      "env": {
        "RETAINER_URL": "https://retainer.example",
        "RETAINER_API_KEY": "rtn_…"
      }
    }
  }
}
```

| Variable           | Value                                                            |
| ------------------ | ---------------------------------------------------------------- |
| `RETAINER_URL`     | The server's base URL. `/mcp` is added if missing.               |
| `RETAINER_API_KEY` | An API key for one workspace; it decides who writes are made as. |

Clients that support Streamable HTTP can skip the bridge and connect to
`https://<host>/mcp` directly. See
[Connecting agents](https://github.com/Tamloot-cc/Retainer/blob/main/docs/agents.md).

MIT licensed.
