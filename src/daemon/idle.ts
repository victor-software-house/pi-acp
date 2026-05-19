import type { IdleTracker } from "@pi-acp/daemon/context";

const DEFAULT_IDLE_SECONDS = 600;

export function createIdleTracker(opts: { idleMs: number; onIdle: () => void }): IdleTracker {
	let active = 0;
	let timer: ReturnType<typeof setTimeout> | null = null;

	const startTimer = (): void => {
		if (timer !== null) return;
		timer = setTimeout(opts.onIdle, opts.idleMs);
		timer.unref?.();
	};

	const stopTimer = (): void => {
		if (timer === null) return;
		clearTimeout(timer);
		timer = null;
	};

	// Cold start: no connections yet. Arm the timer so an unused daemon
	// shuts itself down even if the spawning client never connected.
	startTimer();

	return {
		bump(delta: 1 | -1) {
			active = Math.max(0, active + delta);
			if (active === 0) startTimer();
			else stopTimer();
		},
		dispose() {
			stopTimer();
		},
	};
}

export function resolveIdleMs(): number {
	const raw = process.env["PI_ACP_DAEMON_IDLE_SECONDS"];
	if (raw === undefined || raw === "") return DEFAULT_IDLE_SECONDS * 1000;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n) || n <= 0) return DEFAULT_IDLE_SECONDS * 1000;
	return n * 1000;
}
