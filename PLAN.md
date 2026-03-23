# PLAN

Address all gaps identified in `GAPS.md` and `docs/engineering/claude-acp-comparison.md`.
Supersedes the previous refactor plan (phases 1-7, completed in v0.2.0).

Tracking checklist: `TODO.md`.

Reference implementations (patterns to follow):

- `zed-industries/claude-agent-acp` (TypeScript, Claude Code SDK)
- `zed-industries/codex-acp` (Rust, Codex protocol)

---

## Context

v0.2.0 shipped multi-session support, structured replay, usage tracking, error
hardening, and UX polish. v0.3.0 closed the main tool-output and conformance
gaps. What remains is mostly **cleanup and ownership tightening**:

- remove non-reference UX accretions (startup banner, runtime update notice)
- keep local ACP-only command handlers where pi's `AgentSession` does not offer
  an equivalent surface
- continue correctness and protocol parity work from the reference comparison

The issues fall into three tiers:

1. **Critical** -- tool output is invisible/collapsed in Zed (phases 1-2)
2. **High** -- missing metadata, kind/title gaps, no capability detection (phases 3-5)
3. **Medium** -- cleanup, test coverage, MCP wiring, optional features (phases 6A-8)

---

## Patterns from reference implementations

Both `claude-agent-acp` and `codex-acp` follow consistent patterns that pi-acp
should adopt. These patterns inform every phase below.

### Pattern: per-tool content dispatching

Both implementations dispatch tool result formatting by tool name. There is no
generic "convert result to text" function. Each tool type produces content
appropriate for its output:

- **Shell commands**: code-fenced output (`` ```console `` in claude-acp,
  `` ```sh `` in codex-acp with file-extension awareness)
- **File reads**: markdown-escaped text (claude-acp `markdownEscape()`)
- **File edits**: `{ type: "diff" }` content with `oldText`/`newText`
- **Errors**: code-fenced error text (`` ```\n{error}\n``` ``)

### Pattern: accumulated output buffer for streaming

codex-acp maintains per-command accumulated output (`active_command.output`).
Each streaming delta appends to the buffer. Each `tool_call_update` sends the
**full accumulated buffer** wrapped in a code fence, not just the delta.

This means each streaming update is self-contained -- the client can replace
the previous content entirely. codex-acp also varies the code fence language
by file extension:

```rust
match active_command.file_extension.as_deref() {
    Some("md") => active_command.output.clone(),  // raw markdown
    Some(ext)  => format!("```{ext}\n{}\n```\n", output),  // language-specific
    None       => format!("```sh\n{}\n```\n", output),     // shell default
}
```

pi already has this buffer pattern (pi's bash tool uses a rolling tail buffer
via `onUpdate`), but the content is sent as raw text. The fix is wrapping.

### Pattern: terminal lifecycle is opt-in per command

Both implementations gate terminal metadata on two conditions:

1. The client advertises `_meta.terminal_output === true`
2. The specific command is classified as producing terminal output

codex-acp uses `parse_command_tool_call()` to determine per-command whether
output is terminal-style (unknown/general commands -> terminal, read/search
commands -> not terminal). claude-acp checks this globally for Bash tools.

When terminal output is NOT supported, **both fall back to code-fenced content**
-- never raw text.

### Pattern: `_meta` on every tool emission

claude-agent-acp includes `_meta.claudeCode.toolName` on every `tool_call` and
`tool_call_update`. This is used for UI-side tool identification.

codex-acp includes `_meta` selectively (terminal_info, terminal_output,
terminal_exit) but does not include a generic tool name field.

pi-acp should include `_meta.piAcp.toolName` for consistency with claude-acp.

### Pattern: tool_call status lifecycle

Both implementations follow:

1. `tool_call` with `status: "pending"` (streaming tool_use start / permission request)
2. `tool_call_update` with `status: "in_progress"` (execution started)
3. `tool_call_update` with `status: "completed"` or `"failed"` (execution finished)

