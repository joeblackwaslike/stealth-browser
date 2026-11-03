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

	it("calls a 200 with the search container a results page", () => {
		expect(
			classifyResponse(200, new Headers(), '<div id="search"></div>'),
		).toEqual({ kind: "results" });
	});

	it("marks a 423 with a non-JSON body unparseable, not a gateway pause reason", () => {
		expect(classifyResponse(423, new Headers(), "not json")).toEqual({
			kind: "paused",
			reason: "unparseable",
			retryAfter: null,
		});
	});

	it("calls any other status other", () => {
		expect(classifyResponse(500, new Headers(), "")).toEqual({
			kind: "other",
		});
	});
});

describe("classifyResponse fallthrough", () => {
	it("keeps reason unknown for a JSON 423 without a reason", () => {
		expect(classifyResponse(423, new Headers(), "{}")).toMatchObject({
			reason: "unknown",
		});
	});

	it("calls a 200 with neither results nor a /sorry/ marker other, not a challenge", () => {
		expect(
			classifyResponse(200, new Headers(), "<html>consent interstitial</html>"),
		).toEqual({ kind: "other" });
	});
});
