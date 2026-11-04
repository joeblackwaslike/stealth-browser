import { describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import type { Challenge } from "../src/detect.js";
import {
	createSolver,
	createTwoCaptchaSolver,
	SolveBudgetExceededError,
	withBudget,
} from "../src/solver/index.js";
import { type SolveReason, tagSolveReason } from "../src/solver/types.js";

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

	it("refuses redirects on submit and poll so the key stays on https", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(json({ status: 1, request: "42" }))
			.mockResolvedValueOnce(json({ status: 1, request: "TOKEN" }));
		const solver = createTwoCaptchaSolver({
			apiKey: "SECRETKEY",
			baseUrl: "https://2captcha.test",
			pollIntervalMs: 0,
			fetchImpl,
		});

		await solver.solve(challenge);

		expect(fetchImpl.mock.calls[0]?.[1]?.redirect).toBe("error");
		expect(fetchImpl.mock.calls[1]?.[1]?.redirect).toBe("error");
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

describe("createTwoCaptchaSolver resilience", () => {
	const opts = {
		apiKey: "SECRETKEY",
		baseUrl: "https://2captcha.test",
		pollIntervalMs: 0,
	};

	function hangUntilAborted(init?: RequestInit): Promise<Response> {
		return new Promise((_resolve, reject) => {
			init?.signal?.addEventListener("abort", () =>
				reject(new Error("aborted https://2captcha.test/in.php?key=SECRETKEY")),
			);
		});
	}

	it("rejects with a redacted timeout when a request hangs", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockImplementation((_url, init) => hangUntilAborted(init));
		const solver = createTwoCaptchaSolver({
			...opts,
			timeoutMs: 20,
			fetchImpl,
		});
		const error = (await solver
			.solve(challenge)
			.catch((e: Error) => e)) as Error;
		expect(error.message).toBe("solver timed out");
	});

	it("keeps polling through a transient 503 with an html body", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(json({ status: 1, request: "42" }))
			.mockResolvedValueOnce(
				new Response("<html>bad gateway</html>", { status: 503 }),
			)
			.mockResolvedValueOnce(json({ status: 1, request: "TOKEN" }));
		const solver = createTwoCaptchaSolver({ ...opts, fetchImpl });
		await expect(solver.solve(challenge)).resolves.toBe("TOKEN");
	});

	it("fails a 503 on submit with the status and no key", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValue(
				new Response("<html>SECRETKEY</html>", { status: 503 }),
			);
		const solver = createTwoCaptchaSolver({ ...opts, fetchImpl });
		const error = (await solver
			.solve(challenge)
			.catch((e: Error) => e)) as Error;
		expect(error.message).toContain("503");
		expect(error.message).not.toContain("SECRETKEY");
	});

	it("fails a poll immediately on a permanent HTTP status, without retrying", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(json({ status: 1, request: "42" }))
			.mockResolvedValueOnce(new Response("forbidden", { status: 401 }));
		const solver = createTwoCaptchaSolver({ ...opts, fetchImpl });
		const error = (await solver
			.solve(challenge)
			.catch((e: Error) => e)) as Error;
		expect(error.message).toBe("solver poll failed: HTTP 401");
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("clamps the poll sleep to the remaining budget", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockImplementation(async (url) =>
				String(url).includes("/in.php")
					? json({ status: 1, request: "42" })
					: json({ status: 0, request: "CAPCHA_NOT_READY" }),
			);
		const solver = createTwoCaptchaSolver({
			...opts,
			timeoutMs: 30,
			pollIntervalMs: 5_000,
			fetchImpl,
		});
		const started = Date.now();
		await expect(solver.solve(challenge)).rejects.toThrow(/timed out/i);
		expect(Date.now() - started).toBeLessThan(1_000);
	});

	it("treats a null poll reply as a transient tick, not a crash", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(json({ status: 1, request: "42" }))
			.mockResolvedValueOnce(json(null))
			.mockResolvedValueOnce(json({ status: 1, request: "TOKEN" }));
		const solver = createTwoCaptchaSolver({ ...opts, fetchImpl });
		await expect(solver.solve(challenge)).resolves.toBe("TOKEN");
	});

	it("treats a poll reply missing request as a transient tick", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(json({ status: 1, request: "42" }))
			.mockResolvedValueOnce(json({ status: 1 }))
			.mockResolvedValueOnce(json({ status: 1, request: "TOKEN" }));
		const solver = createTwoCaptchaSolver({ ...opts, fetchImpl });
		await expect(solver.solve(challenge)).resolves.toBe("TOKEN");
	});

	it("fails a non-object submit reply as a provider error", async () => {
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json(null));
		const solver = createTwoCaptchaSolver({
			...opts,
			timeoutMs: 20,
			fetchImpl,
		});
		const error = (await solver
			.solve(challenge)
			.catch((e: Error) => e)) as Error & { code?: string };
		expect(error.code).toBe("provider_error");
	});

	it("redacts the api key when the provider echoes it back on submit", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValue(json({ status: 0, request: "invalid key SECRETKEY" }));
		const solver = createTwoCaptchaSolver({ ...opts, fetchImpl });
		const error = (await solver
			.solve(challenge)
			.catch((e: Error) => e)) as Error;
		expect(error.message).toContain("<solver-key>");
		expect(error.message).not.toContain("SECRETKEY");
	});

	it("redacts the api key when the provider echoes it back on poll", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(json({ status: 1, request: "42" }))
			.mockResolvedValueOnce(
				json({ status: 0, request: "invalid key SECRETKEY" }),
			);
		const solver = createTwoCaptchaSolver({ ...opts, fetchImpl });
		const error = (await solver
			.solve(challenge)
			.catch((e: Error) => e)) as Error;
		expect(error.message).toContain("<solver-key>");
		expect(error.message).not.toContain("SECRETKEY");
	});

	it("fails immediately on a poll error other than CAPCHA_NOT_READY", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(json({ status: 1, request: "42" }))
			.mockResolvedValueOnce(
				json({ status: 0, request: "ERROR_CAPTCHA_UNSOLVABLE" }),
			);
		const solver = createTwoCaptchaSolver({ ...opts, fetchImpl });
		const error = (await solver
			.solve(challenge)
			.catch((e: Error) => e)) as Error & { code?: string };
		expect(error.message).toContain("ERROR_CAPTCHA_UNSOLVABLE");
		expect(error.code).toBe("provider_error");
	});

	it("cancels a non-2xx response body instead of leaking it", async () => {
		const response = new Response("rate limited", { status: 429 });
		const cancel = vi.spyOn(response.body as ReadableStream, "cancel");
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);
		const solver = createTwoCaptchaSolver({
			...opts,
			timeoutMs: 20,
			fetchImpl,
		});
		await solver.solve(challenge).catch(() => undefined);
		expect(cancel).toHaveBeenCalled();
	});

	it("never passes a raw error's own code through as the solve reason", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockRejectedValue(
				Object.assign(new Error("socket reset"), { code: "ECONNRESET" }),
			);
		const solver = createTwoCaptchaSolver({
			...opts,
			timeoutMs: 20,
			fetchImpl,
		});
		const error = (await solver
			.solve(challenge)
			.catch((e: Error) => e)) as Error & { code?: string };
		expect(error.code).not.toBe("ECONNRESET");
		expect(error.code).toBe("provider_error");
	});
});

