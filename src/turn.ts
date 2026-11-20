import { coderabbitState } from './bots/coderabbit.ts';
import type { CodeRabbitState } from './bots/coderabbit.ts';
import { codexState } from './bots/codex.ts';
import type { CodexState } from './bots/codex.ts';
import { ciState } from './ci.ts';
import type { CiState } from './ci.ts';
import type { Config } from './config.ts';
import type { QueueEntry } from './queue.ts';
import type { PullRequest } from './types.ts';
import { latestBy } from './util.ts';

export type Group = 'author' | 'review' | 'waiting_ai' | 'ready' | 'others';

export const GROUP_ORDER: Group[] = ['author', 'review', 'waiting_ai', 'ready', 'others'];

export interface Assessment {
	pr: PullRequest;
	group: Group;
	reason: string;
	mine: boolean;
	ci: CiState;
	coderabbit: CodeRabbitState;
	codex: CodexState;
	queued: QueueEntry[];
	threadsAwaitingAuthor: number;
	/** The AI button would do something on this PR. */
	aiActionable: boolean;
}

export function assess(pr: PullRequest, config: Config, me: string, now: Date, queue: QueueEntry[] = []): Assessment {
	const mine = pr.author === me;
	const queued = queue.filter((e) => e.repo === pr.repo && e.number === pr.number && e.headOid === pr.headOid);
	const ci = ciState(pr, [...config.ignoreChecks, config.coderabbit.checkName]);
	const coderabbit = coderabbitState(pr, config.coderabbit, now);
	const codex = codexState(pr, config.codex, now);
	const labels = new Set(pr.labels.map((l) => l.toLowerCase()));
	const threadsAwaitingAuthor = pr.threads.filter((t) => !t.isResolved && t.lastAuthor !== null && t.lastAuthor !== pr.author).length;

	const blockers: string[] = [];
	if (pr.isDraft) blockers.push('draft');
	if (pr.mergeable === 'CONFLICTING') blockers.push('merge conflicts');
	if (ci === 'failure') blockers.push('CI failing');

	const rateLimitOver = coderabbit.kind === 'rate_limited' && Date.parse(coderabbit.retryAt) <= now.getTime();
	const aiBusy =
		coderabbit.kind === 'reviewing' ||
		coderabbit.kind === 'requested' ||
		(coderabbit.kind === 'rate_limited' && !rateLimitOver) ||
		codex.kind === 'running' ||
		queued.length > 0;
	const aiActionable =
		blockers.length === 0 &&
		!aiBusy &&
		(coderabbit.kind === 'needs_unstick' || rateLimitOver || ['never', 'outdated', 'timed_out'].includes(codex.kind));

	const base = { pr, mine, ci, coderabbit, codex, queued, threadsAwaitingAuthor, aiActionable };
	const result = (group: Group, reason: string): Assessment => ({ ...base, group, reason });

	if (blockers.length === 0 && labels.has(config.labels.approved.toLowerCase()) && ci !== 'pending') {
		return result('ready', 'approved');
	}

	if (mine) {
		if (blockers.length > 0) return result('author', blockers.join(', '));
		if (threadsAwaitingAuthor > 0) {
			return result('author', `${threadsAwaitingAuthor} open thread${threadsAwaitingAuthor > 1 ? 's' : ''} waiting for you`);
		}
		if (labels.has(config.labels.needsAuthor.toLowerCase())) return result('author', 'changes requested');
		if (aiBusy) return result('waiting_ai', aiWaitReason(coderabbit, codex, queued));
		if (aiActionable) return result('author', 'request the AI review');
		const reviewers = pr.requestedReviewers.filter((r) => r !== me);
		return result('others', reviewers.length ? `waiting for ${reviewers.join(', ')}` : 'waiting for review');
	}

	if (blockers.length > 0) return result('others', `${pr.author}: ${blockers.join(', ')}`);
	if (labels.has(config.labels.needsAuthor.toLowerCase()) || threadsAwaitingAuthor > 0) {
		return result('others', `waiting for ${pr.author}`);
	}
	if (aiBusy) return result('waiting_ai', aiWaitReason(coderabbit, codex, queued));

	const myLastReview = latestBy(
		pr.reviews.filter((r) => r.author === me),
		(r) => r.submittedAt,
	);
	const reviewedHead = myLastReview?.commitOid === pr.headOid;
	const requested = pr.requestedReviewers.includes(me);
	const teamPr = config.team.includes(pr.author) && config.team.includes(me);
	if (requested || (teamPr && labels.has(config.labels.needsReview.toLowerCase()) && !reviewedHead && myLastReview)) {
		return result('review', myLastReview && !reviewedHead ? 'new commits since your review' : 'review requested');
	}
	return result('others', `${pr.author}'s PR`);
}

function aiWaitReason(coderabbit: CodeRabbitState, codex: CodexState, queued: QueueEntry[]): string {
	if (coderabbit.kind === 'rate_limited') return 'CodeRabbit rate limited, retry scheduled';
	if (coderabbit.kind === 'reviewing' || coderabbit.kind === 'requested') {
		return queued.some((e) => e.bot === 'codex') ? 'CodeRabbit reviewing, Codex queued' : 'CodeRabbit reviewing';
	}
	if (codex.kind === 'running') return 'Codex reviewing';
	return 'queued';
}

export function assessAll(prs: PullRequest[], config: Config, me: string, now: Date, queue: QueueEntry[]): Assessment[] {
	const order = new Map(GROUP_ORDER.map((g, i) => [g, i]));
	return prs
		.map((pr) => assess(pr, config, me, now, queue))
		.sort((a, b) => (order.get(a.group) ?? 0) - (order.get(b.group) ?? 0) || b.pr.number - a.pr.number);
}
