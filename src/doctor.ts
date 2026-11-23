import { accessSync, constants, existsSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { expandHome, originOf } from './checkouts.ts';
import type { LoadedConfig } from './config.ts';
import { TEAM_FILE } from './team.ts';

/**
 * ok: works · warn: works partly or not at all until fixed · error: broken ·
 * off: optional and not set up, nothing to fix.
 */
export type CheckState = 'ok' | 'warn' | 'error' | 'off';

export interface Check {
	feature: string;
	state: CheckState;
	detail?: string;
	/** What to run or change to fix it. */
	fix?: string;
}

/** Whether `command` (the first word of a command line) can be run. */
export function onPath(commandLine: string, path = process.env.PATH ?? ''): boolean {
	const command = expandHome(commandLine.trim().split(/\s+/)[0] ?? '');
	if (!command) return false;
	const executable = (file: string) => {
		try {
			accessSync(file, constants.X_OK);
			return true;
		} catch {
			return false;
		}
	};
	if (command.includes('/')) return executable(isAbsolute(command) ? command : join(process.cwd(), command));
	return path.split(delimiter).some((dir) => dir && executable(join(dir, command)));
}

/** Checks that need no network, cheap enough for every menu refresh. */
export function localChecks(loaded: Omit<LoadedConfig, 'path'>, options: { path?: string } = {}): Check[] {
	const { config } = loaded;
	const checks: Check[] = [];

	for (const file of loaded.teamFiles) {
		const where = `${TEAM_FILE} in ${file.repo}`;
		if (file.status === 'invalid') {
			checks.push({ feature: `Team settings (${file.repo})`, state: 'error', detail: `${where} is ignored: ${file.error}`, fix: `Fix ${where}` });
		} else if (file.fetchError) {
			checks.push({ feature: `Team settings (${file.repo})`, state: 'warn', detail: `Could not read ${where}: ${file.fetchError}`, fix: 'Check your network and "gh auth status", then run "gh wpr doctor" again' });
		} else if (file.missing) {
			checks.push({ feature: `Team settings (${file.repo})`, state: 'warn', detail: `${where} has not been fetched yet`, fix: 'Run "gh wpr doctor"' });
		} else if (file.status === 'found') {
			checks.push({ feature: `Team settings (${file.repo})`, state: 'ok', detail: `from ${where}` });
		} else {
			checks.push({ feature: `Team settings (${file.repo})`, state: 'off', detail: `no ${TEAM_FILE}; team settings come from your own config` });
		}
	}
	if (loaded.conflicts.length > 0) {
		checks.push({
			feature: 'Team settings',
			state: 'warn',
			detail: `Repos disagree on ${loaded.conflicts.join(', ')}; the first repo in "repos" wins`,
			fix: `Make ${TEAM_FILE} agree across repos, or set these in your own config`,
		});
	}

	const claudeFound = onPath(config.claude.command, options.path);
	const missingPaths: string[] = [];
	const wrongPaths: string[] = [];
	for (const repo of config.repos) {
		const configured = config.localPaths[repo.toLowerCase()];
		if (!configured) missingPaths.push(repo);
		else {
			const dir = expandHome(configured);
			if (!existsSync(dir)) wrongPaths.push(`${configured} does not exist`);
			else if (originOf(dir) !== repo.toLowerCase()) wrongPaths.push(`${configured} is not a clone of ${repo}`);
		}
	}
	if (!claudeFound) {
		checks.push({
			feature: 'Claude Code',
			state: 'warn',
			detail: `"${config.claude.command}" was not found, so "Triage comments with Claude Code" is hidden`,
			fix: 'Install Claude Code, or set "claude.command" to its full path in your config',
		});
	} else if (wrongPaths.length > 0 || missingPaths.length > 0) {
		const detail = [...wrongPaths, ...(missingPaths.length ? [`no local folder for ${missingPaths.join(', ')}`] : [])].join('; ');
		checks.push({ feature: 'Claude Code', state: 'warn', detail: `${detail}; it would start in the wrong folder`, fix: 'Run "gh wpr init" to find your clones' });
	} else {
		checks.push({ feature: 'Claude Code', state: 'ok' });
	}
	return checks;
}

/** How many features need attention. */
export const setupIssues = (checks: Check[]): number => checks.filter((c) => c.state === 'warn' || c.state === 'error').length;
