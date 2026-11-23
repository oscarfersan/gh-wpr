import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfigFresh } from '../config.ts';
import type { Check } from '../doctor.ts';
import { localChecks, setupIssues } from '../doctor.ts';
import { color } from '../format.ts';
import { gh } from '../github.ts';
import { normLogin } from '../util.ts';
import { PLUGIN_NAME, swiftbarPluginDir } from './swiftbar.ts';

const MARK: Record<Check['state'], string> = {
	ok: color.green('✓'),
	warn: color.yellow('⚠'),
	error: color.red('✗'),
	off: color.dim('–'),
};

function nodeCheck(): Check {
	const [major, minor] = process.versions.node.split('.').map(Number);
	const ok = major > 22 || (major === 22 && minor >= 18);
	return ok
		? { feature: 'Node.js', state: 'ok', detail: process.versions.node }
		: { feature: 'Node.js', state: 'error', detail: `${process.versions.node} is too old`, fix: 'Install Node.js 22.18 or newer' };
}

async function swiftbarCheck(): Promise<Check> {
	if (process.platform !== 'darwin') return { feature: 'Menu bar (SwiftBar)', state: 'off', detail: 'macOS only' };
	const dir = await swiftbarPluginDir();
	if (!dir) {
		return { feature: 'Menu bar (SwiftBar)', state: 'off', detail: 'SwiftBar is not set up (optional)', fix: 'brew install --cask swiftbar, open it once, then "gh wpr swiftbar install"' };
	}
	const plugin = join(dir.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'), PLUGIN_NAME);
	return existsSync(plugin)
		? { feature: 'Menu bar (SwiftBar)', state: 'ok', detail: plugin }
		: { feature: 'Menu bar (SwiftBar)', state: 'warn', detail: `the plugin is not in ${dir}`, fix: 'Run "gh wpr swiftbar install"' };
}

/** Every check, including the ones that need GitHub. */
export async function runChecks(): Promise<Check[]> {
	const checks: Check[] = [nodeCheck()];

	let login: string | null = null;
	try {
		login = normLogin((await gh(['api', 'user', '--jq', '.login'])).trim());
		checks.push({ feature: 'GitHub CLI', state: 'ok', detail: `signed in as ${login}` });
	} catch (error) {
		checks.push({ feature: 'GitHub CLI', state: 'error', detail: (error as Error).message.split('\n')[0], fix: 'Run "gh auth login"' });
		return checks;
	}

	let loaded;
	try {
		loaded = await loadConfigFresh({ force: true });
		checks.push({ feature: 'Config', state: 'ok', detail: loaded.path });
	} catch (error) {
		checks.push({ feature: 'Config', state: 'error', detail: (error as Error).message, fix: 'Run "gh wpr init"' });
		return checks;
	}
	const { config } = loaded;

	const access = await Promise.all(
		config.repos.map(async (repo): Promise<Check> => {
			try {
				await gh(['api', `repos/${repo}`, '--jq', '.full_name']);
				return { feature: `Repository ${repo}`, state: 'ok' };
			} catch (error) {
				return { feature: `Repository ${repo}`, state: 'error', detail: (error as Error).message.split('\n')[0], fix: 'Check the name in "repos" and that your gh account can see it' };
			}
		}),
	);
	checks.push(...access);

	if (config.team.length === 0) {
		checks.push({ feature: 'Team', state: 'warn', detail: 'nobody listed, so every PR counts as someone else\'s', fix: 'Add "team" to .github/wpr.json, or to your own config' });
	} else if (!config.team.includes(login)) {
		checks.push({ feature: 'Team', state: 'warn', detail: `${login} is not in the team (${config.team.join(', ')})`, fix: 'Ask to be added to "team" in .github/wpr.json' });
	} else {
		checks.push({ feature: 'Team', state: 'ok', detail: config.team.join(', ') });
	}

	checks.push(...localChecks(loaded));
	checks.push(await swiftbarCheck());
	return checks;
}

export function formatChecks(checks: Check[]): string {
	const lines = checks.map((c) => {
		const head = `${MARK[c.state]} ${c.feature}${c.detail ? color.dim(` · ${c.detail}`) : ''}`;
		return c.fix && c.state !== 'ok' ? `${head}\n    ${color.blue('→')} ${c.fix}` : head;
	});
	const issues = setupIssues(checks);
	lines.push('', issues === 0 ? color.green('Everything is set up.') : color.yellow(`${issues} thing${issues > 1 ? 's' : ''} to fix.`));
	return lines.join('\n');
}

/** Lists every feature with its state and how to fix it. Exits 1 when something needs fixing. */
export async function doctor(options: { json: boolean }): Promise<number> {
	const checks = await runChecks();
	if (options.json) console.log(JSON.stringify(checks, null, 2));
	else console.log(formatChecks(checks));
	return setupIssues(checks) > 0 ? 1 : 0;
}
