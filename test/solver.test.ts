import { describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import type { Challenge } from "../src/detect.js";
import {
	createSolver,
	createTwoCaptchaSolver,
	SolveBudgetExceededError,
	withBudget,
} from "../src/solver/index.js";

const challenge: Challenge = {
	type: "recaptcha_v2",
	sitekey: "SITEKEY",
	pageUrl: "https://www.google.com/sorry/index",
	dataS: "DATAS",
};

function json(body: unknown): Response {
	return new Response(JSON.stringify(body));
}

describe("createTwoCaptchaSolver", () => {
	it("submits then polls until the token is ready", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(json({ status: 1, request: "42" }))
			.mockResolvedValueOnce(json({ status: 0, request: "CAPCHA_NOT_READY" }))
			.mockResolvedValueOnce(json({ status: 1, request: "TOKEN" }));
		const solver = createTwoCaptchaSolver({
			apiKey: "SECRETKEY",
			baseUrl: "https://2captcha.test",
			pollIntervalMs: 0,
			fetchImpl,
		});

		await expect(solver.solve(challenge)).resolves.toBe("TOKEN");

		const submit = new URL(String(fetchImpl.mock.calls[0]?.[0]));
		expect(submit.pathname).toBe("/in.php");
		expect(submit.searchParams.get("method")).toBe("userrecaptcha");
		expect(submit.searchParams.get("googlekey")).toBe("SITEKEY");
		expect(submit.searchParams.get("pageurl")).toBe(challenge.pageUrl);
		expect(submit.searchParams.get("data-s")).toBe("DATAS");
		expect(submit.searchParams.get("json")).toBe("1");
		const poll = new URL(String(fetchImpl.mock.calls[1]?.[0]));
		expect(poll.pathname).toBe("/res.php");
		expect(poll.searchParams.get("action")).toBe("get");
		expect(poll.searchParams.get("id")).toBe("42");
	});

	it("omits data-s when the challenge has none", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(json({ status: 1, request: "1" }))
			.mockResolvedValueOnce(json({ status: 1, request: "T" }));
		const solver = createTwoCaptchaSolver({
			apiKey: "k",
			baseUrl: "https://2captcha.test",
			pollIntervalMs: 0,
			fetchImpl,
		});
		await solver.solve({ ...challenge, dataS: undefined });
		const submit = new URL(String(fetchImpl.mock.calls[0]?.[0]));
		expect(submit.searchParams.has("data-s")).toBe(false);
	});

	it("rejects on a submit error without leaking the api key", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValue(json({ status: 0, request: "ERROR_WRONG_USER_KEY" }));
		const solver = createTwoCaptchaSolver({
			apiKey: "SECRETKEY",
			baseUrl: "https://2captcha.test",
			pollIntervalMs: 0,
			fetchImpl,
		});
		const error = await solver.solve(challenge).catch((e: Error) => e);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("ERROR_WRONG_USER_KEY");
		expect((error as Error).message).not.toContain("SECRETKEY");
	});

	it("redacts the api key from network errors", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockRejectedValue(new Error("fetch failed: ...key=SECRETKEY&..."));
		const solver = createTwoCaptchaSolver({
			apiKey: "SECRETKEY",
			baseUrl: "https://2captcha.test",
			pollIntervalMs: 0,
			fetchImpl,
		});
		const error = (await solver
			.solve(challenge)
			.catch((e: Error) => e)) as Error;
		expect(error.message).toContain("<solver-key>");
		expect(error.message).not.toContain("SECRETKEY");
	});

	it("rejects when no token arrives within the timeout", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockImplementation(async (url) =>
				String(url).includes("/in.php")
					? json({ status: 1, request: "42" })
					: json({ status: 0, request: "CAPCHA_NOT_READY" }),
			);
		const solver = createTwoCaptchaSolver({
			apiKey: "SECRETKEY",
			baseUrl: "https://2captcha.test",
			timeoutMs: 30,
			pollIntervalMs: 5,
			fetchImpl,
		});
		await expect(solver.solve(challenge)).rejects.toThrow(/timed out/i);
	});
});

describe("withBudget", () => {
	it("rejects the call over budget and allows again after an hour", async () => {
		const inner = { solve: vi.fn().mockResolvedValue("T") };
		let t = 0;
		const solver = withBudget(inner, 2, () => t);
		await solver.solve(challenge);
		await solver.solve(challenge);
		await expect(solver.solve(challenge)).rejects.toBeInstanceOf(
			SolveBudgetExceededError,
		);
		expect(inner.solve).toHaveBeenCalledTimes(2);
		t = 60 * 60 * 1000;
		await expect(solver.solve(challenge)).resolves.toBe("T");
	});
});

describe("createSolver", () => {
	const base: Config = {
		gatewayToken: "t".repeat(32),
		camoufoxWsUrl: "ws://x",
		stateDir: "/state",
		port: 8080,
		logLevel: "info",
		solverBaseUrl: "https://2captcha.com",
		solverMaxPerHour: 20,
	};

	it("returns undefined without an api key", () => {
		expect(createSolver(base)).toBeUndefined();
	});

	it("returns a solver with an api key", () => {
		expect(createSolver({ ...base, solverApiKey: "k" })).toBeDefined();
	});
});
