import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { codexApproval, codexState } from '../src/bots/codex.ts';
import { HEAD, NOW, OLD, codexSummary, codexThumbsUp, comment, config, makePr, minutesAgo, review } from './fixtures.ts';

const state = (pr = makePr()) => codexState(pr, config.codex, NOW);

describe('codexState', () => {
	it('is never when Codex has not been involved', () => {
		assert.deepEqual(state(), { kind: 'never' });
	});

	it('is reviewed from the summary state of the head commit', () => {
		assert.deepEqual(state(makePr({ comments: [codexSummary(HEAD, 'completed', 5)] })), { kind: 'reviewed' });
	});

	it('is running while the summary reports another status for the head', () => {
		assert.equal(state(makePr({ comments: [codexSummary(HEAD, 'in_progress', 3)] })).kind, 'running');
	});

	it('is outdated when the summary is about an older commit', () => {
		assert.deepEqual(state(makePr({ comments: [codexSummary(OLD, 'completed', 90)] })), { kind: 'outdated', reviewedOid: OLD });
	});

	it('is reviewed from a receipt with a short sha', () => {
		const receipt = comment('chatgpt-codex-connector', "Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** `aaaaaaa111`", 5);
		assert.deepEqual(state(makePr({ comments: [receipt] })), { kind: 'reviewed' });
	});

	it('is reviewed from a PR review on the head commit', () => {
		assert.deepEqual(state(makePr({ reviews: [review('chatgpt-codex-connector', HEAD, 5, 'COMMENTED', '### 💡 Codex Review')] })), { kind: 'reviewed' });
	});

	it('does not take a reply in a thread for a review of the head', () => {
		const pr = makePr({ reviews: [review('chatgpt-codex-connector', OLD, 90, 'COMMENTED', '### 💡 Codex Review'), review('chatgpt-codex-connector', HEAD, 5)] });
		assert.deepEqual(state(pr), { kind: 'outdated', reviewedOid: OLD });
	});

	it('is running right after a request from anyone', () => {
		assert.equal(state(makePr({ comments: [comment('bob', '@codex review', 4)] })).kind, 'running');
	});

	it('times out when a request got no answer', () => {
		assert.equal(state(makePr({ comments: [comment('bob', '@codex review', 40)] })).kind, 'timed_out');
	});

	it('ignores requests from before the head commit', () => {
		const pr = makePr({ headCommittedAt: minutesAgo(5), comments: [comment('bob', '@codex review', 30), codexSummary(OLD, 'completed', 20)] });
		assert.equal(state(pr).kind, 'outdated');
	});

	it('is reviewed from a 👍 on the description given after the head commit', () => {
		assert.deepEqual(state(makePr({ reactions: [codexThumbsUp(10)] })), { kind: 'reviewed' });
	});

	it('is running when someone asked again after the 👍', () => {
		assert.equal(state(makePr({ reactions: [codexThumbsUp(10)], comments: [comment('bob', '@codex review', 3)] })).kind, 'running');
	});
});

describe('codexApproval', () => {
	const approval = (pr = makePr()) => codexApproval(pr, config.codex, codexState(pr, config.codex, NOW));

	it('approves with 👍 on the description after the head commit', () => {
		assert.equal(approval(makePr({ reactions: [codexThumbsUp(10)] })).kind, 'approved');
	});

	it('ignores a 👍 from before the head commit', () => {
		const pr = makePr({ reactions: [codexThumbsUp(90)], comments: [codexSummary(OLD, 'completed', 95)] });
		assert.equal(approval(pr).kind, 'stale');
	});

	it('ignores a 👍 followed by a review of another commit', () => {
		const pr = makePr({ reactions: [codexThumbsUp(30)], comments: [codexSummary(OLD, 'completed', 20)] });
		assert.equal(approval(pr).kind, 'stale');
	});

	it('ignores 👍 from people', () => {
		assert.equal(approval(makePr({ reactions: [{ ...codexThumbsUp(10), login: 'bob' }] })).kind, 'none');
	});

	it("approves with a \"Didn't find any major issues\" receipt for the head", () => {
		const receipt = comment('chatgpt-codex-connector', "Codex Review: Didn't find any major issues. Bravo.\n\n**Reviewed commit:** `aaaaaaa111`", 5);
		assert.equal(approval(makePr({ comments: [receipt] })).kind, 'approved');
	});

	it('reports changes when it reviewed the head with suggestions', () => {
		const pr = makePr({ reviews: [review('chatgpt-codex-connector', HEAD, 5, 'COMMENTED', '### 💡 Codex Review')] });
		assert.equal(approval(pr).kind, 'changes');
	});
});
