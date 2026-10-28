# MPGR skills v2

Agent skills in the [Binance Skills Hub](https://github.com/binance/binance-skills-hub) shape: one folder, one `SKILL.md`, YAML frontmatter with `metadata.version` `2.0`.

These skills do not add a second swap engine, a signer, or a new MCP server. They tell an agent how to use the MCP tools that already answer at `POST /api/mcp`.

| Skill | Use when |
| --- | --- |
| [mpgr-mcp](./mpgr/mpgr-mcp/SKILL.md) | Connecting a client and discovering tools |
| [paigerswap](./mpgr/paigerswap/SKILL.md) | Quoting or preparing a buy or sell |
| [mpgr-agent](./mpgr/mpgr-agent/SKILL.md) | Talking to the in-app agent, including the mic |

A skill invocation is not a wallet signature. The user's wallet still confirms every trade.
