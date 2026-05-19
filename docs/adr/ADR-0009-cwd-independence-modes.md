---
title: "Cwd Independence: local | overlay | none Modes"
adr: ADR-0009
status: Accepted
date: 2026-05-19
prd: "docs/prd/PRD-002-portable-runtime.md"
decision: "Explicit mode enum; default local preserves v0.5 behavior"
---

# ADR-0009: Cwd Independence Modes

## Status

Accepted

## Date

2026-05-19

## Requirement Source

- **PRD**: `docs/prd/PRD-002-portable-runtime.md`
- **Decision Point**: FR-5 (Cwd-independence modes).

## Context

pi-acp `v0.5` requires every session to declare a real, absolute, local `cwd` via ACP `session/new` params. The cwd is the project root for tool execution (`read`/`edit`/`write`/`bash`) AND the discovery root for resources (`AGENTS.md` walk, `.pi/prompts/`).

Two distinct user needs are conflated in that single `cwd` field:

- **Tool target.** Where do `bash` commands run? Where does `edit` write?
- **Discovery root.** Where does pi look for context files?

PRD-002 separates them. Tool target stays as the ACP `cwd`. Discovery becomes the responsibility of `VirtualResourceLoader` + manifest sources.

That separation enables three meaningful modes, but only if pi-acp accepts that `cwd` may not be a real project root at all.

## Decision Drivers

- Users sometimes want sessions with no project root ("explain ECMAScript modules") and resent being forced to choose an unrelated cwd.
- Users with multi-repo projects want a primary cwd plus auxiliary read-only roots feeding context.
- The v0.5 behavior must remain reachable, and must be the default.

## Considered Options

### Option 1: Boolean flags

```yaml
cwdRequired: false
multiRoot: true
ephemeral: true
```

- Bad, because 2³ = 8 flag combinations but only ~3 meaningful states.
- Bad, because reviewers must remember which combinations are valid.

### Option 2: Single enum, explicit modes (chosen)

```yaml
mode: local | overlay | none
```

- Good, because three modes, exhaustive, mutually exclusive.
- Good, because each mode's semantics fit in one sentence.
- Good, because adding `mode: container` or `mode: remote-shell` in v0.7+ is additive.

### Option 3: Implicit detection (cwd exists → local; cwd missing → none; etc.)

- Good, because no user-facing config.
- Bad, because implicit behavior is unpredictable when filesystem state changes between sessions.
- Bad, because the user has no recourse if detection picks the wrong mode.

## Decision

Chosen option: **"Explicit `mode: local | overlay | none` enum, default `local`"**.

| Mode | cwd handling | Resource sources | Tool target |
|------|--------------|------------------|-------------|
| `local` (default) | ACP `params.cwd` must exist, must be absolute | Single `local` source rooted at cwd | Local cwd |
| `overlay` | ACP `params.cwd` is primary | Multiple sources from manifest (local + remote) | Local cwd |
| `none` | pi-acp creates `os.tmpdir() + "/pi-acp-session-<id>/"` and uses that | Multiple sources from manifest (no local-cwd source unless user adds one) | Tmpdir |

`mode` lives in the manifest. ACP session-param override at `params._meta.piAcp.mode` takes precedence per ADR-0008's cascade.

### Tmpdir semantics for `none`

- Real on-disk directory under `os.tmpdir()`. Not a memfs.
- Created with mode `0700`.
- Cleaned up on `session/close`, on `connection.closed` shutdown, and on SIGINT/SIGTERM (via the existing `shuttingDown` guard).
- Existence is documented in the diagnostics surface (FR-7) when `diagnostics: true`.

Rationale for real disk: pi extensions may call `process.cwd()`, expecting a real path. A memfs would surprise extensions; tmpdir is the least-surprising choice.

## Consequences

### Positive

- Three modes cover the observed user scenarios with no leftover combinations.
- Default stays at `local`, so v0.5 behavior is the default for users who do not write a manifest.
- `none` mode unlocks ephemeral Q&A sessions without polluting any real directory.
- `overlay` mode unlocks multi-root context without conflating cwd selection with discovery.

### Negative

- `none` mode's tmpdir consumes disk space (small) and leaves a window where a crash could leave an orphan tmpdir. Mitigation: shutdown handler cleans up; `os.tmpdir()` is platform-managed so orphan dirs are reaped by OS over time.
- Pi extensions that scan cwd for project-specific files (e.g., `.git/config`) get nothing in `none` mode. Documented as expected behavior — the mode is for cwd-less sessions on purpose.
- Three modes mean three sets of edge cases to test. Mitigation: one component test per mode.

### Neutral

- The ACP `cwd` param is still required (the spec says so). In `none` mode, pi-acp accepts whatever cwd the client sends but does not use it as the tool target. The provided cwd may still be exposed as a manifest source if the user explicitly declares one.

## Related

- **PRD**: `docs/prd/PRD-002-portable-runtime.md` (FR-5).
- **Plan**: `docs/architecture/plan-portable-runtime.md` (Phase 7).
- **ADRs**: ADR-0008 (manifest carries the `mode` field).
