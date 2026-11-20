import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseConfig } from '../config.ts';
import { color } from '../format.ts';
import { currentRepo, gh } from '../github.ts';
import { configFile } from '../paths.ts';

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

export async function init(options: InitOptions): Promise<number> {
	const path = configFile();
	if (existsSync(path) && !options.force) {
		console.log(`${color.yellow('!')} ${path} already exists. Edit it, or run "gh wpr init --force" to replace it.`);
		return 1;
	}

	const login = (await gh(['api', 'user', '--jq', '.login'])).trim();
	console.log(`Signed in to gh as ${color.bold(login)}. Requests will be posted as this account.`);

	let repos = options.repos;
	let team = options.team;
	let ignoreChecks = options.ignoreChecks;

	if (!options.yes) {
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		try {
			const here = await currentRepo();
			if (repos.length === 0) {
				const answer = await rl.question(`Repositories to follow (owner/name, comma separated)${here ? ` [${here}]` : ''}: `);
				repos = list(answer).length ? list(answer) : here ? [here] : [];
			}
			if (team.length === 0) {
				team = list(await rl.question(`Your team's GitHub logins, you included [${login}]: `));
			}
			if (ignoreChecks.length === 0) {
				ignoreChecks = list(await rl.question('Checks that should not count as CI, if any (comma separated) []: '));
			}
		} finally {
			rl.close();
		}
	}

	if (!team.map((t) => t.toLowerCase()).includes(login.toLowerCase())) team = [login, ...team];
	const config = { repos, team, ignoreChecks };
	parseConfig(config); // fail early with a clear message

	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
	console.log(`${color.green('✓')} Saved ${path}`);
	console.log(color.dim('Bot settings use the defaults; see config.example.json in the repo to change them.'));
	return 0;
}
