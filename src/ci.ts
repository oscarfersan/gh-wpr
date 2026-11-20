import type { CheckRun, PullRequest } from './types.ts';

export type CiState = 'success' | 'failure' | 'pending' | 'none';

const FAILED = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);

/**
 * CI state from the latest run of each check. Re-runs of a workflow leave older
 * runs with the same name behind, so only the newest one per name counts.
 */
export function ciState(pr: PullRequest, ignore: string[]): CiState {
	const ignored = new Set(ignore.map((n) => n.toLowerCase()));
	const latest = new Map<string, CheckRun>();
	for (const run of pr.checkRuns) {
		const name = run.name.toLowerCase();
		if (ignored.has(name)) continue;
		const current = latest.get(name);
		const at = Date.parse(run.startedAt ?? run.completedAt ?? '') || 0;
		const currentAt = current ? Date.parse(current.startedAt ?? current.completedAt ?? '') || 0 : -1;
		if (!current || at >= currentAt) latest.set(name, run);
	}
	if (latest.size === 0) return 'none';
	const runs = [...latest.values()];
	if (runs.some((r) => r.conclusion !== null && FAILED.has(r.conclusion))) return 'failure';
	if (runs.some((r) => r.status !== 'COMPLETED')) return 'pending';
	return 'success';
}
