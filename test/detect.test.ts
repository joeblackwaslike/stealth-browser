import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { classifyPage, detectChallenge, hasChallenge } from "../src/detect.js";

const fixture = (name: string) =>
	readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

const WIDGET = '<div class="g-recaptcha" data-sitekey="K"></div>';
const challengeForm = (widget = WIDGET) =>
	`<form action="/verify" method="post"><input type="hidden" name="continue" value="x">${widget}<textarea name="g-recaptcha-response" class="g-recaptcha-response"></textarea><input type="submit" value="Continue"></form>`;
const contentForm = (field: string) =>
	`<form action="/signup" method="post">${field}${WIDGET}<button type="submit">Go</button></form>`;
const classifyAnon = (body: string) =>
	classifyPage({
		profile: "anon",
		html: `<html><head><title>x</title></head><body>${body}</body></html>`,
		finalUrl: "https://example.com/",
		cookieNames: [],
	});

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
			marker: "ebay_challenge_redirect",
		});
	});

	it("blocks a Pardon Our Interruption page", async () => {
		const verdict = classifyPage({
			profile: "ebay",
			html: await fixture("ebay-challenge.html"),
			finalUrl: "https://www.ebay.com/sch/i.html",
			cookieNames: [],
		});
		expect(verdict).toEqual({
			kind: "blocked",
			reason: "interruption_page",
			marker: "interruption_page",
		});
	});

	it.each([
		['<div class="h-captcha"></div>', "captcha_widget:h-captcha"],
		['<input id="captchacharacters">', "captcha_widget:amazon"],
	])("blocks a captcha widget unconditionally: %s", (widget, marker) => {
		const verdict = classifyPage({
			profile: "anon",
			html: `<html><head><title>x</title></head><body>${widget}</body></html>`,
			finalUrl: "https://www.amazon.com/s?k=x",
			cookieNames: [],
		});
		expect(verdict).toEqual({ kind: "blocked", reason: "captcha", marker });
	});

	it("blocks a reCAPTCHA challenge form", () => {
		expect(classifyAnon(challengeForm())).toEqual({
			kind: "blocked",
			reason: "captcha",
			marker: "captcha_widget:g-recaptcha",
		});
	});

	it.each([
		['<input type="text" name="q">'],
		['<input name="q">'],
		['<input type="email" name="email">'],
		['<input type="password" name="pw">'],
		['<textarea name="comment"></textarea>'],
		['<select name="s"><option>a</option></select>'],
		['<input type="checkbox" name="agree">'],
		['<input type="radio" name="r">'],
	])("returns ok for a widget in a content form with %s", (field) => {
		expect(classifyAnon(contentForm(field))).toEqual({ kind: "ok" });
	});

	it("returns ok for a widget outside any form", () => {
		expect(classifyAnon(WIDGET)).toEqual({ kind: "ok" });
	});

	it("judges only the first widget", () => {
		const html = `${contentForm('<input type="text" name="q">')}${challengeForm()}`;
		expect(classifyAnon(html)).toEqual({ kind: "ok" });
	});

	it("blocks on 'verify you are human' in visible text", () => {
		const verdict = classifyPage({
			profile: "anon",
			html: "<html><body><p>Please Verify You Are Human to continue</p></body></html>",
			finalUrl: "https://example.com/",
			cookieNames: [],
		});
		expect(verdict).toEqual({
			kind: "blocked",
			reason: "verify_human",
			marker: "verify_human",
		});
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

	it("treats the hidden response textarea of an invisible reCAPTCHA as ok", () => {
		const verdict = classifyPage({
			profile: "anon",
			html: `<html><head><title>Your Go-to Marketplace</title></head><body><div class="grecaptcha-badge"><div class="grecaptcha-error"></div><textarea id="g-recaptcha-response-100000" name="g-recaptcha-response" class="g-recaptcha-response" style="display: none;"></textarea></div><p>listings</p></body></html>`,
			finalUrl: "https://www.mercari.com/",
			cookieNames: [],
		});
		expect(verdict).toEqual({ kind: "ok" });
	});

	it("treats an hCaptcha response textarea as ok", () => {
		const verdict = classifyPage({
			profile: "anon",
			html: `<html><body><textarea name="h-captcha-response" class="h-captcha-response"></textarea></body></html>`,
			finalUrl: "https://example.com/",
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
			marker: "ebay_error_page",
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
			marker: "ebay_error_page",
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

	it("blocks google's 429 sorry page so a failed solve pauses the profile", async () => {
		const verdict = classifyPage({
			profile: "google",
			html: await fixture("google-sorry.html"),
			finalUrl: "https://www.google.com/sorry/index?continue=x",
			cookieNames: [],
			status: 429,
		});
		expect(verdict).toEqual({
			kind: "blocked",
			reason: "google_sorry",
			marker: "google_sorry",
		});
	});

	it("still treats a google 429 outside /sorry as rate_limited", () => {
		const verdict = classifyPage({
			profile: "google",
			html: "<html><body>Too many requests</body></html>",
			finalUrl: "https://www.google.com/search?q=x",
			cookieNames: [],
			status: 429,
		});
		expect(verdict).toEqual({ kind: "rate_limited" });
	});

	it("does not treat a lookalike host's /sorry page as google_sorry", () => {
		const verdict = classifyPage({
			profile: "anon",
			html: "<html><body>Too many requests</body></html>",
			finalUrl: "https://notgoogle.com/sorry/index",
			cookieNames: [],
			status: 429,
		});
		expect(verdict).toEqual({ kind: "rate_limited" });
	});

	it.each([
		[
			challengeForm('<div class="g-recaptcha extra"></div>'),
			"captcha",
			"captcha_widget:g-recaptcha",
		],
		["<div class='h-captcha'></div>", "captcha", "captcha_widget:h-captcha"],
		[
			"<p>Please verify you\n   <b>are</b> human</p>",
			"verify_human",
			"verify_human",
		],
	])("blocks a challenge written as %s", (html, reason, marker) => {
		const verdict = classifyPage({
			profile: "anon",
			html: `<html><body>${html}</body></html>`,
			finalUrl: "https://example.com/",
			cookieNames: [],
			status: 200,
		});
		expect(verdict).toEqual({ kind: "blocked", reason, marker });
	});

	it("blocks an eBay error page whose title has leading whitespace", () => {
		const verdict = classifyPage({
			profile: "ebay",
			html: "<html><head><title>\n  Error Page | eBay</title></head><body></body></html>",
			finalUrl: "https://www.ebay.com/sch/i.html",
			cookieNames: ["s"],
			status: 200,
		});
		expect(verdict).toEqual({
			kind: "blocked",
			reason: "ebay_error_page",
			marker: "ebay_error_page",
		});
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
			marker: "ebay_error_page",
		});
	});

	it("treats a 403 as blocked even when the page has real content", () => {
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
			marker: "http_block_status",
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

	it.each([
		'<div data-class="g-recaptcha"></div>',
		'<input data-id="captchacharacters">',
	])("does not block an attribute-name lookalike: %s", (widget) => {
		const verdict = classifyPage({
			profile: "anon",
			html: `<html><body>${widget}</body></html>`,
			finalUrl: "https://example.com/",
			cookieNames: [],
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

describe("detectChallenge", () => {
	const sorryUrl = "https://www.google.com/sorry/index?continue=x";

	it("reads sitekey and data-s from a google sorry page", async () => {
		expect(
			detectChallenge(await fixture("google-sorry.html"), sorryUrl),
		).toEqual({
			type: "recaptcha_v2",
			sitekey: "SITEKEY123",
			pageUrl: sorryUrl,
			dataS: "DATAS456",
		});
	});

	it("omits dataS when the widget has none", async () => {
		expect(
			detectChallenge(await fixture("recaptcha-widget.html"), sorryUrl),
		).toEqual({
			type: "recaptcha_v2",
			sitekey: "SITEKEY123",
			pageUrl: sorryUrl,
		});
	});

	it("returns null for a widget without data-sitekey", () => {
		expect(
			detectChallenge(
				challengeForm('<div class="g-recaptcha"></div>'),
				sorryUrl,
			),
		).toBeNull();
	});

	it("returns null for the eBay challenge page", async () => {
		expect(
			detectChallenge(await fixture("ebay-challenge.html"), sorryUrl),
		).toBeNull();
	});

	it("returns null for a normal reddit page", async () => {
		expect(
			detectChallenge(await fixture("reddit-search-ok.html"), sorryUrl),
		).toBeNull();
	});

	it("returns null for a g-recaptcha-response element", () => {
		expect(
			detectChallenge(
				'<textarea class="g-recaptcha-response" data-sitekey="X"></textarea>',
				sorryUrl,
			),
		).toBeNull();
	});

	it("reads both values when data-s comes before data-sitekey", () => {
		expect(
			detectChallenge(
				challengeForm(
					'<div class="g-recaptcha" data-s="S1" data-sitekey="K1"></div>',
				),
				sorryUrl,
			),
		).toEqual({
			type: "recaptcha_v2",
			sitekey: "K1",
			pageUrl: sorryUrl,
			dataS: "S1",
		});
	});

	it("accepts single-quoted attributes", () => {
		expect(
			detectChallenge(
				challengeForm("<div class='g-recaptcha' data-sitekey='K2'></div>"),
				sorryUrl,
			),
		).toEqual({ type: "recaptcha_v2", sitekey: "K2", pageUrl: sorryUrl });
	});

	it("returns null for a widget in a content form", () => {
		expect(
			detectChallenge(contentForm('<input type="text" name="q">'), sorryUrl),
		).toBeNull();
	});

	it("ignores a widget inside a script template", () => {
		expect(
			detectChallenge(
				'<script type="text/template"><div class="g-recaptcha" data-sitekey="K3"></div></script>',
				sorryUrl,
			),
		).toBeNull();
	});
});

describe("hasChallenge", () => {
	it("is true for a google /sorry URL with no widget markup", () => {
		expect(
			hasChallenge(
				"<html><body>sorry</body></html>",
				"https://www.google.com/sorry/index?continue=x",
			),
		).toBe(true);
	});

	it("is false for a lookalike host's /sorry path", () => {
		expect(
			hasChallenge(
				"<html><body>sorry</body></html>",
				"https://notgoogle.com/sorry/index",
			),
		).toBe(false);
	});

	it("is true for a reCAPTCHA challenge form on an ordinary URL", () => {
		expect(hasChallenge(challengeForm(), "https://example.com/")).toBe(true);
	});

	it("is false for a widget in a content form", () => {
		expect(
			hasChallenge(
				contentForm('<input type="text" name="q">'),
				"https://example.com/",
			),
		).toBe(false);
	});

	it("is true for an hCaptcha widget or captchacharacters marker", () => {
		expect(
			hasChallenge('<div class="h-captcha"></div>', "https://example.com/"),
		).toBe(true);
		expect(
			hasChallenge('<input id="captchacharacters">', "https://example.com/"),
		).toBe(true);
	});

	it("is false for a hidden g-recaptcha-response textarea only", () => {
		expect(
			hasChallenge(
				'<textarea class="g-recaptcha-response"></textarea>',
				"https://example.com/",
			),
		).toBe(false);
	});

	it("is false for widget markup inside a script only", () => {
		expect(
			hasChallenge(
				"<script>var t = '<div class=\"g-recaptcha\"></div>'</script>",
				"https://example.com/",
			),
		).toBe(false);
	});

	it("returns false for an unparsable finalUrl without throwing", () => {
		expect(hasChallenge("<html><body>ok</body></html>", "")).toBe(false);
		expect(hasChallenge(challengeForm(), "")).toBe(true);
	});
});

describe("detectChallenge attribute boundaries", () => {
	it("ignores an attribute whose name only ends in data-sitekey", () => {
		const html = challengeForm(
			'<div class="g-recaptcha" not-data-sitekey="WRONG" data-sitekey="RIGHT"></div>',
		);
		expect(detectChallenge(html, "https://example.com/")?.sitekey).toBe(
			"RIGHT",
		);
		expect(
			detectChallenge(
				challengeForm(
					'<div class="g-recaptcha" not-data-sitekey="WRONG"></div>',
				),
				"https://example.com/",
			),
		).toBeNull();
	});
});
