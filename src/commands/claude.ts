import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Config } from '../config.ts';
import { color } from '../format.ts';
import { loadSnapshot } from '../snapshot.ts';
import { resolveTarget } from '../target.ts';
import type { PullRequest } from '../types.ts';

export function claudePrompt(config: Config, pr: PullRequest): string {
	return config.claude.prompt
		.replaceAll('{url}', pr.url)
		.replaceAll('{number}', String(pr.number))
		.replaceAll('{repo}', pr.repo);
}

/** Starts Claude Code in the repo's local checkout with a prompt about the PR. */
export async function claude(config: Config, target: string, repo: string | undefined): Promise<number> {
	const snapshot = await loadSnapshot(config);
	const pr = resolveTarget(target, repo, config, snapshot.prs);
	const configured = config.localPaths[pr.repo.toLowerCase()]?.replace(/^~(?=\/|$)/, process.env.HOME ?? '~');
	let cwd = process.cwd();
	if (configured && existsSync(configured)) cwd = configured;
	else {
		const hint = configured ? `${configured} does not exist` : `no "localPaths" entry for ${pr.repo}`;
		console.log(color.yellow(`! ${hint}; starting in ${cwd}`));
	}

	const [command, ...args] = config.claude.command.split(/\s+/).filter(Boolean);
	const prompt = claudePrompt(config, pr);
	console.log(color.dim(`${cwd}$ ${config.claude.command} "${prompt}"`));
	return new Promise((resolvePromise) => {
		const child = spawn(command, [...args, prompt], { cwd, stdio: 'inherit' });
		child.on('error', (error) => {
			console.error(`${color.red('error')} Could not start "${command}": ${error.message}`);
			resolvePromise(1);
		});
		child.on('exit', (code) => resolvePromise(code ?? 0));
	});
}
