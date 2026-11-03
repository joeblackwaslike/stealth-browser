import type { Challenge } from "../detect.js";

/** Turns a detected CAPTCHA challenge into a response token. */
export interface Solver {
	solve(challenge: Challenge): Promise<string>;
}

/** Thrown when the hourly solve budget is spent. */
export class SolveBudgetExceededError extends Error {
	constructor(maxPerHour: number) {
		super(`solver budget of ${maxPerHour} solves per hour exceeded`);
		this.name = "SolveBudgetExceededError";
	}
}
