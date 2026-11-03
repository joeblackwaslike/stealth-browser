import type { Config } from "../config.js";
import { withBudget } from "./budget.js";
import { createTwoCaptchaSolver } from "./two-captcha.js";
import type { Solver } from "./types.js";

export { withBudget } from "./budget.js";
export {
	createTwoCaptchaSolver,
	SOLVER_TIMEOUT_MS,
} from "./two-captcha.js";
export { SolveBudgetExceededError, type Solver } from "./types.js";

/** Builds the budgeted solver from config, or undefined when no api key is set. */
export function createSolver(
	config: Config,
	now?: () => number,
): Solver | undefined {
	if (!config.solverApiKey) return undefined;
	return withBudget(
		createTwoCaptchaSolver({
			apiKey: config.solverApiKey,
			baseUrl: config.solverBaseUrl,
		}),
		config.solverMaxPerHour,
		now,
	);
}
