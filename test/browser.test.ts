import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { createCamoufoxFetcher } from "../src/browser.js";

describe("createCamoufoxFetcher", () => {
	it("never leaks the ws path in connect errors", async () => {
		const secret = "s3cr3t-ws-path-0123456789abcdef";
		const fetcher = createCamoufoxFetcher(`ws://127.0.0.1:1/${secret}`);
		const error = await fetcher
			.fetch({ url: "https://example.com/", waitForTimeout: 0 })
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).not.toContain(secret);
		await fetcher.close();
	});

	it("rejects within the deadline when the server never completes the handshake", async () => {
		const secret = "hang-ws-path-0123456789abcdef";
		const server = createServer(() => {});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const { port } = server.address() as AddressInfo;
		const fetcher = createCamoufoxFetcher(`ws://127.0.0.1:${port}/${secret}`, {
			connectTimeoutMs: 300,
			requestDeadlineMs: 600,
		});
		const started = Date.now();
		const error = await fetcher
			.fetch({ url: "https://example.com/", waitForTimeout: 0 })
			.catch((e: unknown) => e);
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).not.toContain(secret);
		await fetcher.close();
		server.close();
	}, 10_000);
});