pi-acp currently emits `tool_call` with `status: "pending"` during streaming,
then `tool_call` with `status: "in_progress"` at execution start (if not
already emitted), then `tool_call_update` with `status: "completed"/"failed"`.
This is functionally correct.

### Pattern: cwd in terminal_info

codex-acp includes `cwd` in `_meta.terminal_info`:

```json
{ "terminal_id": "...", "cwd": "/path/to/project" }
```

claude-acp does not include `cwd`. pi-acp should follow codex-acp here since
the cwd is available.

### Pattern: completed tool_call on replay (codex-acp)

codex-acp has a `send_completed_tool_call()` helper that emits a `tool_call`
with `status: "completed"` directly (no separate tool_call + tool_call_update).
This is used for replay of historical tool calls.

claude-agent-acp replays tool calls through the same `toAcpNotifications()`
function with `registerHooks: false`, which emits `tool_call` then
`tool_call_update` for results.

pi-acp's replay path emits tool_call + tool_call_update, which is correct.

### Pattern: model alias resolution (claude-agent-acp)

claude-agent-acp resolves model aliases ("opus", "sonnet") to full model IDs
via tokenized matching (`resolveModelPreference()`). This allows users to type
friendly names in config options.

pi-acp currently requires exact model IDs. This is a nice-to-have for UX.

### Pattern: resource_link and resource translation in prompts

claude-agent-acp translates ACP `resource_link` chunks into `[@name](uri)`
markdown links, and `resource` chunks into `<context ref="...">` blocks
appended after user content.

pi-acp has prompt translation in `src/acp/translate/prompt.ts`. Verify it
follows this pattern.

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
| `tmux` | Same as bash (`` ```console\n{output}\n``` ``). |
| `read` | Apply `markdownEscape()` to each text block. Preserve image content blocks unchanged. |
| `edit` | Return empty (diff content is handled separately in `handleToolEnd`). |
| `write` | Return empty (diff content is handled separately in `handleToolEnd`). |
| `lsp` | Wrap in `` ```\n{text}\n``` `` (structured output). |
| All others | Plain text content block. |
| Errors (any) | Wrap error text in `` ```\n{text}\n``` ``. |

Follow claude-agent-acp pattern: each case returns `ToolCallContent[]`, never
raw strings. The caller (`handleToolEnd`) uses the array directly.

#### 1.2 `markdownEscape()`

Add to `tool-content.ts`. Port from claude-agent-acp `tools.ts`:

```ts
export function markdownEscape(text: string): string {
  // Escape characters that would be interpreted as markdown
}
```

Escapes: `#` at line start, `[`/`]`, `` ` `` sequences, `<`, `---`/`***`/`___`.

#### 1.3 Extract helpers for pi result shapes

Pi tool results have varying shapes. Create focused extractors:

```ts
function extractBashOutput(result: unknown): { output: string; exitCode: number };
function extractTextContent(result: unknown): string;
function extractContentBlocks(result: unknown): Array<{ type: string; text?: string }>;
```

These replace the generic `toolResultToText()` with structured extraction.

#### 1.4 Update `handleToolEnd()` in `session.ts`

```ts
// Before:
const text = toolResultToText(result);
content = [{ type: "content", content: { type: "text", text } }];

