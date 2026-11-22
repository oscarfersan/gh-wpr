import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { coderabbitState, isCodeRabbitRequest, parseRetryDelayMs } from '../src/bots/coderabbit.ts';
import { HEAD, NOW, OLD, check, comment, config, crPaused, crRateLimited, crRunning, makePr, minutesAgo, rateLimitNotice, review } from './fixtures.ts';

const state = (pr = makePr()) => coderabbitState(pr, config.coderabbit, NOW);

describe('parseRetryDelayMs', () => {
	it('reads minutes and seconds', () => {
		assert.equal(parseRetryDelayMs('Next included review available in **3 minutes and 5 seconds**.'), 185_000);
	});
	it('reads seconds only', () => {
		assert.equal(parseRetryDelayMs('available in **17 seconds**'), 17_000);
	});
	it('reads hours', () => {
		assert.equal(parseRetryDelayMs('available in **1 hour and 2 minutes**'), 3_720_000);
	});
	it('returns null without a delay', () => {
		assert.equal(parseRetryDelayMs('Review limit reached'), null);
	});
});

describe('isCodeRabbitRequest', () => {
	it('matches full review, review and resume', () => {
		assert.ok(isCodeRabbitRequest('@coderabbitai full review', 'coderabbitai'));
		assert.ok(isCodeRabbitRequest('  @CodeRabbitAI review', 'coderabbitai'));
		assert.ok(isCodeRabbitRequest('@coderabbitai resume', 'coderabbitai'));
	});
	it('ignores conversations with the bot', () => {
		assert.ok(!isCodeRabbitRequest('@coderabbitai about your comment on the cache', 'coderabbitai'));
	});
});

describe('coderabbitState', () => {
	it('is reviewed when the head check finished', () => {
		assert.deepEqual(state(makePr({ checkRuns: [check()] })), { kind: 'reviewed' });
	});

	it('is reviewing while the check runs', () => {
		assert.equal(state(makePr({ checkRuns: [crRunning(5)] })).kind, 'reviewing');
	});

	it('is stuck when the check runs for too long', () => {
		assert.deepEqual(state(makePr({ checkRuns: [crRunning(45)] })), {
			kind: 'needs_unstick',
			reason: 'too_slow',
			alreadyRequested: false,
		});
	});

	it('takes the retry time from the rate-limit notice', () => {
		const pr = makePr({ checkRuns: [crRateLimited(10)], comments: [rateLimitNotice('**5 minutes and 0 seconds**', 10)] });
		const s = state(pr);
		assert.equal(s.kind, 'rate_limited');
		assert.equal(s.kind === 'rate_limited' && s.retryAt, new Date(NOW.getTime() - 10 * 60_000 + 300_000 + 30_000).toISOString());
	});

	it('falls back to a fixed delay when the notice has no time', () => {
		const s = state(makePr({ checkRuns: [crRateLimited(3)] }));
		assert.equal(s.kind === 'rate_limited' && s.retryAt, new Date(NOW.getTime() - 3 * 60_000 + 10 * 60_000).toISOString());
	});

	it('needs a nudge when reviews are paused', () => {
		assert.deepEqual(state(makePr({ checkRuns: [crPaused()] })), {
			kind: 'needs_unstick',
			reason: 'paused',
			alreadyRequested: false,
		});
	});

	it('is skipped when there are no files to review', () => {
		assert.equal(state(makePr({ checkRuns: [check({ conclusion: 'SKIPPED', title: 'No files to review' })] })).kind, 'skipped');
	});

	it('treats a cancelled review as failed', () => {
		const s = state(makePr({ checkRuns: [check({ conclusion: 'CANCELLED', title: 'Review cancelled' })] }));
		assert.equal(s.kind === 'needs_unstick' && s.reason, 'failed');
	});

	it('uses the newest run when there are several', () => {
		const pr = makePr({ checkRuns: [crRateLimited(40), check({ startedAt: minutesAgo(20), completedAt: minutesAgo(15) })] });
		assert.equal(state(pr).kind, 'reviewed');
	});

	it('is still reviewing shortly after a push with no check yet', () => {
		assert.equal(state(makePr({ headCommittedAt: minutesAgo(2) })).kind, 'reviewing');
	});

	it('is stuck when nothing happened long after the push', () => {
		assert.deepEqual(state(makePr()), { kind: 'needs_unstick', reason: 'no_response', alreadyRequested: false });
	});

	it('counts a fresh full review request as requested', () => {
		const pr = makePr({ checkRuns: [crRateLimited(30)], comments: [comment('bob', '@coderabbitai full review', 3)] });
		assert.equal(state(pr).kind, 'requested');
	});

	it('remembers that a request was already made when it got no answer', () => {
		const pr = makePr({ comments: [comment('bob', '@coderabbitai full review', 30)] });
		assert.deepEqual(state(pr), { kind: 'needs_unstick', reason: 'no_response', alreadyRequested: true });
	});

	it('ignores requests made before the head commit', () => {
		const pr = makePr({ headCommittedAt: minutesAgo(2), comments: [comment('bob', '@coderabbitai full review', 30)] });
		assert.equal(state(pr).kind, 'reviewing');
	});

	it('accepts a review on the head commit when there is no check run', () => {
		assert.equal(state(makePr({ reviews: [review('coderabbitai', HEAD, 30)] })).kind, 'reviewed');
		assert.equal(state(makePr({ reviews: [review('coderabbitai', OLD, 30)] })).kind, 'needs_unstick');
	});

	it('is disabled when turned off', () => {
		const off = { ...config.coderabbit, enabled: false };
		assert.equal(coderabbitState(makePr(), off, NOW).kind, 'disabled');
	});
});

describe('coderabbitState after a draft is marked ready', () => {
	// While the PR was a draft CodeRabbit left a skipped check on the same commit.
	const draftSkip = check({ conclusion: 'SKIPPED', title: 'Review skipped', startedAt: minutesAgo(58), completedAt: minutesAgo(58) });

	it('waits for the new review instead of treating the draft skip as done', () => {
		const pr = makePr({ readyAt: minutesAgo(3), checkRuns: [draftSkip] });
		assert.deepEqual(state(pr), { kind: 'reviewing', since: minutesAgo(3) });
	});

	it('counts the no-answer time from when the PR left draft', () => {
		const pr = makePr({ readyAt: minutesAgo(20), checkRuns: [draftSkip] });
		assert.deepEqual(state(pr), { kind: 'needs_unstick', reason: 'no_response', alreadyRequested: false });
	});

	it('follows the check CodeRabbit runs once the PR is ready', () => {
		const pr = makePr({ readyAt: minutesAgo(10), checkRuns: [draftSkip, crRunning(8)] });
		assert.equal(state(pr).kind, 'reviewing');
	});

	it('still treats "No files to review" on a ready PR as skipped', () => {
		const pr = makePr({ readyAt: minutesAgo(120), checkRuns: [check({ conclusion: 'SKIPPED', title: 'No files to review' })] });
		assert.equal(state(pr).kind, 'skipped');
	});
});
