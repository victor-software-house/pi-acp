/**
 * Daemon-level shared state injected into per-connection PiAcpAgent instances.
 *
 * Phase 1 lands the interface plus stub implementations. Future phases (PRD-002
 * backends, PRD-003 SessionRegistry / IdleTracker) replace stubs with real
 * implementations registered at daemon startup.
 */

export interface DaemonContext {
	/** Cross-window session registry. Phase 2 of PRD-003. */
	sessionRegistry: SessionRegistry;
	/** Idle-shutdown tracker. Phase 3 of PRD-003. */
	idleTracker: IdleTracker;
}

/** Phase-1 stub. Replaced in Phase 2 (cross-window session visibility). */
export interface SessionRegistry {
	register(entry: SessionEntry): void;
	release(sessionId: string, connectionId: string): { disposed: boolean } | { unknown: true };
	listAll(): SessionEntry[];
	get(sessionId: string): SessionEntry | undefined;
}

export interface SessionEntry {
	sessionId: string;
	ownerConnectionId: string;
	alsoHeldBy: Set<string>;
}

/** Phase-1 stub. Replaced in Phase 3 (idle shutdown timer). */
export interface IdleTracker {
	bump(delta: 1 | -1): void;
	dispose(): void;
}

export function createStubSessionRegistry(): SessionRegistry {
	const map = new Map<string, SessionEntry>();
	return {
		register(entry) {
			map.set(entry.sessionId, entry);
		},
		release(sessionId, connectionId) {
			const entry = map.get(sessionId);
			if (!entry) return { unknown: true };
			entry.alsoHeldBy.delete(connectionId);
			if (entry.ownerConnectionId === connectionId && entry.alsoHeldBy.size === 0) {
				map.delete(sessionId);
				return { disposed: true };
			}
			return { disposed: false };
		},
		listAll() {
			return Array.from(map.values());
		},
		get(sessionId) {
			return map.get(sessionId);
		},
	};
}

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
		sessionRegistry: createStubSessionRegistry(),
		idleTracker: createNoopIdleTracker(),
	};
}
