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
});
