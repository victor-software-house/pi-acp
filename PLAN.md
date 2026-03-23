# PLAN

Address all gaps identified in `GAPS.md` and `docs/engineering/claude-acp-comparison.md`.
Supersedes the previous refactor plan (phases 1-7, completed in v0.2.0).

Tracking checklist: `TODO.md`.

---

## Context

v0.2.0 shipped multi-session support, structured replay, usage tracking, error
hardening, and UX polish. What remains is primarily **tool output quality** --
the reason bash output does not render properly in Zed -- plus conformance
improvements from the reference implementation comparison.

The issues fall into three tiers:

1. **Critical** -- tool output is invisible/collapsed in Zed (phases 1-2)
2. **High** -- missing metadata, kind/title gaps, no capability detection (phases 3-5)
3. **Medium** -- test coverage, MCP wiring, optional features (phases 6-8)

---

## Phase 1: Per-tool output formatting

**Goal:** make tool results render correctly in Zed.

**Root cause:** `toolResultToText()` is tool-agnostic. It concatenates raw text
from pi's result objects. Zed expects formatted content: `` ```console `` code
fences for bash, markdown-escaped text for read, code fences for errors.

### Changes

#### 1.1 New module: `src/acp/translate/tool-content.ts`

Replace `toolResultToText()` with a per-tool content formatter:

```ts
export function formatToolContent(
  toolName: string,
  result: unknown,
  isError: boolean,
): ToolCallContent[];
```

Dispatches by tool name:

| Tool | Formatting |
|------|-----------|
| `bash` | Extract stdout/stderr from result. Wrap in `` ```console\n{output}\n``` ``. On non-zero exit code, append `exit code: N`. On error, wrap in `` ```\n{text}\n``` `` with `status: "failed"`. |
| `read` | Apply `markdownEscape()` to each text block. Preserve image content blocks unchanged. |
| `edit` | Return empty (diff content is handled separately in `handleToolEnd`). |
| `write` | Return empty (diff content is handled separately in `handleToolEnd`). |
| `lsp` | Wrap in `` ```\n{text}\n``` `` (structured output). |
| `tmux` | Wrap in `` ```console\n{text}\n``` `` (terminal-like output). |
| All others | Plain text content block. |
| Errors (any) | Wrap error text in `` ```\n{text}\n``` ``. |

#### 1.2 `markdownEscape()`

Add to `tool-content.ts`. Escapes characters that would be interpreted as
markdown when displaying file content:

- `#` at line start (headings)
- `[` / `]` (links)
- `` ` `` sequences (code spans/fences)
- `<` (HTML tags)
- `---` / `***` / `___` (horizontal rules)

Reference: claude-agent-acp `markdownEscape()` in `tools.ts`.

#### 1.3 Update `handleToolEnd()` in `session.ts`

Replace the current generic path:

```ts
// Before:
const text = toolResultToText(result);
content = [{ type: "content", content: { type: "text", text } }];

// After:
content = formatToolContent(toolName, result, isError);
```

The diff path for edit/write stays unchanged (it already produces correct
`{ type: "diff" }` content). `formatToolContent` returns empty for edit/write
so the existing diff logic takes precedence.

#### 1.4 Update `handleToolUpdate()` in `session.ts`

Streaming bash updates should also be formatted:

```ts
// Before:
content: text ? [{ type: "content", content: { type: "text", text } }] : null

// After (for bash):
content: text ? [{ type: "content", content: { type: "text", text: wrapConsole(text) } }] : null
```

The tool name is not currently available in `handleToolUpdate`. Either:

- (a) Pass `toolName` through the pi event (it is available on `tool_execution_update`), or
- (b) Track `toolCallId -> toolName` in a map populated by `handleToolStart`

Option (b) is cleaner since `handleToolStart` already runs first.

#### 1.5 Update replay path in `agent.ts`

`replaySessionHistory()` replays tool results. Apply the same formatting:

```ts
// Use formatToolContent for replayed tool results instead of raw text
```

#### 1.6 Remove `toolResultToText()` from `pi-tools.ts`

After all callers migrate to `formatToolContent`, delete the generic function.
Keep `pi-tools.ts` for any remaining pi-specific translation utilities, or
remove the file entirely if empty.

### Tests

- Bash output: normal (stdout with `` ```console ``), error (code fence + failed status), empty
- Read output: plain text, file containing markdown syntax (headings, code fences, links)
- Error output: all tool types (verify code fence wrapping)
- Streaming bash: verify `handleToolUpdate` formats partial output
- Replay: verify replayed tool results match live formatting

