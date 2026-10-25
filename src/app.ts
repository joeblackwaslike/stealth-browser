import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import type { Logger } from "pino";
import { z } from "zod";
import type { Fetcher } from "./browser.js";
import { classifyPage } from "./detect.js";
import { isLoginProfile, type ProfileName, profileForUrl } from "./profiles.js";
import {
	type StateStore,
	type StorageState,
	storageStateSchema,
} from "./state-store.js";
import {
	ProfilePausedError,
	QueueFullError,
	type Scheduler,
} from "./throttle.js";
import { isPublicHttpUrl } from "./url-guard.js";

const contentBodySchema = z.object({
	url: z.string(),
	waitForTimeout: z.number().int().min(0).max(15000).default(3000),
});

export type AppDeps = {
	token: string;
	fetcher: Fetcher;
	scheduler: Scheduler;
	store: StateStore;
	logger: Logger;
	now?: () => number;
};

function parseUrl(raw: string): URL | undefined {
	try {
		return new URL(raw);
	} catch {
		return undefined;
	}
}

/** Build the gateway app. Every route sits behind the bearer token. */
export function createApp(deps: AppDeps): Hono {
	const { fetcher, scheduler, store, logger } = deps;
	const now = deps.now ?? Date.now;
	const app = new Hono();
	app.use("*", bearerAuth({ token: deps.token }));

	app.get("/healthz", (c) => c.json({ ok: true }));

	app.post("/content", async (c) => {
		const started = now();
		let profile: ProfileName | undefined;
		let host = "";
		let verdict = "none";
		const done = (res: Response): Response => {
			logger.info({
				profile,
				host,
				verdict,
				status: res.status,
				ms: now() - started,
			});
			return res;
		};
		const invalid = (message: string) => {
			verdict = "invalid_request";
			return done(c.json({ error: "invalid_request", message }, 400));
		};

		const body = contentBodySchema.safeParse(
			await c.req.json().catch(() => undefined),
		);
		if (!body.success) return invalid(z.prettifyError(body.error));
		const { url, waitForTimeout } = body.data;
		const parsed = parseUrl(url);
		if (!parsed || !isPublicHttpUrl(parsed))
			return invalid("url is not allowed");

		host = parsed.hostname;
		// The URL alone picks the profile, so a caller can't route an eBay URL
		// around eBay's pacing and pauses.
		const resolved = profileForUrl(parsed);
		profile = resolved;

		if (isLoginProfile(resolved) && !(await store.read(resolved))) {
			verdict = "no_session";
			return done(c.json({ session_expired: true, profile: resolved }, 401));
		}

		let generation = 0;
		try {
			// Read the login when the task starts, not when it was queued, so a
			// waiting request uses the cookies the previous request refreshed.
			const result = await scheduler.run(resolved, async () => {
				let storageState: StorageState | undefined;
				if (isLoginProfile(resolved)) {
					const stored = await store.read(resolved);
					storageState = stored?.state;
					generation = stored?.generation ?? 0;
				}
				return fetcher({ url, waitForTimeout, storageState });
			});
			const finalUrl = parseUrl(result.finalUrl) ? result.finalUrl : url;
			const page = classifyPage({
				profile: resolved,
				html: result.html,
				finalUrl,
				cookieNames: result.storageState.cookies.map((cookie) => cookie.name),
				status: result.status,
			});
			verdict = page.kind;

			if (page.kind === "blocked") {
				scheduler.pause(resolved);
				await saveCapture(resolved, "blocked", result.html);
				return done(
					c.json(
						{ blocked: true, profile: resolved, reason: page.reason },
						423,
					),
				);
			}
			if (page.kind === "rate_limited") {
				return done(c.json({ error: "rate_limited", profile: resolved }, 429));
			}
			if (page.kind === "session_expired") {
				await saveCapture(resolved, "session_expired", result.html);
				return done(c.json({ session_expired: true, profile: resolved }, 401));
			}
			if (isLoginProfile(resolved)) {
				// The page was fetched fine; a failed save only loses the cookie
				// refresh, so log it instead of failing the request.
				await store
					.writeIfUnchanged(resolved, result.storageState, generation)
					.catch((error: unknown) =>
						logger.warn(
							{ profile: resolved, err: String(error) },
							"state_save_failed",
						),
					);
			}
			return done(
				c.body(result.html, 200, {
					"content-type": "text/html; charset=utf-8",
					"X-Final-Url": result.finalUrl,
				}),
			);
		} catch (error) {
			if (error instanceof QueueFullError) {
				verdict = "queue_full";
				return done(c.json({ error: "queue_full" }, 429));
			}
			if (error instanceof ProfilePausedError) {
				verdict = "paused";
				const retryAfter = Math.max(1, Math.ceil((error.until - now()) / 1000));
				return done(
					c.json({ blocked: true, profile: resolved, reason: "paused" }, 423, {
						"Retry-After": String(retryAfter),
					}),
				);
			}
			verdict = "navigation_failed";
			return done(
				c.json(
					{
						error: "navigation_failed",
						message: error instanceof Error ? error.message : String(error),
					},
					502,
				),
			);
		}
	});

	async function saveCapture(
		profile: ProfileName,
		kind: "blocked" | "session_expired",
		html: string,
	): Promise<void> {
		try {
			await store.saveCapture(profile, kind, html);
		} catch (error) {
			logger.warn({ profile, kind, err: String(error) }, "capture_save_failed");
		}
	}

	app.put("/profiles/:name/state", async (c) => {
		const name = c.req.param("name");
		if (!isLoginProfile(name)) return c.json({ error: "not_found" }, 404);
		const state = storageStateSchema.safeParse(
			await c.req.json().catch(() => undefined),
		);
		if (!state.success) {
			return c.json(
				{ error: "invalid_request", message: z.prettifyError(state.error) },
				400,
			);
		}
		await store.write(name, state.data);
		logger.info({ profile: name, status: 204 });
		return c.body(null, 204);
	});

	return app;
}
