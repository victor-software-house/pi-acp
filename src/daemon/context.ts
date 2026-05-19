/**
 * Daemon-level shared state injected into per-connection PiAcpAgent instances.
 *
 * Phase 1 landed the interface + stub IdleTracker.
 * Phase 2 wires the real SessionRegistry.
 * Phase 3 will replace IdleTracker.
 */

import { createSessionRegistry, type SessionRegistry } from "@pi-acp/daemon/session-registry";

export interface DaemonContext {
	/** Cross-window session registry. PRD-003 FR-5. */
	sessionRegistry: SessionRegistry;
	/** Idle-shutdown tracker. Stub in Phase 1-2; real in Phase 3. */
	idleTracker: IdleTracker;
}

/** Phase-3 stub. Replaced when idle shutdown lands. */
export interface IdleTracker {
	bump(delta: 1 | -1): void;
	dispose(): void;
}

export type { SessionEntry, SessionRegistry } from "@pi-acp/daemon/session-registry";
export { createSessionRegistry } from "@pi-acp/daemon/session-registry";

export function createNoopIdleTracker(): IdleTracker {
	return {
		bump() {
			/* phase 3 wires this */
		},
		dispose() {
			/* phase 3 wires this */
		},
	};
}

export function createDaemonContext(): DaemonContext {
	return {
		sessionRegistry: createSessionRegistry(),
		idleTracker: createNoopIdleTracker(),
	};
}
