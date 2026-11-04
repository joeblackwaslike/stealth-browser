import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const token = "t".repeat(32);

describe("loadConfig", () => {
	it("rejects a gateway token shorter than 32 characters", () => {
		expect(() =>
			loadConfig({ GATEWAY_TOKEN: "short", CAMOUFOX_WS_URL: "ws://x:3000/p" }),
		).toThrow();
	});

	it("rejects a non-websocket camoufox url", () => {
		expect(() =>
			loadConfig({ GATEWAY_TOKEN: token, CAMOUFOX_WS_URL: "http://x" }),
		).toThrow();
	});

	it("rejects a port above 65535", () => {
		expect(() =>
			loadConfig({
				GATEWAY_TOKEN: token,
				CAMOUFOX_WS_URL: "ws://x:3000/p",
				PORT: "70000",
			}),
		).toThrow();
	});

	it("applies defaults", () => {
		expect(
			loadConfig({
				GATEWAY_TOKEN: token,
				CAMOUFOX_WS_URL: "ws://camoufox:3000/abc",
			}),
		).toMatchObject({ stateDir: "/state", port: 8080, logLevel: "info" });
	});
	describe("solver settings", () => {
		const required = { GATEWAY_TOKEN: token, CAMOUFOX_WS_URL: "ws://x:3000/p" };

		it("leaves the api key optional and applies defaults", () => {
			expect(loadConfig(required)).toMatchObject({
				solverApiKey: undefined,
				solverBaseUrl: "https://2captcha.com",
			});
		});

		it("defaults the solver budget to 100 per hour", () => {
			expect(loadConfig(required).solverMaxPerHour).toBe(100);
		});

		it("reads overrides", () => {
			expect(
				loadConfig({
					...required,
					SOLVER_API_KEY: "k",
					SOLVER_BASE_URL: "https://s.test",
					SOLVER_MAX_PER_HOUR: "5",
				}),
			).toMatchObject({
				solverApiKey: "k",
				solverBaseUrl: "https://s.test",
				solverMaxPerHour: 5,
			});
		});

		it("has no solverProfiles in the loaded config", () => {
			expect(loadConfig(required)).not.toHaveProperty("solverProfiles");
		});

		it("ignores SOLVER_PROFILES", () => {
			expect(() =>
				loadConfig({ ...required, SOLVER_PROFILES: "google,nope" }),
			).not.toThrow();
		});

		it("rejects a non-positive hourly budget", () => {
			expect(() =>
				loadConfig({ ...required, SOLVER_MAX_PER_HOUR: "0" }),
			).toThrow();
		});
	});
});

describe("loadConfig SOLVER_BASE_URL", () => {
	const base = { GATEWAY_TOKEN: token, CAMOUFOX_WS_URL: "ws://x:3000/p" };

	it("rejects a plain-http solver url, which would send the key in cleartext", () => {
		expect(() =>
			loadConfig({ ...base, SOLVER_BASE_URL: "http://2captcha.com" }),
		).toThrow();
	});

	it("accepts an https solver url with a path prefix", () => {
		expect(
			loadConfig({ ...base, SOLVER_BASE_URL: "https://provider.test/api" })
				.solverBaseUrl,
		).toBe("https://provider.test/api");
	});
});
