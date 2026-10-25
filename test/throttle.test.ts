import { describe, expect, it } from "vitest";
import { PROFILES } from "../src/profiles.js";
import {
	ProfilePausedError,
	QueueFullError,
	Scheduler,
	type SchedulerClock,
} from "../src/throttle.js";

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
		const s = new Scheduler(PROFILES, fakeClock());
		const events: string[] = [];
		const gate = deferred();
		const a = s.run("anon", async () => {
			events.push("a:start");
			await gate.promise;
			events.push("a:end");
		});
		const b = s.run("anon", async () => {
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
		const s = new Scheduler(PROFILES, clock);
		const starts: number[] = [];
		const task = async () => {
			starts.push(clock.now());
		};
		await Promise.all([s.run("ebay", task), s.run("ebay", task)]);
		expect(starts).toEqual([0, 30000]);
	});

	it("does not delay a different profile by another profile's gap", async () => {
		const clock = fakeClock(0.5);
		const s = new Scheduler(PROFILES, clock);
		const starts: number[] = [];
		const task = async () => {
			starts.push(clock.now());
		};
		await Promise.all([s.run("ebay", task), s.run("anon", task)]);
		expect(starts).toEqual([0, 0]);
	});

	it("rejects the sixth waiting task with QueueFullError", async () => {
		const s = new Scheduler(PROFILES, fakeClock());
		const gate = deferred();
		const blocker = s.run("anon", () => gate.promise);
		const waiting = Array.from({ length: 5 }, () =>
			s.run("anon", async () => 1),
		);
		await expect(s.run("anon", async () => 1)).rejects.toBeInstanceOf(
			QueueFullError,
		);
		gate.release();
		await Promise.all([blocker, ...waiting]);
	});

	it("rejects with ProfilePausedError during a pause and accepts again after 1_800_000 ms", async () => {
		const clock = fakeClock();
		const s = new Scheduler(PROFILES, clock);
		s.pause("reddit");
		expect(s.pausedUntil("reddit")).toBe(1_800_000);
		const err = await s.run("reddit", async () => 1).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ProfilePausedError);
		expect(err).toMatchObject({ profile: "reddit", until: 1_800_000 });
		await expect(s.run("anon", async () => "ok")).resolves.toBe("ok");
		await clock.sleep(1_800_000);
		expect(s.pausedUntil("reddit")).toBeUndefined();
		await expect(s.run("reddit", async () => "ok")).resolves.toBe("ok");
	});

	it("rejects a queued task when its profile is paused before it starts", async () => {
		const s = new Scheduler(PROFILES, fakeClock());
		const gate = deferred();
		const a = s.run("anon", () => gate.promise);
		const b = s.run("ebay", async () => 1);
		const bResult = b.catch((e: unknown) => e);
		s.pause("ebay");
		gate.release();
		await a;
		expect(await bResult).toBeInstanceOf(ProfilePausedError);
	});

	it("rejects a paused task without first sleeping its gap", async () => {
		const clock = fakeClock();
		const s = new Scheduler(PROFILES, clock);
		await s.run("ebay", async () => 1);
		const gate = deferred();
		const a = s.run("anon", () => gate.promise);
		const b = s.run("ebay", async () => 2).catch((e: unknown) => e);
		s.pause("ebay");
		const before = clock.now();
		gate.release();
		await a;
		expect(await b).toBeInstanceOf(ProfilePausedError);
		expect(clock.now()).toBe(before);
	});

	it("releases the slot when a task throws", async () => {
		const s = new Scheduler(PROFILES, fakeClock());
		await expect(
			s.run("anon", async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		await expect(s.run("anon", async () => "next")).resolves.toBe("next");
	});
});
