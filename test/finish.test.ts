import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { parseConfig } from '../src/config.ts';
import { cardUpdate, mentionsPr, schemaProblems, statusForBase } from '../src/finish/notion.ts';
import type { Schema } from '../src/finish/notion.ts';
import { decideFinish } from '../src/finish/queue.ts';
import type { FinishEntry } from '../src/finish/queue.ts';
import { rebaseOntoBase, worktreeDir } from '../src/finish/rebase.ts';
import { renderMenu } from '../src/swiftbar.ts';
import { assess } from '../src/turn.ts';
import { HEAD, NOW, check, config, makePr, minutesAgo, review } from './fixtures.ts';

/** Synthetic data only. */

const tracker = parseConfig({
	repos: ['acme/api'],
	tracker: {
		kind: 'notion',
		dataSourceId: 'ds-1',
		prProperty: 'PR',
		statusProperty: 'Stage',
		commitProperty: 'Commit',
		statusByBase: { develop: 'Done (dev)', 'hotfix/*': 'Done (hotfix)' },
	},
}).tracker;

const schema: Schema = {
	dataSourceId: 'ds-1',
	properties: {
		PR: { type: 'url', options: [] },
		Stage: { type: 'status', options: ['In progress', 'Done (dev)', 'Done (hotfix)'] },
		Commit: { type: 'rich_text', options: [] },
	},
};

describe('tracker config', () => {
	it('defaults to no tracker', () => {
		assert.equal(config.tracker.kind, 'none');
		assert.equal(config.finish.mergeMethod, 'merge');
	});
	it('needs a data source for Notion and a known merge method', () => {
		assert.throws(() => parseConfig({ repos: ['acme/api'], tracker: { kind: 'notion' } }), /dataSourceId/);
		assert.throws(() => parseConfig({ repos: ['acme/api'], finish: { mergeMethod: 'octopus' } }), /mergeMethod/);
		assert.throws(() => parseConfig({ repos: ['acme/api'], tracker: { statusByBase: { develop: 1 } } }), /statusByBase/);
	});
});

describe('statusForBase', () => {
	it('prefers an exact branch and falls back to patterns', () => {
		assert.equal(statusForBase(tracker.statusByBase, 'develop'), 'Done (dev)');
		assert.equal(statusForBase(tracker.statusByBase, 'hotfix/login'), 'Done (hotfix)');
		assert.equal(statusForBase(tracker.statusByBase, 'main'), null);
		assert.equal(statusForBase({ 'release.*': 'x' }, 'releaseX1'), null, 'dots are literal');
	});
});

describe('mentionsPr', () => {
	it('matches the PR and not one whose number starts the same', () => {
		assert.ok(mentionsPr('https://github.com/acme/api/pull/12', 'acme/api', 12));
		assert.ok(mentionsPr('[https://github.com/Acme/my\\_api/pull/12](https://github.com/acme/my_api/pull/12)', 'acme/my_api', 12));
		assert.ok(!mentionsPr('https://github.com/acme/api/pull/123', 'acme/api', 12));
		assert.ok(!mentionsPr('https://github.com/acme/web/pull/12', 'acme/api', 12));
	});
});

describe('schemaProblems', () => {
	it('accepts matching properties and options', () => {
		assert.deepEqual(schemaProblems(schema, tracker), []);
	});
	it('names missing properties, wrong types and unknown options', () => {
		const broken: Schema = { dataSourceId: 'ds-1', properties: { PR: { type: 'number', options: [] }, Stage: { type: 'select', options: ['Done (dev)'] } } };
		const problems = schemaProblems(broken, tracker);
		assert.ok(problems.some((p) => /"PR" is a number property/.test(p)));
		assert.ok(problems.some((p) => /no property "Commit"/.test(p)));
		assert.ok(problems.some((p) => /no option "Done \(hotfix\)"/.test(p)));
	});
});

describe('cardUpdate', () => {
	it('sets the status by its type and the commit as text', () => {
		assert.deepEqual(cardUpdate(schema, tracker, 'Done (dev)', 'abc123'), {
			properties: { Stage: { status: { name: 'Done (dev)' } }, Commit: { rich_text: [{ type: 'text', text: { content: 'abc123' } }] } },
		});
	});
	it('leaves the status alone when the base has no mapping', () => {
		assert.deepEqual(Object.keys((cardUpdate(schema, tracker, null, 'abc123').properties as object)), ['Commit']);
	});
});

