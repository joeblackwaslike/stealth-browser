import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AppDeps, createApp } from "../src/app.js";
import type { Fetcher, FetchRequest, FetchResult } from "../src/browser.js";
import type { Solver } from "../src/solver/index.js";
import {
	createStateStore,
	type StateStore,
	type StorageState,
} from "../src/state-store.js";
import { Scheduler } from "../src/throttle.js";

const TOKEN = "test-token";
const auth = { authorization: `Bearer ${TOKEN}` };
function cookie(name: string): StorageState["cookies"][number] {
	return {
		name,
		value: "v",
		domain: ".reddit.com",
		path: "/",
		expires: -1,
		httpOnly: true,
		secure: true,
		sameSite: "Lax",
	};
}
const stateWith = (...names: string[]): StorageState => ({
	cookies: names.map(cookie),
	origins: [],
});

function deferred() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

const CHALLENGE = '<form><div class="g-recaptcha"></div></form>';

const okResult = (
	url: string,
	storageState = stateWith(),
	html = "<html><body>hello</body></html>",
) => ({ html, finalUrl: url, status: 200, storageState });

let dir: string;
let store: StateStore;
let calls: number;
let sleeps: number[];

function build(
	fetcher: Fetcher,
	logger = pino({ level: "silent" }) as AppDeps["logger"],
	solver?: Solver,
) {
	const counted: Fetcher = (req) => {
		calls++;
		return fetcher(req);
	};
	const clock = {
		now: () => 1_000_000,
		sleep: async (ms: number) => {
			sleeps.push(ms);
		},
		random: () => 0,
	};
	return createApp({
		token: TOKEN,
		fetcher: counted,
		scheduler: new Scheduler(clock),
		store,
		logger,
		now: clock.now,
		solver,
	});
}

