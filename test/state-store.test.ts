import { mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	createStateStore,
	type StorageState,
	storageStateSchema,
} from "../src/state-store.js";

const stateA: StorageState = {
	cookies: [
		{
			name: "s",
			value: "a",
			domain: ".ebay.com",
			path: "/",
			expires: -1,
			httpOnly: true,
			secure: true,
			sameSite: "Lax",
		},
	],
	origins: [],
};
const stateB: StorageState = {
	cookies: [],
	origins: [
		{
			origin: "https://www.ebay.com",
			localStorage: [{ name: "k", value: "v" }],
		},
	],
};

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "state-store-"));
});

describe("state store", () => {
	it("returns undefined for a profile with no file", async () => {
		expect(await createStateStore(dir).read("ebay")).toBeUndefined();
	});

	it("round-trips a written state and bumps the generation", async () => {
		const store = createStateStore(dir);
		expect(await store.write("ebay", stateA)).toBe(1);
		expect(await store.read("ebay")).toEqual({ state: stateA, generation: 1 });
		expect(await store.write("ebay", stateB)).toBe(2);
	});

	it("writeIfUnchanged refuses a stale generation", async () => {
		const store = createStateStore(dir);
		await store.write("ebay", stateA);
		const seen = await store.read("ebay");
		await store.write("ebay", stateB);
		expect(
			await store.writeIfUnchanged("ebay", stateA, seen?.generation ?? -1),
		).toBe(false);
		expect((await store.read("ebay"))?.state).toEqual(stateB);
	});

	it("writeIfUnchanged writes and bumps when the generation matches", async () => {
		const store = createStateStore(dir);
		await store.write("ebay", stateA);
		expect(await store.writeIfUnchanged("ebay", stateB, 1)).toBe(true);
		expect(await store.read("ebay")).toEqual({ state: stateB, generation: 2 });
	});

	it("starts a file that exists at boot at generation 0", async () => {
		await createStateStore(dir).write("reddit", stateA);
		const rebooted = createStateStore(dir);
		expect((await rebooted.read("reddit"))?.generation).toBe(0);
	});

	it("throws a clear error on a corrupt state file", async () => {
		await writeFile(join(dir, "ebay.json"), "{not json");
		await expect(createStateStore(dir).read("ebay")).rejects.toThrow(
			/ebay\.json/,
		);
	});

	it("throws a clear error on a schema-invalid state file", async () => {
		await writeFile(join(dir, "ebay.json"), JSON.stringify({ origins: [] }));
		await expect(createStateStore(dir).read("ebay")).rejects.toThrow(
			/ebay\.json/,
		);
	});

	it("writes state files with mode 0o600", async () => {
		await createStateStore(dir).write("ebay", stateA);
		expect((await stat(join(dir, "ebay.json"))).mode & 0o777).toBe(0o600);
		expect((await readdir(dir)).filter((f) => f.includes("tmp"))).toEqual([]);
	});

	it("keeps only the newest 20 captures", async () => {
		let tick = 0;
		const store = createStateStore(
			dir,
			() => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
		);
		for (let i = 0; i < 25; i++)
			await store.saveCapture("ebay", "blocked", `<p>${i}</p>`);
		const files = (await readdir(join(dir, "captures"))).sort();
		expect(files).toHaveLength(20);
		expect(files[0]).toBe("ebay-blocked-2026-01-01T00-00-05.000Z.html");
	});

	it("writes captures readable only by the owner, since they can hold session tokens", async () => {
		const store = createStateStore(dir);
		await store.saveCapture("ebay", "blocked", "<p>token</p>");
		const [file] = await readdir(join(dir, "captures"));
		const { mode } = await stat(join(dir, "captures", file ?? ""));
		expect(mode & 0o777).toBe(0o600);
	});
});

describe("storageStateSchema", () => {
	it("rejects a body without cookies", () => {
		expect(storageStateSchema.safeParse({ origins: [] }).success).toBe(false);
	});
});