describe('decideFinish', () => {
	const entry = (overrides: Partial<FinishEntry> = {}): FinishEntry => ({
		repo: 'acme/api',
		number: 42,
		url: 'https://github.com/acme/api/pull/42',
		baseRef: 'develop',
		headRef: 'feature/thing',
		headOid: HEAD,
		isCrossRepository: false,
		pushed: true,
		createdAt: minutesAgo(10),
		...overrides,
	});
	const ci = (conclusion: string | null, status = 'COMPLETED') => check({ name: 'tests', conclusion, status });

	it('merges once CI passes', () => {
		assert.equal(decideFinish(entry(), makePr({ checkRuns: [ci('SUCCESS')] }), config, NOW).decision, 'merge');
	});
	it('waits while CI runs or has not started right after the push', () => {
		assert.equal(decideFinish(entry(), makePr({ checkRuns: [ci(null, 'IN_PROGRESS')] }), config, NOW).why, 'waiting for CI');
		assert.equal(decideFinish(entry({ createdAt: minutesAgo(1) }), makePr({ checkRuns: [] }), config, NOW).why, 'waiting for CI to start');
		assert.equal(decideFinish(entry(), makePr({ checkRuns: [] }), config, NOW).decision, 'merge', 'a repo without CI merges after the grace');
	});
	it('drops on a failed CI, another push, a conflict or a closed PR', () => {
		assert.match(decideFinish(entry(), makePr({ checkRuns: [ci('FAILURE')] }), config, NOW).why, /CI failed/);
		assert.match(decideFinish(entry(), makePr({ headOid: 'c'.repeat(40) }), config, NOW).why, /pushed/);
		assert.match(decideFinish(entry(), makePr({ mergeable: 'CONFLICTING' }), config, NOW).why, /conflict/);
		assert.equal(decideFinish(entry(), undefined, config, NOW).decision, 'drop');
	});
	it('waits for GitHub to compute mergeability', () => {
		assert.equal(decideFinish(entry(), makePr({ checkRuns: [ci('SUCCESS')], mergeable: 'UNKNOWN' }), config, NOW).decision, 'keep');
	});
});

describe('renderMenu Finish', () => {
	const ctx = { plugin: '/tmp/wpr.1m.sh', now: NOW, viewer: 'alice', queued: 0, config };
	const done = assess(makePr({ checkRuns: [check()], reviews: [review('coderabbitai', HEAD, 10, 'APPROVED'), review('bob', HEAD, 5, 'APPROVED')] }), config, 'alice', NOW);

	it('offers Finish on my approved PR when the repo has a clone', () => {
		assert.ok(done.done);
		assert.match(renderMenu([done], { ...ctx, finishRepos: ['acme/api'] }), /Finish: rebase, merge and update the card .*param1="finish" .*terminal=true/);
		assert.doesNotMatch(renderMenu([done], ctx), /Finish:/);
	});
	it('says it is finishing while queued', () => {
		const out = renderMenu([done], { ...ctx, finishRepos: ['acme/api'], finishing: [{ repo: 'acme/api', number: 42 }] });
		assert.match(out, /Finishing: merges when CI passes/);
		assert.doesNotMatch(out, /Finish: rebase/);
	});
});

