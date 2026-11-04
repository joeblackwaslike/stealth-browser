import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCamoufoxFetcher } from "../src/browser.js";
import type { Challenge } from "../src/detect.js";
import { SolveBudgetExceededError, type Solver } from "../src/solver/index.js";

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
async function fakePlaywright(
	opts: {
		formEnclosesWidget?: boolean;
		submitDestroysContext?: boolean;
		navigationStatus?: number | null;
		secondPageStillSorry?: boolean;
		afterSubmit?: { html: string; url: string };
	} = {},
) {
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
	const navigationStatus =
		opts.navigationStatus === undefined ? 200 : opts.navigationStatus;
	const page = {
		goto: async () => ({ status: () => 429 }),
		waitForTimeout: async () => {},
		content: async () =>
			submitted && !opts.secondPageStillSorry
				? (opts.afterSubmit?.html ?? RESULTS_HTML)
				: firstHtml,
		url: () =>
			submitted && !opts.secondPageStillSorry
				? (opts.afterSubmit?.url ?? RESULTS_URL)
				: SORRY_URL,
		waitForNavigation: () => {
			navigationWaits++;
			return submit.then(() =>
				navigationStatus === null ? null : { status: () => navigationStatus },
			);
		},
		evaluate: async (_fn: unknown, token?: string | null) => {
			if (token === null) return opts.formEnclosesWidget !== false;
			if (token !== undefined) {
				injected.push(token);
				return opts.formEnclosesWidget !== false;
			}
			submitted = true;
			markSubmitted();
			if (opts.submitDestroysContext) {
				throw new Error(
					"Execution context was destroyed, most likely because of a navigation",
				);
			}
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

	it("counts the solve when the navigation tears down the submit's context", async () => {
		await fakePlaywright({ submitDestroysContext: true });
		const { solver } = recordingSolver(async () => "TOKEN");
		const fetcher = createCamoufoxFetcher("ws://fake/");
		const result = await fetcher.fetch({
			url: SORRY_URL,
			waitForTimeout: 0,
			solver,
		});
		expect(result).toMatchObject({
			html: RESULTS_HTML,
			finalUrl: RESULTS_URL,
			status: 200,
			solve: "solved",
		});
	});

	it("reports a null status, not the challenge's 429, when the navigation has no response", async () => {
		await fakePlaywright({ navigationStatus: null });
		const { solver } = recordingSolver(async () => "TOKEN");
		const fetcher = createCamoufoxFetcher("ws://fake/");
		const result = await fetcher.fetch({
			url: SORRY_URL,
			waitForTimeout: 0,
			solver,
		});
		expect(result).toMatchObject({
			html: RESULTS_HTML,
			status: null,
			solve: "solved",
		});
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
			solveReason: "unknown",
		});
	});

	it("returns the pre-solve page when no form encloses the widget", async () => {
		const fake = await fakePlaywright({ formEnclosesWidget: false });
		const { solver, seen } = recordingSolver(async () => "TOKEN");
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
			solveReason: "no_form",
		});
		expect(seen).toEqual([]);
		expect(fake.navigationWaits()).toBe(0);
	});

	it("reports a failed solve with challenge_remained when the destination still shows the challenge", async () => {
		const fake = await fakePlaywright({ secondPageStillSorry: true });
		const { solver, seen } = recordingSolver(async () => "TOKEN");
		const fetcher = createCamoufoxFetcher("ws://fake/");
		const result = await fetcher.fetch({
			url: SORRY_URL,
			waitForTimeout: 0,
			solver,
		});
		expect(seen).toHaveLength(1);
		expect(fake.injected).toEqual(["TOKEN"]);
		expect(result.html).toContain("g-recaptcha");
		expect(result).toMatchObject({
			finalUrl: SORRY_URL,
			status: 200,
			solve: "failed",
			solveReason: "challenge_remained",
		});
	});

	it("falls back to unknown for an error carrying an arbitrary code", async () => {
		const fake = await fakePlaywright();
		const { solver } = recordingSolver(async () => {
			throw Object.assign(new Error("socket reset"), {
				code: "ECONNRESET",
			});
		});
		const fetcher = createCamoufoxFetcher("ws://fake/");
		const result = await fetcher.fetch({
			url: SORRY_URL,
			waitForTimeout: 0,
			solver,
		});
		expect(fake.injected).toEqual([]);
		expect(result).toMatchObject({
			solve: "failed",
			solveReason: "unknown",
		});
	});

	it("reports budget_exceeded when the solver's budget wrapper rejects", async () => {
		const fake = await fakePlaywright();
		const { solver } = recordingSolver(async () => {
			throw new SolveBudgetExceededError(20);
		});
		const fetcher = createCamoufoxFetcher("ws://fake/");
		const result = await fetcher.fetch({
			url: SORRY_URL,
			waitForTimeout: 0,
			solver,
		});
		expect(fake.injected).toEqual([]);
		expect(result).toMatchObject({
			solve: "failed",
			solveReason: "budget_exceeded",
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
		await vi.advanceTimersByTimeAsync(300_000);
		expect(((await error) as Error).message).toContain("exceeded 195000ms");
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

describe("createCamoufoxFetcher solve failure detail", () => {
	it("carries the failed solve's error class and redacted message", async () => {
		await fakePlaywright();
		const secret = "s3cr3t-ws-path";
		const { solver } = recordingSolver(async () => {
			const error = new TypeError(`page crashed near ws://fake/${secret}`);
			throw error;
		});
		const fetcher = createCamoufoxFetcher(`ws://fake/${secret}`);
		const result = await fetcher.fetch({
			url: SORRY_URL,
			waitForTimeout: 0,
			solver,
		});
		expect(result).toMatchObject({
			solve: "failed",
			solveReason: "unknown",
			solveError: "TypeError: page crashed near <camoufox>",
		});
	});
});

describe("createCamoufoxFetcher post-submit challenge check", () => {
	it("reports challenge_remained for a widget without a sitekey, which the classifier still blocks", async () => {
		await fakePlaywright({
			afterSubmit: {
				html: '<html><body><form><div class="g-recaptcha"></div></form></body></html>',
				url: "https://shop.example.com/verify",
			},
		});
		const { solver } = recordingSolver(async () => "TOKEN");
		const result = await createCamoufoxFetcher("ws://fake/").fetch({
			url: SORRY_URL,
			waitForTimeout: 0,
			solver,
		});
		expect(result).toMatchObject({
			solve: "failed",
			solveReason: "challenge_remained",
		});
	});

	it("counts a solve as solved when a non-Google destination merely has a /sorry path", async () => {
		await fakePlaywright({
			afterSubmit: {
				html: RESULTS_HTML,
				url: "https://shop.example.com/sorry-we-moved",
			},
		});
		const { solver } = recordingSolver(async () => "TOKEN");
		const result = await createCamoufoxFetcher("ws://fake/").fetch({
			url: SORRY_URL,
			waitForTimeout: 0,
			solver,
		});
		expect(result).toMatchObject({ solve: "solved" });
	});
});
