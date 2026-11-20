import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { codexState } from '../src/bots/codex.ts';
import { HEAD, NOW, OLD, codexSummary, comment, config, makePr, minutesAgo, review } from './fixtures.ts';

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
		assert.deepEqual(state(makePr({ reviews: [review('chatgpt-codex-connector', HEAD, 5)] })), { kind: 'reviewed' });
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
});
