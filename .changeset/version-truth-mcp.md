---
"@membook/mcp": patch
---

`SERVER_VERSION` reads package.json at runtime instead of a hardcoded string,
so the version the MCP server reports to clients tracks the release. Same
drift class as the CLI's `--version` bug; same guard test.