### Acceptance criteria

- Bash tool output renders as a code block in Zed
- Read tool output does not render file content as markdown
- Error output is visually distinct from normal output
- Streaming updates render progressively in Zed

---

## Phase 2: Terminal content lifecycle

**Goal:** emit ACP terminal metadata when the client supports it, with the
`` ```console `` fallback from Phase 1 as the default.

### Prerequisites

- Phase 1 completed (`` ```console `` fallback exists)

### Changes

#### 2.1 Store `clientCapabilities` on `PiAcpAgent`

In `initialize()`, store `request.clientCapabilities` as an instance field.

#### 2.2 Detect terminal output support

```ts
private supportsTerminalOutput(): boolean {
  return this.clientCapabilities?._meta?.["terminal_output"] === true;
}
```

Pass this flag to `PiAcpSession` on construction via `PiAcpSessionOpts`.

#### 2.3 Terminal lifecycle in `PiAcpSession`

When `supportsTerminalOutput` is true and tool is `bash`:

**`handleToolStart`:**

```ts
// Add to tool_call emission:
content: [{ type: "terminal", terminalId: toolCallId }],
_meta: { terminal_info: { terminal_id: toolCallId } }
```

**`handleToolUpdate`:**

```ts
// Emit terminal_output instead of text content:
_meta: { terminal_output: { terminal_id: toolCallId, data: text } }
```

**`handleToolEnd`:**

```ts
// Emit terminal_exit:
_meta: { terminal_exit: { terminal_id: toolCallId, exit_code: exitCode, signal: null } }
```

When `supportsTerminalOutput` is false, use the Phase 1 `` ```console `` fallback.

#### 2.4 Extract exit code from pi bash results

Pi bash results include exit code in `details.exitCode` or top-level
`exitCode`. `formatToolContent` already extracts this (Phase 1). For terminal
lifecycle, extract and pass to `terminal_exit`.

### Tests

- Terminal lifecycle: info -> output -> exit sequence
- Fallback: verify `` ```console `` content when terminal not supported
- Mixed sessions: one with terminal support, one without

### Acceptance criteria

- Zed receives terminal_info/output/exit for bash when it advertises support
- Zed falls back to code block rendering when it does not

---

## Phase 3: Tool call `_meta` and tool kind/title gaps

**Goal:** match the reference implementations for tool metadata.

### Changes

#### 3.1 Add `_meta` to all tool call emissions

Every `tool_call` and `tool_call_update` emission should include:

```ts
_meta: { piAcp: { toolName: actualToolName } }
```

Affected methods in `session.ts`:

- `handleMessageUpdate` (toolcall streaming)
- `handleToolStart`
- `handleToolUpdate`
- `handleToolEnd`

And in `agent.ts`:

- `replaySessionHistory` (replayed tool calls and results)

#### 3.2 Fix tool kind gaps (from GAPS.md)

In `toToolKind()`:

```ts
case "lsp": return "search";
case "tmux": return "execute";
```

#### 3.3 Fix tool title gaps (from GAPS.md)

In `buildToolTitle()`, add cases:

**`lsp`:**
```ts
case "lsp": {
  const action = args["action"];
  const file = args["file"];
  const query = args["query"];
  if (typeof action === "string") {
    if (typeof file === "string") return truncateTitle(`${capitalize(action)} ${file}`);
    if (typeof query === "string") return truncateTitle(`${capitalize(action)} ${query}`);
    return capitalize(action);
  }
  return "LSP";
}
```

**`tmux`:**
```ts
case "tmux": {
  const action = args["action"];
  const command = args["command"];
  const name = args["name"];
  if (typeof action === "string") {
    if (action === "run" && typeof command === "string")
      return truncateTitle(`Tmux: ${command}`);
    if (typeof name === "string")
      return truncateTitle(`Tmux ${action} ${name}`);
    return `Tmux ${action}`;
  }
  return "Tmux";
}
```

