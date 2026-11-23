import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** "owner/name" from a GitHub remote URL (https, ssh or scp-like), or null. */
export function repoFromRemote(url: string): string | null {
	const match = url.trim().match(/^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?[^/:]+[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
	return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
}

export function originOf(dir: string): string | null {
	try {
		const url = execFileSync('git', ['-C', dir, 'config', '--get', 'remote.origin.url'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
		return repoFromRemote(url);
	} catch {
		return null;
	}
}

/** Replaces the home folder with "~" so the config reads the same on every machine. */
export const tildify = (path: string, home = homedir()): string => (path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path);

export const expandHome = (path: string, home = homedir()): string => path.replace(/^~(?=\/|$)/, home);

const SKIP = new Set(['node_modules', 'Library', 'Applications', 'Pictures', 'Music', 'Movies', 'Downloads', 'vendor', 'dist', 'build']);

/** Folders where people usually keep their clones, and how deep to look in each. */
export function searchRoots(home = homedir()): { dir: string; depth: number }[] {
	const extra = (process.env.GH_WPR_SEARCH_DIRS ?? '').split(':').filter(Boolean).map((dir) => ({ dir: expandHome(dir, home), depth: 3 }));
	const usual = ['code', 'Code', 'src', 'dev', 'Developer', 'projects', 'Projects', 'repos', 'git', 'workspace', 'Desktop', 'Documents'];
	return [...extra, { dir: process.cwd(), depth: 0 }, { dir: home, depth: 1 }, ...usual.map((name) => ({ dir: join(home, name), depth: 3 }))];
}

/**
 * Local clones of the given repos, found by looking a few levels deep in the usual
 * folders and reading each clone's `origin`. Returns repo (lowercase) → folders.
 */
export function findCheckouts(repos: string[], roots = searchRoots(), limit = 5000): Map<string, string[]> {
	const wanted = new Set(repos.map((r) => r.toLowerCase()));
	const found = new Map<string, string[]>();
	// A folder seen at a shallower depth is looked at again when another root reaches it deeper.
	const visited = new Map<string, number>();
	let budget = limit;

	const visit = (dir: string, depth: number) => {
		if (budget-- <= 0 || (visited.get(dir) ?? -1) >= depth) return;
		const seenBefore = visited.has(dir);
		visited.set(dir, depth);
		if (existsSync(join(dir, '.git'))) {
			const repo = seenBefore ? null : originOf(dir);
			if (repo && wanted.has(repo)) found.set(repo, [...(found.get(repo) ?? []), dir]);
			return; // clones inside clones are not worth the time
		}
		if (depth <= 0) return;
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
			visit(join(dir, entry.name), depth - 1);
		}
	};

	for (const root of roots) {
		if (existsSync(root.dir)) visit(root.dir, root.depth);
	}
	return found;
}
