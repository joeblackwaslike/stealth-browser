import { type Browser, firefox, type Page } from "playwright-core";
import { detectChallenge, hasChallenge } from "./detect.js";
import {
	isSolveReason,
	SOLVER_TIMEOUT_MS,
	SolveBudgetExceededError,
	type SolveReason,
	type Solver,
} from "./solver/index.js";
import type { StorageState } from "./state-store.js";

export type FetchRequest = {
	url: string;
	waitForTimeout: number;
	storageState?: StorageState;
	solver?: Solver;
};

/**
 * Outcome of the one solve attempt; `solve` is absent when none was made.
 * `solveReason` is the fixed vocabulary for why it failed; `solveError` is the
 * thrown error's class and message, with the ws endpoint redacted.
 */
type SolveOutcome =
	| { solve?: undefined; solveReason?: undefined }
	| { solve: "solved"; solveReason?: undefined }
	| { solve: "failed"; solveReason: SolveReason; solveError?: string };

type PageRead = {
	html: string;
	finalUrl: string;
	status: number | null;
} & SolveOutcome;

export type FetchResult = PageRead & { storageState: StorageState };

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
 * Runs in the page, so it must stay self-contained. Checks the live form around
 * the first `.g-recaptcha`: the widget is a visible div, every form control is a
 * button, a hidden/submit/button/image/reset input or the response textarea, and
 * nothing in the form is editable. Given a token, writes it into the response
 * field. Returns whether the form passed.
 */
function fillChallengeForm(token: string | null): boolean {
	const widget = document.querySelector(".g-recaptcha");
	const form = widget?.closest("form");
	if (!widget || !form || widget.tagName !== "DIV") return false;
	if (widget.getAttribute("data-size")?.toLowerCase() === "invisible")
		return false;
	if (form.querySelector('[contenteditable]:not([contenteditable="false"])'))
		return false;
	const allowedInputs = ["hidden", "submit", "button", "image", "reset"];
	for (const control of Array.from(form.elements)) {
		const allowed =
			control.tagName === "BUTTON" ||
			(control.tagName === "INPUT" &&
				allowedInputs.includes((control as HTMLInputElement).type)) ||
			(control.tagName === "TEXTAREA" &&
				(control as HTMLTextAreaElement).name === "g-recaptcha-response");
		if (!allowed) return false;
	}
	if (token === null) return true;
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
	field.value = token;
	return true;
}

function noFormError(): Error {
	return Object.assign(new Error("no challenge form encloses the widget"), {
		code: "no_form" as const,
	});
}

/**
 * Write the token into the reCAPTCHA response field of the form around the
 * widget and submit it. Resolves with the navigation's response; rejects when
 * the live form fails the challenge-form check or the navigation never arrives.
 */
async function submitToken(page: Page, token: string) {
	if (!(await page.evaluate(fillChallengeForm, token))) throw noFormError();
	const navigation = page
		.waitForNavigation({
			waitUntil: "domcontentloaded",
			timeout: NAVIGATION_TIMEOUT_MS,
		})
		.catch((error) => {
			throw Object.assign(new Error("navigation failed"), {
				code: "navigation_failed" as const,
				cause: error,
			});
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

function classifySolveError(error: unknown): SolveReason {
	if (error instanceof SolveBudgetExceededError) return "budget_exceeded";
	if (error instanceof Error && "code" in error) {
		const code = (error as { code?: unknown }).code;
		if (isSolveReason(code)) return code;
	}
	return "unknown";
}

/**
 * Solve the page's challenge, if it has one, and read the page it leads to.
 * Any failure, or a challenge still present after submitting, keeps the
 * app's blocked verdict and 30-minute pause.
 */
async function solveOnce(
	page: Page,
	solver: Solver,
	loaded: PageRead,
	redact: (error: unknown) => Error,
): Promise<PageRead> {
	const challenge = detectChallenge(loaded.html, loaded.finalUrl);
	if (!challenge) return loaded;
	try {
		if (!(await page.evaluate(fillChallengeForm, null))) throw noFormError();
		const token = await solver.solve(challenge);
		const response = await submitToken(page, token);
		const html = await page.content();
		const finalUrl = page.url();
		const status = response?.status() ?? null;
		if (hasChallenge(html, finalUrl))
			return {
				html,
				finalUrl,
				status,
				solve: "failed",
				solveReason: "challenge_remained",
			};
		return { html, finalUrl, status, solve: "solved" };
	} catch (error) {
		const safe = redact(error);
		return {
			...loaded,
			solve: "failed",
			solveReason: classifySolveError(error),
			solveError: `${safe.name}: ${safe.message}`,
		};
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
					? await solveOnce(page, req.solver, loaded, redact)
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
