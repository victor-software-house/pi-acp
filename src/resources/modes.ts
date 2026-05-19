/**
 * Cwd-independence modes (PRD-002 §FR-5).
 *
 * | Mode      | cwd handling                               | Tool target   |
 * |-----------|--------------------------------------------|---------------|
 * | `local`   | ACP params.cwd (must be absolute)          | params.cwd    |
 * | `overlay` | same as local — manifest aux roots compose | params.cwd    |
 * | `none`    | substitute ephemeral tmpdir                | tmpdir        |
 *
 * `local` and `overlay` are functionally identical in the current substrate
 * because `VirtualResourceLoader` always overlays manifest roots on top of
 * the implicit local root. The `overlay` keyword is retained for
 * forward-compatibility and operator clarity (declaring `mode: overlay`
 * documents the intent even if the runtime path is the same).
 *
 * `none` mints `mkdtemp(...)` under the OS tmpdir and returns a cleanup
 * thunk the caller must invoke at session close. The cleanup is
 * best-effort — never throws — so a session dispose path that runs it
 * after the directory has already been removed is safe.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Manifest } from "@pi-acp/resources/manifest.schema";

export type CwdMode = Manifest["mode"];

export interface ResolveModeInput {
	manifest: Manifest;
	requestedCwd: string;
}

export interface ResolveModeResult {
	mode: CwdMode;
	/**
	 * Effective cwd to thread through pi and ACP session updates. For
	 * `local` / `overlay` this echoes `requestedCwd`; for `none` it's a
	 * freshly-minted tmpdir.
	 */
	cwd: string;
	/**
	 * Best-effort cleanup. Always defined to simplify caller wiring; a
	 * no-op for `local` / `overlay`. Idempotent.
	 */
	cleanup: () => void;
	/**
	 * True when the resolver created an ephemeral directory the caller
	 * does NOT own. Useful for diagnostics + skipping the absolute-path
	 * guard in callers that would normally reject a synthetic cwd.
	 */
	ephemeral: boolean;
}

const TMPDIR_PREFIX = "pi-acp-session-";

export function resolveMode(input: ResolveModeInput): ResolveModeResult {
	const mode = input.manifest.mode;

	if (mode === "none") {
		const dir = mkdtempSync(join(tmpdir(), TMPDIR_PREFIX));
		let removed = false;
		const cleanup = (): void => {
			if (removed) return;
			removed = true;
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				// best-effort — fall through silently
			}
		};
		return { mode, cwd: dir, cleanup, ephemeral: true };
	}

	// local + overlay: pass requestedCwd through untouched.
	return {
		mode,
		cwd: input.requestedCwd,
		cleanup: () => {},
		ephemeral: false,
	};
}
