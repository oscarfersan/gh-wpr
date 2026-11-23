import type { Config } from '../config.ts';
import { color } from '../format.ts';
import { readFinishQueue } from '../finish/queue.ts';
import { runFinishQueue } from './finish.ts';
import { postComment } from '../github.ts';
import { decideEntry, decideQueue, readQueue, writeQueue } from '../queue.ts';
import type { QueueEntry } from '../queue.ts';
import { loadSnapshot } from '../snapshot.ts';
import type { Snapshot } from '../snapshot.ts';
import { prKey } from '../types.ts';

const BOT_NAME = { coderabbit: 'CodeRabbit', codex: 'Codex' } as const;

export interface QueueRun {
	posted: number;
	postedEntries: QueueEntry[];
	lines: string[];
}

/** Posts the queued comments that are due. Each one is re-checked against fresh data first. */
export async function runQueue(config: Config, snapshot: Snapshot, options: { dryRun: boolean }): Promise<QueueRun> {
	const entries = readQueue();
	if (entries.length === 0) return { posted: 0, postedEntries: [], lines: [] };

	const lines: string[] = [];
	const kept: QueueEntry[] = [];
	const postedEntries: QueueEntry[] = [];

	for (const decision of decideQueue(entries, snapshot.prs, config, new Date())) {
		const { entry } = decision;
		const label = `${BOT_NAME[entry.bot]} on ${entry.repo}#${entry.number}`;
		if (decision.decision === 'drop') {
			lines.push(color.dim(`− ${label}: dropped (${decision.why})`));
			continue;
		}
		if (decision.decision === 'keep') {
			kept.push(decision.notBefore ? { ...entry, notBefore: decision.notBefore } : entry);
			continue;
		}
		// Due: confirm with fresh data, another teammate may have asked already.
		const fresh = await loadSnapshot(config, { fresh: [prKey(entry)] });
		const confirmed = decideEntry(entry, fresh.prs.find((p) => prKey(p) === prKey(entry)), config, new Date());
		if (confirmed.decision !== 'post') {
			if (confirmed.decision === 'keep') kept.push(entry);
			else lines.push(color.dim(`− ${label}: dropped (${confirmed.why})`));
			continue;
		}
		if (options.dryRun) {
			lines.push(`${color.yellow('○')} ${label}: would post "${entry.body}" (${confirmed.why})`);
			kept.push(entry);
			continue;
		}
		try {
			const url = await postComment(entry.repo, entry.number, entry.body);
			postedEntries.push(entry);
			lines.push(`${color.green('✓')} ${label}: posted "${entry.body}" (${confirmed.why}) → ${url}`);
		} catch (error) {
			kept.push(entry);
			lines.push(`${color.red('✗')} ${label}: ${(error as Error).message}`);
		}
	}

	if (!options.dryRun) writeQueue(kept);
	return { posted: postedEntries.length, postedEntries, lines };
}

export async function tick(config: Config, options: { dryRun: boolean; quiet: boolean }): Promise<void> {
	if (readFinishQueue().length > 0) {
		for (const line of (await runFinishQueue(config, options)).lines) console.log(line);
	}
	if (readQueue().length === 0) {
		if (!options.quiet) console.log(color.dim('Queue is empty.'));
		return;
	}
	const snapshot = await loadSnapshot(config);
	const result = await runQueue(config, snapshot, options);
	for (const line of result.lines) console.log(line);
	if (!options.quiet) {
		const left = readQueue();
		console.log(color.dim(left.length ? `${left.length} waiting in the queue.` : 'Queue is empty.'));
	}
}