describe('rebaseOntoBase', () => {
	let root: string;
	let origin: string;
	let clone: string;
	const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
	const commit = (cwd: string, file: string, text: string) => {
		writeFileSync(join(cwd, file), text);
		git(cwd, 'add', file);
		git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', `${file}: ${text}`);
	};
	const saved = process.env.GH_WPR_STATE_DIR;

	before(() => {
		root = mkdtempSync(join(tmpdir(), 'wpr-rebase-'));
		process.env.GH_WPR_STATE_DIR = join(root, 'state');
		origin = join(root, 'origin.git');
		execFileSync('git', ['init', '-q', '--bare', '-b', 'develop', origin]);
		clone = join(root, 'clone');
		execFileSync('git', ['clone', '-q', origin, clone]);
		git(clone, 'config', 'user.name', 't');
		git(clone, 'config', 'user.email', 't@example.com');
		commit(clone, 'a.txt', 'one');
		git(clone, 'push', '-q', 'origin', 'HEAD:develop');
	});
	after(() => {
		if (saved === undefined) delete process.env.GH_WPR_STATE_DIR;
		else process.env.GH_WPR_STATE_DIR = saved;
	});

	const branch = (name: string, file: string, text: string) => {
		git(clone, 'switch', '-q', '-c', name, 'origin/develop');
		commit(clone, file, text);
		git(clone, 'push', '-q', 'origin', `HEAD:${name}`);
		const oid = git(clone, 'rev-parse', 'HEAD');
		git(clone, 'switch', '-q', '--detach');
		return oid;
	};
	const advanceBase = (file: string, text: string) => {
		git(clone, 'switch', '-q', '--detach', 'origin/develop');
		commit(clone, file, text);
		git(clone, 'push', '-q', 'origin', 'HEAD:develop');
		git(clone, 'fetch', '-q');
	};

	it('does nothing when the branch is already on top of its base', async () => {
		const oid = branch('feature/fresh', 'b.txt', 'x');
		const result = await rebaseOntoBase(clone, { repo: 'acme/api', number: 1, baseRef: 'develop', headRef: 'feature/fresh', headOid: oid }, { dryRun: false });
		assert.deepEqual(result, { kind: 'up_to_date', headOid: oid });
	});

	it('rebases in a worktree and force-pushes with a lease', async () => {
		const oid = branch('feature/behind', 'c.txt', 'x');
		advanceBase('d.txt', 'y');
		const target = { repo: 'acme/api', number: 2, baseRef: 'develop', headRef: 'feature/behind', headOid: oid };
		assert.equal((await rebaseOntoBase(clone, target, { dryRun: true })).kind, 'would_push');
		const result = await rebaseOntoBase(clone, target, { dryRun: false });
		assert.equal(result.kind, 'pushed');
		const pushed = execFileSync('git', ['-C', origin, 'rev-parse', 'feature/behind'], { encoding: 'utf8' }).trim();
		assert.equal(result.kind === 'pushed' && result.headOid, pushed);
		execFileSync('git', ['-C', origin, 'merge-base', '--is-ancestor', 'develop', 'feature/behind']);
		assert.ok(!existsSync(worktreeDir(target)), 'the worktree is removed');
	});

	it('refuses when origin moved past the approved commit', async () => {
		const oid = branch('feature/moved', 'e.txt', 'x');
		git(clone, 'switch', '-q', 'feature/moved');
		commit(clone, 'e.txt', 'later');
		git(clone, 'push', '-q', 'origin', 'HEAD:feature/moved');
		git(clone, 'switch', '-q', '--detach');
		await assert.rejects(
			rebaseOntoBase(clone, { repo: 'acme/api', number: 3, baseRef: 'develop', headRef: 'feature/moved', headOid: oid }, { dryRun: false }),
			/not the approved/,
		);
	});

	it('keeps the worktree on conflicts and pushes once they are resolved', async () => {
		const oid = branch('feature/clash', 'a.txt', 'branch side');
		advanceBase('a.txt', 'base side');
		const target = { repo: 'acme/api', number: 4, baseRef: 'develop', headRef: 'feature/clash', headOid: oid };
		const result = await rebaseOntoBase(clone, target, { dryRun: false });
		assert.equal(result.kind, 'conflict');
		assert.deepEqual(result.kind === 'conflict' && result.files, ['a.txt']);
		assert.equal(execFileSync('git', ['-C', origin, 'rev-parse', 'feature/clash'], { encoding: 'utf8' }).trim(), oid, 'nothing pushed');

		const again = await rebaseOntoBase(clone, target, { dryRun: false });
		assert.equal(again.kind, 'conflict', 'still unresolved');

		const dir = worktreeDir(target);
		writeFileSync(join(dir, 'a.txt'), 'both sides');
		git(dir, 'add', 'a.txt');
		execFileSync('git', ['-C', dir, '-c', 'core.editor=true', 'rebase', '--continue'], { stdio: 'ignore' });
		const done = await rebaseOntoBase(clone, target, { dryRun: false });
		assert.equal(done.kind, 'pushed');
		execFileSync('git', ['-C', origin, 'merge-base', '--is-ancestor', 'develop', 'feature/clash']);
	});
});
