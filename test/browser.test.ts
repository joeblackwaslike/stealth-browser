import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCamoufoxFetcher } from "../src/browser.js";
import type { Challenge } from "../src/detect.js";
import type { Solver } from "../src/solver/index.js";

const fakeConnect = vi.hoisted(() => ({
	browser: undefined as unknown,
}));

vi.mock("playwright-core", async (importOriginal) => {
	const real = await importOriginal<typeof import("playwright-core")>();
	return {
		...real,
		firefox: {
			connect: (...args: Parameters<typeof real.firefox.connect>) =>
				fakeConnect.browser
					? Promise.resolve(fakeConnect.browser)
					: real.firefox.connect(...args),
		},
	};
});

afterEach(() => {
	fakeConnect.browser = undefined;
	vi.useRealTimers();
});

const SORRY_URL = "https://www.google.com/sorry/index?continue=x";
const RESULTS_URL = "https://www.google.com/search?q=x";
const RESULTS_HTML = "<html><body>results</body></html>";

/** A connected fake browser whose page shows `firstHtml` until the form is submitted. */
async function fakePlaywright(opts: { formEnclosesWidget?: boolean } = {}) {
	const firstHtml = await readFile(
		new URL("./fixtures/google-sorry.html", import.meta.url),
		"utf8",
	);
	const injected: string[] = [];
	let navigationWaits = 0;
	let submitted = false;
	let markSubmitted!: () => void;
	const submit = new Promise<void>((resolve) => {
		markSubmitted = resolve;
	});
	const page = {
		goto: async () => ({ status: () => 429 }),
		waitForTimeout: async () => {},
		content: async () => (submitted ? RESULTS_HTML : firstHtml),
		url: () => (submitted ? RESULTS_URL : SORRY_URL),
		waitForNavigation: () => {
			navigationWaits++;
			return submit.then(() => ({ status: () => 200 }));
		},
		evaluate: async (_fn: unknown, token: string) => {
			injected.push(token);
			if (opts.formEnclosesWidget === false) return false;
			submitted = true;
			markSubmitted();
			return true;
		},
	};
	const context = {
		route: async () => {},
		newPage: async () => page,
		storageState: async () => ({
			cookies: submitted ? [{ name: "after-solve" }] : [],
			origins: [],
		}),
		close: async () => {},
	};
	fakeConnect.browser = {
		isConnected: () => true,
		on: () => {},
		newContext: async () => context,
		close: async () => {},
	};
	return {
		injected,
		navigationWaits: () => navigationWaits,
	};
}

function recordingSolver(result: () => Promise<string>) {
	const seen: Challenge[] = [];
	const solver: Solver = {
		solve: (challenge) => {
			seen.push(challenge);
			return result();
		},
	};
	return { solver, seen };
}

