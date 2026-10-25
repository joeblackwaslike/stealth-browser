import { randomUUID } from "node:crypto";
import {
	chmod,
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext } from "playwright-core";
import { z } from "zod";
import type { LoginProfileName, ProfileName } from "./profiles.js";

/** Playwright `storageState` payload: cookies plus per-origin localStorage. */
export type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

export const storageStateSchema = z.object({
	cookies: z.array(
		z.object({
			name: z.string(),
			value: z.string(),
			domain: z.string(),
			path: z.string(),
			expires: z.number(),
			httpOnly: z.boolean(),
			secure: z.boolean(),
			sameSite: z.enum(["Strict", "Lax", "None"]),
		}),
	),
	origins: z.array(
		z.object({
			origin: z.string(),
			localStorage: z.array(z.object({ name: z.string(), value: z.string() })),
		}),
	),
}) satisfies z.ZodType<StorageState>;

/** A saved login and the in-memory generation it was read at. */
export type StoredState = { state: StorageState; generation: number };

export type StateStore = {
	read(profile: LoginProfileName): Promise<StoredState | undefined>;
	/** Always writes; returns the new generation. */
	write(profile: LoginProfileName, state: StorageState): Promise<number>;
	/** Writes only if the profile is still at `expectedGeneration`; false means a newer login won. */
	writeIfUnchanged(
		profile: LoginProfileName,
		state: StorageState,
		expectedGeneration: number,
	): Promise<boolean>;
	saveCapture(
		profile: ProfileName,
		kind: "blocked" | "session_expired",
		html: string,
	): Promise<void>;
};

const MAX_CAPTURES = 20;
const TIMESTAMP_START = /\d{4}-.*$/;

/** File-backed store under `dir`. `now` is injectable for capture filenames. */
export function createStateStore(
	dir: string,
	now: () => Date = () => new Date(),
): StateStore {
	// ponytail: in-memory generation, fine for replicas: 1
	const generations = new Map<LoginProfileName, number>();
	const capturesDir = join(dir, "captures");
	let chain: Promise<unknown> = Promise.resolve();

	const serial = <T>(fn: () => Promise<T>): Promise<T> => {
		const result = chain.then(fn);
		chain = result.catch(() => undefined);
		return result;
	};

	const fileFor = (profile: LoginProfileName) => join(dir, `${profile}.json`);

	async function atomicWrite(
		profile: LoginProfileName,
		state: StorageState,
	): Promise<void> {
		await mkdir(dir, { recursive: true });
		const tmp = join(dir, `.${profile}.${randomUUID()}.tmp`);
		try {
			await writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
			await chmod(tmp, 0o600);
			await rename(tmp, fileFor(profile));
		} catch (error) {
			await rm(tmp, { force: true });
			throw error;
		}
	}

	async function read(
		profile: LoginProfileName,
	): Promise<StoredState | undefined> {
		const file = fileFor(profile);
		let raw: string;
		try {
			raw = await readFile(file, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
		let parsed: StorageState;
		try {
			parsed = storageStateSchema.parse(JSON.parse(raw));
		} catch (error) {
			throw new Error(
				`invalid state file ${profile}.json: ${(error as Error).message}`,
			);
		}
		if (!generations.has(profile)) generations.set(profile, 0);
		return { state: parsed, generation: generations.get(profile) ?? 0 };
	}

	async function commit(
		profile: LoginProfileName,
		state: StorageState,
	): Promise<number> {
		await atomicWrite(profile, state);
		const next = (generations.get(profile) ?? 0) + 1;
		generations.set(profile, next);
		return next;
	}

	return {
		read: (profile) => serial(() => read(profile)),
		write: (profile, state) => serial(() => commit(profile, state)),
		writeIfUnchanged: (profile, state, expectedGeneration) =>
			serial(async () => {
				if ((generations.get(profile) ?? 0) !== expectedGeneration)
					return false;
				await commit(profile, state);
				return true;
			}),
		async saveCapture(profile, kind, html) {
			await mkdir(capturesDir, { recursive: true });
			const stamp = now().toISOString().replaceAll(":", "-");
			// Captures can hold session tokens, same as the saved state.
			await writeFile(
				join(capturesDir, `${profile}-${kind}-${stamp}.html`),
				html,
				{ mode: 0o600 },
			);
			const files = (await readdir(capturesDir)).sort((a, b) =>
				(a.match(TIMESTAMP_START)?.[0] ?? a).localeCompare(
					b.match(TIMESTAMP_START)?.[0] ?? b,
				),
			);
			await Promise.all(
				files
					.slice(0, -MAX_CAPTURES)
					.map((f) => rm(join(capturesDir, f), { force: true })),
			);
		},
	};
}
