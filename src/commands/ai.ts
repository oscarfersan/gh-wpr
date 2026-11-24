import type { Config } from '../config.ts';
import { color } from '../format.ts';
import { postComment } from '../github.ts';
import { planAi } from '../plan.ts';
import type { PlanOptions } from '../plan.ts';
import { readQueue, upsert, writeQueue } from '../queue.ts';
import { loadSnapshot } from '../snapshot.ts';
import { resolveTarget } from '../target.ts';
import { assessAll } from '../turn.ts';
import type { PullRequest } from '../types.ts';
import { prKey } from '../types.ts';

export interface AiOptions extends PlanOptions {
	targets: string[];
	repo?: string;
	mine: boolean;
	dryRun: boolean;
}

const BOT_NAME = { coderabbit: 'CodeRabbit', codex: 'Codex' } as const;

export async function ai(config: Config, options: AiOptions): Promise<number> {
	let snapshot = await loadSnapshot(config);
	let prs: PullRequest[];
	if (options.mine) {
		prs = assessAll(snapshot.prs, config, snapshot.viewer, new Date(), readQueue())
			.filter((a) => a.mine && a.group === 'author' && a.aiActionable)
			.map((a) => a.pr);
		if (prs.length === 0) {
			console.log(color.dim('None of your PRs needs an AI review right now.'));
			return 0;
		}
	} else {
		if (options.targets.length === 0) throw new Error('Which PR? Usage: gh wpr ai <number|url> [--bot codex|coderabbit]');
		prs = options.targets.map((t) => resolveTarget(t, options.repo, config, snapshot.prs));
	}

	// Act on fresh data: a teammate may have just asked for the same review.
	snapshot = await loadSnapshot(config, { fresh: prs.map(prKey) });
	let exitCode = 0;
	let queue = readQueue();
	let queueChanged = false;

	for (const target of prs) {
		const pr = snapshot.prs.find((p) => prKey(p) === prKey(target));
		if (!pr) {
			console.log(`${color.red('✗')} ${prKey(target)} is no longer open`);
			exitCode = 1;
			continue;
		}
		const now = new Date();
		const plan = planAi(pr, config, now, { force: options.force, only: options.only, codexOnlyInPlay: options.mine });
		console.log(color.bold(`#${pr.number} ${pr.title}`));
		if (plan.blocked) {
			console.log(`  ${color.yellow('!')} Not requesting reviews: ${plan.blocked}.`);
			exitCode = 1;
			continue;
		}
		const verb = options.dryRun ? 'would post' : 'posted';
		for (const action of plan.actions) {
			const name = BOT_NAME[action.bot];
			switch (action.kind) {
				case 'skip':
					console.log(`  ${color.dim('·')} ${name}: ${action.why}`);
					break;
				case 'post':
					if (options.dryRun) {
						console.log(`  ${color.yellow('○')} ${name}: ${verb} "${action.body}" (${action.why})`);
						break;
					}
					try {
						const url = await postComment(pr.repo, pr.number, action.body);
						console.log(`  ${color.green('✓')} ${name}: ${verb} "${action.body}" (${action.why}) → ${url}`);
					} catch (error) {
						console.log(`  ${color.red('✗')} ${name}: ${(error as Error).message}`);
						exitCode = 1;
					}
					break;
				case 'schedule':
				case 'enqueue':
					console.log(
						`  ${color.magenta('⇢')} ${name}: ${options.dryRun ? 'would queue' : 'queued'} "${action.body}" (${action.why})`,
					);
					if (!options.dryRun) {
						queue = upsert(queue, {
							repo: pr.repo,
							number: pr.number,
							bot: action.bot,
							body: action.body,
							headOid: pr.headOid,
							notBefore: action.kind === 'schedule' ? action.at : null,
							createdAt: now.toISOString(),
							...(action.kind === 'enqueue' && action.force ? { force: true } : {}),
						});
						queueChanged = true;
					}
					break;
			}
		}
	}

	if (queueChanged) {
		writeQueue(queue);
		console.log(color.dim('Queued items are posted by "gh wpr tick" (the menu bar runs it every minute).'));
	}
	return exitCode;
}
