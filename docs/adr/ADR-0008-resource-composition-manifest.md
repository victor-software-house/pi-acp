---
title: "Resource Composition Manifest: .pi-acp.yaml at Project + User Scope"
adr: ADR-0008
status: Accepted
date: 2026-05-19
prd: "docs/prd/PRD-002-portable-runtime.md"
decision: "Declarative YAML manifest with cascade: ACP session params > project > user-global > default"
---

# ADR-0008: Resource Composition Manifest

## Status

Accepted

## Date

2026-05-19

## Requirement Source

- **PRD**: `docs/prd/PRD-002-portable-runtime.md`
- **Decision Point**: FR-3 (Manifest format and cascade).

## Context

The `VirtualResourceLoader` (ADR-0006) needs configuration: which sources exist, what backend each uses, what paths to expose. The configuration must be:

- **Per-project.** Each repo can declare its own composition (e.g., this monorepo has a `vsh-shared-skills` source pointing at `cvm`).
- **Per-user.** Workstation-global defaults that follow the user across projects (e.g., personal dotfiles repo as a context source).
- **Per-session.** ACP session-param override for ephemeral compositions (e.g., a one-shot session targeting a specific remote host).
- **Optional.** No manifest → identical to v0.5 behavior.

The configuration is **server-side** — pi-acp reads it, the ACP client does not. There is no need for the client to understand or validate the manifest schema.

## Decision Drivers

- Three scopes need to coexist with clear precedence.
- Manifest is config, not code — must be human-readable with comments.
- JS/TS ecosystem convention favors YAML for config files of this shape.
- Schema must be machine-validated to catch typos at load time.

## Considered Options

### Option 1: JSON manifest

- Good, because no parser dep beyond what's already used.
- Bad, because no comments — config files like this benefit from explanatory comments next to each source.
- Bad, because trailing commas trip users.

### Option 2: TOML manifest

- Good, because comments + simple syntax.
- Bad, because less conventional in JS/TS world; users will reach for YAML reflexively.
- Bad, because nested arrays-of-objects (which our `roots:` is) are awkward in TOML.

### Option 3: YAML manifest (chosen)

- Good, because comments are natural, indentation matches Kubernetes / GitHub Actions / `package.json` aesthetics.
- Good, because nested objects + arrays are conventional.
- Neutral, because adds the `yaml` npm dep (well-maintained, small).
- Bad, because YAML has well-known footguns (`no` as boolean, indentation ambiguity). Mitigation: Zod validation surfaces unexpected types loudly.

### Option 4: TS config file (`pi-acp.config.ts`)

- Good, because programmable.
- Bad, because requires evaluating arbitrary user TS — security concern.
- Bad, because debugging a config file that runs code is harder than debugging declarative YAML.

## Decision

Chosen option: **"YAML manifest at `.pi-acp.yaml` (project) and `~/.pi-acp/config.yaml` (user-global), with cascade resolution and ACP session-param override at the top"**.

Cascade (highest precedence first):

1. **ACP session params** — `params._meta.piAcp.manifest` (inline manifest object or path string).
2. **Project** — `<cwd>/.pi-acp.yaml`.
3. **User-global** — `~/.pi-acp/config.yaml`.
4. **Default** — synthesized `{ version: 1, mode: "local", roots: [{ id: "local", kind: "local", paths: { cwd: ".", agentDir: "~/.pi/agent" } }], mergeStrategy: "append" }`.

Manifests are merged shallow at the top level; the highest-precedence value wins per field. Within `roots`, ID is the merge key.

### Filename choices

- `.pi-acp.yaml` (hidden, project-local) — matches the `.pi/` convention pi itself uses.
- `~/.pi-acp/config.yaml` (visible directory, hidden inside) — fits alongside `~/.pi/agent/` without colliding.

Both are written explicitly so users can grep, edit, and version-control. No "computed" config files.

### Schema validation

Zod schema at `src/resources/manifest.schema.ts`. On parse failure or schema mismatch:

- Fatal errors (no version, malformed YAML at top level): fall back to synthesized default, emit a diagnostic chunk at session start.
- Per-source errors (one source has a bad shape): drop that source, emit per-source diagnostic, continue with the rest.

Unknown top-level keys: warning diagnostic, parse proceeds.

## Consequences

### Positive

- Users have one place to declare composition per project, plus a workstation-global fallback.
- Manifest is git-versionable, scriptable, and reviewable by other contributors on the project.
- Cascade gives ephemeral overrides without rewriting files (ACP param at the top).
- No-manifest case stays identical to v0.5 (synthesized default = today's behavior).

### Negative

- New runtime dep (`yaml`). Small footprint, well-maintained.
- YAML footguns. Mitigation: documented warnings in the README, Zod catches type mismatches.
- Two filename conventions (`.pi-acp.yaml` for project, `~/.pi-acp/config.yaml` for user). Slightly asymmetric. Mitigation: documented prominently; cascade resolver handles both transparently.

### Neutral

- Manifest is server-side only. Client (Zed, etc.) is unaffected and does not need to know about it. No new ACP wire surface.
- XDG-compliance is not pursued (`~/.config/pi-acp/`). Decision deferred to a future ADR if user demand arises; `~/.pi-acp/` is the v0.6 choice for symmetry with `~/.pi/`.

## Related

- **PRD**: `docs/prd/PRD-002-portable-runtime.md` (FR-3).
- **Plan**: `docs/architecture/plan-portable-runtime.md` (Phase 2).
- **ADRs**: ADR-0006 (loader the manifest configures); ADR-0009 (mode field in manifest selects cwd handling).
