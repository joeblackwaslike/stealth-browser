import { type Browser, firefox, type Page } from "playwright-core";
import { detectChallenge } from "./detect.js";
import { SOLVER_TIMEOUT_MS, type Solver } from "./solver/index.js";
import type { StorageState } from "./state-store.js";

export type FetchRequest = {
	url: string;
	waitForTimeout: number;
	storageState?: StorageState;
	solver?: Solver;
};

export type FetchResult = {
	html: string;
	finalUrl: string;
	status: number | null;
	storageState: StorageState;
	/** Outcome of the one solve attempt; absent when none was made. */
	solve?: "solved" | "failed";
};

/** Navigates to a URL in the shared browser and returns the rendered page. */
export type Fetcher = (req: FetchRequest) => Promise<FetchResult>;

const BLOCKED_RESOURCE_TYPES = new Set(["image", "media", "font"]);
const NAVIGATION_TIMEOUT_MS = 30_000;
const REQUEST_MARGIN_MS = 15_000;
// ponytail: fixed cap; if a dropped connection ever takes longer to unwind, the
// next request may briefly overlap it rather than wedge the queue.
const ABANDONED_WORK_GRACE_MS = 10_000;

function redactor(wsEndpoint: string): (error: unknown) => Error {
	const secrets = [wsEndpoint];
	try {
		const { pathname } = new URL(wsEndpoint);
		if (pathname.length > 1) secrets.push(pathname, pathname.slice(1));
	} catch {
		// endpoint was validated by config; fall back to redacting the raw string only
	}
	return (error) => {
		const original = error instanceof Error ? error : new Error(String(error));
		let message = original.message;
		for (const secret of secrets)
			message = message.replaceAll(secret, "<camoufox>");
		const redacted = new Error(message);
		redacted.name = original.name;
		return redacted;
	};
}

/**
 * Write the token into the reCAPTCHA response field of the form around the
 * widget and submit it. Resolves with the navigation's response; rejects when
 * no form encloses the widget or the navigation never arrives.
 */
async function submitToken(page: Page, token: string) {
	const filled = await page.evaluate((value) => {
		const form = document.querySelector(".g-recaptcha")?.closest("form");
		if (!form) return false;
		let field = form.querySelector<HTMLTextAreaElement>(
			"textarea#g-recaptcha-response",
		);
		if (!field) {
			field = document.createElement("textarea");
			field.id = "g-recaptcha-response";
			field.name = "g-recaptcha-response";
			field.hidden = true;
			form.append(field);
		}
		field.value = value;
		return true;
	}, token);
	if (!filled) throw new Error("no form encloses the challenge");
	const navigation = page.waitForNavigation({
		waitUntil: "domcontentloaded",
		timeout: NAVIGATION_TIMEOUT_MS,
	});
	navigation.catch(() => undefined);
	// The navigation can tear down the context before this evaluate returns,
	// so only the navigation decides whether the submit worked.
	await page
		.evaluate(() => {
			const form = document.querySelector(".g-recaptcha")?.closest("form");
			if (form) HTMLFormElement.prototype.submit.call(form);
		})
		.catch(() => undefined);
	return navigation;
}

type PageRead = Omit<FetchResult, "storageState">;

/**
 * Solve the page's challenge, if it has one, and read the page it leads to.
 * Any failure keeps the challenge page, which the app classifies as blocked,
 * so the profile pause still applies.
 */
async function solveOnce(
	page: Page,
	solver: Solver,
	loaded: PageRead,
): Promise<PageRead> {
	const challenge = detectChallenge(loaded.html, loaded.finalUrl);
	if (!challenge) return loaded;
	try {
		const token = await solver.solve(challenge);
		const response = await submitToken(page, token);
		return {
			html: await page.content(),
			finalUrl: page.url(),
			status: response?.status() ?? null,
			solve: "solved",
		};
	} catch {
		return { ...loaded, solve: "failed" };
	}
}

