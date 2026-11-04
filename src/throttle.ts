/** Injectable time and randomness so the scheduler is testable without real timers. */
export type SchedulerClock = {
	now: () => number;
	sleep: (ms: number) => Promise<void>;
	random: () => number;
};

/** Thrown when the waiting queue is at capacity. */
export class QueueFullError extends Error {
	constructor() {
		super("queue_full");
		this.name = "QueueFullError";
	}
}

/** Thrown when a key is paused after a bot challenge. `until` is epoch ms. */
export class ProfilePausedError extends Error {
	readonly key: string;
	readonly until: number;

	constructor(key: string, until: number) {
		super(`${key} paused until ${until}`);
		this.name = "ProfilePausedError";
		this.key = key;
		this.until = until;
	}
}

const MAX_TRACKED_KEYS = 256;
/** Longer than the largest pacing gap, so a forgotten key has no gap left to wait. */
const IDLE_AFTER_MS = 60_000;

/**
 * Single-slot FIFO scheduler for the one shared browser. Enforces a jittered
 * per-key gap between task starts, caps the waiting queue, and pauses a
 * key after a block.
 */
export class Scheduler {
	private tail: Promise<void> = Promise.resolve();
	/** Running plus waiting tasks. */
	private inFlight = 0;
	private readonly lastStart = new Map<string, number>();
	private readonly pausedUntilMs = new Map<string, number>();
	private readonly maxQueue: number;
	private readonly blockPauseMs: number;

	constructor(
		private readonly clock: SchedulerClock,
		opts: { maxQueue?: number; blockPauseMs?: number } = {},
	) {
		this.maxQueue = opts.maxQueue ?? 5;
		this.blockPauseMs = opts.blockPauseMs ?? 1_800_000;
	}

	/** Epoch ms when the key's pause ends, or undefined if not paused. */
	pausedUntil(key: string): number | undefined {
		const until = this.pausedUntilMs.get(key);
		return until !== undefined && this.clock.now() < until ? until : undefined;
	}

	/** Pause a key for `blockPauseMs` from now. */
	pause(key: string): void {
		this.pausedUntilMs.set(key, this.clock.now() + this.blockPauseMs);
	}

	/** Queue `task` behind all earlier tasks, honouring the key's gap and pause. */
	run<T>(
		key: string,
		minGapMs: readonly [number, number],
		task: () => Promise<T>,
	): Promise<T> {
		const until = this.pausedUntil(key);
		if (until !== undefined)
			return Promise.reject(new ProfilePausedError(key, until));
		// One in-flight task is running; maxQueue more may wait.
		if (this.inFlight > this.maxQueue)
			return Promise.reject(new QueueFullError());

		this.inFlight++;
		const result = this.tail.then(async () => {
			try {
				// Check the pause before and after the gap, so a paused task never
				// holds the only browser slot for its full gap.
				this.throwIfPaused(key);
				await this.waitForGap(key, minGapMs);
				this.throwIfPaused(key);
				this.lastStart.set(key, this.clock.now());
				this.pruneIdle();
				return await task();
			} finally {
				this.inFlight--;
			}
		});
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private pruneIdle(): void {
		if (this.lastStart.size <= MAX_TRACKED_KEYS) return;
		const now = this.clock.now();
		for (const [key, last] of this.lastStart)
			if (now - last > IDLE_AFTER_MS && this.pausedUntil(key) === undefined)
				this.lastStart.delete(key);
	}

	private throwIfPaused(key: string): void {
		const until = this.pausedUntil(key);
		if (until !== undefined) throw new ProfilePausedError(key, until);
	}

	private async waitForGap(
		key: string,
		minGapMs: readonly [number, number],
	): Promise<void> {
		const last = this.lastStart.get(key);
		if (last === undefined) return;
		const [min, max] = minGapMs;
		const gap = min + this.clock.random() * (max - min);
		const wait = last + gap - this.clock.now();
		if (wait > 0) await this.clock.sleep(wait);
	}
}
