import type { CodeRabbitConfig } from '../config.ts';
import type { CheckRun, IssueComment, PullRequest } from '../types.ts';
import { addMs, isAfter, latestBy, minutesSince, reviewableSince } from '../util.ts';
import type { Approval } from './approval.ts';

/*
 * CodeRabbit reviews every push on its own. It only needs a nudge
 * ("@coderabbitai full review") when it got stuck. Its check run on the head
 * commit says exactly what happened:
 *
 *   in_progress                      -> reviewing
 *   success   "Finished"             -> reviewed
 *   neutral   "Review rate limited"  -> rate limited, retry later
 *   skipped   "Review paused"        -> paused after too many pushes
 *   skipped   "No files to review"   -> nothing to review
 *   cancelled / failure              -> failed
 *
 * It also skips drafts ("skipping" check). Once the PR is marked ready it
 * reviews the same commit again, so anything from before that is ignored.
 */

export type UnstickReason = 'paused' | 'failed' | 'no_response' | 'too_slow';

export type CodeRabbitState =
	| { kind: 'disabled' }
	| { kind: 'reviewed' }
	| { kind: 'skipped' }
	| { kind: 'reviewing'; since: string }
	| { kind: 'requested'; at: string }
	| { kind: 'rate_limited'; retryAt: string; alreadyRequested: boolean }
	| { kind: 'needs_unstick'; reason: UnstickReason; alreadyRequested: boolean };

/** States in which Codex can go next. */
export const coderabbitDone = (state: CodeRabbitState): boolean =>
	state.kind === 'reviewed' || state.kind === 'skipped' || state.kind === 'disabled';

const RATE_LIMIT_MARKER = 'rate limited by coderabbit.ai';

export function latestCheck(pr: PullRequest, name: string): CheckRun | null {
	const target = name.toLowerCase();
	return latestBy(
		pr.checkRuns.filter((c) => c.name.toLowerCase() === target),
		(c) => c.startedAt ?? c.completedAt,
	);
}

export function isCodeRabbitRequest(body: string, login: string): boolean {
	const escaped = login.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return new RegExp(`^\\s*@${escaped}\\s+(full\\s+review|review|resume)\\b`, 'i').test(body);
}

/** Parses "Next included review available in **3 minutes and 5 seconds**." into milliseconds. */
export function parseRetryDelayMs(body: string): number | null {
	const match = body.match(/available in\s+\**([^*\n]+)/i);
	if (!match) return null;
	let ms = 0;
	let found = false;
	for (const part of match[1].matchAll(/(\d+)\s*(hour|minute|second)s?/gi)) {
		found = true;
		const value = Number(part[1]);
		const unit = part[2].toLowerCase();
		ms += value * (unit === 'hour' ? 3_600_000 : unit === 'minute' ? 60_000 : 1_000);
	}
	return found ? ms : null;
}

function retryAt(pr: PullRequest, config: CodeRabbitConfig, check: CheckRun, now: Date): string {
	const notice = latestBy(
		pr.comments.filter((c) => c.author === config.login && c.body.includes(RATE_LIMIT_MARKER)),
		(c) => c.updatedAt,
	);
	const delay = notice ? parseRetryDelayMs(notice.body) : null;
	if (notice && delay !== null) return addMs(notice.updatedAt, delay + 30_000);
	return addMs(check.completedAt ?? now.toISOString(), config.rateLimitFallbackMinutes * 60_000);
}

function stateFromCheck(
	pr: PullRequest,
	config: CodeRabbitConfig,
	check: CheckRun,
	alreadyRequested: boolean,
	now: Date,
): CodeRabbitState {
	if (check.status !== 'COMPLETED') {
		const since = check.startedAt ?? reviewableSince(pr);
		if (minutesSince(since, now) > config.stuckAfterMinutes) {
			return { kind: 'needs_unstick', reason: 'too_slow', alreadyRequested };
		}
		return { kind: 'reviewing', since };
	}
	const title = (check.title ?? '').toLowerCase();
	switch (check.conclusion) {
		case 'SUCCESS':
			return { kind: 'reviewed' };
		case 'NEUTRAL':
			if (title.includes('rate limit')) {
				return { kind: 'rate_limited', retryAt: retryAt(pr, config, check, now), alreadyRequested };
			}
			return { kind: 'reviewed' };
		case 'SKIPPED':
			if (title.includes('paused')) return { kind: 'needs_unstick', reason: 'paused', alreadyRequested };
			return { kind: 'skipped' };
		default:
			return { kind: 'needs_unstick', reason: 'failed', alreadyRequested };
	}
}

export function coderabbitState(pr: PullRequest, config: CodeRabbitConfig, now: Date): CodeRabbitState {
	if (!config.enabled) return { kind: 'disabled' };

	const since = reviewableSince(pr);
	const headCheck = latestCheck(pr, config.checkName);
	const headCheckAt = headCheck?.startedAt ?? headCheck?.completedAt ?? null;
	// A check from while the PR was a draft says nothing about the review CodeRabbit owes now.
	const check = headCheck && headCheckAt && isAfter(since, headCheckAt) ? null : headCheck;
	const requests = pr.comments.filter((c) => !isAfter(since, c.createdAt) && isCodeRabbitRequest(c.body, config.login));
	const lastRequest: IssueComment | null = latestBy(requests, (c) => c.createdAt);
	const checkStart = check?.startedAt ?? check?.completedAt ?? null;
	const requestIsNewest = lastRequest !== null && (checkStart === null || isAfter(lastRequest.createdAt, checkStart));

	if (check && !requestIsNewest) return stateFromCheck(pr, config, check, lastRequest !== null, now);

	// Without a check run, a review on the head commit is still proof enough.
	if (!lastRequest && pr.reviews.some((r) => r.author === config.login && r.commitOid === pr.headOid)) {
		return { kind: 'reviewed' };
	}

	if (lastRequest) {
		if (minutesSince(lastRequest.createdAt, now) <= config.noStartAfterMinutes) {
			return { kind: 'requested', at: lastRequest.createdAt };
		}
		return { kind: 'needs_unstick', reason: 'no_response', alreadyRequested: true };
	}

	if (minutesSince(since, now) <= config.noStartAfterMinutes) {
		return { kind: 'reviewing', since };
	}
	return { kind: 'needs_unstick', reason: 'no_response', alreadyRequested: false };
}

/**
 * CodeRabbit's verdict is its last APPROVED or CHANGES_REQUESTED review. It often
 * approves on the same commit after the author answers its threads, so the
 * check run alone is not enough. A commit with nothing to review keeps the
 * verdict of the one before.
 */
export function coderabbitApproval(pr: PullRequest, config: CodeRabbitConfig, state: CodeRabbitState): Approval {
	if (!config.enabled) return { kind: 'disabled' };
	const verdict = latestBy(
		pr.reviews.filter((r) => r.author === config.login && (r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED')),
		(r) => r.submittedAt,
	);
	if (!verdict) return { kind: 'none' };
	const approved = verdict.state === 'APPROVED';
	if (verdict.commitOid === pr.headOid || (approved && state.kind === 'skipped')) {
		return approved ? { kind: 'approved', at: verdict.submittedAt } : { kind: 'changes', at: verdict.submittedAt };
	}
	return { kind: 'stale', oid: verdict.commitOid };
}