/**
 * Fetcher backed by a remote Camoufox server. Connects lazily, reconnects after
 * the server drops, and never lets the ws endpoint appear in a thrown error.
 */
export function createCamoufoxFetcher(
	wsEndpoint: string,
	opts: { connectTimeoutMs?: number; requestDeadlineMs?: number } = {},
): {
	fetch: Fetcher;
	close(): Promise<void>;
} {
	const redact = redactor(wsEndpoint);
	const connectTimeoutMs = opts.connectTimeoutMs ?? NAVIGATION_TIMEOUT_MS;
	let browser: Browser | undefined;
	let connecting: Promise<Browser> | undefined;

	function getBrowser(): Promise<Browser> {
		if (browser?.isConnected()) return Promise.resolve(browser);
		connecting ??= firefox
			.connect(wsEndpoint, { timeout: connectTimeoutMs })
			.then((connected) => {
				browser = connected;
				connected.on("disconnected", () => {
					if (browser === connected) browser = undefined;
				});
				return connected;
			})
			.finally(() => {
				connecting = undefined;
			});
		return connecting;
	}

	const run: Fetcher = async (req) => {
		try {
			const context = await (await getBrowser()).newContext({
				storageState: req.storageState,
			});
			try {
				await context.route("**/*", (route) =>
					BLOCKED_RESOURCE_TYPES.has(route.request().resourceType())
						? route.abort()
						: route.continue(),
				);
				const page = await context.newPage();
				const response = await page.goto(req.url, {
					waitUntil: "domcontentloaded",
					timeout: NAVIGATION_TIMEOUT_MS,
				});
				await page.waitForTimeout(req.waitForTimeout);
				const loaded: PageRead = {
					html: await page.content(),
					finalUrl: page.url(),
					status: response?.status() ?? null,
				};
				const read = req.solver
					? await solveOnce(page, req.solver, loaded)
					: loaded;
				return { ...read, storageState: await context.storageState() };
			} finally {
				// A context that won't close would stay alive on the server. Drop
				// the connection instead; the server discards a client's contexts
				// when it disconnects, and the next request reconnects.
				await context.close().catch(() => {
					const stuck = browser;
					browser = undefined;
					void stuck?.close().catch(() => undefined);
				});
			}
		} catch (error) {
			throw redact(error);
		}
	};

	const fetch: Fetcher = async (req) => {
		// The deadline starts before getBrowser(), so it budgets a reconnect too.
		const deadlineMs =
			opts.requestDeadlineMs ??
			connectTimeoutMs +
				NAVIGATION_TIMEOUT_MS +
				req.waitForTimeout +
				REQUEST_MARGIN_MS +
				(req.solver ? SOLVER_TIMEOUT_MS + NAVIGATION_TIMEOUT_MS : 0);
		let timer: NodeJS.Timeout | undefined;
		const deadline = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				const stuck = browser;
				browser = undefined;
				void stuck?.close().catch(() => undefined);
				reject(new Error(`camoufox request exceeded ${deadlineMs}ms`));
			}, deadlineMs);
		});
		const work = run(req);
		const settled = work.then(
			() => undefined,
			() => undefined,
		);
		try {
			return await Promise.race([work, deadline]);
		} catch (error) {
			// Hold the scheduler's slot until the abandoned request has unwound,
			// so the next task doesn't overlap it on the browser.
			let grace: NodeJS.Timeout | undefined;
			await Promise.race([
				settled,
				new Promise((resolve) => {
					grace = setTimeout(resolve, ABANDONED_WORK_GRACE_MS);
				}),
			]);
			clearTimeout(grace);
			throw error;
		} finally {
			clearTimeout(timer);
		}
	};

	return {
		fetch,
		async close() {
			const current = browser ?? (await connecting?.catch(() => undefined));
			browser = undefined;
			await current?.close().catch(() => undefined);
		},
	};
}
