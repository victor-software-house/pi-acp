# Roadmap

## P0 -- Ship

- [x] Publish to npm as `@victor-software-house/pi-acp`
- [ ] Verify `npx @victor-software-house/pi-acp` works with Zed
- [x] Fix README Limitations section (see TODO.md)

## P1 -- Protocol Test Coverage

- [ ] Protocol-level tests: send JSON-RPC, validate response shapes
- [ ] Cover `initialize`, `session/new`, `session/load`, `session/prompt`, `session/list`
- [ ] Cover `setSessionConfigOption`, `setSessionMode`, `unstable_setSessionModel`
- [ ] Cover `available_commands_update` and `config_option_update` emissions

## P2 -- MCP Server Wiring

- [ ] Wire `mcpServers` from `session/new` and `session/load` through to `createAgentSession()`
- [ ] Test with at least one MCP server (e.g. filesystem)
- [ ] This is the main remaining MUST-level ACP compliance gap

## P3 -- Optional ACP Features

- [ ] `session/request_permission` -- hook into pi extension system
- [ ] `session_info_update` -- automatic emission for metadata changes beyond `/name`
- [ ] `agent_plan` updates
- [ ] ACP filesystem/terminal delegation (if clients need it)
