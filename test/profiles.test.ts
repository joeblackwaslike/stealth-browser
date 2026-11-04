import { describe, expect, it } from "vitest";
import {
	isLoginProfile,
	isProfileName,
	PROFILES,
	profileForUrl,
	scheduleKey,
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
		["https://www.google.com/search?q=x", "google"],
		["https://notgoogle.com/", "anon"],
	])("routes %s to %s", (url, expected) => {
		expect(profileForUrl(new URL(url))).toBe(expected);
	});
});

describe("google profile", () => {
	it("has its own pacing and needs no login", () => {
		expect(PROFILES.google.minGapMs).toEqual([8000, 15000]);
		expect(PROFILES.google.requiresLogin).toBe(false);
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

describe("scheduleKey", () => {
	it("maps ebay subdomains to ebay", () => {
		expect(scheduleKey(new URL("https://m.ebay.com/itm/1"))).toBe("ebay");
	});

	it("uses the hostname for unknown hosts", () => {
		expect(scheduleKey(new URL("https://WWW.Amazon.com./s"))).toBe(
			"www.amazon.com",
		);
	});
});

describe("pauseOnBlock", () => {
	it("is true only for ebay and reddit", () => {
		expect(
			Object.values(PROFILES)
				.filter((p) => p.pauseOnBlock)
				.map((p) => p.name),
		).toEqual(["ebay", "reddit"]);
	});
});
