import type { CodexConfig } from '../config.ts';
import type { PullRequest } from '../types.ts';
import { isAfter, latestBy, matchesOid, minutesSince } from '../util.ts';
import type { Approval } from './approval.ts';

/*
 * Codex reviews on demand ("@codex review"). It keeps a summary comment whose
 * hidden `codex-review-state:v1` JSON names the commit it reviewed and the
 * status. When it finds nothing it puts 👍 on the PR description and may leave
 * a receipt comment ("Didn't find any major issues", "**Reviewed commit:**
 * `abc1234`") instead of a PR review with suggestions.
 */

export type CodexState =
	| { kind: 'disabled' }
	| { kind: 'reviewed' }
	| { kind: 'running'; since: string }
	| { kind: 'outdated'; reviewedOid: string }
	| { kind: 'timed_out'; requestedAt: string }
	| { kind: 'never' };

const STATE_RE = /<!--\s*codex-review-state:v1\s*(\{[\s\S]*?\})\s*-->/;
const RECEIPT_RE = /\*\*Reviewed commit:\*\*\s*`([0-9a-f]{7,40})`/i;
const NO_ISSUES_RE = /didn['’]t find any major issues/i;

interface CodexStateJson {
	code_review?: { commit_sha?: string | null; status?: string | null };
}

/**
 * Codex's actual reviews. Its replies in a thread also show up as reviews of
 * whatever commit is the head at the time, but with an empty body.
 */
const codexReviews = (pr: PullRequest, config: CodexConfig) =>
	pr.reviews.filter((r) => r.author === config.login && r.body.trim() !== '');

export function isCodexRequest(body: string, command: string): boolean {
	return body.trim().toLowerCase().startsWith(command.toLowerCase());
}

/** Latest evidence that Codex looked at a commit other than the head, if any. */
function olderReview(pr: PullRequest, config: CodexConfig): { oid: string; at: string } | null {
	const found: { oid: string; at: string }[] = [];
	for (const comment of pr.comments.filter((c) => c.author === config.login)) {
		const state = comment.body.match(STATE_RE);
		if (state) {
			try {
				const parsed = JSON.parse(state[1]) as CodexStateJson;
				const sha = parsed.code_review?.commit_sha;
				if (sha && parsed.code_review?.status === 'completed') found.push({ oid: sha, at: comment.updatedAt });
			} catch {
				// Unknown format: fall back to receipts and reviews.
			}
		}
		const receipt = comment.body.match(RECEIPT_RE);
		if (receipt) found.push({ oid: receipt[1], at: comment.updatedAt });
	}
	for (const review of codexReviews(pr, config).filter((r) => r.commitOid)) {
		found.push({ oid: review.commitOid as string, at: review.submittedAt });
	}
	return latestBy(
		found.filter((f) => !matchesOid(pr.headOid, f.oid)),
		(f) => f.at,
	);
}

/**
 * Codex's 👍 on the PR description, when it is about the head commit: given
 * after that commit, and not followed by a review of another commit.
 */
export function codexThumbsUp(pr: PullRequest, config: CodexConfig): string | null {
	const thumbs = latestBy(
		pr.reactions.filter((r) => r.login === config.login && r.content === 'THUMBS_UP'),
		(r) => r.at,
	);
	if (!thumbs || isAfter(pr.headCommittedAt, thumbs.at)) return null;
	const older = olderReview(pr, config);
	if (older && isAfter(older.at, thumbs.at)) return null;
	return thumbs.at;
}

export function codexState(pr: PullRequest, config: CodexConfig, now: Date): CodexState {
	if (!config.enabled) return { kind: 'disabled' };

	const comments = pr.comments.filter((c) => c.author === config.login);
	const reviews = codexReviews(pr, config);

	if (reviews.some((r) => r.commitOid === pr.headOid)) return { kind: 'reviewed' };

	let reviewedOid: string | null = null;
	for (const comment of [...comments].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))) {
		const state = comment.body.match(STATE_RE);
		if (state) {
			let parsed: CodexStateJson = {};
			try {
				parsed = JSON.parse(state[1]) as CodexStateJson;
			} catch {
				// Unknown format: fall back to receipts and reviews.
			}
			const sha = parsed.code_review?.commit_sha;
			const status = parsed.code_review?.status;
			if (sha && matchesOid(pr.headOid, sha)) {
				if (status === 'completed') return { kind: 'reviewed' };
				if (status && minutesSince(comment.updatedAt, now) <= config.timeoutMinutes * 2) {
					return { kind: 'running', since: comment.updatedAt };
				}
			}
			if (sha && status === 'completed' && !reviewedOid) reviewedOid = sha;
		}
		const receipt = comment.body.match(RECEIPT_RE);
		if (receipt && matchesOid(pr.headOid, receipt[1])) return { kind: 'reviewed' };
		if (receipt && !reviewedOid) reviewedOid = receipt[1];
	}

	const lastReview = latestBy(reviews, (r) => r.submittedAt);
	if (!reviewedOid && lastReview?.commitOid) reviewedOid = lastReview.commitOid;

	// A request only counts for the current head if it was made after that commit.
	const request = latestBy(
		pr.comments.filter((c) => !isAfter(pr.headCommittedAt, c.createdAt) && isCodexRequest(c.body, config.command)),
		(c) => c.createdAt,
	);
	const thumbsAt = codexThumbsUp(pr, config);
	if (thumbsAt && (!request || !isAfter(request.createdAt, thumbsAt))) return { kind: 'reviewed' };
	if (request) {
		if (minutesSince(request.createdAt, now) <= config.timeoutMinutes) {
			return { kind: 'running', since: request.createdAt };
		}
		return { kind: 'timed_out', requestedAt: request.createdAt };
	}

	return reviewedOid ? { kind: 'outdated', reviewedOid } : { kind: 'never' };
}

/** Codex approves with 👍 on the description (or a "Didn't find any major issues" receipt) for the head. */
export function codexApproval(pr: PullRequest, config: CodexConfig, state: CodexState): Approval {
	if (!config.enabled) return { kind: 'disabled' };
	const thumbsAt = codexThumbsUp(pr, config);
	if (thumbsAt) return { kind: 'approved', at: thumbsAt };
	const noIssues = latestBy(
		pr.comments.filter((c) => {
			if (c.author !== config.login || !NO_ISSUES_RE.test(c.body)) return false;
			const receipt = c.body.match(RECEIPT_RE);
			return receipt !== null && matchesOid(pr.headOid, receipt[1]);
		}),
		(c) => c.updatedAt,
	);
	if (noIssues) return { kind: 'approved', at: noIssues.updatedAt };
	// Suggestions come as a PR review on the head. Without one the verdict is still on its way.
	const suggestions = latestBy(
		codexReviews(pr, config).filter((r) => r.commitOid === pr.headOid),
		(r) => r.submittedAt,
	);
	if (suggestions) return { kind: 'changes', at: suggestions.submittedAt };
	if (state.kind === 'outdated') return { kind: 'stale', oid: state.reviewedOid };
	return { kind: 'none' };
}
