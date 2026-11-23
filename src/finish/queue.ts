import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ciState } from '../ci.ts';
import type { Config } from '../config.ts';
import { stateDir } from '../paths.ts';
import type { PullRequest } from '../types.ts';
import { prKey } from '../types.ts';
import { minutesSince, short } from '../util.ts';

/*
 * PRs that were rebased and pushed and now wait for CI before the merge. Like the
 * bot queue, it lives on this machine and advances with every `gh wpr tick`.
 */

export interface FinishEntry {
	repo: string;
	number: number;
	url: string;
	baseRef: string;
	headRef: string;
	/** The commit to merge: the one pushed after the rebase. Any other push cancels. */
	headOid: string;
	isCrossRepository: boolean;
	/** The branch was force-pushed, so its CI starts from scratch. */
	pushed: boolean;
	createdAt: string;
}

/** After a push, how long a PR with no checks at all waits for CI to show up. */
const CI_START_GRACE_MINUTES = 3;

const MAX_AGE_MINUTES = 24 * 60;

const finishFile = (): string => join(stateDir(), 'finish.json');

export function readFinishQueue(): FinishEntry[] {
	try {
		const parsed = JSON.parse(readFileSync(finishFile(), 'utf8')) as unknown;
		return Array.isArray(parsed) ? (parsed as FinishEntry[]) : [];
	} catch {
		return [];
	}
}

export function writeFinishQueue(entries: FinishEntry[]): void {
	mkdirSync(stateDir(), { recursive: true });
	const tmp = `${finishFile()}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`);
	renameSync(tmp, finishFile());
}

export function upsertFinish(entries: FinishEntry[], entry: FinishEntry): FinishEntry[] {
	return [...entries.filter((e) => prKey(e) !== prKey(entry)), entry];
}

export type FinishDecision =
	| { decision: 'merge'; why: string }
	| { decision: 'keep'; why: string }
	| { decision: 'drop'; why: string };

/** What to do with a queued PR, from fresh data. `pr` is undefined once it is no longer open. */
export function decideFinish(entry: FinishEntry, pr: PullRequest | undefined, config: Config, now: Date): FinishDecision {
	if (!pr) return { decision: 'drop', why: 'the PR is no longer open' };
	if (pr.headOid !== entry.headOid) return { decision: 'drop', why: `someone pushed ${short(pr.headOid)} after the rebase` };
	if (minutesSince(entry.createdAt, now) > MAX_AGE_MINUTES) return { decision: 'drop', why: 'still not mergeable after 24 h' };
	if (pr.isDraft) return { decision: 'drop', why: 'it is a draft again' };
	if (pr.mergeable === 'CONFLICTING') return { decision: 'drop', why: 'it is in conflict with its base' };
	if (config.finish.waitForCi) {
		const ci = ciState(pr, config.ignoreChecks);
		if (ci === 'failure') return { decision: 'drop', why: 'CI failed on the rebased commit' };
		if (ci === 'pending') return { decision: 'keep', why: 'waiting for CI' };
		if (ci === 'none' && entry.pushed && minutesSince(entry.createdAt, now) < CI_START_GRACE_MINUTES) {
			return { decision: 'keep', why: 'waiting for CI to start' };
		}
	}
	if (pr.mergeable === 'UNKNOWN') return { decision: 'keep', why: 'GitHub is still checking whether it merges cleanly' };
	return { decision: 'merge', why: config.finish.waitForCi ? 'CI passed' : 'ready' };
}
