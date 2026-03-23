# pi-acp vs claude-agent-acp: Detailed Comparison

Side-by-side analysis of `pi-acp` (v0.2.0) against the reference
`zed-industries/claude-agent-acp` implementation. Focuses on observable
behavioral differences that affect the Zed client experience.

Reference repos:

- `zed-industries/claude-agent-acp` (Claude Code ACP adapter)
- `zed-industries/codex-acp` (Codex ACP adapter, Rust -- cross-referenced for terminal handling)

---

## 0. Startup banner, update checks, and local builtin commands

### Reference adapters

- `claude-agent-acp` does **not** emit a startup banner, startup prelude, or
  startup-info `_meta` payload during session creation.
- `codex-acp` does not emit a startup banner either.
- Neither reference performs a runtime update check, semver parsing, or
  `npm view` lookup.

### pi-acp

pi-acp currently emits a startup info block and inherited a runtime update-check
path from the earlier subprocess-oriented design.

That behavior is not reference-backed and should be removed.

### Important exception: builtin command execution

This cleanup does **not** mean pi-acp can drop its local builtin command
handlers. pi's in-process `AgentSession.prompt()` executes extension commands
and expands skills/prompt templates, but it does not execute pi interactive
builtin slash commands such as `/compact`, `/session`, `/name`, or `/export`.

pi-acp must therefore keep local ACP command handling for those commands, while
still sourcing prompt templates, skills, and extension commands dynamically from
`AgentSession`.

---

## 1. Tool output content formatting

**This is the root cause of bash output not rendering / expanding in Zed.**

### Claude ACP

Each tool type has **dedicated result formatting** in `toolUpdateFromToolResult()`:

| Tool | Content format |
|------|---------------|
| Bash | `` ```console\n{output}\n``` `` code fence (fallback), or `{ type: "terminal", terminalId }` with `_meta.terminal_*` lifecycle (when client supports it) |
| Read | `markdownEscape(text)` -- prevents raw file content from being interpreted as markdown |
| Edit | Handled via post-tool-use hooks with diff content |
| Write | Empty `{}` -- handled separately |
| Other | Wrapped in `{ type: "content", content: { type: "text", text } }` |
| Error | Wrapped in `` ```\n{error}\n``` `` code fence |

### pi-acp

**One generic path for all tools** via `toolResultToText()`:

1. Extracts text from `content[].text` blocks
2. Falls back to `details.diff`, `stdout`, `stderr`, `output`
3. Returns raw string -- no markdown formatting, no code fences, no per-tool handling

Result: tool output arrives at Zed as unformatted plain text. For bash commands
this means no code block, no syntax coloring, likely collapsed or invisible in
the tool call panel.

### Impact

- Bash output is invisible or collapsed in Zed
- Read tool output may render incorrectly if file content contains markdown
- Error output lacks visual distinction from normal output

---

## 2. Terminal content lifecycle (`_meta.terminal_*`)

### Claude ACP

When `clientCapabilities._meta.terminal_output === true`, Claude ACP emits a
3-phase terminal lifecycle:

```
1. tool_call       -> _meta.terminal_info   { terminal_id }
2. tool_call_update -> _meta.terminal_output { terminal_id, data }
3. tool_call_update -> _meta.terminal_exit   { terminal_id, exit_code, signal }
```

Plus `content: [{ type: "terminal", terminalId }]` on the initial tool_call.

When terminal output is NOT supported, it falls back to `` ```console `` code fences.

### codex-acp

Same 3-phase pattern. Terminal support is detected via
`clientCapabilities._meta.terminal_output` and per-command via
`ActiveCommand.terminal_output`.

### pi-acp

No terminal content support at all. No `_meta` on tool updates. No detection
of `clientCapabilities._meta.terminal_output`. No `` ```console `` fallback.

Tool output is emitted as raw `{ type: "content", content: { type: "text", text } }`.

### Impact

