import { serve } from "@hono/node-server";
import { pino } from "pino";
import { createApp } from "./app.js";
import { createCamoufoxFetcher } from "./browser.js";
import { loadConfig } from "./config.js";
import { PROFILES } from "./profiles.js";
import { createStateStore } from "./state-store.js";
import { Scheduler } from "./throttle.js";

const config = loadConfig(process.env);
const logger = pino({ level: config.logLevel });

const scheduler = new Scheduler(PROFILES, {
	now: Date.now,
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	random: Math.random,
});
const camoufox = createCamoufoxFetcher(config.camoufoxWsUrl);
const app = createApp({
	token: config.gatewayToken,
	fetcher: camoufox.fetch,
	scheduler,
	store: createStateStore(config.stateDir),
	logger,
});

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
	logger.info({ port: info.port }, "gateway listening");
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	logger.info({ signal }, "shutting down");
	server.close();
	await camoufox.close();
	process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