// After:
content = formatToolContent(toolName, result, isError);
```

The diff path for edit/write stays unchanged. `formatToolContent` returns
empty for edit/write so the existing diff logic takes precedence.

When `formatToolContent` returns empty AND no diff is available (unexpected),
fall back to a plain text representation to avoid silent content loss.

#### 1.5 Update `handleToolUpdate()` in `session.ts`

For streaming bash output, wrap in code fence. This requires knowing the tool
name, which is available via the toolCallId -> toolName map (see Phase 5).
Phase 1 can use a simpler approach: since `handleToolUpdate` currently receives
`toolCallId` and the event includes `toolName`, thread it through:

```ts
private handleToolUpdate(toolCallId: string, toolName: string, partialResult: unknown): void {
```

Wrap bash/tmux output in `` ```console ``. Leave other tools as plain text.

#### 1.6 Update replay path in `agent.ts`

`replaySessionHistory()` replays tool results. Apply `formatToolContent` for
replayed tool results instead of raw text extraction.

#### 1.7 Remove `toolResultToText()` from `pi-tools.ts`

After all callers migrate to `formatToolContent`, delete the generic function.

### Tests

- Bash output: normal (stdout with `` ```console ``), error (code fence + failed), empty
- Bash output: non-zero exit code appended
- Read output: plain text, file with markdown syntax, image content preserved
- Error output: all tool types verify code fence wrapping
- Streaming bash: `handleToolUpdate` wraps partial output in `` ```console ``
- Replay: replayed tool results match live formatting
- Edit/write: `formatToolContent` returns empty, diff path still works

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
Follow both reference implementations: capabilities are stored once and
referenced throughout the agent's lifetime.

#### 2.2 Detect terminal output support

```ts
private supportsTerminalOutput(): boolean {
  return this.clientCapabilities?._meta?.["terminal_output"] === true;
}
```

Pass this flag to `PiAcpSession` on construction via `PiAcpSessionOpts`.

#### 2.3 Terminal lifecycle in `PiAcpSession`

When `supportsTerminalOutput` is true and tool is `bash` or `tmux`:

**`handleToolStart` (following codex-acp `exec_command_begin`):**

```ts
content: [{ type: "terminal", terminalId: toolCallId }],
_meta: {
  terminal_info: { terminal_id: toolCallId, cwd: this.cwd }
}
```

Note: codex-acp includes `cwd` in terminal_info. claude-acp does not.
Follow codex-acp since the information is available and useful.

**`handleToolUpdate` (following codex-acp `exec_command_output_delta`):**

```ts
_meta: {
  terminal_output: { terminal_id: toolCallId, data: text }
}
```

When terminal output IS supported, do NOT send code-fenced content -- send
only the `_meta.terminal_output`. Follow codex-acp's pattern where the
`ToolCallUpdateFields` has no content, only meta.

**`handleToolEnd` (following codex-acp `exec_command_end`):**

```ts
_meta: {
  terminal_exit: { terminal_id: toolCallId, exit_code: exitCode, signal: null }
}
```

The `status` and `rawOutput` fields are sent alongside the meta on the same
update, matching codex-acp's pattern.

When `supportsTerminalOutput` is false, use the Phase 1 `` ```console `` fallback.

#### 2.4 Extract exit code from pi bash results

Pi bash results include exit code in `details.exitCode` or top-level
`exitCode`. `formatToolContent` already extracts this (Phase 1). For terminal
lifecycle, extract and pass to `terminal_exit`.

### Tests

- Terminal lifecycle: info (with cwd) -> output -> exit sequence
- Fallback: verify `` ```console `` content when terminal not supported
- Mixed sessions: one with terminal support, one without
- Verify no content in tool_call_update when terminal_output meta is present

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

Follow claude-agent-acp's pattern where `_meta.claudeCode.toolName` is present
on every emission. Use `piAcp` namespace to avoid confusion.

Affected methods in `session.ts`:

- `handleMessageUpdate` (toolcall streaming)
- `handleToolStart`
- `handleToolUpdate`
- `handleToolEnd`

And in `agent.ts`:

- `replaySessionHistory` (replayed tool calls and results)

When terminal `_meta` is also present (Phase 2), merge both:

```ts
_meta: {
  piAcp: { toolName: "bash" },
  terminal_output: { terminal_id: "...", data: "..." }
}
```

#### 3.2 Fix tool kind gaps (from GAPS.md)

In `toToolKind()`:

```ts
case "lsp": return "search";
case "tmux": return "execute";
```

#### 3.3 Fix tool title gaps (from GAPS.md)

In `buildToolTitle()`, add cases:

**`lsp`:**

Build descriptive titles from `action`, `file`, `query`, `line` args.
Examples: `Definition src/index.ts:42`, `References MyClass`, `Symbols main.ts`.

Follow codex-acp's `parse_command_tool_call` pattern where the title is
derived from parsed command structure, not just the raw tool name.

```ts
case "lsp": {
  const action = typeof args["action"] === "string" ? args["action"] : undefined;
  const file = typeof args["file"] === "string" ? args["file"] : undefined;
  const query = typeof args["query"] === "string" ? args["query"] : undefined;
  const line = typeof args["line"] === "number" ? args["line"] : undefined;
  if (action !== undefined) {
    const target = file !== undefined
      ? (line !== undefined ? `${file}:${line}` : file)
      : query;
    return target !== undefined
      ? truncateTitle(`${capitalize(action)} ${target}`)
      : capitalize(action);
  }
  return "LSP";
}
```

**`tmux`:**

```ts
case "tmux": {
  const action = typeof args["action"] === "string" ? args["action"] : undefined;
  const command = typeof args["command"] === "string" ? args["command"] : undefined;
  const name = typeof args["name"] === "string" ? args["name"] : undefined;
  if (action === "run" && command !== undefined)
    return truncateTitle(`Tmux: ${command}`);
  if (action !== undefined && name !== undefined)
    return truncateTitle(`Tmux ${action} ${name}`);
  if (action !== undefined)
    return `Tmux ${action}`;
  return "Tmux";
}
```

**Context and utility tools:**

```ts
case "context_tag": {
  const name = typeof args["name"] === "string" ? args["name"] : undefined;
  return name !== undefined ? `Tag ${name}` : "Tag";
}
case "context_log": return "Context log";
case "context_checkout": {
  const target = typeof args["target"] === "string" ? args["target"] : undefined;
  return target !== undefined ? truncateTitle(`Checkout ${target}`) : "Checkout";
}
case "claudemon": return "Check quota";
```

### Tests

- `_meta.piAcp.toolName` present on all tool_call and tool_call_update events
- `_meta` merges correctly with terminal `_meta` (no overwriting)
- `lsp` kind is `search`, title is descriptive for each action type
- `tmux` kind is `execute`, title varies by action
- Context tools have descriptive titles

### Acceptance criteria

- Zed receives tool name metadata for potential UI differentiation
- All pi tools produce meaningful titles and kinds
- `_meta` fields compose correctly when multiple extensions are present

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

function parseClientCapabilities(
  caps: ClientCapabilities | undefined
): ClientCapabilityFlags;
```

Follow claude-agent-acp's pattern of reading capabilities from well-known
paths (`_meta.terminal_output`, `auth.terminal`, `auth._meta.gateway`).

#### 4.2 Wire through to sessions

`PiAcpAgent.initialize()` stores parsed capabilities. Passes relevant flags to
each `PiAcpSession` via `PiAcpSessionOpts`.

#### 4.3 Auth method selection

In `initialize()`, tailor `authMethods` based on client capabilities.
Follow claude-agent-acp's pattern:

- If `terminalAuth` or `_meta.terminal-auth`: offer terminal-based auth with
  command metadata (process.execPath + args)
- If `gatewayAuth`: offer gateway auth (for future use)
- If neither: return empty auth methods (current pi behavior)

claude-agent-acp uses `_meta.terminal-auth` to include the full command:

```ts
terminalAuthMethod._meta = {
  "terminal-auth": {
    command: process.execPath,
    args: [...process.argv.slice(1), "--cli"],
    label: "Claude Login",
  },
};
```

pi-acp should follow this pattern with pi-specific login command if applicable.

### Tests

- Capabilities parsed correctly from various client configs
- Terminal output flag propagated to sessions
- Auth methods vary based on capabilities
- Null/undefined/missing capabilities handled gracefully

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

This is needed because `handleToolUpdate` receives `toolCallId` but needs the
tool name to decide formatting. The pi event (`tool_execution_update`) does
include `toolName`, so alternatively thread it through the event handler.

Prefer the explicit map approach -- it is more robust against event shape
changes and matches codex-acp's `active_commands` map pattern.

#### 5.2 Accumulated output buffer (codex-acp pattern)

codex-acp accumulates output per command and sends the full buffer on each
update. pi's bash tool already sends rolling tail buffer content in `onUpdate`.
However, pi may also send incremental deltas for other tools.

For bash/tmux: each streaming update replaces the previous content entirely
(pi sends accumulated tail), so wrap the full text in a code fence each time.

For other tools: send content as-is (plain text delta or accumulated).

#### 5.3 Format streaming updates

In `handleToolUpdate`, look up the tool name from the map:

- If `bash`/`tmux` and terminal NOT supported: wrap in `` ```console\n{text}\n``` ``
- If `bash`/`tmux` and terminal supported: emit `_meta.terminal_output` (no content)
- If `read`, `lsp`, or other: emit plain text content

Follow codex-acp's branching pattern in `exec_command_output_delta`.

### Tests

- Streaming bash output with `` ```console `` wrapping
- Streaming bash output with terminal_output metadata
- Streaming non-bash tools remain plain text
- Tool name map populated and cleaned up correctly

### Acceptance criteria

- Bash output is readable during execution, not just after completion
- Terminal-aware clients see streaming terminal output
- Non-bash tools stream normally

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

Follow codex-acp's test pattern: it uses a `MockClient` that implements the
`Client` trait and records all sent notifications for assertion.

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

## Phase 6A: Reference cleanup and ownership boundaries

**Goal:** remove svkozak-style startup/update clutter, keep only the ACP surface
that pi's in-process `AgentSession` embedding actually requires.

### Findings from reference review

- `claude-agent-acp` and `codex-acp` do **not** emit a startup banner or
  prelude text on session creation.
- Neither reference performs a runtime update check, semver parsing, or
  `npm view` lookup.
- pi-acp **does** need local builtin command handlers because `AgentSession`
  intercepts extension commands, skill commands, and prompt templates, but it
  does not execute pi's interactive builtin slash commands such as `/compact`
  or `/session`.
- The builtin command advertisement should stay, but as local ACP adapter data,
  not as inherited helper code.

### Work items

- Delete runtime update-check code:
  - `cachedUpdateNotice`
  - `buildUpdateNotice()`
  - `isSemver()`
  - `compareSemver()`
- Delete startup banner code:
  - `buildStartupInfo()`
  - local `addSection()` helper
  - startup-info emission plumbing in `newSession` / `loadSession`
  - startup-info session state and tests
- Keep builtin command execution for ACP-only coverage of pi interactive
  commands:
  - `/compact`
  - `/autocompact`
  - `/export`
  - `/session`
  - `/name`
  - `/steering`
  - `/follow-up`
  - `/changelog`
- Rewrite command advertisement locally:
  - replace `builtinAvailableCommands()` with `const BUILTIN_COMMANDS`
  - replace `mergeCommands()` with a clearer local deduplication helper
  - continue sourcing prompts, skills, and extension commands from
    `AgentSession`
- Keep `/changelog` support and `findChangelog()` because this is a real ACP
  command surface, independent of startup/update behavior.
- Replace `readNearestPackageJson()` with a direct JSON import for adapter
  version metadata, following `claude-agent-acp`.

### Acceptance criteria

- No startup banner or startup-info `_meta` is emitted during session creation
- No runtime update-check path exists
- Builtin ACP command execution remains available and documented in code
- Available commands still include prompts, skills, extension commands, and the
  local builtin ACP commands
- README and planning docs no longer present startup banner or update notice as
  reference-backed behavior

---

## Phase 7: MCP server wiring

**Goal:** wire `mcpServers` from ACP session params through to pi.

### Status

Blocked on pi SDK. `createAgentSession()` does not accept per-session
`mcpServers`. Monitor upstream for:

- New `mcpServers` option on `createAgentSession()`
- Or a `session.addMcpServer()` post-creation API

### Reference pattern

claude-agent-acp converts ACP MCP server configs to its SDK format:

```ts
for (const server of params.mcpServers) {
  if ("type" in server) {
    mcpServers[server.name] = {
      type: server.type, url: server.url,
      headers: Object.fromEntries(server.headers.map(e => [e.name, e.value])),
    };
  } else {
    mcpServers[server.name] = {
      type: "stdio", command: server.command,
      args: server.args,
      env: Object.fromEntries(server.env.map(e => [e.name, e.value])),
    };
  }
}
```

When pi SDK unblocks, follow this conversion pattern.

### When unblocked

- Convert ACP `McpServer[]` to pi's MCP config format
- Pass to `createAgentSession()` options
- Test with at least one stdio MCP server
- Test with at least one HTTP/SSE MCP server

---

## Phase 8: Optional ACP features

Low priority. Implement when upstream support exists or a client needs them.

### 8.1 `session/request_permission`

Requires pi to expose a tool permission hook. Current state: pi handles
permissions internally via its extension system.

Follow claude-agent-acp's `canUseTool()` pattern when implementing:
- Call `client.requestPermission()` with tool call info and options
- Support Allow/Always Allow/Reject decisions
- Store permission mode per session

### 8.2 `agent_plan` updates

Requires pi to expose a planning/TODO surface. Current state: pi has no
equivalent concept.

Follow codex-acp's `update_plan()` pattern:
- Map plan items to `PlanEntry` with status (Pending/InProgress/Completed)
- Emit `SessionUpdate::Plan` notification

### 8.3 Filesystem delegation (`readTextFile` / `writeTextFile`)

Would allow Zed to serve unsaved editor buffer contents. Follow
claude-agent-acp's delegation pattern:

```ts
async readTextFile(params) {
  return await this.client.readTextFile(params);
}
```

Requires pi to route file reads/writes through a pluggable backend.

### 8.4 Terminal delegation

Would allow Zed to host terminal sessions. Requires pi to delegate terminal
creation to an external provider.

### 8.5 Model alias resolution (nice-to-have)

claude-agent-acp resolves friendly model names ("opus", "sonnet") to full IDs
via tokenized matching. Consider porting `resolveModelPreference()` for better
`setSessionConfigOption` UX.

---

## Implementation order

```
Phase 1 ──> Phase 2 ──> Phase 5
   |                       |
   └──> Phase 3            |
          |                |
          └──> Phase 4     |
                           |
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
| `src/acp/translate/tool-content.ts` | 1 | **New file.** Per-tool content formatting, `markdownEscape()`, bash/read/error extractors. |
| `src/acp/session.ts` | 1, 2, 3, 5 | Use `formatToolContent`, track toolName per callId, add `_meta`, terminal lifecycle, streaming formatting. |
| `src/acp/agent.ts` | 2, 3, 4 | Store `clientCapabilities`, pass to sessions, replay formatting, auth method selection, capability parsing. |
| `src/acp/translate/pi-tools.ts` | 1 | Remove `toolResultToText()` after migration. |
| `test/component/session-diff.test.ts` | 1 | Update expected content format. |
| `test/component/session-replay.test.ts` | 1, 3 | Update expected content format, verify `_meta`. |
| `test/component/session-events.test.ts` | 1, 2, 5 | New tests for bash formatting, terminal lifecycle, streaming. |
| `test/unit/tool-content.test.ts` | 1 | **New file.** Tests for `formatToolContent`, `markdownEscape`, extractors. |
| `test/unit/tool-titles.test.ts` | 3 | Add tests for lsp, tmux, context tool titles and kinds. |
| `test/unit/protocol-surface.test.ts` | 6 | Add prompt, config, mode tests. |
| `test/helpers/fakes.ts` | 5, 6 | Add toolName tracking to FakeAgentSession, extend for prompt/config flows. |
