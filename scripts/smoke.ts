// Smoke tests against the deployed gateway. Runs sequentially: the gateway throttles per profile.
// Usage: pnpm smoke [check ...]   (no args = all). Needs STEALTH_BROWSER_URL and STEALTH_BROWSER_TOKEN.
// Set SMOKE_OUT=<dir> to save each OK page body (for fixtures).
// WARNING: pages from logged-in profiles (reddit, ebay) contain session tokens (modhash, csrf,
// username). Redact them before committing a saved page as a fixture.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const REQUEST_TIMEOUT_MS = 180_000;
const SEARCH_URL =
	"https://www.ebay.com/sch/i.html?_nkw=thinkpad+t480&LH_Sold=1&LH_Complete=1";

function env(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is not set`);
	return value;
}

interface Fetched {
	status: number;
	body: string;
	finalUrl: string | null;
}

async function gateway(url: string, name: string): Promise<Fetched> {
	const res = await fetch(
		`${env("STEALTH_BROWSER_URL").replace(/\/$/, "")}/content`,
		{
			method: "POST",
			headers: {
				authorization: `Bearer ${env("STEALTH_BROWSER_TOKEN")}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ url }),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		},
	);
	const body = await res.text();
	if (res.status === 200 && process.env.SMOKE_OUT) {
		mkdirSync(process.env.SMOKE_OUT, { recursive: true });
		writeFileSync(join(process.env.SMOKE_OUT, `${name}.html`), body);
	}
	return { status: res.status, body, finalUrl: res.headers.get("x-final-url") };
}

function expectOk(res: Fetched, marker: RegExp, min = 1): void {
	if (res.status !== 200)
		throw new Error(`status ${res.status}: ${res.body.slice(0, 200)}`);
	const count = res.body.match(new RegExp(marker, "g"))?.length ?? 0;
	if (count < min)
		throw new Error(`expected >= ${min} matches of ${marker}, got ${count}`);
}

async function fingerprint(): Promise<void> {
	const wsPath = execFileSync(
		"sh",
		[
			"-c",
			"kubectl get secret stealth-browser-secrets -n stealth-browser -o jsonpath='{.data.wsPath}' | base64 -d",
		],
		{ encoding: "utf8" },
	).trim();
	const forward = spawn(
		"kubectl",
		["port-forward", "-n", "stealth-browser", "svc/camoufox", "3000:3000"],
		{
			stdio: "ignore",
		},
	);
	try {
		await sleep(3000);
		await new Promise<void>((resolve, reject) => {
			const child = spawn("node", ["scripts/verify-fingerprint.ts"], {
				env: {
					...process.env,
					CAMOUFOX_WS_URL: `ws://localhost:3000/${wsPath}`,
				},
				stdio: "inherit",
			});
			child.on("exit", (code) =>
				code === 0
					? resolve()
					: reject(new Error(`verify-fingerprint exited ${code}`)),
			);
		});
	} finally {
		forward.kill();
	}
}

async function ebaySold(): Promise<void> {
	expectOk(
		await gateway(SEARCH_URL, "ebay-sold-ok"),
		/s-item__price|s-card__price/,
		5,
	);
}

async function terapeak(): Promise<void> {
	const url = process.env.TERAPEAK_URL;
	if (!url) throw new Error("TERAPEAK_URL is not set (URL from Task 11)");
	const res = await gateway(url, "terapeak-ok");
	if (new URL(res.finalUrl ?? url).hostname === "signin.ebay.com")
		throw new Error("redirected to signin.ebay.com");
	// Seller Hub answers 200 with this form until the account has an address.
	if (res.body.includes("Complete your account info"))
		throw new Error("eBay wants the account's contact info before Terapeak");
	expectOk(res, /research-table-row/, 5);
}

async function reddit(): Promise<void> {
	const prefs = await gateway(
		"https://old.reddit.com/prefs/",
		"reddit-prefs-ok",
	);
	if (prefs.status !== 200)
		throw new Error(
			`prefs status ${prefs.status}: ${prefs.body.slice(0, 200)}`,
		);
	expectOk(
		await gateway(
			"https://old.reddit.com/r/mechmarket/search?q=keychron&restrict_sr=on",
			"reddit-search-ok",
		),
		/search-result/,
	);
}

async function amazon(): Promise<void> {
	const search = await gateway(
		"https://www.amazon.com/s?k=usb+c+hub+4k+60hz",
		"amazon-search-ok",
	);
	expectOk(search, /s-result-item/);
	const asin = /\/dp\/([A-Z0-9]{10})/.exec(search.body)?.[1];
	if (!asin) throw new Error("no /dp/<ASIN> link in search results");
	expectOk(
		await gateway(`https://www.amazon.com/dp/${asin}`, "amazon-product-ok"),
		/productTitle/,
	);
}

const checks: Record<string, () => Promise<void>> = {
	fingerprint,
	ebaySold,
	terapeak,
	reddit,
	amazon,
};

const requested = process.argv.slice(2);
const names = requested.length > 0 ? requested : Object.keys(checks);
let failed = false;
for (const name of names) {
	const check = checks[name];
	if (!check) {
		console.error(
			`FAIL ${name}: unknown check (have: ${Object.keys(checks).join(", ")})`,
		);
		failed = true;
		continue;
	}
	try {
		await check();
		console.log(`PASS ${name}`);
	} catch (error) {
		console.error(
			`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`,
		);
		failed = true;
	}
}
process.exit(failed ? 1 : 0);