**`context_tag`:**
```ts
case "context_tag": {
  const name = args["name"];
  return typeof name === "string" ? `Tag ${name}` : "Tag";
}
```

**`context_log`:**
```ts
case "context_log": return "Context log";
```

**`context_checkout`:**
```ts
case "context_checkout": {
  const target = args["target"];
  return typeof target === "string" ? truncateTitle(`Checkout ${target}`) : "Checkout";
}
```

**`claudemon`:**
```ts
case "claudemon": return "Check quota";
```

### Tests

- `_meta.piAcp.toolName` present on all tool_call and tool_call_update events
- `lsp` kind is `search`, title is descriptive
- `tmux` kind is `execute`, title is descriptive
- Context tools have descriptive titles

### Acceptance criteria

- Zed receives tool name metadata for potential UI differentiation
- All pi tools produce meaningful titles and kinds

---

## Phase 4: Client capabilities

**Goal:** detect and use client capabilities for feature toggling.

### Changes

#### 4.1 Typed capabilities interface

```ts
interface ClientCapabilityFlags {
  terminalOutput: boolean;
  terminalAuth: boolean;
  gatewayAuth: boolean;
}

function parseClientCapabilities(caps: ClientCapabilities | undefined): ClientCapabilityFlags;
```

#### 4.2 Wire through to sessions

`PiAcpAgent.initialize()` stores parsed capabilities. Passes relevant flags to
each `PiAcpSession` via `PiAcpSessionOpts`.

#### 4.3 Auth method selection

In `initialize()`, tailor `authMethods` based on client capabilities:

- If `terminalAuth` or `_meta.terminal-auth`: offer terminal-based auth
- If `gatewayAuth`: offer gateway auth (if pi supports it in future)

Currently pi-acp returns a fixed set of auth methods. This phase makes it
capability-aware.

### Tests

- Capabilities parsed correctly from various client configs
- Terminal output flag propagated to sessions
- Auth methods vary based on capabilities

### Acceptance criteria

- Feature flags derived from `clientCapabilities` are available to all sessions
- Auth method list adapts to client capabilities

---

## Phase 5: Streaming bash output formatting

**Goal:** make incremental bash output readable during execution.

### Prerequisites

- Phase 1 completed (`formatToolContent` exists)
- Phase 2 completed (terminal lifecycle available)

### Changes

#### 5.1 Track toolName per toolCallId

Add a `Map<string, string>` in `PiAcpSession` to track `toolCallId -> toolName`.
Populated in `handleToolStart`, cleaned up in `handleToolEnd`.

#### 5.2 Format streaming updates

In `handleToolUpdate`, look up the tool name:

- If `bash` and terminal not supported: wrap in `` ```console ``
- If `bash` and terminal supported: emit `_meta.terminal_output`
- If other tool: emit plain text content

Each streaming update from pi replaces the previous content (rolling tail
buffer), so each update must be self-contained. The code fence wrapping must
be applied to each update independently.

### Tests

- Streaming bash output with `` ```console `` wrapping
- Streaming bash output with terminal_output metadata
- Non-bash streaming updates remain plain text

### Acceptance criteria

- Bash output is readable during execution, not just after completion
- Terminal-aware clients see streaming terminal output

---

## Phase 6: Protocol test coverage

**Goal:** cover the remaining untested ACP methods.

### Approach

The remaining methods (`session/prompt`, `setSessionConfigOption`,
`setSessionMode`, `unstable_setSessionModel`) require an active session with
a functioning `AgentSession`. Two options:

1. **Deep fakes**: extend `FakeAgentSession` to support `prompt()`, `setModel()`,
   `setThinkingLevel()`, and event emission. Tests exercise the full adapter flow.

2. **Integration tests**: use real `createAgentSession()` with a mock provider.
   More realistic but slower and requires provider configuration.

Recommendation: option 1 (deep fakes) for unit/component tests. Add one
integration smoke test with a real provider as a separate test suite.

