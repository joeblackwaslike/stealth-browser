import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Fetcher, FetchResult } from "../src/browser.js";
import { PROFILES, type Profile, type ProfileName } from "../src/profiles.js";
import {
	createStateStore,
	type StateStore,
	type StorageState,
} from "../src/state-store.js";
import { Scheduler } from "../src/throttle.js";

const TOKEN = "test-token";
const auth = { authorization: `Bearer ${TOKEN}` };
const noGap = Object.fromEntries(
	Object.entries(PROFILES).map(([name, p]) => [
		name,
		{ ...p, minGapMs: [0, 0] as const },
	]),
) as Record<ProfileName, Profile>;

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

const okResult = (
	url: string,
	storageState = stateWith(),
	html = "<html><body>hello</body></html>",
): FetchResult => ({ html, finalUrl: url, status: 200, storageState });

let dir: string;
let store: StateStore;
let calls: number;

function build(fetcher: Fetcher) {
	const counted: Fetcher = (req) => {
		calls++;
		return fetcher(req);
	};
	const clock = {
		now: () => 1_000_000,
		sleep: async () => {},
		random: () => 0,
	};
	return createApp({
		token: TOKEN,
		fetcher: counted,
		scheduler: new Scheduler(noGap, clock),
		store,
		logger: pino({ level: "silent" }),
		now: clock.now,
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

	it("returns 423 and pauses the profile when the page is a challenge", async () => {
		const app = build(async (r) =>
			okResult(r.url, stateWith(), '<div class="g-recaptcha"></div>'),
		);
		const first = await post(app, { url: "https://example.com/" });
		expect(first.status).toBe(423);
		expect(await first.json()).toEqual({
			blocked: true,
			profile: "anon",
			reason: "captcha",
		});
		const second = await post(app, { url: "https://example.com/" });
		expect(second.status).toBe(423);
		expect(await second.json()).toEqual({
			blocked: true,
			profile: "anon",
			reason: "paused",
		});
		expect(Number(second.headers.get("retry-after"))).toBe(1800);
		expect(calls).toBe(1);
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