Even without terminal support, the `` ```console `` fallback is necessary for
Zed to render bash output as a code block. pi-acp skips both paths.

---

## 3. `_meta` extensions on tool calls

### Claude ACP

Every `tool_call` and `tool_call_update` includes:

```json
{
  "_meta": {
    "claudeCode": {
      "toolName": "Bash"
    }
  }
}
```

Tool results additionally include `toolResponse` in `_meta.claudeCode` (via
post-tool-use hooks).

### pi-acp

No `_meta` on any tool call or update.

### Impact

Unknown. Zed may use `_meta.claudeCode.toolName` for UI decisions (icon
selection, rendering mode). Without it, Zed falls back to generic rendering.

---

## 4. Streaming architecture

### Claude ACP

Uses the Claude SDK's async generator (`query.next()`). Messages arrive as:

- `stream_event` -> real-time content deltas (text, thinking, tool_use)
- `assistant` / `user` -> full messages (used for tool results, replay)
- `result` -> turn completion with usage data
- `tool_progress` -> ignored (no-op)
- `system` -> compacting, hooks, local commands

The `stream_event` path calls `streamEventToAcpNotifications()` which handles
`content_block_start` and `content_block_delta` separately.

For tool_use chunks, it maintains a `toolUseCache` (keyed by tool ID) to:

1. First encounter -> emit `tool_call` (status: `pending`)
2. Second encounter (full message after streaming) -> emit `tool_call_update`
   with refined `rawInput`

### pi-acp

Uses pi's `AgentSession.subscribe()` event emitter. Events are:

- `message_update` -> text/thinking deltas and toolcall streaming
- `tool_execution_start` -> tool begins execution
- `tool_execution_update` -> partial results during execution
- `tool_execution_end` -> final result
- `message_end` -> stop reason
- `agent_end` -> turn completion

The event model maps correctly to ACP updates. The streaming mechanics are
**structurally sound** -- the issue is not streaming timing but content format.

### Key difference

Claude ACP's `tool_use` chunks carry **both** the initial tool_call notification
AND register post-tool-use hooks for result formatting. pi-acp separates these
into `message_update` (toolcall streaming) and `tool_execution_*` (execution).
This separation is fine architecturally but means pi-acp must handle result
formatting in `handleToolEnd()` rather than via hooks.

---

## 5. Tool result handling patterns

### Claude ACP

Tool results flow through two paths:

1. **Post-tool-use hooks** (`registerHookCallback`): fire after tool execution,
   can emit additional `tool_call_update` notifications. Used for Edit tool to
   send diff content from the tool response.

2. **`toolUpdateFromToolResult()`**: formats the SDK tool result into ACP
   content. Dispatches per tool name (Bash, Read, Edit, Write, etc.).

Bash results specifically:
- Extract `stdout`, `stderr`, `return_code` from the result
- Format as `` ```console `` code block (without terminal support)
- OR emit terminal lifecycle events (with terminal support)

### pi-acp

Tool results flow through one path:

1. `handleToolEnd()` -> calls `toolResultToText(result)` -> emits `tool_call_update`

`toolResultToText()` is tool-agnostic: it tries `content[].text`, then
`details.diff/stdout/stderr/output`, then `JSON.stringify`. No formatting.

For edit/write tools, `handleToolEnd()` has diff logic (read file before/after)
which works correctly. But bash and read tools get no special treatment.

---

## 6. Bash tool execution streaming

### Claude ACP

During bash execution, no intermediate output is streamed to the ACP client.
Tool output arrives only in the final `tool_result` message. The terminal
lifecycle (`_meta.terminal_output`) is sent in one batch at result time.

### pi-acp

pi's bash tool calls `onUpdate()` during execution with partial results
(rolling tail buffer). These arrive as `tool_execution_update` events and are
forwarded as `tool_call_update` with `status: "in_progress"`.

This means pi-acp **already streams bash output incrementally**, which is
better than Claude ACP in principle. But the content is unformatted raw text,
so Zed may not render it usefully.

---

## 7. Read tool result formatting

### Claude ACP

Read tool results are wrapped with `markdownEscape()`:

```ts
content: toolResult.content.map((content) => ({
  type: "content",
  content: content.type === "text"
    ? { type: "text", text: markdownEscape(content.text) }
    : toAcpContentBlock(content, false),
})),
```

`markdownEscape()` prevents file content containing markdown syntax from being
rendered as markdown in the Zed UI.

### pi-acp

Read tool results pass through `toolResultToText()` which extracts raw text.
No escaping applied.

### Impact

Files containing markdown syntax (headings, links, code fences) may render
incorrectly in Zed's tool output panel.

---

## 8. Error content formatting

### Claude ACP

Errors are wrapped in code fences:

