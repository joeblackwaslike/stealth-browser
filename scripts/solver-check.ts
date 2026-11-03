// Live check of the captcha solver against a deployed gateway. Sequential POST /content for Google results.
// Usage: pnpm solver-check [--max N] [query ...]. Needs STEALTH_BROWSER_URL and STEALTH_BROWSER_TOKEN.
// The script cannot see solves; read the gateway log for `solve: "solved"` / `solve_failed`.
import { setTimeout as sleep } from "node:timers/promises";

const REQUEST_TIMEOUT_MS = 300_000;
const PAUSE_MS = 10_000;
const DEFAULT_MAX = 40;
const DEFAULT_QUERIES = [
	"weather new york",
	"how to boil an egg",
	"python list comprehension",
	"cast iron skillet seasoning",
];

export type Classified =
	| { kind: "results" }
	| { kind: "challenge" }
	| { kind: "paused"; reason: string; retryAfter: string | null }
	| { kind: "other" };

export function classifyResponse(
	status: number,
	headers: Headers,
	body: string,
): Classified {
	if (status === 423) {
		let reason: string;
		try {
			reason = String(JSON.parse(body).reason ?? "unknown");
		} catch {
			// Not the gateway's JSON, e.g. a proxy's 423 page.
			reason = "unparseable";
		}
		return { kind: "paused", reason, retryAfter: headers.get("retry-after") };
	}
	if (status !== 200) return { kind: "other" };
	if (body.includes('id="search"') || body.includes('id="rso"'))
		return { kind: "results" };
	if (body.includes("/sorry/")) return { kind: "challenge" };
	return { kind: "other" };
}

function env(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is not set`);
	return value;
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const maxIndex = args.indexOf("--max");
	const max = maxIndex >= 0 ? Number(args.splice(maxIndex, 2)[1]) : DEFAULT_MAX;
	if (!Number.isInteger(max) || max < 1) throw new Error("--max needs N >= 1");
	const queries = args.length > 0 ? args : DEFAULT_QUERIES;
	const base = env("STEALTH_BROWSER_URL").replace(/\/$/, "");
	const token = env("STEALTH_BROWSER_TOKEN");
	const counts = new Map<number, number>();

	for (let i = 1; i <= max; i++) {
		const query = queries[(i - 1) % queries.length] ?? "";
		const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
		const started = Date.now();
		let line: string;
		let paused = false;
		try {
			const res = await fetch(`${base}/content`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ url, waitForTimeout: 3000 }),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			const result = classifyResponse(
				res.status,
				res.headers,
				await res.text(),
			);
			counts.set(res.status, (counts.get(res.status) ?? 0) + 1);
			const secs = ((Date.now() - started) / 1000).toFixed(1);
			line = `${i} ${res.status} ${secs}s`;
			if (result.kind === "paused") {
				paused = true;
				line += ` paused reason=${result.reason} retry-after=${result.retryAfter ?? "-"}`;
			} else if (res.status === 200) {
				line += ` ${result.kind} final=${res.headers.get("x-final-url") ?? "-"}`;
			}
		} catch (error) {
			counts.set(0, (counts.get(0) ?? 0) + 1);
			line = `${i} ERR ${error instanceof Error ? error.message : String(error)}`;
		}
		console.log(line);
		if (paused) break;
		if (i < max) await sleep(PAUSE_MS);
	}

	console.log(
		`summary: ${[...counts].map(([s, n]) => `${s === 0 ? "error" : s}=${n}`).join(" ")}`,
	);
	console.log(
		'reminder: read the gateway logs for `solve: "solved"` / `solve_failed` entries',
	);
	if (counts.has(0)) process.exitCode = 1;
}

if (import.meta.main) await main();
