import type { Config } from '../config.ts';
import { approvalChip, ciChip, codexChip, coderabbitChip, GROUP_TITLE, renderTable } from '../format.ts';
import { readQueue } from '../queue.ts';
import { loadSnapshot } from '../snapshot.ts';
import { assessAll } from '../turn.ts';
import type { Assessment } from '../turn.ts';
import { runQueue } from './tick.ts';

export interface StatusOptions {
	json: boolean;
	full: boolean;
	/** Advance the local queue first, reusing the same fetch. */
	tick: boolean;
}

export function toJson(a: Assessment) {
	const queuedCodex = a.queued.some((e) => e.bot === 'codex');
	return {
		repo: a.pr.repo,
		number: a.pr.number,
		title: a.pr.title,
		url: a.pr.url,
		author: a.pr.author,
		mine: a.mine,
		group: a.group,
		groupTitle: GROUP_TITLE[a.group],
		reason: a.reason,
		headOid: a.pr.headOid,
		updatedAt: a.pr.updatedAt,
		ci: a.ci,
		coderabbit: a.coderabbit,
		codex: a.codex,
		queued: a.queued.map((e) => ({ bot: e.bot, notBefore: e.notBefore })),
		aiActionable: a.aiActionable,
		isDraft: a.pr.isDraft,
		approvals: a.approvals,
		done: a.done,
		chips: {
			coderabbit: coderabbitChip(a.coderabbit, a.approvals.coderabbit),
			codex: codexChip(a.codex, queuedCodex, a.approvals.codex),
			human: approvalChip(a.approvals.human),
			notion: approvalChip(a.approvals.notion),
			ci: ciChip(a.ci),
		},
	};
}

export async function status(config: Config, options: StatusOptions): Promise<void> {
	const now = new Date();
	let snapshot = await loadSnapshot(config, { full: options.full });
	const tickLines: string[] = [];
	if (options.tick) {
		const result = await runQueue(config, snapshot, { dryRun: false });
		tickLines.push(...result.lines);
		if (result.posted > 0) snapshot = await loadSnapshot(config);
	}
	const items = assessAll(snapshot.prs, config, snapshot.viewer, now, readQueue());

	if (options.json) {
		process.stdout.write(
			`${JSON.stringify({ viewer: snapshot.viewer, fetchedAt: snapshot.fetchedAt, tick: tickLines, items: items.map(toJson) }, null, 2)}\n`,
		);
		return;
	}
	for (const line of tickLines) console.log(line);
	console.log(renderTable(items, now, config.repos.length > 1));
}
