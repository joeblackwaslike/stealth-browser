// Connects to the Camoufox server twice and checks the fingerprint is pinned.
// Usage: CAMOUFOX_WS_URL=ws://host:3000/<ws-path> node scripts/verify-fingerprint.ts
import { firefox } from "playwright-core";
import { z } from "zod";

const EXPECTED_TIMEZONE = "America/New_York";

const wsUrl = z.url({ protocol: /^wss?$/ }).parse(process.env.CAMOUFOX_WS_URL);

async function probe() {
	const browser = await firefox.connect(wsUrl);
	try {
		const page = await browser.newPage();
		return await page.evaluate(() => ({
			userAgent: navigator.userAgent,
			screen: `${screen.width}x${screen.height}`,
			timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
			webdriver: navigator.webdriver,
		}));
	} finally {
		await browser.close();
	}
}

const first = await probe();
const second = await probe();
console.log(JSON.stringify({ first, second }, null, 2));

const differing = (Object.keys(first) as (keyof typeof first)[]).filter(
	(key) => first[key] !== second[key],
);
const failures = [
	...differing.map((key) => `${key} differs between connections`),
	first.timeZone !== EXPECTED_TIMEZONE && `timeZone is ${first.timeZone}`,
	first.webdriver !== false && `webdriver is ${first.webdriver}`,
].filter(Boolean);

if (failures.length > 0) {
	console.error(`FAIL: ${failures.join("; ")}`);
	process.exit(1);
}
console.log("OK: fingerprint pinned");
