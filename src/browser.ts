import { type Browser, firefox } from "playwright-core";
import type { StorageState } from "./state-store.js";

export type FetchRequest = {
	url: string;
	waitForTimeout: number;
	storageState?: StorageState;
};

export type FetchResult = {
	html: string;
	finalUrl: string;
	status: number | null;
	storageState: StorageState;
};

/** Navigates to a URL in the shared browser and returns the rendered page. */
export type Fetcher = (req: FetchRequest) => Promise<FetchResult>;

const BLOCKED_RESOURCE_TYPES = new Set(["image", "media", "font"]);
const NAVIGATION_TIMEOUT_MS = 30_000;
const REQUEST_MARGIN_MS = 15_000;

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
				return {
					html: await page.content(),
					finalUrl: page.url(),
					status: response?.status() ?? null,
					storageState: await context.storageState(),
				};
			} finally {
				await context.close().catch(() => undefined);
			}
		} catch (error) {
			throw redact(error);
		}
	};

	const fetch: Fetcher = async (req) => {
		const deadlineMs =
			opts.requestDeadlineMs ??
			NAVIGATION_TIMEOUT_MS + req.waitForTimeout + REQUEST_MARGIN_MS;
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
		work.catch(() => undefined);
		try {
			return await Promise.race([work, deadline]);
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
