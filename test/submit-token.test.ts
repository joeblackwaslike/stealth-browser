// @vitest-environment happy-dom
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCamoufoxFetcher } from "../src/browser.js";

// Runs browser.ts's real page.evaluate callbacks against a DOM, so the token
// fill and form submit are exercised rather than stubbed.

const fakeConnect = vi.hoisted(() => ({ browser: undefined as unknown }));

vi.mock("playwright-core", async (importOriginal) => {
	const real = await importOriginal<typeof import("playwright-core")>();
	return {
		...real,
		firefox: { connect: () => Promise.resolve(fakeConnect.browser) },
	};
});

afterEach(() => {
	vi.restoreAllMocks();
	document.body.innerHTML = "";
});

const SORRY_URL = "https://www.google.com/sorry/index?continue=x";
const RESULTS_URL = "https://www.google.com/search?q=x";
const SITEKEY_FIXTURE = join(import.meta.dirname, "fixtures/google-sorry.html");

type Submitted = { formId: string; token: FormDataEntryValue | null };

function domPage(
	bodyHtml: string,
	opts: { navigationFails?: boolean; served?: string } = {},
) {
	document.body.innerHTML = bodyHtml;
	const submitted: Submitted[] = [];
	let markSubmitted!: () => void;
	const submit = new Promise<void>((resolve) => {
		markSubmitted = resolve;
	});
	vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(function (
		this: HTMLFormElement,
	) {
		submitted.push({
			formId: this.id,
			token: new FormData(this).get("g-recaptcha-response"),
		});
		markSubmitted();
	});
	const page = {
		goto: async () => ({ status: () => 429 }),
		waitForTimeout: async () => {},
		content: async () =>
			submitted.length > 0
				? "<html><body>results</body></html>"
				: (opts.served ?? document.documentElement.outerHTML),
		url: () => (submitted.length > 0 ? RESULTS_URL : SORRY_URL),
		waitForNavigation: () =>
			opts.navigationFails
				? Promise.reject(new Error("Timeout 30000ms exceeded"))
				: submit.then(() => ({ status: () => 200 })),
		evaluate: async <A, R>(fn: (arg: A) => R, arg: A) => fn(arg),
	};
	fakeConnect.browser = {
		isConnected: () => true,
		on: () => {},
		newContext: async () => ({
			route: async () => {},
			newPage: async () => page,
			storageState: async () => ({ cookies: [], origins: [] }),
			close: async () => {},
		}),
		close: async () => {},
	};
	return { submitted };
}

async function fetchWithToken(solve = async () => "TOKEN") {
	return createCamoufoxFetcher("ws://fake/").fetch({
		url: SORRY_URL,
		waitForTimeout: 0,
		solver: { solve },
	});
}

const WIDGET = '<div class="g-recaptcha" data-sitekey="SITEKEY123"></div>';

async function sorryBody(): Promise<string> {
	const html = await readFile(SITEKEY_FIXTURE, "utf8");
	return /<body>([\s\S]*)<\/body>/.exec(html)?.[1] ?? "";
}

