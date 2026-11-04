import { describe, expect, it } from "vitest";
import { PROFILES } from "../src/profiles.js";
import {
	ProfilePausedError,
	QueueFullError,
	Scheduler,
	type SchedulerClock,
} from "../src/throttle.js";

const GAP = PROFILES.anon.minGapMs;
const EBAY = PROFILES.ebay.minGapMs;

function fakeClock(random = 0.5) {
	let t = 0;
	const clock: SchedulerClock = {
		now: () => t,
		sleep: async (ms) => {
			t += ms;
		},
		random: () => random,
	};
	return clock;
}

function deferred() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

describe("Scheduler", () => {
	it("runs one task at a time", async () => {
		const s = new Scheduler(fakeClock());
		const events: string[] = [];
		const gate = deferred();
		const a = s.run("anon", GAP, async () => {
			events.push("a:start");
			await gate.promise;
			events.push("a:end");
		});
		const b = s.run("anon", GAP, async () => {
			events.push("b:start");
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(events).toEqual(["a:start"]);
		gate.release();
		await Promise.all([a, b]);
		expect(events).toEqual(["a:start", "a:end", "b:start"]);
	});

	it("waits the per-profile gap between starts", async () => {
		const clock = fakeClock(0.5);
		const s = new Scheduler(clock);
		const starts: number[] = [];
		const task = async () => {
			starts.push(clock.now());
		};
		await Promise.all([s.run("ebay", EBAY, task), s.run("ebay", EBAY, task)]);
		expect(starts).toEqual([0, 30000]);
	});

	it("does not delay a different profile by another profile's gap", async () => {
		const clock = fakeClock(0.5);
		const s = new Scheduler(clock);
		const starts: number[] = [];
		const task = async () => {
			starts.push(clock.now());
		};
		await Promise.all([s.run("ebay", EBAY, task), s.run("anon", GAP, task)]);
		expect(starts).toEqual([0, 0]);
	});

	it("rejects the sixth waiting task with QueueFullError", async () => {
		const s = new Scheduler(fakeClock());
		const gate = deferred();
		const blocker = s.run("anon", GAP, () => gate.promise);
		const waiting = Array.from({ length: 5 }, () =>
			s.run("anon", GAP, async () => 1),
		);
		await expect(s.run("anon", GAP, async () => 1)).rejects.toBeInstanceOf(
			QueueFullError,
		);
		gate.release();
		await Promise.all([blocker, ...waiting]);
	});

	it("rejects with ProfilePausedError during a pause and accepts again after 1_800_000 ms", async () => {
		const clock = fakeClock();
		const s = new Scheduler(clock);
		s.pause("reddit");
		expect(s.pausedUntil("reddit")).toBe(1_800_000);
		const err = await s
			.run("reddit", GAP, async () => 1)
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ProfilePausedError);
		expect(err).toMatchObject({ key: "reddit", until: 1_800_000 });
		await expect(s.run("anon", GAP, async () => "ok")).resolves.toBe("ok");
		await clock.sleep(1_800_000);
		expect(s.pausedUntil("reddit")).toBeUndefined();
		await expect(s.run("reddit", GAP, async () => "ok")).resolves.toBe("ok");
	});

	it("rejects a queued task when its profile is paused before it starts", async () => {
		const s = new Scheduler(fakeClock());
		const gate = deferred();
		const a = s.run("anon", GAP, () => gate.promise);
		const b = s.run("ebay", EBAY, async () => 1);
		const bResult = b.catch((e: unknown) => e);
		s.pause("ebay");
		gate.release();
		await a;
		expect(await bResult).toBeInstanceOf(ProfilePausedError);
	});

	it("rejects a paused task without first sleeping its gap", async () => {
		const clock = fakeClock();
		const s = new Scheduler(clock);
		await s.run("ebay", EBAY, async () => 1);
		const gate = deferred();
		const a = s.run("anon", GAP, () => gate.promise);
		const b = s.run("ebay", EBAY, async () => 2).catch((e: unknown) => e);
		s.pause("ebay");
		const before = clock.now();
		gate.release();
		await a;
		expect(await b).toBeInstanceOf(ProfilePausedError);
		expect(clock.now()).toBe(before);
	});

	it("two keys do not share a gap", async () => {
		const clock = fakeClock(0.5);
		const s = new Scheduler(clock);
		const starts: number[] = [];
		const task = async () => {
			starts.push(clock.now());
		};
		await Promise.all([
			s.run("a.example", GAP, task),
			s.run("b.example", GAP, task),
			s.run("a.example", GAP, task),
		]);
		expect(starts).toEqual([0, 0, 5500]);
	});

	it("pausing one key leaves another runnable", async () => {
		const s = new Scheduler(fakeClock());
		s.pause("a.example");
		await expect(s.run("a.example", GAP, async () => 1)).rejects.toBeInstanceOf(
			ProfilePausedError,
		);
		await expect(s.run("b.example", GAP, async () => "ok")).resolves.toBe("ok");
		expect(s.pausedUntil("b.example")).toBeUndefined();
	});

	it("releases the slot when a task throws", async () => {
		const s = new Scheduler(fakeClock());
		await expect(
			s.run("anon", GAP, async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		await expect(s.run("anon", GAP, async () => "next")).resolves.toBe("next");
	});

	it("keeps pacing recent hosts after pruning idle ones", async () => {
		const clock = fakeClock(0.5);
		const s = new Scheduler(clock);
		const task = async () => undefined;
		await s.run("idle.example", GAP, task);
		await clock.sleep(61_000);
		await s.run("recent.example", GAP, task);
		for (let i = 0; i < 257; i++) await s.run(`h${i}.example`, GAP, task);
		const before = clock.now();
		await s.run("idle.example", GAP, task);
		expect(clock.now()).toBe(before);
		await s.run("recent.example", GAP, task);
		expect(clock.now()).toBe(before + 5500);
	});

	it("keeps a paused host paused after pruning", async () => {
		const clock = fakeClock(0.5);
		const s = new Scheduler(clock);
		const task = async () => undefined;
		await s.run("paused.example", GAP, task);
		s.pause("paused.example");
		await clock.sleep(61_000);
		for (let i = 0; i < 257; i++) await s.run(`h${i}.example`, GAP, task);
		expect(s.pausedUntil("paused.example")).toBeDefined();
	});
});
