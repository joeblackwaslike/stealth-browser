import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/integration/**/*.test.ts"],
		pool: "forks",
		testTimeout: 60000,
		hookTimeout: 60000,
	},
});
