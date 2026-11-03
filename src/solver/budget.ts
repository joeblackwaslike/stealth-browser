import { SolveBudgetExceededError, type Solver } from "./types.js";

const HOUR_MS = 60 * 60 * 1000;

/** Wraps a solver so at most `maxPerHour` solves start in any rolling hour. */
export function withBudget(
	solver: Solver,
	maxPerHour: number,
	now: () => number = Date.now,
): Solver {
	let calls: number[] = [];
	return {
		solve(challenge) {
			const current = now();
			calls = calls.filter((at) => current - at < HOUR_MS);
			if (calls.length >= maxPerHour)
				return Promise.reject(new SolveBudgetExceededError(maxPerHour));
			calls.push(current);
			return solver.solve(challenge);
		},
	};
}