describe("createCamoufoxFetcher solving", () => {
	it("solves a detected challenge once, submits the token and returns the next page", async () => {
		const fake = await fakePlaywright();
		const { solver, seen } = recordingSolver(async () => "TOKEN");
		const fetcher = createCamoufoxFetcher("ws://fake/");
		const result = await fetcher.fetch({
			url: SORRY_URL,
			waitForTimeout: 0,
			solver,
		});
		expect(seen).toEqual([
			{
				type: "recaptcha_v2",
				sitekey: "SITEKEY123",
				pageUrl: SORRY_URL,
				dataS: "DATAS456",
			},
		]);
		expect(fake.injected).toEqual(["TOKEN"]);
		expect(result).toMatchObject({
			html: RESULTS_HTML,
			finalUrl: RESULTS_URL,
			status: 200,
			solve: "solved",
		});
		expect(result.storageState.cookies.map((c) => c.name)).toEqual([
			"after-solve",
		]);
	});

	it("returns the pre-solve page when the solver rejects", async () => {
		const fake = await fakePlaywright();
		const { solver, seen } = recordingSolver(async () => {
			throw new Error("solver budget exceeded");
		});
		const fetcher = createCamoufoxFetcher("ws://fake/");
		const result = await fetcher.fetch({
			url: SORRY_URL,
			waitForTimeout: 0,
			solver,
		});
		expect(seen).toHaveLength(1);
		expect(fake.injected).toEqual([]);
		expect(result.html).toContain("g-recaptcha");
		expect(result).toMatchObject({
			finalUrl: SORRY_URL,
			status: 429,
			solve: "failed",
		});
	});

	it("returns the pre-solve page when no form encloses the widget", async () => {
		await fakePlaywright({ formEnclosesWidget: false });
		const { solver } = recordingSolver(async () => "TOKEN");
		const fetcher = createCamoufoxFetcher("ws://fake/");
		const result = await fetcher.fetch({
			url: SORRY_URL,
			waitForTimeout: 0,
			solver,
		});
		expect(result.html).toContain("g-recaptcha");
		expect(result).toMatchObject({
			finalUrl: SORRY_URL,
			status: 429,
			solve: "failed",
		});
	});

	it("never solves or submits without a solver", async () => {
		const fake = await fakePlaywright();
		const fetcher = createCamoufoxFetcher("ws://fake/");
		const result = await fetcher.fetch({ url: SORRY_URL, waitForTimeout: 0 });
		expect(fake.injected).toEqual([]);
		expect(fake.navigationWaits()).toBe(0);
		expect(result.html).toContain("g-recaptcha");
		expect(result).not.toHaveProperty("solve");
	});

	it("extends the request deadline by the solver timeout when a solver is set", async () => {
		vi.useFakeTimers();
		await fakePlaywright();
		const { solver } = recordingSolver(() => new Promise<string>(() => {}));
		const fetcher = createCamoufoxFetcher("ws://fake/", {
			connectTimeoutMs: 0,
		});
		const error = fetcher
			.fetch({ url: SORRY_URL, waitForTimeout: 0, solver })
			.catch((e: unknown) => e);
		await vi.advanceTimersByTimeAsync(200_000);
		expect(((await error) as Error).message).toContain("exceeded 165000ms");
	});
});

describe("createCamoufoxFetcher", () => {
	it("never leaks the ws path in connect errors", async () => {
		const secret = "s3cr3t-ws-path-0123456789abcdef";
		const fetcher = createCamoufoxFetcher(`ws://127.0.0.1:1/${secret}`);
		const error = await fetcher
			.fetch({ url: "https://example.com/", waitForTimeout: 0 })
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).not.toContain(secret);
		await fetcher.close();
	});

	it("rejects within the deadline when the server never completes the handshake", async () => {
		const secret = "hang-ws-path-0123456789abcdef";
		const server = createServer(() => {});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const { port } = server.address() as AddressInfo;
		const fetcher = createCamoufoxFetcher(`ws://127.0.0.1:${port}/${secret}`, {
			connectTimeoutMs: 300,
			requestDeadlineMs: 600,
		});
		const started = Date.now();
		const error = await fetcher
			.fetch({ url: "https://example.com/", waitForTimeout: 0 })
			.catch((e: unknown) => e);
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).not.toContain(secret);
		await fetcher.close();
		server.close();
	}, 10_000);

	it("holds a timed-out request until its abandoned work settles, so the scheduler can't overlap it", async () => {
		const server = createServer(() => {});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const { port } = server.address() as AddressInfo;
		const fetcher = createCamoufoxFetcher(`ws://127.0.0.1:${port}/x`, {
			connectTimeoutMs: 800,
			requestDeadlineMs: 100,
		});
		const started = Date.now();
		const error = await fetcher
			.fetch({ url: "https://example.com/", waitForTimeout: 0 })
			.catch((e: unknown) => e);
		expect((error as Error).message).toContain("exceeded 100ms");
		expect(Date.now() - started).toBeGreaterThanOrEqual(700);
		await fetcher.close();
		server.close();
	}, 10_000);
});
