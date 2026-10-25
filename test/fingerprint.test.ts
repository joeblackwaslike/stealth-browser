import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const fingerprint = JSON.parse(
	readFileSync(
		new URL("../profiles/fingerprint.json", import.meta.url),
		"utf8",
	),
) as Record<string, unknown>;

describe("profiles/fingerprint.json", () => {
	it("pins the locale and timezone that geoip would otherwise pick per launch", () => {
		expect(fingerprint).toMatchObject({
			"locale:language": "en",
			"locale:region": "US",
			"locale:script": "Latn",
			timezone: "America/New_York",
		});
	});

	it("pins every value Camoufox would randomize per launch", () => {
		for (const key of [
			"canvas:seed",
			"audio:seed",
			"fonts:spacing_seed",
			"fonts",
			"voices",
			"window.history.length",
		]) {
			expect(fingerprint, key).toHaveProperty([key]);
		}
	});
});
