---
title: "Phase 5 execution plan — Manifest parser + cascade resolver"
prd: "docs/prd/PRD-002-portable-runtime.md"
plan: "docs/architecture/plan-portable-runtime.md"
branch_base: "feat/v0.6-foundation-refactor"
branch_wip: "feat/v0.6-phase-5-manifest"
status: Draft
date: 2026-05-19
---

# Phase 5 execution plan — Manifest parser + cascade resolver

## Reality check

Phase 5 implementation is **NOT greenfield**. It exists on the sibling branch `feat/v0.6-phase-5-manifest`, two commits ahead of `feat/v0.6-foundation-refactor`:

```
8f0f691 fix(resources): surface manifest diagnostics under PI_ACP_DAEMON_DEBUG
404eb9e feat(resources): manifest parser + cascade resolver (PRD-002 Phase 5)
```

Files added/changed on that branch (vs the base of foundation-refactor):

| File | Status | Lines |
|---|---|---|
| `src/resources/manifest.schema.ts` | new | 103 |
| `src/resources/manifest.ts` | new | 135 |
| `test/unit/manifest.test.ts` | new | 170 |
| `src/acp/agent.ts` | modified | +75 |
| `package.json` | +`yaml` dep | +1 |
| `bun.lock` | yaml resolution | +1 |
| Five doc files | older versions (pre-reconciliation) | -194/+50 |

The Phase 5 *code* is good. The *docs* on that branch predate this session's reconciliation commits on `feat/v0.6-foundation-refactor` (`8e85686`, `a650f68`), so a naive rebase will conflict on every reconciled spec file.