const post = (app: ReturnType<typeof build>, body: unknown) =>
	app.request("/content", {
		method: "POST",
		headers: { ...auth, "content-type": "application/json" },
		body: JSON.stringify(body),
	});

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "app-test-"));
	store = createStateStore(dir);
	calls = 0;
	sleeps = [];
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("app", () => {
	it("rejects requests without the bearer token", async () => {
		const app = build(async (r) => okResult(r.url));
		expect((await app.request("/healthz")).status).toBe(401);
		expect((await app.request("/healthz", { headers: auth })).status).toBe(200);
	});

	it("returns html and X-Final-Url for an ok anon page", async () => {
		const app = build(async () =>
			okResult("https://example.com/final", stateWith(), "<p>hi</p>"),
		);
		const res = await post(app, { url: "https://example.com/" });
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
		expect(res.headers.get("x-final-url")).toBe("https://example.com/final");
		expect(await res.text()).toBe("<p>hi</p>");
	});

	it("returns 401 session_expired for ebay with no saved state and never calls the fetcher", async () => {
		const app = build(async (r) => okResult(r.url));
		const res = await post(app, { url: "https://www.ebay.com/itm/1" });
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({
			session_expired: true,
			profile: "ebay",
		});
		expect(calls).toBe(0);
	});

	it("423 body carries host, marker, html and capture", async () => {
		const html = CHALLENGE;
		const app = build(async (r) => okResult(r.url, stateWith(), html));
		const res = await post(app, { url: "https://example.com/" });
		expect(res.status).toBe(423);
		const body = (await res.json()) as { capture: string };
		expect(body).toEqual({
			blocked: true,
			profile: "anon",
			host: "example.com",
			reason: "captcha",
			marker: "captcha_widget:g-recaptcha",
			html,
			capture: expect.stringMatching(/^anon-blocked-.*\.html$/),
		});
		expect(await readFile(join(dir, "captures", body.capture), "utf8")).toBe(
			html,
		);
	});

	it("omits capture when the capture write fails", async () => {
		store = {
			...store,
			saveCapture: async () => {
				throw new Error("ENOSPC");
			},
		};
		const app = build(async (r) => okResult(r.url, stateWith(), CHALLENGE));
		const res = await post(app, { url: "https://example.com/" });
		expect(res.status).toBe(423);
		const body = await res.json();
		expect(body).toMatchObject({ blocked: true, html: CHALLENGE });
		expect(body).not.toHaveProperty("capture");
	});

	it("an unsolved challenge on anon returns 423 and does not pause the host", async () => {
		const app = build(async (r) => okResult(r.url, stateWith(), CHALLENGE));
		expect((await post(app, { url: "https://example.com/" })).status).toBe(423);
		const second = await post(app, { url: "https://example.com/" });
		expect(second.status).toBe(423);
		expect(await second.json()).toMatchObject({ reason: "captcha" });
		expect(calls).toBe(2);
	});

	it("an unsolved challenge on ebay pauses ebay", async () => {
		await store.write("ebay", stateWith("s"));
		const app = build(async (r) => okResult(r.url, stateWith(), CHALLENGE));
		expect(
			(await post(app, { url: "https://www.ebay.com/itm/1" })).status,
		).toBe(423);
		const second = await post(app, { url: "https://www.ebay.com/itm/2" });
		expect(second.status).toBe(423);
		expect(await second.json()).toEqual({
			blocked: true,
			profile: "ebay",
			reason: "paused",
		});
		expect(Number(second.headers.get("retry-after"))).toBe(1800);
		expect(calls).toBe(1);
	});

	it("a block on one unknown host does not pause another unknown host", async () => {
		const app = build(async (r) =>
			r.url.includes("blocked.example")
				? okResult(r.url, stateWith(), CHALLENGE)
				: okResult(r.url),
		);
		await post(app, { url: "https://blocked.example/" });
		const other = await post(app, { url: "https://other.example/" });
		expect(other.status).toBe(200);
		expect(calls).toBe(2);
	});

	it("paces each unknown host on its own key with the anon gap", async () => {
		const app = build(async (r) => okResult(r.url));
		await post(app, { url: "https://one.example/" });
		await post(app, { url: "https://two.example/" });
		expect(sleeps).toEqual([]);
		await post(app, { url: "https://one.example/again" });
		expect(sleeps).toHaveLength(1);
		expect(sleeps[0]).toBeGreaterThanOrEqual(3000);
	});

	it("paces eBay with eBay's gap", async () => {
		await store.write("ebay", stateWith("s"));
		const app = build(async (r) => okResult(r.url));
		await post(app, { url: "https://www.ebay.com/itm/1" });
		await post(app, { url: "https://www.ebay.com/itm/2" });
		expect(sleeps).toHaveLength(1);
		expect(sleeps[0]).toBeGreaterThanOrEqual(20000);
	});

	it("with a spent budget on ebay the challenge stays unsolved and blocks and pauses", async () => {
		await store.write("ebay", stateWith("s"));
		const app = build(
			async (r) => ({
				...okResult(r.url, stateWith(), CHALLENGE),
				solve: "failed",
				solveReason: "budget_exceeded",
			}),
			undefined,
			{ solve: async () => "TOKEN" },
		);
		const first = await post(app, { url: "https://www.ebay.com/itm/1" });
		expect(first.status).toBe(423);
		expect(await first.json()).toMatchObject({
			marker: "captcha_widget:g-recaptcha",
		});
		const second = await post(app, { url: "https://www.ebay.com/itm/2" });
		expect(await second.json()).toMatchObject({ reason: "paused" });
		expect(calls).toBe(1);
	});

	it("routes by URL and ignores a caller-supplied profile, so eBay pacing can't be bypassed", async () => {
		const app = build(async (r) => okResult(r.url));
		const res = await post(app, {
			url: "https://www.ebay.com/itm/1",
			profile: "anon",
		});
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({
			session_expired: true,
			profile: "ebay",
		});
		expect(calls).toBe(0);
	});

	it("still returns the page when saving the refreshed login fails", async () => {
		await store.write("reddit", stateWith("reddit_session"));
		store = {
			...store,
			writeIfUnchanged: async () => {
				throw new Error("disk full");
			},
		};
		const app = build(async (r) =>
			okResult(r.url, stateWith("reddit_session")),
		);
		const res = await post(app, { url: "https://www.reddit.com/r/x" });
		expect(res.status).toBe(200);
	});

	it("reads the saved login inside the queue, so a waiting request gets the state the previous one saved", async () => {
		await store.write("reddit", stateWith("a", "reddit_session"));
		const gate = deferred();
		const seen: string[][] = [];
		const app = build(async (r) => {
			seen.push((r.storageState?.cookies ?? []).map((c) => c.name));
			if (seen.length === 1) await gate.promise;
			return okResult(r.url, stateWith("b", "reddit_session"));
		});
		const first = post(app, { url: "https://www.reddit.com/r/x" });
		const second = post(app, { url: "https://www.reddit.com/r/y" });
		await new Promise((resolve) => setTimeout(resolve, 20));
		gate.release();
		expect((await first).status).toBe(200);
		expect((await second).status).toBe(200);
		expect(seen[1]).toEqual(["b", "reddit_session"]);
	});

	it("pauses the profile before the next queued request can start", async () => {
		await store.write("ebay", stateWith("s"));
		const gate = deferred();
		const app = build(async (r) => {
			if (calls === 1) {
				await gate.promise;
				return okResult(
					r.url,
					stateWith(),
					'<form><div class="g-recaptcha"></div></form>',
				);
			}
			return okResult(r.url);
		});
		const first = post(app, { url: "https://www.ebay.com/itm/a" });
		const second = post(app, { url: "https://www.ebay.com/itm/b" });
		await new Promise((resolve) => setTimeout(resolve, 20));
		gate.release();
		expect((await first).status).toBe(423);
		const res = await second;
		expect(res.status).toBe(423);
		expect(await res.json()).toMatchObject({ reason: "paused" });
		expect(calls).toBe(1);
	});

	it("returns a structured 500 when the saved login can't be read", async () => {
		store = {
			...store,
			read: async () => {
				throw new Error("EIO");
			},
		};
		const app = build(async (r) => okResult(r.url));
		const res = await post(app, { url: "https://www.reddit.com/r/x" });
		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({
			error: "state_unavailable",
			profile: "reddit",
		});
		expect(calls).toBe(0);
	});

	it("returns a structured 500 when an uploaded login can't be saved", async () => {
		store = {
			...store,
			write: async () => {
				throw new Error("ENOSPC");
			},
		};
		const app = build(async (r) => okResult(r.url));
		const res = await app.request("/profiles/reddit/state", {
			method: "PUT",
			headers: { ...auth, "content-type": "application/json" },
			body: JSON.stringify(stateWith("reddit_session")),
		});
		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({
			error: "state_write_failed",
			profile: "reddit",
		});
	});

	it("logs the underlying error when navigation fails", async () => {
		const lines: string[] = [];
		const logger = pino(
			{ level: "warn" },
			{ write: (line: string) => void lines.push(line) },
		);
		const app = build(async () => {
			throw new Error("NS_ERROR_CONNECTION_REFUSED");
		}, logger);
		const res = await post(app, { url: "https://example.com/" });
		expect(res.status).toBe(502);
		expect(lines.join("")).toContain("NS_ERROR_CONNECTION_REFUSED");
	});

	it("returns 400 for a cluster-internal url", async () => {
		const app = build(async (r) => okResult(r.url));
		const res = await post(app, {
			url: "http://camoufox.stealth-browser.svc.cluster.local:3000",
		});
		expect(res.status).toBe(400);
		expect(calls).toBe(0);
	});

	it("returns 400 for waitForTimeout above 15000", async () => {
		const app = build(async (r) => okResult(r.url));
		const res = await post(app, {
			url: "https://example.com/",
			waitForTimeout: 15001,
		});
		expect(res.status).toBe(400);
		expect((await res.json()) as { error: string }).toMatchObject({
			error: "invalid_request",
		});
	});

	it("returns 429 when the queue is full", async () => {
		const gate = deferred();
		const app = build(async (r) => {
			await gate.promise;
			return okResult(r.url);
		});
		const inflight = Array.from({ length: 6 }, () =>
			post(app, { url: "https://example.com/" }),
		);
		await new Promise((resolve) => setTimeout(resolve, 50));
		const res = await post(app, { url: "https://example.com/" });
		expect(res.status).toBe(429);
		expect(await res.json()).toEqual({ error: "queue_full" });
		gate.release();
		const settled = await Promise.all(inflight);
		expect(settled.every((r) => r.status === 200)).toBe(true);
	});

	it("keeps a login uploaded mid-scrape", async () => {
		const stateA = stateWith("a");
		const stateB = stateWith("b");
		await store.write("reddit", stateA);
		const gate = deferred();
		const app = build(async (r) => {
			await gate.promise;
			return okResult(r.url, stateWith("a", "reddit_session"));
		});
		const pending = post(app, { url: "https://www.reddit.com/r/x" });
		await new Promise((resolve) => setTimeout(resolve, 20));
		const put = await app.request("/profiles/reddit/state", {
			method: "PUT",
			headers: { ...auth, "content-type": "application/json" },
			body: JSON.stringify(stateB),
		});
		expect(put.status).toBe(204);
		gate.release();
		expect((await pending).status).toBe(200);
		expect((await store.read("reddit"))?.state).toEqual(stateB);
	});

	it("passes the solver to the fetcher for every profile", async () => {
		await store.write("ebay", stateWith("s"));
		const solver: Solver = { solve: async () => "TOKEN" };
		const seen: FetchRequest[] = [];
		const app = build(
			async (r) => {
				seen.push(r);
				return okResult(r.url);
			},
			undefined,
			solver,
		);
		await post(app, { url: "https://www.google.com/a" });
		await post(app, { url: "https://example.com/b" });
		await post(app, { url: "https://www.ebay.com/itm/1" });
		expect(seen.map((r) => r.solver)).toEqual([solver, solver, solver]);
	});

	it("a signup form with a widget returns 200", async () => {
		const html =
			'<form><input type="email" name="e"><div class="g-recaptcha"></div></form>';
		const app = build(async (r) => okResult(r.url, stateWith(), html));
		const res = await post(app, { url: "https://example.com/signup" });
		expect(res.status).toBe(200);
		expect(await res.text()).toBe(html);
	});

	it("turns a failed solve on google's sorry page into a 423 that does not pause google", async () => {
		const sorry = await readFile(
			new URL("./fixtures/google-sorry.html", import.meta.url),
			"utf8",
		);
		const app = build(
			async () => ({
				html: sorry,
				finalUrl: "https://www.google.com/sorry/index?continue=x",
				status: 429,
				storageState: stateWith(),
				solve: "failed",
				solveReason: "timeout",
			}),
			undefined,
			{ solve: async () => "TOKEN" },
		);
		const first = await post(app, { url: "https://www.google.com/search?q=x" });
		expect(first.status).toBe(423);
		expect(await first.json()).toMatchObject({
			blocked: true,
			profile: "google",
			reason: "google_sorry",
			marker: "google_sorry",
		});
		const second = await post(app, {
			url: "https://www.google.com/search?q=x",
		});
		expect(second.status).toBe(423);
		expect(await second.json()).toMatchObject({ reason: "google_sorry" });
		expect(calls).toBe(2);
	});

	it("logs the solve outcome, and warns without the token when it failed", async () => {
		const lines: string[] = [];
		const logger = pino(
			{ level: "info" },
			{ write: (line: string) => void lines.push(line) },
		) as AppDeps["logger"];
		const app = build(
			async (r) => ({
				...okResult(r.url),
				solve: "failed",
				solveReason: "timeout",
			}),
			logger,
			{ solve: async () => "SECRET-TOKEN" },
		);
		await post(app, { url: "https://example.com/" });
		const logs = lines.map((line) => JSON.parse(line));
		expect(logs.find((l) => l.verdict)?.solve).toBe("failed");
		expect(logs.some((l) => l.level === 40 && l.msg === "solve_failed")).toBe(
			true,
		);
		expect(lines.join("")).not.toContain("SECRET-TOKEN");
	});

	it("logs the solve failure's fixed-vocabulary reason without the token", async () => {
		const lines: string[] = [];
		const logger = pino(
			{ level: "info" },
			{ write: (line: string) => void lines.push(line) },
		) as AppDeps["logger"];
		const app = build(
			async (r) => ({
				...okResult(r.url),
				solve: "failed",
				solveReason: "budget_exceeded",
			}),
			logger,
			{ solve: async () => "SECRET-TOKEN" },
		);
		await post(app, { url: "https://example.com/" });
		const warn = lines
			.map((line) => JSON.parse(line))
			.find((l) => l.msg === "solve_failed");
		expect(warn.reason).toBe("budget_exceeded");
		expect(lines.join("")).not.toContain("SECRET-TOKEN");
	});

	it("only types a solve reason on a failed solve", () => {
		const base = okResult("https://example.com/");
		// @ts-expect-error a failed solve always carries its reason
		const noReason: FetchResult = { ...base, solve: "failed" };
		const solvedWithReason: FetchResult = {
			...base,
			solve: "solved",
			// @ts-expect-error a solved fetch has no failure reason
			solveReason: "timeout",
		};
		expect([noReason.solve, solvedWithReason.solve]).toEqual([
			"failed",
			"solved",
		]);
	});

	it("logs the failed solve's error detail next to its reason", async () => {
		const lines: string[] = [];
		const logger = pino(
			{ level: "info" },
			{ write: (line: string) => void lines.push(line) },
		) as AppDeps["logger"];
		const app = build(
			async (r) => ({
				...okResult(r.url),
				solve: "failed",
				solveReason: "provider_error",
				solveError: "Error: solver rejected the task: ERROR_ZERO_BALANCE",
			}),
			logger,
			{ solve: async () => "TOKEN" },
		);
		await post(app, { url: "https://example.com/" });
		const warn = lines
			.map((line) => JSON.parse(line))
			.find((l) => l.msg === "solve_failed");
		expect(warn).toMatchObject({
			reason: "provider_error",
			err: "Error: solver rejected the task: ERROR_ZERO_BALANCE",
		});
	});

	it("returns 200 and logs a solved outcome with no solve_failed warning", async () => {
		const lines: string[] = [];
		const logger = pino(
			{ level: "info" },
			{ write: (line: string) => void lines.push(line) },
		) as AppDeps["logger"];
		const app = build(
			async (r) => ({ ...okResult(r.url), solve: "solved" }),
			logger,
			{ solve: async () => "TOKEN" },
		);
		const res = await post(app, { url: "https://example.com/" });
		expect(res.status).toBe(200);
		const logs = lines.map((line) => JSON.parse(line));
		expect(logs.find((l) => l.verdict)?.solve).toBe("solved");
		expect(logs.some((l) => l.msg === "solve_failed")).toBe(false);
	});

	it.each([
		[
			"a solved challenge",
			{ solve: "solved" as const },
			{
				verdict: "ok",
				status: 200,
				marker: undefined,
				solve: "solved",
				solveReason: undefined,
				challengeType: "recaptcha_v2",
				attempts: 1,
			},
		],
		[
			"a failed solve",
			{
				html: CHALLENGE,
				solve: "failed" as const,
				solveReason: "timeout" as const,
			},
			{
				verdict: "blocked",
				status: 423,
				marker: "captcha_widget:g-recaptcha",
				solve: "failed",
				solveReason: "timeout",
				challengeType: "recaptcha_v2",
				attempts: 1,
			},
		],
		[
			"a spent budget",
			{
				html: CHALLENGE,
				solve: "failed" as const,
				solveReason: "budget_exceeded" as const,
			},
			{
				verdict: "blocked",
				status: 423,
				marker: "captcha_widget:g-recaptcha",
				solve: "failed",
				solveReason: "budget_exceeded",
				challengeType: undefined,
				attempts: undefined,
			},
		],
		[
			"a page with no form",
			{
				html: CHALLENGE,
				solve: "failed" as const,
				solveReason: "no_form" as const,
			},
			{
				verdict: "blocked",
				status: 423,
				marker: "captcha_widget:g-recaptcha",
				solve: "failed",
				solveReason: "no_form",
				challengeType: undefined,
				attempts: undefined,
			},
		],
		[
			"a plain 200",
			{},
			{
				verdict: "ok",
				status: 200,
				marker: undefined,
				solve: undefined,
				solveReason: undefined,
				challengeType: undefined,
				attempts: undefined,
			},
		],
	])(
		"logs the dashboard fields on the done line for %s",
		async (_name, outcome, expected) => {
			const lines: string[] = [];
			const logger = pino(
				{ level: "info" },
				{ write: (line: string) => void lines.push(line) },
			) as AppDeps["logger"];
			const app = build(
				async (r) => ({ ...okResult(r.url), ...outcome }) as FetchResult,
				logger,
				{ solve: async () => "TOKEN" },
			);
			await post(app, { url: "https://example.com/" });
			const entry = lines
				.map((line) => JSON.parse(line))
				.find((l) => l.verdict !== undefined);
			const fields = Object.keys(expected) as (keyof typeof expected)[];
			expect(entry).toMatchObject({ entry: "anon", host: "example.com" });
			expect(Object.fromEntries(fields.map((f) => [f, entry[f]]))).toEqual(
				expected,
			);
		},
	);

	it("PUT rejects the anon profile with 404 and a malformed body with 400", async () => {
		const app = build(async (r) => okResult(r.url));
		const put = (name: string, body: unknown) =>
			app.request(`/profiles/${name}/state`, {
				method: "PUT",
				headers: { ...auth, "content-type": "application/json" },
				body: JSON.stringify(body),
			});
		expect((await put("anon", stateWith())).status).toBe(404);
		expect((await put("ebay", { cookies: "nope" })).status).toBe(400);
	});
});
