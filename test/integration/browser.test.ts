import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { createCamoufoxFetcher } from "../../src/browser.js";

const wsUrl = process.env.CAMOUFOX_WS_URL;
const container = process.env.CAMOUFOX_CONTAINER;

if (!wsUrl)
	console.warn("skipping browser integration tests: CAMOUFOX_WS_URL unset");

describe.skipIf(!wsUrl)("camoufox fetcher", () => {
	const fetcher = createCamoufoxFetcher(wsUrl ?? "");
	afterAll(() => fetcher.close());

	it("fetches a page and returns final url and html", async () => {
		const result = await fetcher.fetch({
			url: "https://example.com/",
			waitForTimeout: 0,
		});
		expect(result.html).toContain("Example Domain");
		expect(result.finalUrl).toBe("https://example.com/");
		expect(result.status).toBe(200);
	});

	it("returns cookies the page set", async () => {
		const result = await fetcher.fetch({
			url: "https://httpbin.org/cookies/set?sb=1",
			waitForTimeout: 0,
		});
		expect(result.storageState.cookies.map((c) => c.name)).toContain("sb");
	});

	it.skipIf(!container)(
		"reconnects after the camoufox server restarts",
		async () => {
			await fetcher.fetch({ url: "https://example.com/", waitForTimeout: 0 });
			execFileSync("docker", ["restart", container ?? ""]);
			await new Promise((r) => setTimeout(r, 8_000));
			const result = await fetcher.fetch({
				url: "https://example.com/",
				waitForTimeout: 0,
			});
			expect(result.html).toContain("Example Domain");
		},
		90_000,
	);
});
