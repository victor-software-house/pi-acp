/**
 * Daemon-level session registry. Maps sessionId -> live AgentSession plus
 * ownership refcount so that closing a session from one client does NOT
 * dispose the underlying pi runtime if another client also holds it.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";

export interface SessionEntry {
	sessionId: string;
	piSession: AgentSession;
	ownerConnectionId: string;
	alsoHeldBy: Set<string>;
	cwd: string;
	sessionFile: string | undefined;
	updatedAt: Date;
}

export interface SessionRegistry {
	register(entry: NewSessionEntry): void;
	attach(sessionId: string, connectionId: string): SessionEntry | undefined;
	release(sessionId: string, connectionId: string): ReleaseResult;
	get(sessionId: string): SessionEntry | undefined;
	listAll(): SessionEntry[];
	listOwnedBy(connectionId: string): SessionEntry[];
}

export interface NewSessionEntry {
	sessionId: string;
	piSession: AgentSession;
	ownerConnectionId: string;
	cwd: string;
	sessionFile: string | undefined;
}

export type ReleaseResult =
	| { kind: "disposed"; entry: SessionEntry }
	| { kind: "still-held"; entry: SessionEntry }
	| { kind: "unknown" };

export function createSessionRegistry(): SessionRegistry {
	const map = new Map<string, SessionEntry>();

	return {
		register(input) {
			const entry: SessionEntry = {
				sessionId: input.sessionId,
				piSession: input.piSession,
				ownerConnectionId: input.ownerConnectionId,
				alsoHeldBy: new Set<string>(),
				cwd: input.cwd,
				sessionFile: input.sessionFile,
				updatedAt: new Date(),
			};
			map.set(input.sessionId, entry);
		},

		attach(sessionId, connectionId) {
			const entry = map.get(sessionId);
			if (entry === undefined) return undefined;
			if (entry.ownerConnectionId !== connectionId) {
				entry.alsoHeldBy.add(connectionId);
				entry.updatedAt = new Date();
			}
			return entry;
		},

		release(sessionId, connectionId) {
			const entry = map.get(sessionId);
			if (entry === undefined) return { kind: "unknown" };

			if (entry.alsoHeldBy.delete(connectionId)) {
				entry.updatedAt = new Date();
				if (entry.ownerConnectionId === connectionId && entry.alsoHeldBy.size === 0) {
					map.delete(sessionId);
					return { kind: "disposed", entry };
				}
				return { kind: "still-held", entry };
			}

			if (entry.ownerConnectionId === connectionId) {
				if (entry.alsoHeldBy.size > 0) {
					// Hand ownership to one of the still-holders so the entry
					// keeps a coherent owner record. Pick first by iteration.
					const next = entry.alsoHeldBy.values().next().value;
					if (next !== undefined) {
						entry.alsoHeldBy.delete(next);
						entry.ownerConnectionId = next;
						entry.updatedAt = new Date();
						return { kind: "still-held", entry };
					}
				}
				map.delete(sessionId);
				return { kind: "disposed", entry };
			}

			return { kind: "still-held", entry };
		},

		get(sessionId) {
			return map.get(sessionId);
		},

		listAll() {
			return Array.from(map.values());
		},

		listOwnedBy(connectionId) {
			return Array.from(map.values()).filter(
				(e) => e.ownerConnectionId === connectionId || e.alsoHeldBy.has(connectionId),
			);
		},
	};
}
