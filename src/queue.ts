import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { coderabbitDone, coderabbitState } from './bots/coderabbit.ts';
import { codexState } from './bots/codex.ts';
import type { Config } from './config.ts';
import { stateDir } from './paths.ts';
import { blockedReason } from './plan.ts';
import type { Bot, PullRequest } from './types.ts';
import { prKey } from './types.ts';
import { isAfter, minutesSince, short } from './util.ts';

/*
 * Local queue of comments to post later: a CodeRabbit retry after a rate limit,
 * or Codex waiting for CodeRabbit to finish. It lives on this machine only and
 * advances whenever `gh wpr tick` runs (SwiftBar runs it on every refresh).
 */

export interface QueueEntry {
	repo: string;
	number: number;
	bot: Bot;
	body: string;
	/** The commit the request is for. A new push invalidates it. */
	headOid: string;
	/** Do not post before this time. */
	notBefore: string | null;
	createdAt: string;
	/** Asked for again on purpose: post even if Codex already reviewed this commit. */
	force?: boolean;
}

const MAX_AGE_MINUTES = 24 * 60;

const queueFile = (): string => join(stateDir(), 'queue.json');

export function readQueue(): QueueEntry[] {
	try {
		const parsed = JSON.parse(readFileSync(queueFile(), 'utf8')) as unknown;
		return Array.isArray(parsed) ? (parsed as QueueEntry[]) : [];
	} catch {
		return [];
	}
}

export function writeQueue(entries: QueueEntry[]): void {
	mkdirSync(stateDir(), { recursive: true });
	const tmp = `${queueFile()}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`);
	renameSync(tmp, queueFile());
}

/** Adds an entry, replacing any previous one for the same PR and bot. */
export function upsert(entries: QueueEntry[], entry: QueueEntry): QueueEntry[] {
	return [...entries.filter((e) => !(e.repo === entry.repo && e.number === entry.number && e.bot === entry.bot)), entry];
}

export type QueueDecision =
	| { entry: QueueEntry; decision: 'post'; why: string }
	| { entry: QueueEntry; decision: 'keep'; why: string; notBefore?: string }
	| { entry: QueueEntry; decision: 'drop'; why: string };

export function decideEntry(entry: QueueEntry, pr: PullRequest | undefined, config: Config, now: Date): QueueDecision {
	if (!pr) return { entry, decision: 'drop', why: 'PR is closed or no longer tracked' };
	if (pr.headOid !== entry.headOid) return { entry, decision: 'drop', why: `new push (${short(pr.headOid)})` };
	if (minutesSince(entry.createdAt, now) > MAX_AGE_MINUTES) return { entry, decision: 'drop', why: 'expired after 24 h' };
	const blocked = blockedReason(pr);
	if (blocked) return { entry, decision: 'keep', why: blocked };

	const cr = coderabbitState(pr, config.coderabbit, now);

	if (entry.bot === 'coderabbit') {
		if (entry.notBefore && Date.parse(entry.notBefore) > now.getTime()) {
			return { entry, decision: 'keep', why: 'waiting for the rate limit to reset' };
		}
		if (cr.kind === 'rate_limited' && Date.parse(cr.retryAt) > now.getTime()) {
			return { entry, decision: 'keep', why: 'still rate limited', notBefore: cr.retryAt };
		}
		if (cr.kind === 'rate_limited' || cr.kind === 'needs_unstick') return { entry, decision: 'post', why: 'retry is due' };
		return { entry, decision: 'drop', why: `CodeRabbit is ${cr.kind.replace('_', ' ')}` };
	}

	const codex = codexState(pr, config.codex, now);
	if (entry.force) {
		// Only a request made after this one (by anyone) makes it redundant.
		if (codex.kind === 'running' && isAfter(codex.since, entry.createdAt)) {
			return { entry, decision: 'drop', why: 'Codex was asked again already' };
		}
	} else if (codex.kind === 'reviewed' || codex.kind === 'running' || codex.kind === 'disabled') {
		return { entry, decision: 'drop', why: `Codex is ${codex.kind}` };
	}
	if (codex.kind === 'disabled') return { entry, decision: 'drop', why: 'Codex is disabled' };
	if (coderabbitDone(cr)) return { entry, decision: 'post', why: 'CodeRabbit finished' };
	return { entry, decision: 'keep', why: 'waiting for CodeRabbit' };
}

export function decideQueue(entries: QueueEntry[], prs: PullRequest[], config: Config, now: Date): QueueDecision[] {
	const byKey = new Map(prs.map((pr) => [prKey(pr), pr]));
	return entries.map((entry) => decideEntry(entry, byKey.get(prKey(entry)), config, now));
}
