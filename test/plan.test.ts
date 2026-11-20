import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { planAi } from '../src/plan.ts';
import { HEAD, NOW, check, codexSummary, comment, config, crPaused, crRateLimited, crRunning, makePr, rateLimitNotice } from './fixtures.ts';

const kinds = (plan: ReturnType<typeof planAi>) => plan.actions.map((a) => `${a.bot}:${a.kind}`);

describe('planAi', () => {
	it('asks Codex right away when CodeRabbit already reviewed the head', () => {
		const plan = planAi(makePr({ checkRuns: [check()] }), config, NOW);
		assert.deepEqual(kinds(plan), ['coderabbit:skip', 'codex:post']);
		assert.equal(plan.actions[1].kind === 'post' && plan.actions[1].body, '@codex review');
	});

	it('does nothing when both bots already reviewed the head', () => {
		const plan = planAi(makePr({ checkRuns: [check()], comments: [codexSummary(HEAD, 'completed', 5)] }), config, NOW);
		assert.deepEqual(kinds(plan), ['coderabbit:skip', 'codex:skip']);
	});

	it('does not repeat a Codex request that is still running', () => {
		const pr = makePr({ checkRuns: [check()], comments: [comment('bob', '@codex review', 3)] });
		assert.deepEqual(kinds(planAi(pr, config, NOW)), ['coderabbit:skip', 'codex:skip']);
	});

	it('schedules a full review after a rate limit and queues Codex behind it', () => {
		const pr = makePr({ checkRuns: [crRateLimited(2)], comments: [rateLimitNotice('**8 minutes**', 2)] });
		const plan = planAi(pr, config, NOW);
		assert.deepEqual(kinds(plan), ['coderabbit:schedule', 'codex:enqueue']);
	});

	it('posts the full review at once when the rate limit is already over', () => {
		const pr = makePr({ checkRuns: [crRateLimited(30)], comments: [rateLimitNotice('**17 seconds**', 30)] });
		assert.deepEqual(kinds(planAi(pr, config, NOW)), ['coderabbit:post', 'codex:enqueue']);
	});

	it('unsticks paused reviews and queues Codex', () => {
		const plan = planAi(makePr({ checkRuns: [crPaused()] }), config, NOW);
		assert.deepEqual(kinds(plan), ['coderabbit:post', 'codex:enqueue']);
		assert.equal(plan.actions[0].kind === 'post' && plan.actions[0].body, '@coderabbitai full review');
	});

	it('waits while CodeRabbit is reviewing', () => {
		assert.deepEqual(kinds(planAi(makePr({ checkRuns: [crRunning(3)] }), config, NOW)), ['coderabbit:skip', 'codex:enqueue']);
	});

	it('does not repeat a full review that already got no answer, unless forced', () => {
		const pr = makePr({ comments: [comment('bob', '@coderabbitai full review', 30)] });
		assert.deepEqual(kinds(planAi(pr, config, NOW)), ['coderabbit:skip', 'codex:enqueue']);
		assert.deepEqual(kinds(planAi(pr, config, NOW, { force: true })), ['coderabbit:post', 'codex:enqueue']);
	});

	it('lets --bot codex skip the wait for CodeRabbit', () => {
		const plan = planAi(makePr({ checkRuns: [crRunning(3)] }), config, NOW, { only: 'codex' });
		assert.deepEqual(kinds(plan), ['codex:post']);
	});

	it('refuses drafts and PRs with conflicts', () => {
		assert.equal(planAi(makePr({ isDraft: true }), config, NOW).blocked, 'the PR is a draft');
		assert.equal(planAi(makePr({ mergeable: 'CONFLICTING' }), config, NOW).blocked, 'the PR has merge conflicts');
	});
});
