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

/**
 * Fixed, safe-to-log vocabulary for why a solve didn't produce a usable
 * token. Never derived from an error's message, which may carry secrets.
 */
export type SolveReason =
	| "budget_exceeded"
	| "timeout"
	| "provider_error"
	| "no_form"
	| "navigation_failed"
	| "challenge_remained"
	| "unknown";

/** An adapter error tagged with the reason it maps to, set on `.code`. */
export type SolveReasonError = Error & { code: SolveReason };

export function tagSolveReason(error: Error, code: SolveReason): Error {
	return Object.assign(error, { code });
}
