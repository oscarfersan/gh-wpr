import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { claudePrompt } from '../src/commands/claude.ts';
import { parseConfig } from '../src/config.ts';
import { notices, postedNotices, remember } from '../src/notify.ts';
import { menuText, renderError, renderMenu } from '../src/swiftbar.ts';
import { assess } from '../src/turn.ts';
import type { Assessment } from '../src/turn.ts';
import { HEAD, NOW, OLD, check, codexSummary, comment, config, crRunning, makePr, minutesAgo, review } from './fixtures.ts';

const ctx = { plugin: '/Users/me/Library/Application Support/SwiftBar/wpr.1m.sh', now: NOW, viewer: 'alice', queued: 0 };

const mineNeedsCodex = (): Assessment => assess(makePr({ checkRuns: [check()] }), config, 'alice', NOW);
const reviewForBob = (number = 7): Assessment =>
	assess(
		makePr({ number, author: 'bob', checkRuns: [check()], comments: [codexSummary(HEAD, 'completed', 3)], requestedReviewers: ['alice'] }),
		config,
		'alice',
		NOW,
	);

describe('menuText', () => {
	it('removes the parameter separator and leading dashes', () => {
		assert.equal(menuText('--Fix a | b'), 'Fix a ∣ b');
	});
	it('shortens long titles', () => {
		assert.equal(menuText('x'.repeat(80), 10), `${'x'.repeat(9)}…`);
	});
});

describe('renderMenu', () => {
	it('shows how many PRs are your turn in the menu bar', () => {
		const out = renderMenu([mineNeedsCodex(), reviewForBob()], ctx);
		assert.match(out.split('\n')[0], /^2 \| sfimage=arrow\.triangle\.pull$/);
		assert.equal(out.split('\n')[1], '---');
	});

	it('runs actions through the plugin with quoted paths', () => {
		const out = renderMenu([mineNeedsCodex()], ctx);
		assert.ok(
			out.includes(
				`--Request AI review | sfimage=sparkles bash="${ctx.plugin}" param1="ai" param2="https://github.com/acme/api/pull/42" terminal=false refresh=true`,
			),
		);
		assert.ok(out.includes('param1="ai" param2="--mine"'));
	});

	it('opens Claude Code in a terminal', () => {
		const out = renderMenu([mineNeedsCodex()], ctx);
		assert.match(out, /--Triage comments with Claude Code .*param1="claude".*terminal=true/);
	});

	it('does not offer the AI button while CodeRabbit reviews', () => {
		const busy = assess(makePr({ checkRuns: [crRunning(2)] }), config, 'alice', NOW);
		const out = renderMenu([busy], ctx);
		assert.ok(!out.includes('Request AI review'));
		assert.match(out.split('\n')[0], /^⧗1 /);
	});

	it('keeps titles with pipes from breaking the line format', () => {
		const a = assess(makePr({ title: 'Parse a | b', checkRuns: [check()] }), config, 'alice', NOW);
		const line = renderMenu([a], ctx).split('\n').find((l) => l.startsWith('#42'));
		assert.equal(line?.split('|').length, 2);
	});

	it('renders errors as a warning icon', () => {
		assert.match(renderError('No config'), /^⚠︎ \| sfimage=exclamationmark\.triangle\n---\nNo config/);
	});
});

describe('notices', () => {
	it('stays quiet on the first refresh', () => {
		assert.deepEqual(notices(null, [reviewForBob()]), []);
	});

	it('announces a PR that became yours to review', () => {
		const before = remember([]);
		const out = notices(before, [reviewForBob(9)]);
		assert.equal(out.length, 1);
		assert.equal(out[0].title, 'Your turn to review');
	});

	it('does not repeat a notice for the same state', () => {
		const items = [reviewForBob()];
		assert.deepEqual(notices(remember(items), items), []);
	});

	it('announces when Codex finishes on my PR', () => {
		const running = assess(makePr({ checkRuns: [check()], comments: [comment('alice', '@codex review', 3)] }), config, 'alice', NOW);
		const done = assess(makePr({ checkRuns: [check()], comments: [codexSummary(HEAD, 'completed', 1)] }), config, 'alice', NOW);
		const out = notices(remember([running]), [done]);
		assert.ok(out.some((n) => n.title === 'Codex finished'));
	});

	it('does not announce Codex for a review of an older push', () => {
		const old = assess(makePr({ headOid: OLD, checkRuns: [check()], comments: [comment('alice', '@codex review', 3)] }), config, 'alice', NOW);
		const done = assess(makePr({ checkRuns: [check()], comments: [codexSummary(HEAD, 'completed', 1)], reviews: [review('bob', OLD, 90)] }), config, 'alice', NOW);
		assert.ok(!notices(remember([old]), [done]).some((n) => n.title === 'Codex finished'));
	});

	it('describes requests posted from the queue', () => {
		const entry = { repo: 'acme/api', number: 42, bot: 'codex' as const, body: '@codex review', headOid: HEAD, notBefore: null, createdAt: minutesAgo(1) };
		assert.equal(postedNotices([entry], [mineNeedsCodex()])[0].title, 'Requested Codex');
	});
});

describe('claude settings', () => {
	it('fills the prompt template', () => {
		const c = parseConfig({ repos: ['acme/api'], claude: { prompt: '/triage {repo}#{number} {url}' } });
		assert.equal(claudePrompt(c, makePr()), '/triage acme/api#42 https://github.com/acme/api/pull/42');
	});

	it('accepts local paths per repo', () => {
		const c = parseConfig({ repos: ['acme/api'], localPaths: { 'Acme/API': '~/code/api' } });
		assert.equal(c.localPaths['acme/api'], '~/code/api');
		assert.throws(() => parseConfig({ repos: ['acme/api'], localPaths: { 'acme/api': 1 } }), /folder path/);
	});
});
