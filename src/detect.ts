import { type ProfileName, profileForUrl } from "./profiles.js";

/** Outcome of classifying a fetched page. */
export type PageVerdict =
	| { kind: "ok" }
	| { kind: "blocked"; reason: string; marker: string }
	| { kind: "session_expired" }
	| { kind: "rate_limited" };

const HCAPTCHA_WIDGET =
	/(?<=\s)class=["'][^"']*(?<![\w-])h-captcha(?![\w-])[^"']*["']/i;
const AMAZON_CAPTCHA = /(?<=\s)id=["']captchacharacters["']/i;
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

const RECAPTCHA_TAG =
	/<[a-z][^>]*(?<=\s)class=["'][^"']*(?<![\w-])g-recaptcha(?![\w-])[^"']*["'][^>]*>/i;
const FORM = /<form\b[^>]*>[\s\S]*?<\/form>/gi;
const FIELD = /<(input|textarea|select)\b[^>]*>/gi;
const CHALLENGE_INPUT_TYPES = new Set([
	"hidden",
	"submit",
	"button",
	"image",
	"reset",
]);

function attribute(tag: string, name: string): string | undefined {
	return new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(tag)?.[1];
}

function isChallengeField(tag: string, kind: string): boolean {
	if (kind === "input")
		return CHALLENGE_INPUT_TYPES.has(
			(attribute(tag, "type") ?? "text").toLowerCase(),
		);
	return (
		kind === "textarea" && attribute(tag, "name") === "g-recaptcha-response"
	);
}

/**
 * Return the opening tag of the first g-recaptcha element when it sits inside a
 * form whose only fields are hidden inputs, buttons and the response textarea,
 * or null for a widget outside any form or in a form a person fills in.
 */
export function challengeFormWidget(html: string): string | null {
	const markup = withoutScriptsAndStyles(html);
	const widget = RECAPTCHA_TAG.exec(markup);
	if (!widget) return null;
	for (const form of markup.matchAll(FORM)) {
		const start = form.index;
		if (widget.index < start || widget.index >= start + form[0].length)
			continue;
		const fields = form[0].matchAll(FIELD);
		for (const [tag, kind = ""] of fields)
			if (!isChallengeField(tag, kind.toLowerCase())) return null;
		return widget[0];
	}
	return null;
}

type Block = { reason: string; marker: string };

function blockReason(html: string, url: URL): Block | null {
	if (url.pathname.includes("/splashui/challenge"))
		return {
			reason: "ebay_challenge_redirect",
			marker: "ebay_challenge_redirect",
		};
	const markup = withoutScriptsAndStyles(html);
	if (INTERRUPTION_TITLE.test(pageTitle(html)))
		return { reason: "interruption_page", marker: "interruption_page" };
	if (profileForUrl(url) === "ebay" && EBAY_ERROR_TITLE.test(pageTitle(html)))
		return { reason: "ebay_error_page", marker: "ebay_error_page" };
	if (challengeFormWidget(html))
		return { reason: "captcha", marker: "captcha_widget:g-recaptcha" };
	if (HCAPTCHA_WIDGET.test(markup))
		return { reason: "captcha", marker: "captcha_widget:h-captcha" };
	if (AMAZON_CAPTCHA.test(markup))
		return { reason: "captcha", marker: "captcha_widget:amazon" };
	if (VERIFY_HUMAN.test(visibleText(markup)))
		return { reason: "verify_human", marker: "verify_human" };
	return null;
}

function isGoogleSorry(url: URL): boolean {
	return profileForUrl(url) === "google" && url.pathname.startsWith("/sorry");
}

/** True when a page still shows a challenge the classifier blocks: Google's /sorry or a CAPTCHA widget. */
export function hasChallenge(html: string, finalUrl: string): boolean {
	const url = URL.parse(finalUrl);
	const markup = withoutScriptsAndStyles(html);
	return (
		(url !== null && isGoogleSorry(url)) ||
		challengeFormWidget(html) !== null ||
		HCAPTCHA_WIDGET.test(markup) ||
		AMAZON_CAPTCHA.test(markup)
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
	if (isGoogleSorry(url))
		return { kind: "blocked", reason: "google_sorry", marker: "google_sorry" };

	// A target 429 is a rate limit even when its page carries a challenge
	// marker; only a block pauses the profile.
	if (input.status === 429) return { kind: "rate_limited" };

	const reason = blockReason(input.html, url);
	if (reason) return { kind: "blocked", ...reason };

	if (input.status === 403)
		return {
			kind: "blocked",
			reason: "http_block_status",
			marker: "http_block_status",
		};

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

/** Find a solvable reCAPTCHA v2 widget on a page, or null when there is none. */
export function detectChallenge(
	html: string,
	finalUrl: string,
): Challenge | null {
	const tag = challengeFormWidget(html);
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
