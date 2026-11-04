import { type ProfileName, profileForUrl } from "./profiles.js";

/** Outcome of classifying a fetched page. */
export type PageVerdict =
	| { kind: "ok" }
	| { kind: "blocked"; reason: string }
	| { kind: "session_expired" }
	| { kind: "rate_limited" };

const CAPTCHA_WIDGET =
	/class=["'][^"']*\b(?:g-recaptcha|h-captcha)\b[^"']*["']|id=["']captchacharacters["']/i;
const VERIFY_HUMAN = /verify\s+you\s+are\s+human/i;
const INTERRUPTION_TITLE = /Pardon Our Interruption/i;
const EBAY_ERROR_TITLE = /^Error Page/i;

function pageTitle(html: string): string {
	return (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").trim();
}

function withoutScriptsAndStyles(html: string): string {
	return html
		.replace(/<script\b[\s\S]*?<\/script>/gi, " ")
		.replace(/<style\b[\s\S]*?<\/style>/gi, " ");
}

function visibleText(markup: string): string {
	return markup.replace(/<[^>]+>/g, " ");
}

function blockReason(html: string, url: URL): string | null {
	if (url.pathname.includes("/splashui/challenge"))
		return "ebay_challenge_redirect";
	const markup = withoutScriptsAndStyles(html);
	if (INTERRUPTION_TITLE.test(pageTitle(html))) return "interruption_page";
	if (profileForUrl(url) === "ebay" && EBAY_ERROR_TITLE.test(pageTitle(html)))
		return "ebay_error_page";
	if (CAPTCHA_WIDGET.test(markup)) return "captcha";
	if (VERIFY_HUMAN.test(visibleText(markup))) return "verify_human";
	return null;
}

function isGoogleSorry(url: URL): boolean {
	return profileForUrl(url) === "google" && url.pathname.startsWith("/sorry");
}

/** True when a page still shows a challenge the classifier blocks: Google's /sorry or a CAPTCHA widget. */
export function hasChallenge(html: string, finalUrl: string): boolean {
	const url = URL.parse(finalUrl);
	return (
		(url !== null && isGoogleSorry(url)) ||
		CAPTCHA_WIDGET.test(withoutScriptsAndStyles(html))
	);
}

/** Decide whether a fetched page is real content, a bot challenge, or a sign the login expired. */
export function classifyPage(input: {
	profile: ProfileName;
	html: string;
	finalUrl: string;
	cookieNames: readonly string[];
	status?: number | null;
}): PageVerdict {
	const url = new URL(input.finalUrl);

	// Google serves its /sorry challenge as a 429; it is a block, not a rate
	// limit, so an unsolved one pauses the profile.
	if (isGoogleSorry(url)) return { kind: "blocked", reason: "google_sorry" };

	// A target 429 is a rate limit even when its page carries a challenge
	// marker; only a block pauses the profile.
	if (input.status === 429) return { kind: "rate_limited" };

	const reason = blockReason(input.html, url);
	if (reason) return { kind: "blocked", reason };

	if (input.status === 403)
		return { kind: "blocked", reason: "http_block_status" };

	if (input.profile === "ebay" && url.hostname === "signin.ebay.com") {
		return { kind: "session_expired" };
	}
	if (
		input.profile === "reddit" &&
		(url.pathname.startsWith("/login") ||
			!input.cookieNames.includes("reddit_session"))
	) {
		return { kind: "session_expired" };
	}
	return { kind: "ok" };
}

/** A CAPTCHA the gateway can hand to a solver. */
export type Challenge = {
	type: "recaptcha_v2";
	sitekey: string;
	pageUrl: string;
	dataS?: string;
};

const RECAPTCHA_TAG =
	/<[a-z][^>]*class=["'][^"']*(?<![\w-])g-recaptcha(?![\w-])[^"']*["'][^>]*>/i;

function attribute(tag: string, name: string): string | undefined {
	return new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(tag)?.[1];
}

/** Find a solvable reCAPTCHA v2 widget on a page, or null when there is none. */
export function detectChallenge(
	html: string,
	finalUrl: string,
): Challenge | null {
	const tag = RECAPTCHA_TAG.exec(withoutScriptsAndStyles(html))?.[0];
	if (!tag) return null;
	const sitekey = attribute(tag, "data-sitekey");
	if (!sitekey) return null;
	const dataS = attribute(tag, "data-s");
	return {
		type: "recaptcha_v2",
		sitekey,
		pageUrl: finalUrl,
		...(dataS ? { dataS } : {}),
	};
}
