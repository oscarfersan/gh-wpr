import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ciState } from '../src/ci.ts';
import { isOpen } from '../src/snapshot.ts';
import { parseConfig } from '../src/config.ts';
import { parseTarget } from '../src/target.ts';
import { assess } from '../src/turn.ts';
import { HEAD, NOW, OLD, check, codexSummary, config, crRateLimited, crRunning, makePr, minutesAgo, review } from './fixtures.ts';

const reviewedByBots = { checkRuns: [check()], comments: [codexSummary(HEAD, 'completed', 5)] };

describe('assess', () => {
	it('puts my PR with conflicts on my side', () => {
		const a = assess(makePr({ mergeable: 'CONFLICTING' }), config, 'alice', NOW);
		assert.equal(a.group, 'author');
		assert.match(a.reason, /conflicts/);
	});

	it('asks me to request the AI review when Codex has not reviewed my head', () => {
		const a = assess(makePr({ checkRuns: [check()] }), config, 'alice', NOW);
		assert.equal(a.group, 'author');
		assert.ok(a.aiActionable);
	});

	it('shows my PR as waiting for the AI while CodeRabbit reviews', () => {
		assert.equal(assess(makePr({ checkRuns: [crRunning(2)] }), config, 'alice', NOW).group, 'waiting_ai');
	});

	it('stops waiting once the rate limit is over', () => {
		const limited = (minutes: number) =>
			makePr({ checkRuns: [crRateLimited(minutes)], comments: [codexSummary(HEAD, 'completed', 5)] });
		assert.equal(assess(limited(2), config, 'alice', NOW).group, 'waiting_ai');
		const over = assess(limited(30), config, 'alice', NOW);
		assert.equal(over.group, 'author');
		assert.ok(over.aiActionable);
	});

	it('gives the turn to the requested reviewer', () => {
		const a = assess(makePr({ ...reviewedByBots, requestedReviewers: ['bob'] }), config, 'bob', NOW);
		assert.equal(a.group, 'review');
	});

	it('gives the turn back to the reviewer after new commits', () => {
		const pr = makePr({ ...reviewedByBots, labels: ['needs-review'], reviews: [review('bob', OLD, 120, 'CHANGES_REQUESTED')] });
		assert.equal(assess(pr, config, 'bob', NOW).group, 'review');
	});

	it('leaves the turn with the author while threads wait for them', () => {
		const pr = makePr({ ...reviewedByBots, requestedReviewers: ['bob'], threads: [{ isResolved: false, firstAuthor: 'bob', lastAuthor: 'bob', lastIsBot: false, lastAt: minutesAgo(5), lastBody: 'why?' }] });
		assert.equal(assess(pr, config, 'alice', NOW).group, 'author');
		assert.equal(assess(pr, config, 'bob', NOW).group, 'others');
	});

	it('lists approved PRs with green CI as ready', () => {
		const pr = makePr({ ...reviewedByBots, labels: ['approved'], checkRuns: [check(), check({ name: 'tests' })] });
		assert.equal(assess(pr, config, 'alice', NOW).group, 'ready');
	});

	it('shows my PR as waiting for the reviewer once the bots are done', () => {
		const a = assess(makePr({ ...reviewedByBots, requestedReviewers: ['bob'] }), config, 'alice', NOW);
		assert.equal(a.group, 'others');
		assert.equal(a.reason, 'waiting for bob');
	});
});

describe('ciState', () => {
	it('uses only the latest run of each check and skips ignored ones', () => {
		const pr = makePr({
			checkRuns: [
				check({ name: 'tests', conclusion: 'FAILURE', startedAt: minutesAgo(30) }),
				check({ name: 'tests', conclusion: 'SUCCESS', startedAt: minutesAgo(10) }),
				check({ name: 'Triage', conclusion: 'FAILURE' }),
			],
		});
		assert.equal(ciState(pr, ['Triage']), 'success');
		assert.equal(ciState(pr, []), 'failure');
	});

	it('is pending while a check runs', () => {
		assert.equal(ciState(makePr({ checkRuns: [crRunning(1)] }), []), 'pending');
	});
});

describe('parseTarget', () => {
	it('accepts numbers, qualified numbers and URLs', () => {
		assert.deepEqual(parseTarget('#12', undefined), { repo: null, number: 12 });
		assert.deepEqual(parseTarget('12', 'acme/api'), { repo: 'acme/api', number: 12 });
		assert.deepEqual(parseTarget('acme/api#12', undefined), { repo: 'acme/api', number: 12 });
		assert.deepEqual(parseTarget('https://github.com/acme/api/pull/12/files', undefined), { repo: 'acme/api', number: 12 });
	});
});

describe('parseConfig', () => {
	it('fills in bot defaults and normalises logins', () => {
		const c = parseConfig({ repos: ['acme/api'], team: ['Alice'], codex: { timeoutMinutes: 20 } });
		assert.deepEqual(c.team, ['alice']);
		assert.equal(c.codex.timeoutMinutes, 20);
		assert.equal(c.codex.command, '@codex review');
	});

	it('rejects unknown settings and bad repos', () => {
		assert.throws(() => parseConfig({ repos: ['acme/api'], codex: { tiemout: 1 } }), /Unknown setting/);
		assert.throws(() => parseConfig({ repos: ['acme api'] }), /not a valid/);
	});
});

describe('isOpen', () => {
	it('drops PRs that search still lists as open after a merge', () => {
		assert.ok(isOpen({ state: 'OPEN' }));
		assert.ok(!isOpen({ state: 'MERGED' }));
		assert.ok(!isOpen({ state: 'CLOSED' }));
	});
});
