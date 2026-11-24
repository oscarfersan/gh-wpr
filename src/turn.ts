import type { Approval } from './bots/approval.ts';
import { isApproved } from './bots/approval.ts';
import { coderabbitApproval, coderabbitState } from './bots/coderabbit.ts';
import type { CodeRabbitState } from './bots/coderabbit.ts';
import { codexApproval, codexState } from './bots/codex.ts';
import { notionApproval } from './bots/notion.ts';
import type { CodexState } from './bots/codex.ts';
import { ciState } from './ci.ts';
import type { CiState } from './ci.ts';
import type { Config } from './config.ts';
import type { QueueEntry } from './queue.ts';
import type { PullRequest, ReviewThread } from './types.ts';
import { formatClock, latestBy } from './util.ts';

export type Group = 'author' | 'review' | 'waiting_ai' | 'ready' | 'draft' | 'others';

export const GROUP_ORDER: Group[] = ['author', 'review', 'waiting_ai', 'ready', 'draft', 'others'];

/** Where each reviewer stands on the head commit. Done means CodeRabbit, Codex and a person approved it. */
export interface Approvals {
	coderabbit: Approval;
	codex: Approval;
	human: Approval & { by?: string[] };
	/** Only used while the PR is a draft. */
	notion: Approval;
}

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
	/** Unresolved threads whose last word is not the author's, oldest first. */
	pendingThreads: ReviewThread[];
	/** The AI button would do something on this PR. */
	aiActionable: boolean;
	/** A bot is reviewing, rate limited with a retry pending, or a request is queued. */
	aiBusy: boolean;
	approvals: Approvals;
	/** CodeRabbit, Codex and a person approved the head commit. */
	done: boolean;
}

/**
 * A person approved: the last APPROVED / CHANGES_REQUESTED review of each
 * reviewer, or the team's `approved` label. One request for changes wins.
 */
export function humanApproval(pr: PullRequest, config: Config): Approvals['human'] {
	const bots = new Set([config.coderabbit.login, config.codex.login]);
	const latest = new Map<string, { state: string; at: string }>();
	for (const r of pr.reviews) {
		if (r.isBot || bots.has(r.author) || r.author === pr.author) continue;
		if (r.state !== 'APPROVED' && r.state !== 'CHANGES_REQUESTED') continue;
		const prev = latest.get(r.author);
		if (!prev || Date.parse(r.submittedAt) > Date.parse(prev.at)) latest.set(r.author, { state: r.state, at: r.submittedAt });
	}
	const entries = [...latest.entries()];
	const changes = entries.filter(([, v]) => v.state === 'CHANGES_REQUESTED');
	if (changes.length > 0) return { kind: 'changes', at: changes[0][1].at, by: changes.map(([who]) => who) };
	const approved = entries.filter(([, v]) => v.state === 'APPROVED');
	if (approved.length > 0) return { kind: 'approved', at: approved[0][1].at, by: approved.map(([who]) => who) };
	if (pr.labels.some((l) => l.toLowerCase() === config.labels.approved.toLowerCase())) {
		return { kind: 'approved', at: pr.updatedAt, by: [] };
	}
	return { kind: 'none' };
}

/** "CodeRabbit, Codex" — who still has to approve the head commit. */
export function missingApprovals(approvals: Approvals): string[] {
	const out: string[] = [];
	if (!isApproved(approvals.coderabbit)) out.push('CodeRabbit');
	if (!isApproved(approvals.codex)) out.push('Codex');
	if (!isApproved(approvals.human)) out.push('a reviewer');
	return out;
}

const NOTION_REASON: Record<Approval['kind'], string> = {
	disabled: 'draft',
	not_requested: 'draft',
	approved: 'Notion AI approved, mark it ready for review',
	changes: 'draft · Notion AI asked for changes',
	stale: 'draft · Notion AI reviewed an older commit',
	none: 'draft · waiting for the Notion AI review',
};

