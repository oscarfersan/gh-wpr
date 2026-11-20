import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CodexState } from './bots/codex.ts';
import type { Config } from './config.ts';
import { stateDir } from './paths.ts';
import type { QueueEntry } from './queue.ts';
import type { Assessment, Group } from './turn.ts';
import { prKey } from './types.ts';

/*
 * Notifications are the difference between two refreshes: a teammate approving,
 * requesting changes or commenting on a PR you take part in, a PR that just
 * became your turn, or Codex finishing on one of your PRs. The first refresh
 * only records the state, so installing the plugin does not fire a burst of alerts.
 */

export interface Remembered {
	group: Group;
	codex: CodexState['kind'];
	headOid: string;
	/** Newest comment or review by someone else (not a bot). Missing in memories from older versions. */
	lastActivityAt?: string;
}

export type ActivityKind = 'approved' | 'changes' | 'commented';

export interface Activity {
	who: string;
	kind: ActivityKind;
	at: string;
	text: string;
}

const REVIEW_KIND: Record<string, ActivityKind> = {
	APPROVED: 'approved',
	CHANGES_REQUESTED: 'changes',
	COMMENTED: 'commented',
};

/** Mentions that start a comment aimed at a bot: "@coderabbitai ..." or the Codex command's handle. */
export function botHandles(config: Config): string[] {
	const handles = [`@${config.coderabbit.login}`, config.codex.command.trim().split(/\s+/)[0]];
	return handles.filter((h) => h.startsWith('@')).map((h) => h.toLowerCase());
}

const talksToBot = (body: string, handles: string[]): boolean => {
	const first = body.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
	return handles.includes(first);
};

/**
 * Comments and reviews by people other than `me`, oldest first. Bots never count,
 * and neither do comments addressed to a bot ("@codex review", "@coderabbitai ...").
 *
 * Replying inside a review thread creates a review with no text. On your own PRs
 * that is someone commenting on your code, so it counts. On other people's PRs
 * it is usually the author talking to CodeRabbit, so only replies in threads you
 * opened count there.
 */
export function activity(a: Assessment, me: string, handles: string[]): Activity[] {
	const events: Activity[] = [];
	for (const c of a.pr.comments) {
		if (c.isBot || c.author === me || talksToBot(c.body, handles)) continue;
		events.push({ who: c.author, kind: 'commented', at: c.createdAt, text: c.body });
	}
	for (const r of a.pr.reviews) {
		const kind = REVIEW_KIND[r.state];
		if (!kind || r.isBot || r.author === me) continue;
		if (kind === 'commented' && !r.body.trim() && !a.mine) continue;
		events.push({ who: r.author, kind, at: r.submittedAt, text: r.body });
	}
	if (!a.mine) {
		for (const t of a.pr.threads) {
			if (t.firstAuthor !== me || !t.lastAuthor || t.lastAuthor === me || t.lastIsBot || !t.lastAt) continue;
			events.push({ who: t.lastAuthor, kind: 'commented', at: t.lastAt, text: t.lastBody });
		}
	}
	return events.sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
}

/** Your PRs, PRs you were asked to review, and PRs you already reviewed or commented on. */
export function participates(a: Assessment, me: string): boolean {
	return (
		a.mine ||
		a.pr.requestedReviewers.includes(me) ||
		a.pr.reviews.some((r) => r.author === me) ||
		a.pr.comments.some((c) => c.author === me)
	);
}

/** Plain-text preview of a comment: no HTML comments, code blocks or markdown symbols. */
export function snippet(text: string, max = 100): string {
	const plain = text
		.replace(/<!--[\s\S]*?-->/g, ' ')
		.replace(/```[\s\S]*?```/g, ' [code] ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/[*_`>#]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
	return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}

const KIND_RANK: Record<ActivityKind, number> = { commented: 0, changes: 1, approved: 2 };

function activityNotice(a: Assessment, events: Activity[]): Notice {
	const main = events.reduce((best, e) => (KIND_RANK[e.kind] >= KIND_RANK[best.kind] ? e : best));
	const verb = main.kind === 'approved' ? 'approved' : main.kind === 'changes' ? 'requested changes on' : 'commented on';
	const last = [...events].reverse().find((e) => snippet(e.text)) ?? null;
	const lines = [`#${a.pr.number} ${a.pr.title}`];
	if (last) lines.push(`${last.who}: ${snippet(last.text)}`);
	if (events.length > 1) lines.push(`${events.length} new comments and reviews`);
	return { title: `${main.who} ${verb} #${a.pr.number}`, body: lines.join('\n'), url: a.pr.url };
}

export type Memory = Record<string, Remembered>;

export interface Notice {
	title: string;
	body: string;
	url: string;
}

export function remember(items: Assessment[], me: string, config: Config): Memory {
	const handles = botHandles(config);
	const memory: Memory = {};
	for (const a of items) {
		const events = activity(a, me, handles);
		memory[prKey(a.pr)] = {
			group: a.group,
			codex: a.codex.kind,
			headOid: a.pr.headOid,
			lastActivityAt: events.at(-1)?.at ?? '',
		};
	}
	return memory;
}

export function notices(previous: Memory | null, items: Assessment[], me: string, config: Config): Notice[] {
	if (previous === null) return [];
	const handles = botHandles(config);
	const out: Notice[] = [];
	for (const a of items) {
		const before = previous[prKey(a.pr)];
		const label = `#${a.pr.number} ${a.pr.title}`;

		// Someone approved, requested changes or commented. This says more than "your turn", so it replaces it.
		let announced = false;
		if (before?.lastActivityAt !== undefined && participates(a, me)) {
			const since = before.lastActivityAt;
			const fresh = activity(a, me, handles).filter((e) => !since || Date.parse(e.at) > Date.parse(since));
			if (fresh.length > 0) {
				out.push(activityNotice(a, fresh));
				announced = true;
			}
		}

		if (announced) {
			// Already told: skip the turn notice for this PR.
		} else if (a.group === 'review' && before?.group !== 'review') {
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