describe("submitToken against a DOM", () => {
	it("creates the response field in the enclosing form and submits the token", async () => {
		const body = (await sorryBody()).replace(
			/<textarea id="g-recaptcha-response"[^>]*><\/textarea>/,
			"",
		);
		const { submitted } = domPage(body);
		const result = await fetchWithToken();
		expect(submitted).toEqual([{ formId: "captcha-form", token: "TOKEN" }]);
		expect(result).toMatchObject({ solve: "solved", finalUrl: RESULTS_URL });
	});

	it("fills an existing response field instead of adding a second one", async () => {
		const { submitted } = domPage(await sorryBody());
		await fetchWithToken();
		expect(submitted).toEqual([{ formId: "captcha-form", token: "TOKEN" }]);
		expect(document.querySelectorAll("#g-recaptcha-response")).toHaveLength(1);
	});

	it("reuses an existing response textarea with a suffixed id instead of adding a second one", async () => {
		const body = (await sorryBody()).replace(
			/<textarea id="g-recaptcha-response"([^>]*)><\/textarea>/,
			'<textarea id="g-recaptcha-response-100000"$1></textarea>',
		);
		const { submitted } = domPage(body);
		await fetchWithToken();
		expect(submitted).toEqual([{ formId: "captcha-form", token: "TOKEN" }]);
		expect(
			document.querySelectorAll('[name="g-recaptcha-response"]'),
		).toHaveLength(1);
	});

	it("accepts a challenge form that wraps its widget in a fieldset", async () => {
		const { submitted } = domPage(
			`<form id="captcha-form" action="/x"><fieldset><input type="hidden" name="t">${WIDGET}</fieldset><button>Go</button></form>`,
		);
		const result = await fetchWithToken();
		expect(submitted).toEqual([{ formId: "captcha-form", token: "TOKEN" }]);
		expect(result).toMatchObject({ solve: "solved" });
	});

	it("does not attempt a solve or submit for a widget outside any form", async () => {
		const { submitted } = domPage(
			'<div class="g-recaptcha" data-sitekey="SITEKEY123"></div>',
		);
		const result = await fetchWithToken();
		expect(submitted).toEqual([]);
		expect(result.solve).toBeUndefined();
	});

	it.each([
		[
			"a text field tied to the form with form= from outside it",
			`<form id="signup" action="/signup">${WIDGET}<input type="hidden" name="t"><button>Join</button></form><input form="signup" type="email" name="email">`,
		],
		[
			"a template whose widget the live DOM does not contain",
			`<template><form>${WIDGET}<input type="hidden" name="x"></form></template><form id="real"><input type="hidden" name="e"></form>`,
		],
	])("neither solves nor submits for %s", async (_name, body) => {
		const { submitted } = domPage(body);
		const solve = vi.fn(async () => "TOKEN");
		const result = await fetchWithToken(solve);
		expect(solve).not.toHaveBeenCalled();
		expect(submitted).toEqual([]);
		expect(result).toMatchObject({ solve: "failed", solveReason: "no_form" });
	});

	it.each([
		[
			"the hidden attribute",
			'<div class="g-recaptcha" data-sitekey="SITEKEY123" hidden></div>',
		],
		[
			"display:none",
			'<div class="g-recaptcha" data-sitekey="SITEKEY123" style="display:none"></div>',
		],
		[
			"visibility:hidden",
			'<div class="g-recaptcha" data-sitekey="SITEKEY123" style="visibility:hidden"></div>',
		],
		[
			"a display:none ancestor",
			'<div style="display:none"><div class="g-recaptcha" data-sitekey="SITEKEY123"></div></div>',
		],
	])(
		"neither solves nor submits for a widget hidden by %s",
		async (_name, widget) => {
			const { submitted } = domPage(
				`<form id="captcha-form" action="/x"><input type="hidden" name="t">${widget}<button>Go</button></form>`,
			);
			const solve = vi.fn(async () => "TOKEN");
			const result = await fetchWithToken(solve);
			expect(solve).not.toHaveBeenCalled();
			expect(submitted).toEqual([]);
			expect(result).toMatchObject({ solve: "failed", solveReason: "no_form" });
		},
	);

	it("still solves a normally rendered widget", async () => {
		const { submitted } = domPage(
			`<form id="captcha-form" action="/x"><input type="hidden" name="t"><div><div class="g-recaptcha" data-sitekey="SITEKEY123" style="display:block"></div></div><button>Go</button></form>`,
		);
		const result = await fetchWithToken();
		expect(submitted).toEqual([{ formId: "captcha-form", token: "TOKEN" }]);
		expect(result).toMatchObject({ solve: "solved" });
	});

	it("neither solves nor submits for a widget that only exists inside noscript", async () => {
		const { submitted } = domPage("<noscript></noscript><p>content</p>", {
			served: `<html><body><noscript><form>${WIDGET}</form></noscript><p>content</p></body></html>`,
		});
		const noscript = document.querySelector("noscript");
		if (noscript) noscript.textContent = `<form>${WIDGET}</form>`;
		const solve = vi.fn(async () => "TOKEN");
		const result = await fetchWithToken(solve);
		expect(solve).not.toHaveBeenCalled();
		expect(submitted).toEqual([]);
		expect(result).toMatchObject({ solve: "failed", solveReason: "no_form" });
	});

	it("does not submit a form that gained a text field while the solver ran", async () => {
		const { submitted } = domPage(await sorryBody());
		const result = await fetchWithToken(async () => {
			document
				.querySelector("#captcha-form")
				?.insertAdjacentHTML("beforeend", '<input type="text" name="q2">');
			return "TOKEN";
		});
		expect(submitted).toEqual([]);
		expect(result).toMatchObject({ solve: "failed", solveReason: "no_form" });
	});

	it("reports navigation_failed when the submit's navigation never arrives", async () => {
		domPage(await sorryBody(), { navigationFails: true });
		const result = await fetchWithToken();
		expect(result).toMatchObject({
			solve: "failed",
			solveReason: "navigation_failed",
			finalUrl: SORRY_URL,
		});
	});
});
