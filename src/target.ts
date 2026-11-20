import type { Config } from './config.ts';
import type { PullRequest } from './types.ts';

export class TargetError extends Error {}

const URL_RE = /github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/;

/** Accepts "123", "#123", "owner/repo#123" or a PR URL, with an optional --repo. */
export function parseTarget(input: string, repoFlag: string | undefined): { repo: string | null; number: number } {
	const url = input.match(URL_RE);
	if (url) return { repo: url[1], number: Number(url[2]) };
	const qualified = input.match(/^([^/\s]+\/[^#\s]+)#(\d+)$/);
	if (qualified) return { repo: qualified[1], number: Number(qualified[2]) };
	const plain = input.match(/^#?(\d+)$/);
	if (plain) return { repo: repoFlag ?? null, number: Number(plain[1]) };
	throw new TargetError(`"${input}" is not a PR number, owner/repo#number or PR URL`);
}

export function resolveTarget(input: string, repoFlag: string | undefined, config: Config, prs: PullRequest[]): PullRequest {
	const target = parseTarget(input, repoFlag);
	const matches = prs.filter(
		(pr) => pr.number === target.number && (target.repo === null || pr.repo.toLowerCase() === target.repo.toLowerCase()),
	);
	if (matches.length === 1) return matches[0];
	if (matches.length > 1) {
		throw new TargetError(`#${target.number} exists in ${matches.map((m) => m.repo).join(' and ')}; pass --repo`);
	}
	const where = target.repo ?? config.repos.join(', ');
	throw new TargetError(`No open PR #${target.number} in ${where}`);
}