**Strategy**: rebase `feat/v0.6-phase-5-manifest` onto `feat/v0.6-foundation-refactor`, resolve doc conflicts in favor of the reconciled versions (which already incorporate Phase 5's relevant skill references via §16 maps), keep all code + test changes from `404eb9e` + `8f0f691`. Then validate via typecheck / lint / `bun test`.

If validation fails, the fix-up commits land on top of the integrated branch — no rewriting history of the upstream Phase 5 commits.

---

## Phase 0 — Documentation Discovery (complete)

Subagent findings (verified file:line):

### Manifest spec — canonical (PRD-002 §FR-3 + ADR-0008 + this branch's commit 404eb9e)

```yaml
version: 1                                   # literal 1, required
mode: "local" | "overlay" | "none"           # default "local"
roots:
  - id: string                               # unique within roots
    kind: "local" | "ssh" | "http" | "acp-fs"
    # local: paths: { cwd?, agentDir? }
    # ssh:   host (required), user?, paths?: { skills?, prompts?, agentsFiles?, extensions? }
    # http:  baseUrl (https:// only), cache?: { ttl }, paths?: { … }
    # acp-fs: paths?: { … }
mergeStrategy: "append" | "override-by-name" # default "append"
autoImport?:                                 # optional
  - source: <root.id>
    paths: string[]
diagnostics?: boolean                        # default false
```

Cascade precedence (highest first):
1. ACP session params (`params._meta.piAcp.manifest`) — inline object OR path string
2. Project (`<cwd>/.pi-acp.yaml`)
3. User-global (`~/.pi-acp/config.yaml`)
4. Synthesized default: `{ version: 1, mode: "local", roots: [], mergeStrategy: "append", diagnostics: false }`

Phase 5 honors only `kind: "local"` materialization. Remote kinds parse fine and surface as `"not yet supported"` diagnostics.

### Allowed APIs — Zod v4 (cited from chezmoi skill `~/.agents/skills/zod/`)

| API | Use |
|---|---|
| `import * as z from "zod"` | namespace import — never named (`zod-patterns.md`) |
| `z.literal(1)` | version pin |
| `z.enum([...])` | string union (`mode`, `mergeStrategy`) |
| `z.object({}).strict()` | reject unknown keys per-root |
| `z.discriminatedUnion("kind", [...])` | O(1) root selection (`schema-collections.md:96`) |
| `z.url()` + `.refine(...)` | https://-only baseUrl |
| `.default(value)` | post-output short-circuit — caveat in `transformations.md:189` |
| `.safeParse(input)` | returns `{ success: true, data } \| { success: false, error: ZodError }` — never `parse()` |
| `z.treeifyError(err)` / `z.prettifyError(err)` | diagnostic message formatting |
| `z.infer<typeof X>` | export type |

### Forbidden — anti-patterns (do not introduce)

- `import { z } from "zod"` — breaks tree-shaking + violates `zod/consistent-import-source`
- `.parse()` — use `.safeParse()`
- `.deepPartial()` — removed in v4
- `.merge()` — deprecated, use `.extend()`
- `z.nativeEnum()` — deprecated, `z.enum()` handles TS enums
- `z.any()` / `z.unknown()` — flag as defect unless genuinely dynamic

### Pi-acp wiring (cited from `src/`)

| Signature | Location | Today |
|---|---|---|
| `VirtualResourceLoader({sources, mergeStrategy?, primarySourceId?})` | `src/resources/loader.ts:43` | unchanged on Phase 5 branch |
| `LocalBackend({id?, cwd, agentDir})` | `src/resources/sources/local.ts:26` | unchanged on Phase 5 branch |
| `buildResourceLoader(cwd)` | `src/acp/agent.ts:225` | extended on Phase 5 branch to `(cwd, sessionParams?)` |
| Callsites | `src/acp/agent.ts:274, 623, 764, 835` | newSession / loadSession / resumeSession / unstable_forkSession — must thread `params` |

### Existing `_meta.piAcp` namespace

- `toolName` — `src/acp/agent.ts:462, 494, 509`
- `live`, `ownedByThisConnection` — `src/acp/agent.ts:572-576, 593-599`
- **New (Phase 5)**: `manifest` — string path OR inline manifest object

### Test conventions

- Framework: native `bun:test` — `import { describe, expect, test } from "bun:test"`
- Layout: `test/unit/*.test.ts` (~18 files), `test/component/*.test.ts` (~3 files), `test/helpers/fakes.ts`
- CI: `bun test` (no args) — `.github/workflows/publish.yml:62`
- Temp dirs: `mkdtempSync(join(tmpdir(), "pi-acp-manifest-"))` pattern (`socket-path.test.ts`)
- Phase 5 test file (`test/unit/manifest.test.ts`, 170 lines on sibling branch) already covers: schema reject unknown version, defaults filled in, discriminated kind validation, cascade precedence with fixture YAML files

### yaml@2.9.0 (already transitive; explicit dep added on Phase 5 branch)

- `parse(src, options?): unknown` — primary parser
- `parseDocument(src, options?): Document` — capture warnings via `doc.warnings`
- Errors: `YAMLParseError` extends `YAMLError`
- Already in `node_modules/yaml/` at `2.9.0` per `bun.lock`

### TS strictness in effect (tsconfig.json)

`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`, `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`. Schema + cascade code must respect all of these.

---

## Phase 1 — Rebase + doc conflict resolution

### What to do

Rebase `feat/v0.6-phase-5-manifest` onto current `feat/v0.6-foundation-refactor` HEAD (`a650f68` after our recent doc reconciliation + skill-refs commits).

```bash
git checkout feat/v0.6-phase-5-manifest
git rebase feat/v0.6-foundation-refactor
```

### Expected conflict zones

Five doc files were edited on BOTH branches:

| File | Resolution policy |
|---|---|
| `docs/prd/PRD-002-portable-runtime.md` | **Keep ours** (foundation-refactor — has §16 Skill References, FR-2 Bun Shell SSH note, FR-3 Zod v4 namespace note, FR-4/FR-6 pi-tool-progressive-disclosure notes). Verify the Phase 5 branch did not add unrelated FR-3 changes that should be preserved. |
| `docs/prd/PRD-003-runtime-daemon.md` | **Keep ours** (full v1.1 reconciliation — escape hatch, Hono, Posix-only, §16). |
| `docs/architecture/plan-portable-runtime.md` | **Keep ours** (Mandatory Skill Loads table + Phase 2 annotations). Verify Phase 2 status row updates if Phase 5 branch flipped Phase 2 from Pending to Shipped. |
| `docs/architecture/plan-runtime-daemon.md` | **Keep ours** (Mandatory Skill Loads table + Posix-only socket path). |
| `docs/adr/ADR-0010-daemon-client-split.md` | **Keep ours** (Update v1.1 + Implementation skills line). |

Non-doc files conflict-free expectation: `src/resources/manifest.schema.ts`, `src/resources/manifest.ts`, `test/unit/manifest.test.ts` are new on the Phase 5 branch — pure additions. `src/acp/agent.ts` Phase 5 edits are confined to `buildResourceLoader`; verify the surrounding code matches our branch state.

### Documentation references

- This file's "Reality check" section above
- The doc reconciliation commits to favor: `8e85686`, `a650f68`

### Verification checklist

```bash
# After rebase succeeds and conflicts resolved:
git diff feat/v0.6-foundation-refactor..HEAD --stat
# Expect: src/resources/manifest.schema.ts (new), src/resources/manifest.ts (new),
# test/unit/manifest.test.ts (new), src/acp/agent.ts (+75 lines),
# package.json (+yaml dep), bun.lock (+yaml entry). NO doc file changes.

# Confirm reconciled docs are intact:
grep -c "Implementation Skill References\|Mandatory Skill Loads\|v1.1" docs/prd/PRD-003-runtime-daemon.md docs/architecture/plan-runtime-daemon.md
# Each file should show ≥1 hit.
```

### Anti-pattern guards

- Do NOT resolve doc conflicts by taking the Phase 5 branch's older versions. Lose-the-reconciliation = lose the canonical FR→skill map.
- Do NOT squash the two upstream Phase 5 commits. Keep `404eb9e` and `8f0f691` as discrete history.

### Commit cadence

This phase produces ZERO new commits — rebase is structural. The two upstream commits are preserved; their parent shifts.

---

## Phase 2 — Code review against current skill standards

### What to do

Open `src/resources/manifest.schema.ts` + `src/resources/manifest.ts` + the agent.ts diff, audit against the skill-derived standards in PRD-002 §16 and the Allowed-APIs table above.

### Checks (item by item)

| Check | Where | Pass condition |
|---|---|---|
| Namespace import | `manifest.schema.ts:10` | `import * as z from "zod";` |
| Version pin | `manifest.schema.ts:84` | `z.literal(1)` |
| Mode enum | `manifest.schema.ts:85` | `z.enum(["local", "overlay", "none"])` |
| MergeStrategy enum | `manifest.schema.ts:87` | `z.enum(["append", "override-by-name"])` |
| Discriminated union | `manifest.schema.ts:70` | `z.discriminatedUnion("kind", [...])` |
| Strict objects | every `.strict()` callsite | unknown keys rejected, not silently passed |
| safeParse usage | `manifest.ts` | `.safeParse()` only — never `.parse()` |
| https:// refinement | `manifest.schema.ts:54` | `.refine((u) => u.startsWith("https://"))` |
| Diagnostic accumulation | `manifest.ts` LoadManifestResult | array of `{ source, path?, message }` |
| Cascade order | `manifest.ts:loadManifest` | params → project → user-global → default |
| Defaults match PRD-002 §FR-3 | DEFAULT_MANIFEST const | `{version:1, mode:"local", roots:[], mergeStrategy:"append", diagnostics:false}` |

### Improvement candidates (consider — do NOT block)

- `z.url()` v4 — confirm not deprecated relative to `z.string().url()`. Per `zod-patterns.md`, top-level format helpers like `z.email()`, `z.url()` ARE the v4 preferred form. PASS.
- Diagnostic formatting via `z.treeifyError` / `z.prettifyError` instead of `error.message`. Current code uses `result.error.message` — readable but flat. If diagnostics are operator-facing, `z.prettifyError` is denser. Defer to follow-up commit if it lands cleanly.
- `ts-pattern` exhaustive match on `loaded.manifest.roots[].kind` in `buildResourceLoader` — currently `if (root.kind === "local") {} else {}`. Works but does not assert exhaustiveness statically. If we add `ts-pattern` we get a compile error when Phase 6 adds `ssh` materialization and forgets to update the loader. Worth adding — single line + `.exhaustive()`.

### Documentation references

- Zod skill: `~/.agents/skills/zod/SKILL.md` + `references/schema-collections.md:96-99` (discriminated union signature)
- TypeScript-type-safety skill: `~/.agents/skills/typescript-type-safety/references/ts-pattern.md` (exhaustive matching)
- PRD-002 §16 (FR → skill mapping)

### Verification checklist

```bash
# Zod anti-patterns:
grep -rn "import { z }\| z.parse\| z.deepPartial\| z.merge\| z.nativeEnum\| z.any()" src/resources/ test/unit/manifest.test.ts && echo FAIL || echo PASS

# Confirm strict objects throughout schema:
grep -c "\.strict()" src/resources/manifest.schema.ts
# Expect ≥7 (LocalPaths, RemotePaths, LocalRoot, SshRoot, HttpRoot, AcpFsRoot, AutoImport, top-level Manifest)
```

### Anti-pattern guards

- Do NOT introduce `as` casts to satisfy strict TS — fix the schema or the consumer.
- Do NOT add `.passthrough()` to silence unknown-key warnings — the PRD calls for warning diagnostics, NOT acceptance.

### Commit cadence

If improvements land, ONE follow-up commit titled `refactor(manifest): exhaustive ts-pattern match on root.kind` (or similar). Push immediately.

---

## Phase 3 — Verify all callsites thread `sessionParams`

### What to do

`buildResourceLoader` is called from FOUR sites in `src/acp/agent.ts`:

- `newSession(params)` — line 274
- `loadSession(params)` — line 623
- `resumeSession(params)` — line 764
- `unstable_forkSession(params)` — line 835

The Phase 5 branch's agent.ts diff extends the signature to `(cwd, sessionParams?)` but the diff preview I read only shows the function body. Audit every callsite passes the appropriate `params` object so the cascade can find `_meta.piAcp.manifest`.

### Documentation references

- PRD-002 §FR-3 cascade clause: ACP session params is precedence rank #1
- `src/acp/agent.ts` (read in full after rebase, focus on lines 270-280, 619-627, 760-768, 831-839)

### Verification checklist

```bash
# Every buildResourceLoader call passes 2 args:
grep -n "buildResourceLoader" src/acp/agent.ts
# Expect 4 callsite hits + 1 definition hit. Each callsite should show
# `this.buildResourceLoader(<cwd>, <params>)`.

# Sanity: params arrives as the typed request param at each callsite:
grep -B1 "buildResourceLoader" src/acp/agent.ts | head -40
```

### Anti-pattern guards

- Do NOT pass `params._meta` directly — `loadManifest` takes the full `params` and digs in itself.
- Do NOT silently default `sessionParams` to `undefined` at any callsite without explicit comment — that disables the highest cascade tier.

### Commit cadence

If a callsite is missing the threading, ONE fix commit titled `fix(resources): thread session params into resumeSession buildResourceLoader call` (or similar). One commit per fix; push immediately.

---

## Phase 4 — Full verify (typecheck + lint + bun test)

### What to do

Run the project's standard verify lane.

```bash
cd /Users/victor/workspace/victor/pi-ecosystem/pi-acp
bun install                  # if package.json/bun.lock changed
bun run typecheck            # tsc --noEmit
bun run lint                 # biome check . (and oxlint if wired)
bun test                     # native bun:test, all files
```

### Expected results

- `typecheck`: 0 errors. Strict TS flags in `tsconfig.json` are all on; the schema and parser must satisfy `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`.
- `lint`: 0 errors. Biome covers `src/**` and `test/**` per `biome.json`.
- `bun test`: existing tests + new `test/unit/manifest.test.ts` all pass.

### Documentation references

- `package.json` scripts block
- `.github/workflows/publish.yml:62` for the canonical CI invocation

### Verification checklist

```bash
# Tests should report at least the 10 manifest cases from 404eb9e:
bun test test/unit/manifest.test.ts
# Expect ≥10 pass / 0 fail

# Full sweep:
bun test 2>&1 | tail -3
# Expect "0 fail"
```

### Anti-pattern guards

- Do NOT add `// @ts-expect-error` to make typecheck pass.
- Do NOT delete failing assertions — investigate the root cause.
- Do NOT relax `tsconfig.json` strictness flags to make code compile.

### Commit cadence

If validation fails AND a fix lands, commit per fix with conventional commit messages. After all green, no extra commit needed — the rebase + any review/threading fixups already represent the work.

---

## Phase 5 — Land on `feat/v0.6-foundation-refactor`

### What to do

Fast-forward (or merge) the rebased phase-5 branch into foundation-refactor, then push.

```bash
git checkout feat/v0.6-foundation-refactor
git merge --ff-only feat/v0.6-phase-5-manifest
# If --ff-only refuses, the rebase didn't sit cleanly on the foundation-refactor tip — investigate before forcing.
git push origin feat/v0.6-foundation-refactor
git push origin feat/v0.6-phase-5-manifest  # if any new commits added during review
```

### Verification checklist

```bash
# Confirm the two upstream commits are at HEAD~N:
git log --oneline -10
# Expect 404eb9e + 8f0f691 visible (or their rebased equivalents)
# plus any phase-2/3 fix-up commits from this plan.

# Remote sync:
git status
# Expect "Your branch is up to date with 'origin/feat/v0.6-foundation-refactor'."
```

### Anti-pattern guards

- Do NOT delete the `feat/v0.6-phase-5-manifest` branch unless explicitly told — it serves as a recovery checkpoint and as the canonical history of Phase 5.
- Do NOT force-push `main` or any shared branch. Force-push the phase-5 branch only after the user is briefed (rebase moved its commits).

### Commit cadence

This phase produces ZERO new commits — pure integration. The branch state after Phase 5 = (foundation-refactor + 2 upstream commits + any Phase 2/3 fixups).

---

## Open questions (for the executing agent to verify)

1. Does the Phase 5 branch's `src/resources/manifest.schema.ts` use `z.url()` or `z.string().url()`? Either is v4-valid, but `z.url()` matches the canonical v4 idiom.
2. Does the Phase 5 branch ALREADY thread `params` into all 4 `buildResourceLoader` callsites, or only `newSession`? The diff preview only showed the signature change.
3. Does `tsconfig.json` map the `@pi-acp/resources/manifest` path alias used in the new files? If not, the import will not resolve.
4. Should Phase 11's diagnostics surface (`session/update`) get a placeholder hook here, or strictly defer? Today's `process.env["PI_ACP_DAEMON_DEBUG"]` stderr fallback is the only signal.

Each question maps to a `cavecrew-investigator` query if the executing agent finds the existing answer ambiguous.

---

## Done condition

- `feat/v0.6-foundation-refactor` includes the two Phase 5 commits (rebased).
- `bun run typecheck && bun run lint && bun test` all pass.
- `docs/prd/PRD-002-portable-runtime.md §11 Rollout` shows Phase 5 status updated from `Pending` to `Shipped` (one-line doc commit if not done by the rebase).
- Branch pushed to origin.
- Optional: update `docs/architecture/plan-portable-runtime.md` phase table similarly.

Next phase pointer: PRD-002 §11 Phase 3 (SSH backend via Bun Shell `$`) becomes the next runnable phase.