```ts
text: isError ? `\`\`\`\n${text}\n\`\`\`` : text
```

### pi-acp

Errors are emitted as `status: "failed"` with raw text content. No code fence.

### Impact

Error output lacks visual distinction in the Zed UI.

---

## 9. `clientCapabilities` usage

### Claude ACP

Stores `clientCapabilities` from `initialize` and checks:

- `auth._meta.gateway` -- custom gateway auth
- `auth.terminal` -- terminal-based login
- `_meta.terminal-auth` -- terminal auth with command
- `_meta.terminal_output` -- terminal content support (checked per tool call)

### pi-acp

Does not store or use `clientCapabilities` at all.

### Impact

Cannot adapt behavior to client capabilities. Terminal output support cannot
be detected. Auth methods cannot be tailored.

---

## 10. Permission system (`request_permission`)

### Claude ACP

Full permission system via `canUseTool()`:

- Calls `client.requestPermission()` for each tool invocation
- Offers Allow/Always Allow/Reject options
- Handles `ExitPlanMode` with custom options
- Supports bypass mode for sandboxed environments
- Permission mode persisted per session

### pi-acp

Not implemented. pi handles permissions internally. Marked as intentional
exclusion in the conformance notes.

### Impact

All tools execute without Zed-side approval. This is acceptable for pi's
architecture (pi has its own permission system) but means Zed cannot gate
tool execution.

---

## 11. Session list title derivation

### Claude ACP

Uses `session.summary` (a field from the Claude SDK):

```ts
title: sanitizeTitle(session.summary)
```

### pi-acp

Uses `session.name` with fallback to first user message:

```ts
title: (s.name ?? null) ?? truncateSessionTitle(s.firstMessage) ?? null
```

### Impact

Functionally equivalent. Both produce reasonable titles.

---

## 12. Replay path

### Claude ACP

Replay calls `toAcpNotifications()` with `registerHooks: false` on each
stored message. The same function handles both streaming and replay, so replay
produces the same ACP events as live streaming (including tool_call with proper
titles, kinds, and content).

### pi-acp

Replay has a dedicated `replaySessionHistory()` method that iterates persisted
messages. It reconstructs tool calls from stored content blocks and emits
structured ACP events.

### Impact

Both approaches work. pi-acp's replay path was refactored in v0.2.0 and
produces structured updates. The main gap is that replay tool results suffer
from the same formatting issues as live results.

---

## 13. Filesystem delegation

### Claude ACP

Implements `readTextFile` and `writeTextFile` by delegating to the client:

```ts
async readTextFile(params) {
  return await this.client.readTextFile(params);
}
```

This allows Zed to serve unsaved editor buffer contents instead of on-disk files.

### pi-acp

Not implemented. pi reads/writes files directly on disk.

### Impact

pi always operates on the saved-to-disk version of files. If a user has unsaved
changes in Zed, pi will not see them. This is documented as a known limitation.

---

## 14. Plan updates

### Claude ACP

Converts `TodoWrite` tool calls into ACP `plan` updates:

```ts
if (chunk.name === "TodoWrite") {
  update = {
    sessionUpdate: "plan",
    entries: planEntries(chunk.input),
  };
}
```

### pi-acp

Not implemented. pi has no equivalent planning surface.

### Impact

No plan panel in Zed. Low priority -- pi's architecture does not include a
TODO/plan concept.

---

## Summary of gaps by severity

### Critical (breaks core UX)

1. **Bash tool output not formatted** -- raw text instead of `` ```console `` code blocks
2. **No terminal content lifecycle** -- no `_meta.terminal_*` even as fallback
3. **No `clientCapabilities` detection** -- cannot adapt to Zed's capabilities

### High (degrades experience)

4. **Read tool output not markdown-escaped** -- file content may render as markdown
5. **Error output not wrapped in code fences** -- no visual error distinction
6. **No `_meta` on tool calls** -- Zed may miss tool type context for UI rendering
7. **Tool result content not per-tool formatted** -- generic handler for all tools

### Medium (missing features)

8. **No filesystem delegation** -- cannot read unsaved editor buffers
9. **No plan updates** -- no plan panel in Zed

### Low (acceptable differences)

10. **No `request_permission`** -- pi handles permissions internally
11. **Session title derivation** -- functionally equivalent
12. **Streaming architecture** -- structurally different but functionally correct
