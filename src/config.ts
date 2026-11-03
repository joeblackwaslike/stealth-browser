import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";
import { isProfileName, type ProfileName } from "./profiles.js";

/** Validated gateway configuration. */
export type Config = {
	gatewayToken: string;
	camoufoxWsUrl: string;
	stateDir: string;
	port: number;
	logLevel: "debug" | "info" | "warn" | "error";
	solverApiKey?: string;
	solverBaseUrl: string;
	solverMaxPerHour: number;
	/** Profiles whose fetches may spend solver budget. */
	solverProfiles: readonly ProfileName[];
};

/**
 * Parse and validate gateway configuration from environment variables.
 * Throws if a required variable is missing or invalid.
 */
export function loadConfig(env: Record<string, string | undefined>): Config {
	const parsed = createEnv({
		server: {
			GATEWAY_TOKEN: z.string().min(32),
			CAMOUFOX_WS_URL: z
				.string()
				.regex(/^wss?:\/\//, "must start with ws:// or wss://"),
			STATE_DIR: z.string().default("/state"),
			PORT: z.coerce.number().int().positive().max(65535).default(8080),
			LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
			SOLVER_API_KEY: z.string().min(1).optional(),
			SOLVER_BASE_URL: z.string().url().default("https://2captcha.com"),
			SOLVER_MAX_PER_HOUR: z.coerce.number().int().positive().default(20),
			SOLVER_PROFILES: z
				.string()
				.default("google")
				.transform((value) => value.split(",").map((name) => name.trim()))
				.pipe(
					z.array(
						z.string().refine(isProfileName, {
							error: (issue) => `unknown profile "${String(issue.input)}"`,
						}),
					),
				),
		},
		runtimeEnv: env,
		emptyStringAsUndefined: true,
	});
	return {
		gatewayToken: parsed.GATEWAY_TOKEN,
		camoufoxWsUrl: parsed.CAMOUFOX_WS_URL,
		stateDir: parsed.STATE_DIR,
		port: parsed.PORT,
		logLevel: parsed.LOG_LEVEL,
		solverApiKey: parsed.SOLVER_API_KEY,
		solverBaseUrl: parsed.SOLVER_BASE_URL,
		solverMaxPerHour: parsed.SOLVER_MAX_PER_HOUR,
		solverProfiles: parsed.SOLVER_PROFILES as ProfileName[],
	};
}
