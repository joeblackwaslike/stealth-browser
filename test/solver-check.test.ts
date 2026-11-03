import { describe, expect, it } from "vitest";
import { classifyResponse } from "../scripts/solver-check.js";

describe("classifyResponse", () => {
	it("calls a 200 with the rso container a results page", () => {
		expect(
			classifyResponse(200, new Headers(), '<div id="rso"></div>'),
		).toEqual({ kind: "results" });
	});

	it("calls a 200 with a /sorry/ body a challenge page", () => {
		expect(
			classifyResponse(
				200,
				new Headers(),
				"https://www.google.com/sorry/index",
			),
		).toEqual({ kind: "challenge" });
	});

	it("reports a 423 as paused with its reason and Retry-After", () => {
		const body = JSON.stringify({ blocked: true, reason: "paused" });
		expect(
			classifyResponse(423, new Headers({ "retry-after": "900" }), body),
		).toEqual({ kind: "paused", reason: "paused", retryAfter: "900" });
	});
});
