import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

/** Validated gateway configuration. */
export type Config = {
	gatewayToken: string;
	camoufoxWsUrl: string;
	stateDir: string;
	port: number;
	logLevel: "debug" | "info" | "warn" | "error";
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
			PORT: z.coerce.number().int().positive().default(8080),
			LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
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
	};
}
