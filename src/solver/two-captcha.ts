import type { Challenge } from "../detect.js";
import type { Solver } from "./types.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const NOT_READY = "CAPCHA_NOT_READY";

type ApiReply = { status: number; request: string };

/** Adapter for the 2Captcha v1 API (in.php and res.php, json=1). */
export function createTwoCaptchaSolver(opts: {
	apiKey: string;
	baseUrl: string;
	timeoutMs?: number;
	pollIntervalMs?: number;
	fetchImpl?: typeof fetch;
}): Solver {
	const {
		apiKey,
		baseUrl,
		timeoutMs = DEFAULT_TIMEOUT_MS,
		pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
		fetchImpl = fetch,
	} = opts;

	const redact = (message: string) =>
		message.replaceAll(apiKey, "<solver-key>");

	async function call(path: string, params: Record<string, string>) {
		const url = new URL(path, baseUrl);
		for (const [name, value] of Object.entries({ key: apiKey, ...params }))
			url.searchParams.set(name, value);
		url.searchParams.set("json", "1");
		const response = await fetchImpl(url);
		return (await response.json()) as ApiReply;
	}

	async function run(challenge: Challenge): Promise<string> {
		const deadline = Date.now() + timeoutMs;
		const submitted = await call("/in.php", {
			method: "userrecaptcha",
			googlekey: challenge.sitekey,
			pageurl: challenge.pageUrl,
			...(challenge.dataS ? { "data-s": challenge.dataS } : {}),
		});
		if (submitted.status !== 1)
			throw new Error(`solver rejected the task: ${submitted.request}`);
		for (;;) {
			await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
			if (Date.now() >= deadline) throw new Error("solver timed out");
			const reply = await call("/res.php", {
				action: "get",
				id: submitted.request,
			});
			if (reply.status === 1) return reply.request;
			if (reply.request !== NOT_READY)
				throw new Error(`solver failed: ${reply.request}`);
		}
	}

	return {
		async solve(challenge) {
			try {
				return await run(challenge);
			} catch (error) {
				const original =
					error instanceof Error ? error : new Error(String(error));
				const redacted = new Error(redact(original.message));
				redacted.name = original.name;
				throw redacted;
			}
		},
	};
}