### Tests to add

- `session/prompt`: submit a message, verify streaming events, verify response shape
- `setSessionConfigOption`: change model, verify `config_option_update` emission
- `setSessionMode`: change thinking level, verify `current_mode_update` emission
- `unstable_setSessionModel`: change model, verify update emission
- `available_commands_update`: verify emission after session creation
- `config_option_update`: verify emission on config changes

### Acceptance criteria

- All ACP RPC methods have at least one test
- Notification emissions have dedicated tests

---

## Phase 7: MCP server wiring

**Goal:** wire `mcpServers` from ACP session params through to pi.

### Status

Blocked on pi SDK. `createAgentSession()` does not accept per-session
`mcpServers`. Monitor upstream for:

- New `mcpServers` option on `createAgentSession()`
- Or a `session.addMcpServer()` post-creation API

### When unblocked

- Pass `mcpServers` from `NewSessionRequest` / `LoadSessionRequest` to
  `createAgentSession()`
- Validate server config format against pi's expectations
- Test with at least one MCP server (e.g. filesystem)

---

## Phase 8: Optional ACP features

Low priority. Implement when upstream support exists or a client needs them.

### 8.1 `session/request_permission`

Requires pi to expose a tool permission hook. Current state: pi handles
permissions internally via its extension system.

### 8.2 `agent_plan` updates

Requires pi to expose a planning/TODO surface. Current state: pi has no
equivalent concept.

### 8.3 Filesystem delegation (`readTextFile` / `writeTextFile`)

Would allow Zed to serve unsaved editor buffer contents. Requires pi to route
file reads/writes through a pluggable backend instead of direct disk I/O.

### 8.4 Terminal delegation

Would allow Zed to host terminal sessions. Requires pi to delegate terminal
creation to an external provider.

---

## Implementation order

```
Phase 1 ──> Phase 2 ──> Phase 5
   │                       │
   └──> Phase 3            │
          │                │
          └──> Phase 4     │
                           │
Phase 6 (parallel) ────────┘
Phase 7 (when unblocked)
Phase 8 (when needed)
```

- **Phase 1** first: unblocks the primary UX issue (bash output not rendering)
- **Phase 2** after Phase 1: builds on the fallback formatting
- **Phase 3** can start after Phase 1 (independent)
- **Phase 4** after Phase 2 (uses capabilities for terminal detection)
- **Phase 5** after Phase 1 + 2: streaming formatting uses both code fences and terminal lifecycle
- **Phase 6** can run in parallel at any point
- **Phase 7** blocked on upstream
- **Phase 8** deferred

Estimated scope: phases 1-5 are the substantive work (~500-700 lines of
production code + tests). Phase 6 is test-only. Phases 7-8 are blocked/deferred.

---

## Files affected

| File | Phases | Changes |
|------|--------|---------|
| `src/acp/translate/tool-content.ts` | 1 | **New file.** Per-tool content formatting, `markdownEscape()`. |
| `src/acp/session.ts` | 1, 2, 3, 5 | Use `formatToolContent`, track toolName per callId, add `_meta`, terminal lifecycle, streaming formatting. |
| `src/acp/agent.ts` | 2, 3, 4 | Store `clientCapabilities`, pass to sessions, replay formatting, auth method selection. |
| `src/acp/translate/pi-tools.ts` | 1 | Remove `toolResultToText()` after migration. |
| `test/component/session-diff.test.ts` | 1 | Update expected content format. |
| `test/component/session-replay.test.ts` | 1, 3 | Update expected content format, verify `_meta`. |
| `test/component/session-events.test.ts` | 1, 2, 5 | New tests for bash formatting, terminal lifecycle, streaming. |
| `test/unit/tool-content.test.ts` | 1 | **New file.** Tests for `formatToolContent`, `markdownEscape`. |
| `test/unit/tool-titles.test.ts` | 3 | Add tests for lsp, tmux, context tools. |
| `test/unit/protocol-surface.test.ts` | 6 | Add prompt, config, mode tests. |
| `test/helpers/fakes.ts` | 6 | Extend `FakeAgentSession` for prompt/config flows. |
