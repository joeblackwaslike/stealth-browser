import type { Challenge } from "../detect.js";
import { isSolveReason, type Solver, tagSolveReason } from "./types.js";

/** How long the solver adapter waits for a token before giving up. */
export const SOLVER_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const NOT_READY = "CAPCHA_NOT_READY";

type ApiReply = { status: number; request: string };

/** A well-formed reply; a success must carry a non-empty task id or token. */
function isApiReply(value: unknown): value is ApiReply {
	if (typeof value !== "object" || value === null) return false;
	const { status, request } = value as ApiReply;
	return (
		typeof status === "number" &&
		typeof request === "string" &&
		(status !== 1 || request.length > 0)
	);
}

/** Error class, message and cause code of a failed fetch, e.g. "TypeError: fetch failed (ENOTFOUND)". */
function describeTransportError(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	const code = (error.cause as { code?: unknown } | undefined)?.code;
	return `${error.name}: ${error.message}${typeof code === "string" ? ` (${code})` : ""}`;
}

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
		timeoutMs = SOLVER_TIMEOUT_MS,
		pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
		fetchImpl = fetch,
	} = opts;

	const redact = (message: string) =>
		message.replaceAll(apiKey, "<solver-key>");

	const timedOut = (lastFailure?: string) =>
		tagSolveReason(
			new Error(
				lastFailure
					? `solver timed out; last failure: ${lastFailure}`
					: "solver timed out",
			),
			"timeout",
		);

	// 2Captcha has no documented status for "permanently rejected" vs
	// "transient" failures, so treat 401/403/404/other-4xx (except 429) as
	// permanent and everything else (network errors, 429, 5xx, unparseable
	// bodies) as worth retrying until the deadline.
	function isPermanentStatus(status: number): boolean {
		return status >= 400 && status < 500 && status !== 429;
	}

	async function call(
		path: string,
		params: Record<string, string>,
		deadline: number,
		lastFailure?: string,
	): Promise<{
		ok: boolean;
		status: number;
		body?: ApiReply;
		failure?: string;
	}> {
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw timedOut(lastFailure);
		const url = new URL(path, baseUrl);
		for (const [name, value] of Object.entries({ key: apiKey, ...params }))
			url.searchParams.set(name, value);
		url.searchParams.set("json", "1");
		let response: Response;
		try {
			response = await fetchImpl(url, {
				signal: AbortSignal.timeout(Math.max(1, remaining)),
			});
		} catch (error) {
			// Past the deadline the error is our own abort, not a provider failure.
			if (Date.now() >= deadline) throw timedOut(lastFailure);
			return { ok: false, status: 0, failure: describeTransportError(error) };
		}
		if (!response.ok) {
			await response.body?.cancel().catch(() => undefined);
			return { ok: false, status: response.status };
		}
		let body: unknown;
		try {
			body = await response.json();
		} catch {
			if (Date.now() >= deadline) throw timedOut();
			return { ok: false, status: response.status };
		}
		if (!isApiReply(body)) {
			if (Date.now() >= deadline) throw timedOut();
			return { ok: false, status: response.status };
		}
		return { ok: true, status: response.status, body };
	}

	async function run(challenge: Challenge): Promise<string> {
		const deadline = Date.now() + timeoutMs;
		const submit = await call(
			"/in.php",
			{
				method: "userrecaptcha",
				googlekey: challenge.sitekey,
				pageurl: challenge.pageUrl,
				...(challenge.dataS ? { "data-s": challenge.dataS } : {}),
			},
			deadline,
		);
		if (!submit.ok)
			throw tagSolveReason(
				new Error(
					`solver submit failed: ${submit.failure ?? `HTTP ${submit.status}`}`,
				),
				"provider_error",
			);
		const submitted = submit.body;
		if (!submitted)
			throw tagSolveReason(
				new Error("solver submit failed: empty reply"),
				"provider_error",
			);
		if (submitted.status !== 1)
			throw tagSolveReason(
				new Error(`solver rejected the task: ${submitted.request}`),
				"provider_error",
			);
		let lastFailure: string | undefined;
		for (;;) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) throw timedOut(lastFailure);
			await new Promise((resolve) =>
				setTimeout(resolve, Math.min(pollIntervalMs, remaining)),
			);
			const poll = await call(
				"/res.php",
				{ action: "get", id: submitted.request },
				deadline,
				lastFailure,
			);
			if (!poll.ok) {
				if (isPermanentStatus(poll.status))
					throw tagSolveReason(
						new Error(`solver poll failed: HTTP ${poll.status}`),
						"provider_error",
					);
				lastFailure = poll.failure ?? `HTTP ${poll.status}`;
				continue;
			}
			const reply = poll.body;
			if (!reply) continue;
			if (reply.status === 1) return reply.request;
			if (reply.request !== NOT_READY)
				throw tagSolveReason(
					new Error(`solver failed: ${reply.request}`),
					"provider_error",
				);
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
				const code = "code" in original ? original.code : undefined;
				throw tagSolveReason(
					redacted,
					isSolveReason(code) ? code : "provider_error",
				);
			}
		},
	};
}
