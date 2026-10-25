import { describe, expect, it } from "vitest";
import { isPublicHttpUrl } from "../src/url-guard.js";

describe("isPublicHttpUrl", () => {
	it.each([
		"http://localhost:3000",
		"http://127.0.0.1",
		"http://10.1.2.3",
		"http://192.168.1.1",
		"http://172.16.0.1",
		"http://169.254.169.254",
		"http://[::1]/",
		"http://[::ffff:127.0.0.1]/",
		"http://[fd00::1]/",
		"http://browserless.ai-listings.svc.cluster.local:3000",
		"http://camoufox.svc/",
		"http://camoufox/",
		"http://kubernetes/",
		"http://svc/",
		"http://local/",
		"http://cluster.local/",
		"http://printer.local/",
		"file:///etc/passwd",
		"ftp://example.com",
	])("rejects %s", (url) => {
		expect(isPublicHttpUrl(new URL(url))).toBe(false);
	});

	it.each(["https://www.ebay.com/", "http://example.com/", "http://8.8.8.8/"])(
		"accepts %s",
		(url) => {
			expect(isPublicHttpUrl(new URL(url))).toBe(true);
		},
	);
});
