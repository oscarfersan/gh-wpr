import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CodexState } from './bots/codex.ts';
import { stateDir } from './paths.ts';
import type { QueueEntry } from './queue.ts';
import type { Assessment, Group } from './turn.ts';
import { prKey } from './types.ts';

/*
 * Notifications are the difference between two refreshes: a PR that just became
 * your turn, or Codex finishing on one of your PRs. The first refresh only
 * records the state, so installing the plugin does not fire a burst of alerts.
 */

export interface Remembered {
	group: Group;
	codex: CodexState['kind'];
	headOid: string;
}

export type Memory = Record<string, Remembered>;

export interface Notice {
	title: string;
	body: string;
	url: string;
}

export function remember(items: Assessment[]): Memory {
	const memory: Memory = {};
	for (const a of items) memory[prKey(a.pr)] = { group: a.group, codex: a.codex.kind, headOid: a.pr.headOid };
	return memory;
}

export function notices(previous: Memory | null, items: Assessment[]): Notice[] {
	if (previous === null) return [];
	const out: Notice[] = [];
	for (const a of items) {
		const before = previous[prKey(a.pr)];
		const label = `#${a.pr.number} ${a.pr.title}`;
		if (a.group === 'review' && before?.group !== 'review') {
			out.push({ title: 'Your turn to review', body: `${label}\n${a.reason}`, url: a.pr.url });
		} else if (a.group === 'author' && before !== undefined && before.group !== 'author') {
			out.push({ title: 'Your turn', body: `${label}\n${a.reason}`, url: a.pr.url });
		}
		if (a.mine && a.codex.kind === 'reviewed' && before && before.codex !== 'reviewed' && before.headOid === a.pr.headOid) {
			out.push({ title: 'Codex finished', body: label, url: a.pr.url });
		}
	}
	return out;
}

export function postedNotices(posted: QueueEntry[], items: Assessment[]): Notice[] {
	return posted.map((entry) => {
		const pr = items.find((a) => a.pr.repo === entry.repo && a.pr.number === entry.number)?.pr;
		const bot = entry.bot === 'codex' ? 'Codex' : 'CodeRabbit';
		return {
			title: `Requested ${bot}`,
			body: pr ? `#${pr.number} ${pr.title}` : `${entry.repo}#${entry.number}`,
			url: pr?.url ?? `https://github.com/${entry.repo}/pull/${entry.number}`,
		};
	});
}

const memoryFile = (): string => join(stateDir(), 'notified.json');

export function readMemory(): Memory | null {
	try {
		return JSON.parse(readFileSync(memoryFile(), 'utf8')) as Memory;
	} catch {
		return null;
	}
}

export function writeMemory(memory: Memory): void {
	mkdirSync(stateDir(), { recursive: true });
	const tmp = `${memoryFile()}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(memory));
	renameSync(tmp, memoryFile());
}
