import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { stateDir } from '../paths.ts';
import { short } from '../util.ts';

const execFileAsync = promisify(execFile);

export class GitError extends Error {}

async function git(cwd: string, args: string[]): Promise<string> {
	try {
		const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { maxBuffer: 16 * 1024 * 1024 });
		return stdout.trim();
	} catch (error) {
		const err = error as { stderr?: string; message: string };
		throw new GitError((err.stderr || err.message).trim());
	}
}

const succeeds = (cwd: string, args: string[]): Promise<boolean> => git(cwd, args).then(() => true, () => false);

export interface RebaseTarget {
	repo: string;
	number: number;
	baseRef: string;
	headRef: string;
	/** The head commit the approvals are for. Nothing is pushed if origin moved past it. */
	headOid: string;
}

export type RebaseResult =
	| { kind: 'up_to_date'; headOid: string }
	| { kind: 'pushed'; headOid: string; from: string }
	| { kind: 'would_push'; from: string }
	| { kind: 'conflict'; worktree: string; files: string[] };

/** Where a PR's worktree lives while it is being rebased. */
export const worktreeDir = (target: { repo: string; number: number }): string =>
	join(stateDir(), 'worktrees', `${target.repo.toLowerCase().replace('/', '__')}-${target.number}`);

/** Remembers which head a worktree was started from, so a resolved rebase can be pushed later. */
const markerFile = (dir: string): string => `${dir}.json`;

interface Marker {
	headOid: string;
	baseRef: string;
	headRef: string;
}

async function rebaseInProgress(dir: string): Promise<boolean> {
	const gitDir = await git(dir, ['rev-parse', '--git-dir']);
	const abs = gitDir.startsWith('/') ? gitDir : join(dir, gitDir);
	return existsSync(join(abs, 'rebase-merge')) || existsSync(join(abs, 'rebase-apply'));
}

export async function removeWorktree(clone: string, dir: string): Promise<void> {
	if (existsSync(dir)) await git(clone, ['worktree', 'remove', '--force', dir]).catch(() => rmSync(dir, { recursive: true, force: true }));
	await git(clone, ['worktree', 'prune']).catch(() => undefined);
	rmSync(markerFile(dir), { force: true });
}

async function push(dir: string, target: RebaseTarget): Promise<string> {
	// The lease makes the push fail if someone pushed to the branch since the approvals.
	await git(dir, ['push', `--force-with-lease=refs/heads/${target.headRef}:${target.headOid}`, 'origin', `HEAD:refs/heads/${target.headRef}`]);
	return git(dir, ['rev-parse', 'HEAD']);
}

/**
 * Rebases the PR's branch onto its base in a worktree of `clone`, so the working
 * copy is never touched, and force-pushes it with a lease. On conflicts the worktree
 * is kept with the rebase in progress; once resolved there, running this again pushes it.
 */
export async function rebaseOntoBase(clone: string, target: RebaseTarget, options: { dryRun: boolean }): Promise<RebaseResult> {
	if (!existsSync(join(clone, '.git'))) throw new GitError(`${clone} is not a git clone`);
	const base = `refs/remotes/origin/${target.baseRef}`;
	const head = `refs/remotes/origin/${target.headRef}`;
	await git(clone, ['fetch', '--quiet', 'origin', `+refs/heads/${target.baseRef}:${base}`, `+refs/heads/${target.headRef}:${head}`]);

	const originHead = await git(clone, ['rev-parse', head]);
	if (originHead !== target.headOid) {
		throw new GitError(`${target.headRef} on origin is at ${short(originHead)}, not the approved ${short(target.headOid)}. Refresh and try again.`);
	}

	const dir = worktreeDir(target);
	if (existsSync(dir)) {
		const marker = existsSync(markerFile(dir)) ? (JSON.parse(readFileSync(markerFile(dir), 'utf8')) as Marker) : null;
		if (await rebaseInProgress(dir)) {
			const files = (await git(dir, ['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean);
			return { kind: 'conflict', worktree: dir, files };
		}
		const resolved =
			marker?.headOid === target.headOid &&
			(await git(dir, ['rev-parse', 'HEAD'])) !== target.headOid &&
			(await succeeds(dir, ['merge-base', '--is-ancestor', base, 'HEAD']));
		if (resolved) {
			if (options.dryRun) return { kind: 'would_push', from: target.headOid };
			const pushed = await push(dir, target);
			await removeWorktree(clone, dir);
			return { kind: 'pushed', headOid: pushed, from: target.headOid };
		}
		await removeWorktree(clone, dir);
	}

	if (await succeeds(clone, ['merge-base', '--is-ancestor', base, target.headOid])) return { kind: 'up_to_date', headOid: target.headOid };
	if (options.dryRun) return { kind: 'would_push', from: target.headOid };

	mkdirSync(join(stateDir(), 'worktrees'), { recursive: true });
	await git(clone, ['worktree', 'add', '--quiet', '--detach', dir, target.headOid]);
	writeFileSync(markerFile(dir), JSON.stringify({ headOid: target.headOid, baseRef: target.baseRef, headRef: target.headRef } satisfies Marker));
	try {
		await git(dir, ['rebase', '--quiet', base]);
	} catch (error) {
		if (await rebaseInProgress(dir)) {
			const files = (await git(dir, ['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean);
			return { kind: 'conflict', worktree: dir, files };
		}
		await removeWorktree(clone, dir);
		throw error;
	}
	const pushed = await push(dir, target);
	await removeWorktree(clone, dir);
	return { kind: 'pushed', headOid: pushed, from: target.headOid };
}
