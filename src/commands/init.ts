import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { Interface } from 'node:readline/promises';
import { findCheckouts, tildify } from '../checkouts.ts';
import { parseConfig } from '../config.ts';
import { color } from '../format.ts';
import { currentRepo, gh } from '../github.ts';
import { configFile } from '../paths.ts';
import { combineTeamFiles, refreshTeamFiles, TEAM_FILE } from '../team.ts';
import type { TeamFile } from '../team.ts';
import { normLogin } from '../util.ts';

export interface InitOptions {
	repos: string[];
	team: string[];
	ignoreChecks: string[];
	yes: boolean;
	force: boolean;
}

const list = (answer: string): string[] =>
	answer
		.split(/[\s,]+/)
		.map((s) => s.trim())
		.filter(Boolean);

type Ask = (question: string) => Promise<string>;

function describeTeamFiles(files: TeamFile[]): void {
	for (const file of files) {
		if (file.status === 'found') {
			const keys = Object.keys(file.settings ?? {});
			console.log(`${color.green('✓')} Team settings from ${TEAM_FILE} in ${file.repo}: ${keys.join(', ')}`);
		} else if (file.status === 'invalid') {
			console.log(`${color.red('✗')} ${TEAM_FILE} in ${file.repo} is ignored: ${file.error}`);
		} else if (file.fetchError) {
			console.log(`${color.yellow('!')} Could not read ${TEAM_FILE} in ${file.repo}: ${file.fetchError}`);
		} else {
			console.log(color.dim(`– No ${TEAM_FILE} in ${file.repo}; team settings go in your own config.`));
		}
	}
}

/**
 * Fills in `localPaths` for repos that have none, from clones found on disk.
 * Asks when there are several clones or none (unless `yes`).
 */
async function detectLocalPaths(repos: string[], current: Record<string, string>, ask: Ask | null): Promise<Record<string, string>> {
	const known = new Set(Object.keys(current).map((r) => r.toLowerCase()));
	const missing = repos.filter((r) => !known.has(r.toLowerCase()));
	if (missing.length === 0) return {};
	console.log(color.dim(`Looking for local clones of ${missing.join(', ')}…`));
	const found = findCheckouts(missing);
	const added: Record<string, string> = {};
	for (const repo of missing) {
		const dirs = (found.get(repo.toLowerCase()) ?? []).map((d) => tildify(d));
		if (dirs.length === 1) {
			added[repo] = dirs[0];
			console.log(`${color.green('✓')} ${repo} is cloned at ${dirs[0]}`);
			continue;
		}
		if (!ask) {
			if (dirs.length > 1) {
				added[repo] = dirs[0];
				console.log(`${color.yellow('!')} ${repo} has several clones; using ${dirs[0]}`);
			} else console.log(`${color.yellow('!')} No local clone of ${repo} found; set "localPaths" later if you want Claude Code to start there.`);
			continue;
		}
		if (dirs.length > 1) {
			dirs.forEach((d, i) => console.log(`  ${i + 1}. ${d}`));
			const answer = (await ask(`Which clone of ${repo} should Claude Code use? [1]: `)).trim();
			const picked = dirs[(Number(answer) || 1) - 1];
			if (picked) added[repo] = picked;
		} else {
			const answer = (await ask(`Folder of your clone of ${repo} (Enter to skip): `)).trim();
			if (answer) added[repo] = answer;
		}
	}
	return added;
}

function save(path: string, config: Record<string, unknown>): void {
	parseConfig(config); // fail early with a clear message
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
	console.log(`${color.green('✓')} Saved ${path}`);
}

async function withPrompt<T>(yes: boolean, fn: (ask: Ask | null) => Promise<T>): Promise<T> {
	if (yes) return fn(null);
	const rl: Interface = createInterface({ input: process.stdin, output: process.stdout });
	try {
		return await fn((q) => rl.question(q));
	} finally {
		rl.close();
	}
}

/** Run again on an existing config: only fills in what is missing. */
async function complete(path: string, options: InitOptions): Promise<number> {
	const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
	parseConfig(raw);
	const repos = raw.repos as string[];
	describeTeamFiles(await refreshTeamFiles(repos, { force: true }));
	const localPaths = (raw.localPaths ?? {}) as Record<string, string>;
	const added = await withPrompt(options.yes, (ask) => detectLocalPaths(repos, localPaths, ask));
	if (Object.keys(added).length > 0) save(path, { ...raw, localPaths: { ...localPaths, ...added } });
	else console.log(`${color.green('✓')} ${path} has nothing missing.`);
	console.log(color.dim('Run "gh wpr doctor" to check every feature. "gh wpr init --force" starts over.'));
	return 0;
}

export async function init(options: InitOptions): Promise<number> {
	const path = configFile();
	if (existsSync(path) && !options.force) return complete(path, options);

	const login = normLogin((await gh(['api', 'user', '--jq', '.login'])).trim());
	console.log(`Signed in to gh as ${color.bold(login)}. Requests will be posted as this account.`);

	return withPrompt(options.yes, async (ask) => {
		let repos = options.repos;
		if (repos.length === 0 && ask) {
			const here = await currentRepo();
			const answer = await ask(`Repositories to follow (owner/name, comma separated)${here ? ` [${here}]` : ''}: `);
			repos = list(answer).length ? list(answer) : here ? [here] : [];
		}

		// Whatever the team already committed is not asked again.
		const files = await refreshTeamFiles(repos, { force: true });
		describeTeamFiles(files);
		const team = combineTeamFiles(files.filter((f) => f.status === 'found')).settings;

		const config: Record<string, unknown> = { repos };
		let members = options.team;
		if (members.length === 0 && !Array.isArray(team.team) && ask) {
			members = list(await ask(`Your team's GitHub logins, you included [${login}]: `));
		}
		if (members.length > 0 || !Array.isArray(team.team)) {
			config.team = members.map(normLogin).includes(login) ? members : [login, ...members];
		} else if (!(team.team as string[]).map(normLogin).includes(login)) {
			console.log(`${color.yellow('!')} ${login} is not in "team" in ${TEAM_FILE}. Ask to be added, so your PRs count as yours.`);
		}

		let ignoreChecks = options.ignoreChecks;
		if (ignoreChecks.length === 0 && !Array.isArray(team.ignoreChecks) && ask) {
			ignoreChecks = list(await ask('Checks that should not count as CI, if any (comma separated) []: '));
		}
		if (ignoreChecks.length > 0) config.ignoreChecks = ignoreChecks;

		const localPaths = await detectLocalPaths(repos, {}, ask);
		if (Object.keys(localPaths).length > 0) config.localPaths = localPaths;

		save(path, config);
		console.log(color.dim('Run "gh wpr doctor" to check every feature.'));
		return 0;
	});
}
