import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decideEntry, upsert } from '../src/queue.ts';
import type { QueueEntry } from '../src/queue.ts';
import { HEAD, NOW, OLD, check, codexSummary, comment, config, crRateLimited, crRunning, makePr, minutesAgo, minutesFromNow } from './fixtures.ts';

const entry = (overrides: Partial<QueueEntry> = {}): QueueEntry => ({
	repo: 'acme/api',
	number: 42,
	bot: 'codex',
	body: '@codex review',
	headOid: HEAD,
	notBefore: null,
	createdAt: minutesAgo(5),
	...overrides,
});

const decide = (e: QueueEntry, pr = makePr()) => decideEntry(e, pr, config, NOW).decision;

describe('queue', () => {
	it('posts Codex once CodeRabbit has reviewed the head', () => {
		assert.equal(decide(entry(), makePr({ checkRuns: [check()] })), 'post');
	});

	it('keeps Codex waiting while CodeRabbit reviews', () => {
		assert.equal(decide(entry(), makePr({ checkRuns: [crRunning(3)] })), 'keep');
	});

	it('drops Codex when someone already asked for it', () => {
		const pr = makePr({ checkRuns: [check()], comments: [comment('bob', '@codex review', 1)] });
		assert.equal(decide(entry(), pr), 'drop');
	});

	it('drops Codex when it already reviewed the head', () => {
		assert.equal(decide(entry(), makePr({ checkRuns: [check()], comments: [codexSummary(HEAD, 'completed', 1)] })), 'drop');
	});

	it('drops anything queued for an older commit', () => {
		assert.equal(decide(entry({ headOid: OLD }), makePr({ checkRuns: [check()] })), 'drop');
	});

	it('drops entries for PRs that are gone', () => {
		assert.equal(decideEntry(entry(), undefined, config, NOW).decision, 'drop');
	});

	it('keeps a CodeRabbit retry until its time', () => {
		const e = entry({ bot: 'coderabbit', body: '@coderabbitai full review', notBefore: minutesFromNow(5) });
		assert.equal(decide(e, makePr({ checkRuns: [crRateLimited(5)] })), 'keep');
	});

	it('posts a CodeRabbit retry when it is due and CodeRabbit is still stuck', () => {
		const e = entry({ bot: 'coderabbit', body: '@coderabbitai full review', notBefore: minutesAgo(1) });
		assert.equal(decide(e, makePr({ checkRuns: [crRateLimited(30)] })), 'post');
	});

	it('drops a CodeRabbit retry when CodeRabbit moved on by itself', () => {
		const e = entry({ bot: 'coderabbit', body: '@coderabbitai full review', notBefore: minutesAgo(1) });
		assert.equal(decide(e, makePr({ checkRuns: [check()] })), 'drop');
	});

	it('keeps a forced Codex request until CodeRabbit reviews again, even if Codex already reviewed', () => {
		const forced = entry({ force: true, createdAt: minutesAgo(1) });
		const asked = makePr({ checkRuns: [check()], comments: [codexSummary(HEAD, 'completed', 30), comment('alice', '@coderabbitai full review', 1)] });
		assert.equal(decide(forced, asked), 'keep');
		const reviewedAgain = makePr({ checkRuns: [check({ startedAt: minutesAgo(0.5), completedAt: minutesAgo(0.2) })], comments: [codexSummary(HEAD, 'completed', 30), comment('alice', '@coderabbitai full review', 1)] });
		assert.equal(decide(forced, reviewedAgain), 'post');
	});

	it('drops a forced Codex request when someone asked Codex after it', () => {
		const forced = entry({ force: true, createdAt: minutesAgo(3) });
		assert.equal(decide(forced, makePr({ checkRuns: [check()], comments: [comment('bob', '@codex review', 1)] })), 'drop');
	});

	it('keeps entries while the PR has conflicts', () => {
		assert.equal(decide(entry(), makePr({ mergeable: 'CONFLICTING', checkRuns: [check()] })), 'keep');
	});

	it('replaces an entry for the same PR and bot', () => {
		const list = upsert([entry({ createdAt: minutesAgo(50) })], entry());
		assert.equal(list.length, 1);
		assert.equal(list[0].createdAt, minutesAgo(5));
	});
});