export function assess(pr: PullRequest, config: Config, me: string, now: Date, queue: QueueEntry[] = []): Assessment {
	const mine = pr.author === me;
	const queued = queue.filter((e) => e.repo === pr.repo && e.number === pr.number && e.headOid === pr.headOid);
	const ci = ciState(pr, [...config.ignoreChecks, config.coderabbit.checkName]);
	const coderabbit = coderabbitState(pr, config.coderabbit, now);
	const codex = codexState(pr, config.codex, now);
	const labels = new Set(pr.labels.map((l) => l.toLowerCase()));
	const pendingThreads = pr.threads.filter((t) => !t.isResolved && t.lastAuthor !== null && t.lastAuthor !== pr.author);
	const threadsAwaitingAuthor = pendingThreads.length;

	const blockers: string[] = [];
	if (pr.isDraft) blockers.push('draft');
	if (pr.mergeable === 'CONFLICTING') blockers.push('merge conflicts');
	if (ci === 'failure') blockers.push('CI failing');

	const rateLimitOver = coderabbit.kind === 'rate_limited' && Date.parse(coderabbit.retryAt) <= now.getTime();
	// On my PRs the queue says whether the retry is really scheduled. Without an entry nothing will
	// ask CodeRabbit again, so the retry is still mine to request.
	const crRetryPending =
		coderabbit.kind === 'rate_limited' && !rateLimitOver && (!mine || queued.some((e) => e.bot === 'coderabbit'));
	const aiBusy =
		coderabbit.kind === 'reviewing' ||
		coderabbit.kind === 'requested' ||
		crRetryPending ||
		codex.kind === 'running' ||
		queued.length > 0;
	// Codex is optional: asking it the first time is offered, but only owed once it is in play on this PR.
	const aiOwed = coderabbit.kind === 'needs_unstick' || coderabbit.kind === 'rate_limited' ||['outdated', 'timed_out'].includes(codex.kind);
	const aiActionable = blockers.length === 0 && !aiBusy && (aiOwed || codex.kind === 'never');

	const approvals: Approvals = {
		coderabbit: coderabbitApproval(pr, config.coderabbit, coderabbit),
		codex: codexApproval(pr, config.codex, codex),
		human: humanApproval(pr, config),
		notion: notionApproval(pr, config.notion),
	};
	const missing = missingApprovals(approvals);
	const done = missing.length === 0;

	const base = { pr, mine, ci, coderabbit, codex, queued, threadsAwaitingAuthor, pendingThreads, aiActionable, aiBusy, approvals, done };
	const result = (group: Group, reason: string): Assessment => ({ ...base, group, reason });

	// Drafts go through Notion AI first. They are nobody's turn until it approves.
	if (pr.isDraft) {
		const other = blockers.filter((b) => b !== 'draft');
		const reason = [NOTION_REASON[approvals.notion.kind], ...other].join(', ');
		if (mine && approvals.notion.kind === 'approved' && other.length === 0) return result('author', reason);
		return result('draft', mine ? reason : `${pr.author}: ${reason}`);
	}

	if (blockers.length === 0 && approvals.human.kind === 'approved' && ci !== 'pending') {
		const bots = missing.filter((m) => m !== 'a reviewer');
		return result('ready', bots.length ? `approved · ${bots.join(' and ')} not approved yet` : 'approved by everyone');
	}

	if (mine) {
		if (blockers.length > 0) return result('author', blockers.join(', '));
		if (threadsAwaitingAuthor > 0) return result('author', threadsReason(pendingThreads, config));
		if (labels.has(config.labels.needsAuthor.toLowerCase())) return result('author', 'changes requested');
		if (aiBusy) return result('waiting_ai', aiWaitReason(coderabbit, codex, queued));
		if (aiActionable && aiOwed) {
			if (coderabbit.kind === 'rate_limited' && !rateLimitOver) {
				return result('author', `CodeRabbit rate limited until ${formatClock(coderabbit.retryAt)}, schedule the retry`);
			}
			return result('author', 'request the AI review');
		}
		const reviewers = pr.requestedReviewers.filter((r) => r !== me);
		const waitingFor = missing.flatMap((m) => (m === 'a reviewer' ? (reviewers.length ? reviewers : ['review']) : [`${m}'s approve`]));
		return result('others', `waiting for ${waitingFor.join(', ')}`);
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

/** Display name for whoever opened a thread: the bots by name, people by login. */
export function openerName(login: string | null, config: Config): string {
	if (login === config.coderabbit.login) return 'CodeRabbit';
	if (login === config.codex.login) return 'Codex';
	return login ?? 'someone';
}

/** "1 open CodeRabbit thread waiting for you", "3 open threads waiting for you (Codex, bob)". */
export function threadsReason(threads: ReviewThread[], config: Config): string {
	const names = [...new Set(threads.map((t) => openerName(t.firstAuthor, config)))];
	if (threads.length === 1) return `1 open ${names[0]} thread waiting for you`;
	return `${threads.length} open threads waiting for you (${names.join(', ')})`;
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
