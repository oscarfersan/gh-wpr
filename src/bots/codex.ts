import type { CodexConfig } from '../config.ts';
import type { PullRequest } from '../types.ts';
import { isAfter, latestBy, minutesSince } from '../util.ts';

/*
 * Codex reviews on demand ("@codex review"). It keeps a summary comment whose
 * hidden `codex-review-state:v1` JSON names the commit it reviewed and the
 * status. When it finds nothing it may only leave a receipt comment with
 * "**Reviewed commit:** `abc1234`" instead of a PR review.
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

interface CodexStateJson {
	code_review?: { commit_sha?: string | null; status?: string | null };
}

const matchesHead = (headOid: string, sha: string): boolean =>
	sha.length >= 7 && headOid.toLowerCase().startsWith(sha.toLowerCase());

/**
 * Codex's actual reviews. Its replies in a thread also show up as reviews of
 * whatever commit is the head at the time, but with an empty body.
 */
const codexReviews = (pr: PullRequest, config: CodexConfig) =>
	pr.reviews.filter((r) => r.author === config.login && r.body.trim() !== '');

export function isCodexRequest(body: string, command: string): boolean {
	return body.trim().toLowerCase().startsWith(command.toLowerCase());
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
			if (sha && matchesHead(pr.headOid, sha)) {
				if (status === 'completed') return { kind: 'reviewed' };
				if (status && minutesSince(comment.updatedAt, now) <= config.timeoutMinutes * 2) {
					return { kind: 'running', since: comment.updatedAt };
				}
			}
			if (sha && status === 'completed' && !reviewedOid) reviewedOid = sha;
		}
		const receipt = comment.body.match(RECEIPT_RE);
		if (receipt && matchesHead(pr.headOid, receipt[1])) return { kind: 'reviewed' };
		if (receipt && !reviewedOid) reviewedOid = receipt[1];
	}

	const lastReview = latestBy(reviews, (r) => r.submittedAt);
	if (!reviewedOid && lastReview?.commitOid) reviewedOid = lastReview.commitOid;

	// A request only counts for the current head if it was made after that commit.
	const request = latestBy(
		pr.comments.filter((c) => !isAfter(pr.headCommittedAt, c.createdAt) && isCodexRequest(c.body, config.command)),
		(c) => c.createdAt,
	);
	if (request) {
		if (minutesSince(request.createdAt, now) <= config.timeoutMinutes) {
			return { kind: 'running', since: request.createdAt };
		}
		return { kind: 'timed_out', requestedAt: request.createdAt };
	}

	return reviewedOid ? { kind: 'outdated', reviewedOid } : { kind: 'never' };
}
