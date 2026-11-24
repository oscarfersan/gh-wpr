import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { claudePrompt } from '../src/commands/claude.ts';
import { nudgeComment } from '../src/commands/nudge.ts';
import { parseConfig } from '../src/config.ts';
import { notices, postedNotices, remember, snippet } from '../src/notify.ts';
import { menuText, renderError, renderMenu } from '../src/swiftbar.ts';
import { assess } from '../src/turn.ts';
import type { Assessment } from '../src/turn.ts';
import { HEAD, NOW, OLD, check, codexSummary, codexThumbsUp, comment, config, crRateLimited, crRunning, makePr, minutesAgo, review, thread as makeThread } from './fixtures.ts';

const ctx = { plugin: '/Users/me/Library/Application Support/SwiftBar/wpr.1m.sh', now: NOW, viewer: 'alice', queued: 0, config };

const mineNeedsCodex = (): Assessment =>
	assess(makePr({ checkRuns: [check()], comments: [codexSummary(OLD, 'completed', 90)] }), config, 'alice', NOW);
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
		assert.match(out, /--Triage comments with Claude Code .*param1="terminal" param2="claude".*terminal=false/);
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

	it('makes every info line clickable so SwiftBar does not grey it out', () => {
		const out = renderMenu([mineNeedsCodex()], ctx);
		for (const line of out.split('\n').filter((l) => /^(#|--[^-])/.test(l))) assert.match(line, /(href|bash)=/, line);
	});

	it('links the reason to the open thread', () => {
		const a = assess(makePr({ checkRuns: [check()], threads: [makeThread('coderabbitai', 'coderabbitai')] }), config, 'alice', NOW);
		const out = renderMenu([a], ctx);
		assert.ok(out.includes('--alice · 1 open CodeRabbit thread waiting for you | size=12 href=https://github.com/acme/api/pull/42#discussion_coderabbitai'));
	});

	it('lists each thread when there are several', () => {
		const a = assess(
			makePr({ checkRuns: [check()], threads: [makeThread('coderabbitai', 'coderabbitai'), makeThread('bob', 'bob', { path: 'src/a/b/c.ts' })] }),
			config,
			'alice',
			NOW,
		);
		const out = renderMenu([a], ctx);
		assert.ok(out.includes('----CodeRabbit · service/repository.ts | size=12 href='));
		assert.ok(out.includes('----bob · b/c.ts | size=12 href=https://github.com/acme/api/pull/42#discussion_bob'));
	});

	it('offers asking again once both bots are done', () => {
		const done = assess(makePr({ checkRuns: [check()], comments: [codexSummary(HEAD, 'completed', 5)] }), config, 'alice', NOW);
		const out = renderMenu([done], ctx);
		assert.ok(!out.includes('--Request AI review |'));
		assert.ok(out.includes('--Request AI review again'));
		assert.match(out, /----CodeRabbit, then Codex \| .*param3="--force"/);
		assert.match(out, /----Only Codex \| .*param3="--bot" param4="codex" param5="--force"/);
	});

	it('does not offer asking again while a bot is busy or the PR has conflicts', () => {
		const busy = assess(makePr({ checkRuns: [crRunning(2)] }), config, 'alice', NOW);
		const conflicts = assess(makePr({ number: 43, mergeable: 'CONFLICTING', checkRuns: [check()] }), config, 'alice', NOW);
		assert.ok(!renderMenu([busy, conflicts], ctx).includes('Request AI review again'));
	});

	it('renders errors as a warning icon', () => {
		assert.match(renderError('No config'), /^⚠︎ \| sfimage=exclamationmark\.triangle\n---\nNo config/);
	});
});

describe('review buttons', () => {
	it('asks my reviewer by name until they approve', () => {
		const a = assess(makePr({ checkRuns: [check()], requestedReviewers: ['bob'] }), config, 'alice', NOW);
		assert.match(renderMenu([a], ctx), /--Ask bob to review \| sfimage=bell .*param1="nudge"/);
		const approved = assess(makePr({ checkRuns: [check()], reviews: [review('bob', HEAD, 5, 'APPROVED')] }), config, 'alice', NOW);
		assert.ok(!renderMenu([approved], ctx).includes('to review |'));
	});

	it('does not offer it on drafts or on other people\'s PRs', () => {
		const draft = assess(makePr({ isDraft: true, requestedReviewers: ['bob'] }), config, 'alice', NOW);
		assert.ok(!renderMenu([draft, reviewForBob()], ctx).includes('to review |'));
	});

	it('builds the comment from the configured template', () => {
		const withComment = parseConfig({ repos: ['acme/api'], nudge: { mode: 'comment', comment: '{mentions} review' } });
		assert.equal(nudgeComment(withComment, ['bob']), '@bob review');
		assert.equal(nudgeComment(withComment, ['bob', 'carol']), '@bob @carol review');
	});

	it('rejects a comment that does not say who should review', () => {
		assert.throws(() => parseConfig({ repos: ['acme/api'], nudge: { mode: 'comment', comment: 'please review' } }), /\{mentions\}/);
		assert.throws(() => parseConfig({ repos: ['acme/api'], nudge: { mode: 'shout' } }), /nudge.mode/);
	});

	it('offers asking CodeRabbit again when it reviewed the head without approving, even with Codex pending', () => {
		const pr = makePr({ checkRuns: [check()], comments: [codexSummary(OLD, 'completed', 90)], reviews: [review('coderabbitai', OLD, 95, 'APPROVED')] });
		const out = renderMenu([assess(pr, config, 'alice', NOW)], ctx);
		assert.ok(out.includes('--Request AI review |'));
		assert.match(out, /--Ask CodeRabbit to review again .*param2="https:\/\/github.com\/acme\/api\/pull\/42" param3="--bot" param4="coderabbit" param5="--force"/);
	});

	it('offers scheduling the retry and asking CodeRabbit now while it is rate limited', () => {
		const out = renderMenu([assess(makePr({ checkRuns: [crRateLimited(2)] }), config, 'alice', NOW)], ctx);
		assert.ok(out.includes('--Request AI review |'));
		assert.match(out, /--Ask CodeRabbit now, ignoring the rate limit .*param3="--bot" param4="coderabbit" param5="--force"/);
	});

	it('does not offer asking CodeRabbit again once it approved the head', () => {
		const pr = makePr({ checkRuns: [check()], comments: [codexSummary(OLD, 'completed', 90)], reviews: [review('coderabbitai', HEAD, 5, 'APPROVED')] });
		assert.ok(!renderMenu([assess(pr, config, 'alice', NOW)], ctx).includes('Ask CodeRabbit to review again'));
	});
});

describe('notices', () => {
	it('stays quiet on the first refresh', () => {
		assert.deepEqual(notices(null, [reviewForBob()], 'alice', config), []);
	});

	it('announces a PR that became yours to review', () => {
		const before = remember([], 'alice', config);
		const out = notices(before, [reviewForBob(9)], 'alice', config);
		assert.equal(out.length, 1);
		assert.equal(out[0].title, 'Your turn to review');
	});

	it('does not repeat a notice for the same state', () => {
		const items = [reviewForBob()];
		assert.deepEqual(notices(remember(items, 'alice', config), items, 'alice', config), []);
	});

	it('announces when Codex approves my PR', () => {
		const running = assess(makePr({ checkRuns: [check()], comments: [comment('alice', '@codex review', 3)] }), config, 'alice', NOW);
		const done = assess(makePr({ checkRuns: [check()], comments: [codexSummary(HEAD, 'completed', 1)], reactions: [codexThumbsUp(1)] }), config, 'alice', NOW);
		const out = notices(remember([running], 'alice', config), [done], 'alice', config);
		assert.ok(out.some((n) => n.title === 'Codex approved 👍'));
	});

	it('announces when Codex finds issues on my PR', () => {
		const running = assess(makePr({ checkRuns: [check()], comments: [comment('alice', '@codex review', 3)] }), config, 'alice', NOW);
		const done = assess(makePr({ checkRuns: [check()], reviews: [review('chatgpt-codex-connector', HEAD, 1, 'COMMENTED', '### 💡 Codex Review')] }), config, 'alice', NOW);
		assert.ok(notices(remember([running], 'alice', config), [done], 'alice', config).some((n) => n.title === 'Codex found issues'));
	});

	it('waits for the verdict while only the summary says Codex finished', () => {
		const running = assess(makePr({ checkRuns: [check()], comments: [comment('alice', '@codex review', 3)] }), config, 'alice', NOW);
		const summary = assess(makePr({ checkRuns: [check()], comments: [codexSummary(HEAD, 'completed', 1)] }), config, 'alice', NOW);
		assert.ok(!notices(remember([running], 'alice', config), [summary], 'alice', config).some((n) => n.title.startsWith('Codex')));
	});

	it('does not announce Codex for a review of an older push', () => {
		const old = assess(makePr({ headOid: OLD, checkRuns: [check()], comments: [comment('alice', '@codex review', 3)] }), config, 'alice', NOW);
		const done = assess(makePr({ checkRuns: [check()], reactions: [codexThumbsUp(1)], reviews: [review('bob', OLD, 90)] }), config, 'alice', NOW);
		assert.ok(!notices(remember([old], 'alice', config), [done], 'alice', config).some((n) => n.title.startsWith('Codex')));
	});

	it('announces when my PR gets all three approves', () => {
		const approvedByBots = { checkRuns: [check()], reactions: [codexThumbsUp(4)], reviews: [review('coderabbitai', HEAD, 10, 'APPROVED')] };
		const before = assess(makePr(approvedByBots), config, 'alice', NOW);
		const after = assess(makePr({ ...approvedByBots, reviews: [...approvedByBots.reviews, review('bob', HEAD, 1, 'APPROVED')] }), config, 'alice', NOW);
		assert.ok(notices(remember([before], 'alice', config), [after], 'alice', config).some((n) => n.title === 'Approved by everyone'));
	});

	it('shows the Notion AI state instead of the bots on drafts', () => {
		const a = assess(makePr({ isDraft: true }), config, 'alice', NOW);
		const out = renderMenu([a], ctx);
		assert.ok(out.includes('Notion AI: not reviewed yet'));
		assert.ok(!out.includes('CodeRabbit:'));
		assert.match(out.split('\n')[0], /^  \| /, 'a draft is not your turn');
	});

	it('describes requests posted from the queue', () => {
		const entry = { repo: 'acme/api', number: 42, bot: 'codex' as const, body: '@codex review', headOid: HEAD, notBefore: null, createdAt: minutesAgo(1) };
		assert.equal(postedNotices([entry], [mineNeedsCodex()])[0].title, 'Requested Codex');
	});
});

describe('activity notices', () => {
	const mine = (reviews = [] as ReturnType<typeof review>[], comments = [] as ReturnType<typeof comment>[]) =>
		assess(makePr({ checkRuns: [check()], comments: [codexSummary(HEAD, 'completed', 50), ...comments], reviews }), config, 'alice', NOW);

	it('announces an approval on my PR', () => {
		const before = remember([mine()], 'alice', config);
		const out = notices(before, [mine([review('bob', HEAD, 1, 'APPROVED', 'Looks good')])], 'alice', config);
		assert.deepEqual(out.map((n) => n.title), ['bob approved #42']);
		assert.match(out[0].body, /bob: Looks good/);
	});

	it('announces requested changes', () => {
		const out = notices(remember([mine()], 'alice', config), [mine([review('bob', HEAD, 1, 'CHANGES_REQUESTED')])], 'alice', config);
		assert.equal(out[0].title, 'bob requested changes on #42');
	});

	it('announces a new comment with a preview', () => {
		const out = notices(remember([mine()], 'alice', config), [mine([], [comment('bob', '**Why** not cache this?', 1)])], 'alice', config);
		assert.equal(out[0].title, 'bob commented on #42');
		assert.match(out[0].body, /bob: Why not cache this\?/);
	});

	it('names the most important event when several arrive at once', () => {
		const later = mine([review('bob', HEAD, 2, 'APPROVED')], [comment('bob', 'one nit left', 1)]);
		const out = notices(remember([mine()], 'alice', config), [later], 'alice', config);
		assert.equal(out.length, 1);
		assert.equal(out[0].title, 'bob approved #42');
		assert.match(out[0].body, /2 new comments and reviews/);
	});

	it('ignores my own comments and bots', () => {
		const later = mine([review('coderabbitai', HEAD, 1, 'COMMENTED')], [comment('alice', 'done', 1), comment('chatgpt-codex-connector', 'x', 1)]);
		assert.deepEqual(notices(remember([mine()], 'alice', config), [later], 'alice', config), []);
	});

	it('ignores requests addressed to the bots', () => {
		const later = mine([], [comment('bob', '@codex review', 2), comment('bob', '@coderabbitai full review', 1), comment('bob', '@CodeRabbitAI why?', 1)]);
		assert.deepEqual(notices(remember([mine()], 'alice', config), [later], 'alice', config), []);
	});

	it('ignores the author talking to bots in threads on their own PR', () => {
		const pr = (reviews: ReturnType<typeof review>[]) =>
			assess(makePr({ number: 8, author: 'bob', checkRuns: [check()], reviews: [review('alice', HEAD, 30, 'COMMENTED', 'ok'), ...reviews] }), config, 'alice', NOW);
		assert.deepEqual(notices(remember([pr([])], 'alice', config), [pr([review('bob', HEAD, 1)])], 'alice', config), []);
	});

	it('announces a reply in a thread I opened on someone else\'s PR', () => {
		const thread = (lastAuthor: string, lastAt: string) => makeThread('alice', lastAuthor, { lastAt, lastBody: 'Good catch, fixed' });
		const pr = (t: ReturnType<typeof thread>) =>
			assess(makePr({ number: 8, author: 'bob', checkRuns: [check()], reviews: [review('alice', HEAD, 30)], threads: [t], comments: [] }), config, 'alice', NOW);
		const out = notices(remember([pr(thread('alice', minutesAgo(30)))], 'alice', config), [pr(thread('bob', minutesAgo(1)))], 'alice', config);
		assert.equal(out[0].title, 'bob commented on #8');
		assert.match(out[0].body, /Good catch, fixed/);
	});

	it('announces inline comments on my PR even without a review body', () => {
		const out = notices(remember([mine()], 'alice', config), [mine([review('bob', HEAD, 1)])], 'alice', config);
		assert.equal(out[0].title, 'bob commented on #42');
	});

	it('only covers PRs I take part in', () => {
		const pr = (comments: ReturnType<typeof comment>[]) =>
			assess(makePr({ number: 8, author: 'bob', checkRuns: [check()], comments }), config, 'alice', NOW);
		const out = notices(remember([pr([])], 'alice', config), [pr([comment('carol', 'hi', 1)])], 'alice', config);
		assert.deepEqual(out, []);
	});

	it('tells the reviewer when the author answers', () => {
		const pr = (comments: ReturnType<typeof comment>[]) =>
			assess(makePr({ number: 8, author: 'bob', checkRuns: [check()], reviews: [review('alice', HEAD, 30)], comments }), config, 'alice', NOW);
		const out = notices(remember([pr([])], 'alice', config), [pr([comment('bob', 'Fixed in the last commit', 1)])], 'alice', config);
		assert.equal(out[0].title, 'bob commented on #8');
	});

	it('stays quiet when upgrading from a memory without activity', () => {
		const old = { 'acme/api#42': { group: 'author' as const, codex: 'reviewed' as const, headOid: HEAD } };
		assert.deepEqual(notices(old, [mine([review('bob', HEAD, 1, 'APPROVED')])], 'alice', config), []);
	});

	it('cleans comment previews', () => {
		assert.equal(snippet('<!-- x -->Hi `foo`\n```js\ncode\n```'), 'Hi foo [code]');
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
