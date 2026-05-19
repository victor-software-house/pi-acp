---
title: "Ratify Per-Tool Output Formatter Dispatch and `_meta.piAcp` Namespace"
adr: ADR-0004
status: Accepted
date: 2026-05-18
prd: "docs/prd/PRD-001-acp-v013-zed-alignment.md"
decision: "Strategy table keyed on tool name; `_meta.piAcp.toolName` namespace"
---

# ADR-0004: Ratify Per-Tool Output Formatter Dispatch and `_meta.piAcp` Namespace

## Status

Accepted — ratifies decisions made during v0.3.0 development that were not previously recorded as a standalone ADR. No behavior change.

## Date

2026-05-18

## Requirement Source

- **PRD**: `docs/prd/PRD-001-acp-v013-zed-alignment.md`
- **Decision Point**: PRD §4 "Out of scope / later" — explicitly carves out the v0.3.0 dispatch work as ratified rather than rewritten. PRD §8 D1 explains why.

## Context

The fork at `v0.4.0` already implements per-tool content dispatching in `src/acp/translate/tool-content.ts`. The legacy `PLAN.md` documents the design (Phase 1 of the v0.3.0 plan); the legacy `TODO.md` confirms all phase items shipped; the fork's current code matches the design.

The dispatch shape is:

```ts
// src/acp/translate/tool-content.ts
export function formatToolContent(
  toolName: string,
  result: unknown,
  isError: boolean,
): ToolCallContent[] {
  if (isError) return formatErrorContent(result);
  switch (toolName) {
    case "bash":
    case "tmux":
      return formatBashContent(result);   // wraps in ```console fence + exit code
    case "read":
      return formatReadContent(result);   // markdownEscape per text block, preserve images
    case "edit":
    case "write":
      return [];                           // diff path in session.ts handles these
    case "lsp":
      return formatLspContent(result);     // wraps in ``` fence
    default:
      return formatFallbackContent(result);
  }
}
```

Plus a `wrapStreamingBashOutput()` helper for streaming-side console fencing.

Three associated decisions also shipped in v0.3.0 without standalone ADRs:

1. **Per-call `_meta.piAcp.toolName`** is set on every `tool_call` and `tool_call_update` emission (and merged with terminal `_meta` where applicable).
2. **Terminal-content lifecycle fallback**: when `clientCapabilities._meta.terminal_output === true`, bash/tmux use `_meta.terminal_info` / `terminal_output` / `terminal_exit`. Otherwise the formatters' ```console-fenced fallback is emitted via `session/update` content blocks.
3. **Markdown escape uses dynamic backtick fence wrapping** (`markdownEscape`), matching `claude-agent-acp`'s approach — find the longest backtick run in the content, use one more for the fence.

None of these were recorded as decisions; they exist as facts in `src/`. This ADR makes them durable.

## Decision Drivers

- A future maintainer (human or agent) reading only the spec layout should understand why `_meta.piAcp` is the namespace rather than `vsh.pi-acp/*` or `dev.pi-acp/*`.
- A future contributor should not propose "introduce dispatch" without realizing dispatch already exists, then "improve `_meta` namespace by renaming" without realizing the rename is breaking.
- v0.5 explicitly does not change any of this surface — guardrails must be documented.

## Considered Options (Historical)

These are the options that were on the table during v0.3.0 design; recorded here for context only. The decisions are settled.

### Option A: Inline branching inside session handlers

- Bad, because adding a new tool kind requires editing the central handler.
- Bad, because each branch carries different result-shape assumptions.

### Option B: Strategy table keyed on tool name (chosen)

- Good, because each formatter is a pure function — testable in isolation.
- Good, because adding a new tool is a single switch case.
- Good, because the dispatch site stays small.
- Neutral, because requires a `toolName` lookup map in `session.ts` for streaming updates (already implemented).

### Option C: Class hierarchy

- Bad, because pi's tool kinds are data, not behavior — OOP wrapping adds ceremony without payoff.

### `_meta` namespace options:

- **`_meta.piAcp.toolName`** (chosen) — camelCase nested object, matches `claude-agent-acp`'s `_meta.claudeCode.toolName` pattern.
- `_meta.vsh.pi-acp.tool-kind` — VSH-prefixed slash-delimited. Inconsistent with reference adapters; uses kebab-case keys which mix awkwardly with the rest of ACP's camelCase surface.
- `_meta.dev.pi-acp.tool-kind` — same problem.

## Decision

Ratify:

1. **Per-tool dispatch** in `src/acp/translate/tool-content.ts` is the canonical formatter surface. New pi tool kinds gain entries via the switch in `formatToolContent` and a new pure formatter function.
2. **`_meta.piAcp.toolName`** is the stable namespace for pi-acp-specific tool metadata. The key is `piAcp` (camelCase, nested object), not `vsh.pi-acp` (slash-delimited). Additional pi-specific fields go under `_meta.piAcp.*` (e.g., `_meta.piAcp.exitCode`, `_meta.piAcp.modelLabel`).
3. **Terminal-content lifecycle fallback**: gated on `clientCapabilities._meta.terminal_output === true`. When unsupported, the formatter's ```console-fenced output is the fallback path.
4. **Markdown escape via dynamic backtick fence wrapping** in `markdownEscape()` is the canonical escape strategy for file content from `read`.

## Consequences

### Positive

- Future ACP method surfaces gain `_meta.piAcp.*` extensions without naming churn.
- New pi tool kinds are absorbed by one switch case + one pure formatter.
- A future contributor proposing a `_meta` namespace migration knows they must read this ADR first and weigh the breakage cost against the (minor) consistency benefit.

### Negative

- The `piAcp` namespace deviates from W3C-style trace-context convention (`traceparent` is root-level, not nested). Acceptable: ACP spec only reserves root-level keys for protocol-internal use, not the nested form.
- A consumer reading `_meta.piAcp.toolName` is implicitly coupled to pi-acp; portable code should not assume any `_meta` key. Mitigation: README and ADR document the key as pi-acp-specific extension surface.

### Neutral

- W3C trace context root keys (`traceparent`, `tracestate`, `baggage`) at the `_meta` root remain reserved per ACP spec; pi-acp neither emits nor strips them and they pass through transparently.
- The `ToolCallContent[]` shape returned by every formatter is the SDK type, not a fork type; the dispatch stays inside the SDK's type contract.

## Related

- **PRD**: `docs/prd/PRD-001-acp-v013-zed-alignment.md` (§4 Out-of-scope, §8 D1, Guardrails).
- **Plan**: `docs/architecture/plan-acp-v013-zed-alignment.md` (guardrails section).
- **Reference impl**: `agentclientprotocol/claude-agent-acp/src/tools.ts` (`markdownEscape`, per-tool helpers, `_meta.claudeCode.toolName` pattern).
- **Existing surface**: `src/acp/translate/tool-content.ts` (live), `src/acp/session.ts` (`buildToolMeta`, `PiAcpMeta`).
- **ADRs**: ADR-0001 (Standalone server provides stdout discipline this depends on).
