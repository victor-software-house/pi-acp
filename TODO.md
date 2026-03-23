# TODO

Open issues, gaps, and known problems. Checked items are resolved.

## ACP Protocol Conformance

### MCP Server Wiring (MUST)

- [ ] `session/new` and `session/load` accept `mcpServers` but do not connect to them
- [ ] ACP spec: agents MUST connect to all provided MCP servers (stdio transport mandatory)
- [ ] pi-mono supports MCP via `AgentSessionConfig.mcpServers` — needs wiring through `createAgentSession()`

### session/request_permission (SHOULD)

- [ ] Not implemented — pi executes tools without requesting client permission
- [ ] ACP spec: agents SHOULD request permission before tool execution when client supports it
- [ ] pi-mono has extension hooks (`permission-gate.ts` example) that could be used

### config_option_update Notification (SHOULD)

- [x] `setSessionConfigOption` returns updated `configOptions`
- [x] `setSessionMode` emits `config_option_update` via `emitConfigOptionUpdate()`
- [x] `unstable_setSessionModel` emits `config_option_update` via `emitConfigOptionUpdate()`

### session_info_update Notification (MAY)

- [x] Emitted by `/name` command (pushes title + updatedAt to client)
- [ ] Not emitted automatically for other metadata changes (message count, etc.)
- [ ] ACP spec: agents MAY push `session_info_update` to keep session titles in sync

### Filesystem Delegation (Client Capability)

- [ ] `fs/read_text_file` and `fs/write_text_file` not implemented
- [ ] pi reads/writes locally — no delegation to client
- [ ] Not advertised in agentCapabilities (correct behavior)

### Terminal Delegation (Client Capability)

- [ ] `terminal/*` methods not implemented
- [ ] pi executes commands locally — no delegation to client
- [ ] Not advertised in agentCapabilities (correct behavior)

### Agent Plan Updates (MAY)

- [ ] `agent_plan` session update type not emitted
- [ ] ACP spec: agents MAY send plan updates to describe their approach before executing

## Test Coverage

### Protocol Surface (zero coverage)

- [ ] No test for `initialize` request/response shape
- [ ] No test for `authenticate` request/response
- [ ] No test for `session/new` response (sessionId, configOptions, modes, models, commands)
- [ ] No test for `session/load` response with history replay
- [ ] No test for `session/list` response shape (sessions array, pagination)
- [ ] No test for `session/prompt` response shape (stopReason)
- [ ] No test for `setSessionConfigOption` behavior and response
- [ ] No test for `setSessionMode` behavior and response
- [ ] No test for `unstable_setSessionModel` behavior and response
- [ ] No test for `available_commands_update` emission after session creation
- [ ] No test for `config_option_update` emission after config change

### Translation Layer (covered)

- [x] pi message text extraction (pi-messages)
- [x] pi tool result text extraction (pi-tools)
- [x] ACP ContentBlock to pi message conversion (prompt)
- [x] pi stop reason to ACP stop reason mapping
- [x] pi event to ACP session/update translation (text, thinking, tools)
- [x] edit tool diff emission
- [x] tool call locations
- [x] startup info
- [x] cursor validation on session/list

### Integration (zero coverage)

- [ ] No end-to-end test: JSON-RPC stdin -> stdout with real protocol exchange
- [ ] No test for terminal auth (`--terminal-login`) behavior
- [ ] No test with actual pi AgentSession (all tests use FakeAgentSession)

## Documentation

- [x] ROADMAP.md with priorities and milestones
- [ ] No conformance matrix documenting which ACP spec requirements are met
- [x] README "Limitations" section covers all known gaps
- [ ] No `docs/engineering/` notes carried over from old repo (compliance plan, reference findings)