describe("tagSolveReason", () => {
	it("returns the error typed with its reason, so callers read .code without a cast", () => {
		const tagged = tagSolveReason(new Error("x"), "timeout");
		const code: SolveReason = tagged.code;
		expect(code).toBe("timeout");
	});
});

describe("createTwoCaptchaSolver empty replies", () => {
	it("rejects a submit reply with an empty task id instead of polling it", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValue(json({ status: 1, request: "" }));
		const solver = createTwoCaptchaSolver({
			apiKey: "k",
			baseUrl: "https://2captcha.test",
			pollIntervalMs: 0,
			fetchImpl,
		});
		await expect(solver.solve(challenge)).rejects.toMatchObject({
			code: "provider_error",
		});
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("never resolves with an empty token", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockImplementation(async (url) =>
				String(url).includes("/in.php")
					? json({ status: 1, request: "42" })
					: json({ status: 1, request: "" }),
			);
		const solver = createTwoCaptchaSolver({
			apiKey: "k",
			baseUrl: "https://2captcha.test",
			timeoutMs: 30,
			pollIntervalMs: 5,
			fetchImpl,
		});
		await expect(solver.solve(challenge)).rejects.toMatchObject({
			code: "timeout",
		});
	});
});

describe("createTwoCaptchaSolver transport failures", () => {
	const unreachable = () =>
		new TypeError("fetch failed", {
			cause: Object.assign(new Error("getaddrinfo"), { code: "ENOTFOUND" }),
		});

	it("names the transport failure on submit instead of HTTP 0", async () => {
		const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(unreachable());
		const solver = createTwoCaptchaSolver({
			apiKey: "k",
			baseUrl: "https://2captcha.test",
			pollIntervalMs: 0,
			fetchImpl,
		});
		const error = (await solver.solve(challenge).catch((e) => e)) as Error;
		expect(error.message).toContain("TypeError: fetch failed (ENOTFOUND)");
		expect(error.message).not.toContain("HTTP 0");
	});

	it("names the last poll failure when the solve times out", async () => {
		const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url) => {
			if (String(url).includes("/in.php"))
				return json({ status: 1, request: "42" });
			throw unreachable();
		});
		const solver = createTwoCaptchaSolver({
			apiKey: "k",
			baseUrl: "https://2captcha.test",
			timeoutMs: 30,
			pollIntervalMs: 5,
			fetchImpl,
		});
		const error = (await solver.solve(challenge).catch((e) => e)) as Error;
		expect(error).toMatchObject({ code: "timeout" });
		expect(error.message).toContain("ENOTFOUND");
	});
});

describe("createTwoCaptchaSolver base url", () => {
	it.each(["https://provider.test/api", "https://provider.test/api/"])(
		"keeps the path prefix of %s",
		async (baseUrl) => {
			const fetchImpl = vi
				.fn<typeof fetch>()
				.mockResolvedValueOnce(json({ status: 1, request: "42" }))
				.mockResolvedValueOnce(json({ status: 1, request: "TOKEN" }));
			const solver = createTwoCaptchaSolver({
				apiKey: "k",
				baseUrl,
				pollIntervalMs: 0,
				fetchImpl,
			});
			await solver.solve(challenge);
			const paths = fetchImpl.mock.calls.map(
				([url]) => new URL(String(url)).pathname,
			);
			expect(paths).toEqual(["/api/in.php", "/api/res.php"]);
		},
	);
});
