# ACP Conformance Notes

Status of ACP protocol coverage in `pi-acp` as of this refactor.

## Implemented

### Session lifecycle

| Method | Status | Notes |
|---|---|---|
| `initialize` | Implemented | Advertises all supported capabilities |
| `session/new` | Implemented | Creates pi `AgentSession` via `createAgentSession()` |
| `session/load` | Implemented | Replays structured history with text, thinking, and tool calls |
| `session/list` | Implemented | Pagination via cursor, title fallback from first message |
| `session/prompt` | Implemented | Returns `usage` with token counts |
| `session/cancel` | Implemented | Calls `AgentSession.abort()` |
| `unstable_closeSession` | Implemented | Disposes targeted session only |
| `unstable_resumeSession` | Implemented | Reuses live session or reloads from disk |
| `unstable_forkSession` | Implemented | Uses `SessionManager.forkFrom()` |

### Configuration

| Method | Status | Notes |
|---|---|---|
| `setSessionMode` | Implemented | Maps to `AgentSession.setThinkingLevel()` |
| `setSessionConfigOption` | Implemented | Supports `model` and `thought_level` options |
| `unstable_setSessionModel` | Implemented | Maps to `AgentSession.setModel()` |

### Session updates (agent -> client)

| Update type | Status | Notes |
|---|---|---|
| `agent_message_chunk` | Implemented | Live streaming and replay |
| `agent_thought_chunk` | Implemented | Live streaming and replay |
| `tool_call` | Implemented | Descriptive titles, kind mapping, locations, rawInput |
| `tool_call_update` | Implemented | Progress, completion, diff content for edit/write |
| `user_message_chunk` | Implemented | Replay path only |
| `usage_update` | Implemented | Emitted on agent turn completion |
| `available_commands_update` | Implemented | Sent after session creation |
| `config_option_update` | Implemented | Emitted on model/thinking level changes |
| `current_mode_update` | Implemented | Emitted on thinking level changes |
| `session_info_update` | Implemented | Via `/name` command |

### Capabilities advertised

- `loadSession: true`
- `sessionCapabilities.list`
- `sessionCapabilities.close`
- `sessionCapabilities.resume`
- `sessionCapabilities.fork`
- `promptCapabilities.image: true`
- `promptCapabilities.embeddedContext: true`

### Error handling

- Auth-related errors detected via pattern matching and surfaced as `authRequired`
- Invalid session IDs produce `invalidParams` consistently across all methods
- `cwd` validation rejects non-absolute paths

## Not implemented (intentional)

These are excluded from this refactor for architectural reasons documented in `PLAN.md`.

| Feature | Reason |
|---|---|
| `session/request_permission` | pi owns tool execution and approval internally |
| ACP `plan` updates | pi has no equivalent planning surface |
| `readTextFile` / `writeTextFile` delegation | pi operates on disk directly |
| `terminal/create` and related methods | pi executes commands locally |
| Per-session MCP server wiring | pi SDK does not expose this in `createAgentSession()` |
| Terminal-style `_meta` extensions | No ACP client currently consumes these |

## Upstream limitations

These require changes to the pi SDK before they can be implemented:

1. **MCP server wiring**: `createAgentSession()` does not accept per-session `mcpServers`
2. **Permission bridge**: No hook for ACP-style tool permission gates
3. **Plan surface**: No `TodoWrite`-style planning API
4. **Client-delegated FS/terminal**: pi's architecture assumes local execution
