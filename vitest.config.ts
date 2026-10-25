import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		exclude: ["test/integration/**", "node_modules/**"],
		pool: "forks",
		testTimeout: 30000,
	},
});
