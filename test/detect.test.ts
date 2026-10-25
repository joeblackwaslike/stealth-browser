import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { classifyPage } from "../src/detect.js";

const fixture = (name: string) =>
	readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("classifyPage", () => {
	it("blocks an eBay challenge redirect", async () => {
		const verdict = classifyPage({
			profile: "ebay",
			html: "<html><body>hi</body></html>",
			finalUrl: "https://www.ebay.com/splashui/challenge?ap=1",
			cookieNames: [],
		});
		expect(verdict).toEqual({
			kind: "blocked",
			reason: "ebay_challenge_redirect",
		});
	});

	it("blocks a Pardon Our Interruption page", async () => {
		const verdict = classifyPage({
			profile: "ebay",
			html: await fixture("ebay-challenge.html"),
			finalUrl: "https://www.ebay.com/sch/i.html",
			cookieNames: [],
		});
		expect(verdict).toEqual({ kind: "blocked", reason: "interruption_page" });
	});

	it.each([
		'<div class="g-recaptcha"></div>',
		'<div class="h-captcha"></div>',
		'<input id="captchacharacters">',
	])("blocks a captcha widget: %s", (widget) => {
		const verdict = classifyPage({
			profile: "anon",
			html: `<html><head><title>x</title></head><body>${widget}</body></html>`,
			finalUrl: "https://www.amazon.com/s?k=x",
			cookieNames: [],
		});
		expect(verdict).toEqual({ kind: "blocked", reason: "captcha" });
	});

	it("blocks on 'verify you are human' in visible text", () => {
		const verdict = classifyPage({
			profile: "anon",
			html: "<html><body><p>Please Verify You Are Human to continue</p></body></html>",
			finalUrl: "https://example.com/",
			cookieNames: [],
		});
		expect(verdict).toEqual({ kind: "blocked", reason: "verify_human" });
	});

	it("ignores 'verify you are human' inside a script", () => {
		const verdict = classifyPage({
			profile: "anon",
			html: '<html><body><script>var m = "verify you are human"</script><p>ok</p></body></html>',
			finalUrl: "https://example.com/",
			cookieNames: [],
		});
		expect(verdict).toEqual({ kind: "ok" });
	});

	it("treats a page whose script mentions captcha as ok", async () => {
		const verdict = classifyPage({
			profile: "anon",
			html: await fixture("amazon-search-ok.html"),
			finalUrl: "https://www.amazon.com/s?k=widgets",
			cookieNames: [],
		});
		expect(verdict).toEqual({ kind: "ok" });
	});

	it("treats a page whose script contains captcha widget markup as ok", () => {
		const verdict = classifyPage({
			profile: "anon",
			html: `<html><head><title>x</title></head><body><script>var t = '<div class="g-recaptcha"></div><input id="captchacharacters">'</script><p>ok</p></body></html>`,
			finalUrl: "https://www.amazon.com/s?k=x",
			cookieNames: [],
		});
		expect(verdict).toEqual({ kind: "ok" });
	});

	it("returns ok for a real Reddit search page", async () => {
		const verdict = classifyPage({
			profile: "reddit",
			html: await fixture("reddit-search-ok.html"),
			finalUrl:
				"https://old.reddit.com/r/mechmarket/search?q=keychron&restrict_sr=on",
			cookieNames: ["reddit_session"],
		});
		expect(verdict).toEqual({ kind: "ok" });
	});

	it("reports session_expired when eBay redirects to signin.ebay.com", () => {
		const verdict = classifyPage({
			profile: "ebay",
			html: "<html><body>Sign in</body></html>",
			finalUrl: "https://signin.ebay.com/ws/eBayISAPI.dll",
			cookieNames: [],
		});
		expect(verdict).toEqual({ kind: "session_expired" });
	});

	it("reports session_expired for reddit on a /login redirect", async () => {
		const verdict = classifyPage({
			profile: "reddit",
			html: await fixture("reddit-login-wall.html"),
			finalUrl: "https://www.reddit.com/login/?dest=x",
			cookieNames: ["reddit_session"],
		});
		expect(verdict).toEqual({ kind: "session_expired" });
	});

	it("reports session_expired for reddit when reddit_session cookie is missing", () => {
		const verdict = classifyPage({
			profile: "reddit",
			html: "<html><body>r/test</body></html>",
			finalUrl: "https://www.reddit.com/r/test",
			cookieNames: ["csrf_token"],
		});
		expect(verdict).toEqual({ kind: "session_expired" });
	});

	it("returns ok for a healthy eBay sold page", async () => {
		const verdict = classifyPage({
			profile: "ebay",
			html: await fixture("ebay-sold-ok.html"),
			finalUrl: "https://www.ebay.com/sch/i.html?LH_Sold=1",
			cookieNames: ["s"],
		});
		expect(verdict).toEqual({ kind: "ok" });
	});

	it("checks blocks before session expiry", async () => {
		const verdict = classifyPage({
			profile: "reddit",
			html: await fixture("ebay-challenge.html"),
			finalUrl: "https://www.reddit.com/r/test",
			cookieNames: [],
		});
		expect(verdict.kind).toBe("blocked");
	});

	it("blocks an eBay error page", async () => {
		const verdict = classifyPage({
			profile: "ebay",
			html: await fixture("ebay-error-page.html"),
			finalUrl: "https://www.ebay.com/sch/i.html?_nkw=thinkpad",
			cookieNames: ["s"],
		});
		expect(verdict).toEqual({
			kind: "blocked",
			reason: "ebay_error_page",
		});
	});

	it("blocks an eBay error page even for anon profile", () => {
		const verdict = classifyPage({
			profile: "anon",
			html: "<html><head><title>Error Page | eBay</title></head><body>error</body></html>",
			finalUrl: "https://www.ebay.com/sch/i.html",
			cookieNames: [],
		});
		expect(verdict).toEqual({
			kind: "blocked",
			reason: "ebay_error_page",
		});
	});

	it("returns rate_limited when target responds with 429", () => {
		const verdict = classifyPage({
			profile: "ebay",
			html: "<html><body>Too many requests</body></html>",
			finalUrl: "https://www.ebay.com/sch/i.html",
			cookieNames: ["s"],
			status: 429,
		});
		expect(verdict).toEqual({ kind: "rate_limited" });
	});

	it("returns rate_limited for a target 429 even when the page carries a challenge marker", () => {
		const verdict = classifyPage({
			profile: "anon",
			html: '<html><body><div class="g-recaptcha"></div></body></html>',
			finalUrl: "https://example.com/",
			cookieNames: [],
			status: 429,
		});
		expect(verdict).toEqual({ kind: "rate_limited" });
	});

	it("ignores an 'Error Page' title outside eBay", () => {
		const verdict = classifyPage({
			profile: "anon",
			html: "<html><head><title>Error Page - Acme Docs</title></head><body>how to read errors</body></html>",
			finalUrl: "https://docs.example.com/errors",
			cookieNames: [],
			status: 200,
		});
		expect(verdict).toEqual({ kind: "ok" });
	});

	it("blocks when eBay responds with 403", () => {
		const verdict = classifyPage({
			profile: "ebay",
			html: "<html><head><title>Error Page | eBay</title></head><body>forbidden</body></html>",
			finalUrl: "https://www.ebay.com/sch/i.html",
			cookieNames: ["s"],
			status: 403,
		});
		expect(verdict).toEqual({
			kind: "blocked",
			reason: "ebay_error_page",
		});
	});

	it("does not treat a 403 with real content as blocked", () => {
		const verdict = classifyPage({
			profile: "ebay",
			html: "<html><head><title>eBay - Sold Items</title></head><body><div class='s-item__price'>$50</div></body></html>",
			finalUrl: "https://www.ebay.com/sch/i.html?LH_Sold=1",
			cookieNames: ["s"],
			status: 403,
		});
		expect(verdict).toEqual({
			kind: "blocked",
			reason: "http_block_status",
		});
	});

	it("does not treat a 200 with normal title as rate_limited", () => {
		const verdict = classifyPage({
			profile: "ebay",
			html: "<html><head><title>thinkpad | eBay</title></head><body>ok</body></html>",
			finalUrl: "https://www.ebay.com/sch/i.html",
			cookieNames: ["s"],
			status: 200,
		});
		expect(verdict).toEqual({ kind: "ok" });
	});

	it("never reports session_expired for anon", () => {
		const verdict = classifyPage({
			profile: "anon",
			html: "<html><body>Sign in</body></html>",
			finalUrl: "https://signin.ebay.com/",
			cookieNames: [],
		});
		expect(verdict).toEqual({ kind: "ok" });
	});
});
