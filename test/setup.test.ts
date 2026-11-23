import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { findCheckouts, repoFromRemote, tildify } from '../src/checkouts.ts';
import { buildConfig } from '../src/config.ts';
import { localChecks, onPath, setupIssues } from '../src/doctor.ts';
import { renderMenu } from '../src/swiftbar.ts';
import { combineTeamFiles, layer, parseTeamFile, TeamFileError } from '../src/team.ts';
import type { TeamFile } from '../src/team.ts';
import { assess } from '../src/turn.ts';
import { NOW, OLD, check, codexSummary, config, makePr } from './fixtures.ts';

/** Synthetic data only. */

const found = (repo: string, settings: Record<string, unknown>): TeamFile => ({ repo, status: 'found', fetchedAt: NOW.toISOString(), settings });

describe('parseTeamFile', () => {
	it('accepts team settings', () => {
		assert.deepEqual(parseTeamFile({ team: ['alice'], nudge: { mode: 'comment' } }), { team: ['alice'], nudge: { mode: 'comment' } });
	});
	it('rejects personal settings with a hint', () => {
		assert.throws(() => parseTeamFile({ localPaths: {} }), (e: Error) => e instanceof TeamFileError && /personal setting/.test(e.message));
		assert.throws(() => parseTeamFile({ repos: ['acme/api'] }), /personal setting/);
	});
	it('rejects unknown settings and non-objects', () => {
		assert.throws(() => parseTeamFile({ token: 'x' }), /unknown setting "token"/);
		assert.throws(() => parseTeamFile([]), /JSON object/);
	});
});

describe('layer', () => {
	it('lets later layers win, merging objects one level deep', () => {
		const out = layer({ team: ['a'], codex: { enabled: true, timeoutMinutes: 15 } }, { codex: { enabled: false } });
		assert.deepEqual(out, { team: ['a'], codex: { enabled: false, timeoutMinutes: 15 } });
	});
	it('replaces lists instead of joining them', () => {
		assert.deepEqual(layer({ team: ['a', 'b'] }, { team: ['c'] }), { team: ['c'] });
	});
});

describe('combineTeamFiles', () => {
	it('lets the first repo win and reports what repos disagree on', () => {
		const { settings, conflicts } = combineTeamFiles([
			found('acme/api', { team: ['alice', 'bob'], nudge: { mode: 'comment' } }),
			found('acme/web', { team: ['alice', 'bob'], nudge: { mode: 'request', comment: '{mentions} please' } }),
		]);
		assert.deepEqual(settings, { team: ['alice', 'bob'], nudge: { mode: 'comment', comment: '{mentions} please' } });
		assert.deepEqual(conflicts, ['nudge.mode']);
	});
	it('ignores files that were not found', () => {
		const absent: TeamFile = { repo: 'acme/web', status: 'absent', fetchedAt: NOW.toISOString() };
		assert.deepEqual(combineTeamFiles([absent]).settings, {});
	});
});

describe('buildConfig', () => {
	it('puts personal settings on top of the team file', () => {
		const { config: c, teamFiles } = buildConfig(
			{ repos: ['acme/api'], coderabbit: { stuckAfterMinutes: 60 } },
			[found('acme/api', { team: ['alice', 'bob'], coderabbit: { stuckAfterMinutes: 45, checkName: 'Review' } })],
			['acme/api'],
		);
		assert.deepEqual(c.team, ['alice', 'bob']);
		assert.equal(c.coderabbit.stuckAfterMinutes, 60);
		assert.equal(c.coderabbit.checkName, 'Review');
		assert.equal(teamFiles[0].status, 'found');
	});
	it('leaves out a team file with a wrong value instead of failing', () => {
		const { config: c, teamFiles } = buildConfig(
			{ repos: ['acme/api'], team: ['alice'] },
			[found('acme/api', { nudge: { mode: 'shout' } })],
			['acme/api'],
		);
		assert.equal(c.nudge.mode, 'request');
		assert.equal(teamFiles[0].status, 'invalid');
		assert.match(teamFiles[0].error ?? '', /nudge\.mode/);
	});
	it('marks repos whose team file was never fetched', () => {
		const { teamFiles } = buildConfig({ repos: ['acme/api'] }, [null], ['acme/api']);
		assert.equal(teamFiles[0].missing, true);
	});
});

