import type { Profile, ProfileName } from "./profiles.js";

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

/** Thrown when a profile is paused after a bot challenge. `until` is epoch ms. */
export class ProfilePausedError extends Error {
	readonly profile: ProfileName;
	readonly until: number;

	constructor(profile: ProfileName, until: number) {
		super(`profile ${profile} paused until ${until}`);
		this.name = "ProfilePausedError";
		this.profile = profile;
		this.until = until;
	}
}

/**
 * Single-slot FIFO scheduler for the one shared browser. Enforces a jittered
 * per-profile gap between task starts, caps the waiting queue, and pauses a
 * profile after a block.
 */
export class Scheduler {
	private tail: Promise<void> = Promise.resolve();
	/** Running plus waiting tasks. */
	private inFlight = 0;
	private readonly lastStart = new Map<ProfileName, number>();
	private readonly pausedUntilMs = new Map<ProfileName, number>();
	private readonly maxQueue: number;
	private readonly blockPauseMs: number;

	constructor(
		private readonly profiles: Readonly<Record<ProfileName, Profile>>,
		private readonly clock: SchedulerClock,
		opts: { maxQueue?: number; blockPauseMs?: number } = {},
	) {
		this.maxQueue = opts.maxQueue ?? 5;
		this.blockPauseMs = opts.blockPauseMs ?? 1_800_000;
	}

	/** Epoch ms when the profile's pause ends, or undefined if not paused. */
	pausedUntil(profile: ProfileName): number | undefined {
		const until = this.pausedUntilMs.get(profile);
		return until !== undefined && this.clock.now() < until ? until : undefined;
	}

	/** Pause a profile for `blockPauseMs` from now. */
	pause(profile: ProfileName): void {
		this.pausedUntilMs.set(profile, this.clock.now() + this.blockPauseMs);
	}

	/** Queue `task` behind all earlier tasks, honouring the profile's gap and pause. */
	run<T>(profile: ProfileName, task: () => Promise<T>): Promise<T> {
		const until = this.pausedUntil(profile);
		if (until !== undefined)
			return Promise.reject(new ProfilePausedError(profile, until));
		// One in-flight task is running; maxQueue more may wait.
		if (this.inFlight > this.maxQueue)
			return Promise.reject(new QueueFullError());

		this.inFlight++;
		const result = this.tail.then(async () => {
			try {
				await this.waitForGap(profile);
				const pausedUntil = this.pausedUntil(profile);
				if (pausedUntil !== undefined)
					throw new ProfilePausedError(profile, pausedUntil);
				this.lastStart.set(profile, this.clock.now());
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

	private async waitForGap(profile: ProfileName): Promise<void> {
		const last = this.lastStart.get(profile);
		if (last === undefined) return;
		const [min, max] = this.profiles[profile].minGapMs;
		const gap = min + this.clock.random() * (max - min);
		const wait = last + gap - this.clock.now();
		if (wait > 0) await this.clock.sleep(wait);
	}
}
