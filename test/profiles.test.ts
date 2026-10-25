import { describe, expect, it } from "vitest";
import {
	isLoginProfile,
	isProfileName,
	PROFILES,
	profileForUrl,
} from "../src/profiles.js";

describe("profileForUrl", () => {
	it.each([
		["https://www.ebay.com/sch/i.html", "ebay"],
		["https://ebay.com/itm/1", "ebay"],
		["https://m.ebay.com/itm/1", "ebay"],
		["https://signin.ebay.com/", "ebay"],
		["https://old.reddit.com/r/x", "reddit"],
		["https://np.reddit.com/r/x", "reddit"],
		["https://reddit.com/r/x", "reddit"],
		["https://www.amazon.com/s?k=x", "anon"],
		["https://WWW.EBAY.COM/", "ebay"],
		["https://www.ebay.com./itm/1", "ebay"],
		["https://reddit.com./r/x", "reddit"],
		["https://notebay.com/", "anon"],
		["https://ebay.com.evil.example/", "anon"],
		["https://myreddit.com/", "anon"],
	])("routes %s to %s", (url, expected) => {
		expect(profileForUrl(new URL(url))).toBe(expected);
	});
});

describe("profile guards", () => {
	it("recognizes profile names", () => {
		expect(isProfileName("anon")).toBe(true);
		expect(isProfileName("nope")).toBe(false);
	});

	it("treats anon as not a login profile", () => {
		expect(isLoginProfile("ebay")).toBe(true);
		expect(isLoginProfile("reddit")).toBe(true);
		expect(isLoginProfile("anon")).toBe(false);
	});

	it("defines gaps and login requirements", () => {
		expect(PROFILES.ebay.minGapMs).toEqual([20000, 40000]);
		expect(PROFILES.reddit.minGapMs).toEqual([5000, 10000]);
		expect(PROFILES.anon.minGapMs).toEqual([3000, 8000]);
		expect(PROFILES.anon.requiresLogin).toBe(false);
		expect(PROFILES.ebay.requiresLogin).toBe(true);
	});
});