describe('repoFromRemote', () => {
	it('reads https, ssh and scp-like URLs', () => {
		assert.equal(repoFromRemote('https://github.com/Acme/API.git'), 'acme/api');
		assert.equal(repoFromRemote('git@github.com:acme/api.git'), 'acme/api');
		assert.equal(repoFromRemote('ssh://git@github.com/acme/api'), 'acme/api');
		assert.equal(repoFromRemote('https://github.com/acme/api/\n'), 'acme/api');
	});
	it('returns null for something else', () => {
		assert.equal(repoFromRemote('/some/local/path'), null);
	});
});

describe('tildify', () => {
	it('shortens paths under home only', () => {
		assert.equal(tildify('/home/me/code/api', '/home/me'), '~/code/api');
		assert.equal(tildify('/home/meme/api', '/home/me'), '/home/meme/api');
	});
});

describe('findCheckouts', () => {
	it('finds clones by origin a few levels deep', () => {
		const root = mkdtempSync(join(tmpdir(), 'wpr-checkouts-'));
		const clone = join(root, 'work', 'team', 'api');
		mkdirSync(clone, { recursive: true });
		execFileSync('git', ['init', '-q', clone]);
		execFileSync('git', ['-C', clone, 'remote', 'add', 'origin', 'git@github.com:acme/api.git']);
		const other = join(root, 'other');
		mkdirSync(other);
		execFileSync('git', ['init', '-q', other]);
		execFileSync('git', ['-C', other, 'remote', 'add', 'origin', 'git@github.com:acme/web.git']);

		const shallowFirst = [
			{ dir: root, depth: 1 },
			{ dir: root, depth: 3 },
		];
		const result = findCheckouts(['acme/api'], shallowFirst);
		assert.deepEqual(result.get('acme/api'), [clone]);
		assert.equal(result.has('acme/web'), false);
	});
});

describe('onPath', () => {
	it('finds executables on PATH or by path', () => {
		const dir = mkdtempSync(join(tmpdir(), 'wpr-path-'));
		const bin = join(dir, 'fake-claude');
		writeFileSync(bin, '#!/bin/sh\n');
		chmodSync(bin, 0o755);
		assert.equal(onPath('fake-claude --model x', dir), true);
		assert.equal(onPath(bin, ''), true);
		assert.equal(onPath('not-there', dir), false);
	});
});

describe('localChecks', () => {
	it('flags an invalid team file, a missing claude and missing clones', () => {
		const loaded = buildConfig({ repos: ['acme/api'], claude: { command: 'definitely-not-installed-xyz' } }, [found('acme/api', { nudge: { mode: 'shout' } })], ['acme/api']);
		const checks = localChecks(loaded, { path: '' });
		assert.equal(checks.find((c) => c.feature.startsWith('Team settings'))?.state, 'error');
		assert.equal(checks.find((c) => c.feature === 'Claude Code')?.state, 'warn');
		assert.equal(checks.find((c) => c.feature === 'Finish PR')?.state, 'warn');
		assert.equal(setupIssues(checks), 3);
	});
	it('treats a repo without team file as optional', () => {
		const absent: TeamFile = { repo: 'acme/api', status: 'absent', fetchedAt: NOW.toISOString() };
		const checks = localChecks(buildConfig({ repos: ['acme/api'] }, [absent], ['acme/api']), { path: '' });
		assert.equal(checks[0].state, 'off');
	});
});

describe('renderMenu setup footer', () => {
	const ctx = { plugin: '/tmp/wpr.1m.sh', now: NOW, viewer: 'alice', queued: 0, config };
	const mine = assess(makePr({ checkRuns: [check()], comments: [codexSummary(OLD, 'completed', 90)] }), config, 'alice', NOW);

	it('shows how many features need setting up and opens doctor', () => {
		const out = renderMenu([], { ...ctx, setupIssues: 2 });
		assert.match(out, /^2 features not set up \| sfimage=gearshape .*param1="doctor" terminal=true/m);
	});
	it('shows nothing when everything is set up', () => {
		assert.doesNotMatch(renderMenu([], { ...ctx, setupIssues: 0 }), /not set up/);
	});
	it('hides the Claude Code action when claude cannot be run', () => {
		const withClaude = renderMenu([mine], ctx);
		const without = renderMenu([mine], { ...ctx, claudeAvailable: false });
		assert.equal(mine.group, 'author');
		assert.match(withClaude, /Triage comments with Claude Code/);
		assert.doesNotMatch(without, /Triage comments with Claude Code/);
	});
});
