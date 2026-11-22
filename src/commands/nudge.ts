import type { Config } from '../config.ts';
import { color } from '../format.ts';
import { openInBrowser, postComment, requestReviewers } from '../github.ts';
import { loadSnapshot } from '../snapshot.ts';
import { resolveTarget } from '../target.ts';
import type { PullRequest } from '../types.ts';

/** Who should be asked again: pending reviewers, else past human reviewers, else the rest of the team. */
export function nudgeTargets(pr: PullRequest, config: Config, me: string): string[] {
	const exclude = new Set([me, pr.author, config.coderabbit.login, config.codex.login]);
	const pending = pr.requestedReviewers.filter((r) => !exclude.has(r));
	if (pending.length) return pending;
	const past = [...new Set(pr.reviews.map((r) => r.author))].filter((r) => !exclude.has(r) && config.team.includes(r));
	if (past.length) return past;
	return config.team.filter((r) => !exclude.has(r));
}

/** The comment that asks them, e.g. "@alice @bob review". */
export function nudgeComment(config: Config, reviewers: string[]): string {
	return config.nudge.comment.replaceAll('{mentions}', reviewers.map((r) => `@${r}`).join(' '));
}

export async function nudge(config: Config, target: string, repo: string | undefined, dryRun: boolean): Promise<number> {
	const snapshot = await loadSnapshot(config);
	const pr = resolveTarget(target, repo, config, snapshot.prs);
	if (pr.author !== snapshot.viewer) {
		console.log(`${color.yellow('!')} #${pr.number} is ${pr.author}'s PR. "nudge" asks for reviews on your own PRs.`);
		return 1;
	}
	const reviewers = nudgeTargets(pr, config, snapshot.viewer);
	if (reviewers.length === 0) {
		console.log(`${color.yellow('!')} Nobody to ask on #${pr.number}. Add teammates to "team" in your config.`);
		return 1;
	}
	const { mode } = config.nudge;
	const body = nudgeComment(config, reviewers);
	if (dryRun) {
		if (mode !== 'comment') console.log(`${color.yellow('○')} Would request a review on #${pr.number} from ${reviewers.join(', ')}`);
		if (mode !== 'request') console.log(`${color.yellow('○')} Would comment on #${pr.number}: ${body}`);
		return 0;
	}
	if (mode !== 'comment') {
		await requestReviewers(pr.repo, pr.number, reviewers);
		console.log(`${color.green('✓')} Requested a review on #${pr.number} from ${reviewers.join(', ')}`);
	}
	if (mode !== 'request') {
		const url = await postComment(pr.repo, pr.number, body);
		console.log(`${color.green('✓')} Commented "${body}" on #${pr.number} ${color.dim(url)}`);
	}
	return 0;
}

export async function open(config: Config, target: string, repo: string | undefined): Promise<void> {
	const snapshot = await loadSnapshot(config);
	await openInBrowser(resolveTarget(target, repo, config, snapshot.prs).url);
}
