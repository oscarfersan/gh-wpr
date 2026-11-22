import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ciState } from '../src/ci.ts';
import { isOpen } from '../src/snapshot.ts';
import { parseConfig } from '../src/config.ts';
import { parseTarget } from '../src/target.ts';
import { assess } from '../src/turn.ts';
import { HEAD, NOW, OLD, check, codexSummary, codexThumbsUp, comment, config, crRateLimited, crRunning, makePr, minutesAgo, review, thread } from './fixtures.ts';

const reviewedByBots = { checkRuns: [check()], comments: [codexSummary(HEAD, 'completed', 5)] };
const approvedByBots = {
	checkRuns: [check()],
	comments: [codexSummary(HEAD, 'completed', 5)],
	reactions: [codexThumbsUp(4)],
	reviews: [review('coderabbitai', HEAD, 10, 'APPROVED')],
};

describe('assess', () => {
	it('puts my PR with conflicts on my side', () => {
		const a = assess(makePr({ mergeable: 'CONFLICTING' }), config, 'alice', NOW);
		assert.equal(a.group, 'author');
		assert.match(a.reason, /conflicts/);
	});

	it('asks me to request the AI review when Codex reviewed an older commit', () => {
		const a = assess(makePr({ checkRuns: [check()], comments: [codexSummary(OLD, 'completed', 90)] }), config, 'alice', NOW);
		assert.equal(a.group, 'author');
		assert.ok(a.aiActionable);
	});

	it('treats Codex as optional on a PR where nobody asked it', () => {
		const pr = makePr({ checkRuns: [check()], reviews: [review('coderabbitai', HEAD, 10, 'APPROVED'), review('bob', HEAD, 5, 'APPROVED')] });
		const a = assess(pr, config, 'alice', NOW);
		assert.equal(a.approvals.codex.kind, 'not_requested');
		assert.ok(a.done);
		assert.ok(a.aiActionable, 'asking Codex is still offered');
		const waiting = assess(makePr({ checkRuns: [check()], reviews: [review('coderabbitai', HEAD, 10, 'APPROVED')], requestedReviewers: ['bob'] }), config, 'alice', NOW);
		assert.equal(waiting.group, 'others');
		assert.equal(waiting.reason, 'waiting for bob');
	});

	it('requires Codex once someone asked it', () => {
		const pr = makePr({ checkRuns: [check()], comments: [comment('alice', '@codex review', 40)], reviews: [review('coderabbitai', HEAD, 10, 'APPROVED'), review('bob', HEAD, 5, 'APPROVED')] });
		assert.ok(!assess(pr, config, 'alice', NOW).done);
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
		const pr = makePr({ ...reviewedByBots, requestedReviewers: ['bob'], threads: [thread('bob', 'bob')] });
		assert.equal(assess(pr, config, 'alice', NOW).group, 'author');
		assert.equal(assess(pr, config, 'bob', NOW).group, 'others');
	});

	it('says who opened the threads waiting for the author', () => {
		const one = assess(makePr({ ...reviewedByBots, threads: [thread('coderabbitai', 'coderabbitai')] }), config, 'alice', NOW);
		assert.equal(one.reason, '1 open CodeRabbit thread waiting for you');
		const many = assess(
			makePr({ ...reviewedByBots, threads: [thread('chatgpt-codex-connector', 'chatgpt-codex-connector'), thread('bob', 'bob'), thread('bob', 'bob')] }),
			config,
			'alice',
			NOW,
		);
		assert.equal(many.reason, '3 open threads waiting for you (Codex, bob)');
	});

	it('does not count threads where the author had the last word', () => {
		const a = assess(makePr({ ...reviewedByBots, threads: [thread('coderabbitai', 'alice')] }), config, 'alice', NOW);
		assert.equal(a.threadsAwaitingAuthor, 0);
	});

	it('lists approved PRs with green CI as ready', () => {
		const pr = makePr({ ...reviewedByBots, labels: ['approved'], checkRuns: [check(), check({ name: 'tests' })] });
		assert.equal(assess(pr, config, 'alice', NOW).group, 'ready');
	});

	it('shows my PR as waiting for the reviewer once the bots approved', () => {
		const a = assess(makePr({ ...approvedByBots, requestedReviewers: ['bob'] }), config, 'alice', NOW);
		assert.equal(a.group, 'others');
		assert.equal(a.reason, 'waiting for bob');
	});

	it('says which bot has not approved the head yet', () => {
		const reviews = [review('coderabbitai', HEAD, 10, 'APPROVED'), review('chatgpt-codex-connector', HEAD, 6, 'COMMENTED', '### 💡 Codex Review')];
		const a = assess(makePr({ ...reviewedByBots, reviews, requestedReviewers: ['bob'] }), config, 'alice', NOW);
		assert.equal(a.approvals.coderabbit.kind, 'approved');
		assert.equal(a.approvals.codex.kind, 'changes');
		assert.equal(a.reason, "waiting for Codex's approve, bob");
	});

	it('is done with CodeRabbit, Codex and a teammate approving, in any order', () => {
		const pr = makePr({ ...approvedByBots, reviews: [review('bob', HEAD, 30, 'APPROVED'), review('coderabbitai', HEAD, 10, 'APPROVED')] });
		const a = assess(pr, config, 'alice', NOW);
		assert.ok(a.done);
		assert.equal(a.group, 'ready');
		assert.equal(a.reason, 'approved by everyone');
	});

	it('lists a teammate-approved PR as ready but says which bot is missing', () => {
		const pr = makePr({ ...reviewedByBots, reviews: [review('bob', HEAD, 30, 'APPROVED')] });
		const a = assess(pr, config, 'alice', NOW);
		assert.equal(a.group, 'ready');
		assert.equal(a.reason, 'approved · CodeRabbit and Codex not approved yet');
		assert.ok(!a.done);
	});

	it('lets a later request for changes win over an approval', () => {
		const pr = makePr({ ...approvedByBots, reviews: [review('bob', HEAD, 30, 'APPROVED'), review('carol', HEAD, 5, 'CHANGES_REQUESTED')] });
		assert.equal(assess(pr, config, 'alice', NOW).approvals.human.kind, 'changes');
	});

	it('keeps my drafts out of my turn until Notion AI approves', () => {
		const draft = assess(makePr({ isDraft: true }), config, 'alice', NOW);
		assert.equal(draft.group, 'draft');
		assert.equal(draft.reason, 'draft · waiting for the Notion AI review');
		const changes = makePr({ isDraft: true, comments: [comment('alice', 'Notes…\n\nNotion AI review: CHANGES REQUESTED for aaaaaaa1', 3)] });
		assert.equal(assess(changes, config, 'alice', NOW).reason, 'draft · Notion AI asked for changes');
		const approved = makePr({ isDraft: true, comments: [comment('alice', 'Notion AI review: APPROVED for `aaaaaaa1`', 3)] });
		const a = assess(approved, config, 'alice', NOW);
		assert.equal(a.group, 'author');
		assert.equal(a.reason, 'Notion AI approved, mark it ready for review');
	});

	it('does not count a Notion AI approval of an older commit', () => {
		const pr = makePr({ isDraft: true, reviews: [review('alice', OLD, 90, 'COMMENTED', 'Notion AI review: APPROVED for bbbbbbb2')] });
		const a = assess(pr, config, 'alice', NOW);
		assert.equal(a.group, 'draft');
		assert.equal(a.approvals.notion.kind, 'stale');
	});

	it('lists teammates drafts apart', () => {
		const a = assess(makePr({ isDraft: true }), config, 'bob', NOW);
		assert.equal(a.group, 'draft');
		assert.match(a.reason, /^alice: draft/);
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
