import type { NotionConfig } from '../config.ts';
import type { PullRequest } from '../types.ts';
import { latestBy, matchesOid } from '../util.ts';
import type { Approval } from './approval.ts';

/*
 * Notion AI reviews drafts through Notion's GitHub connector, which posts as
 * the person who asked. Nothing tells its comments apart from theirs, so it
 * ends each review with a fixed line naming the verdict and the commit:
 *
 *   Notion AI review: APPROVED for abc1234
 *   Notion AI review: CHANGES REQUESTED for abc1234
 *
 * Comments, reviews and review threads all count.
 */

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function notionVerdictRe(marker: string): RegExp {
	return new RegExp(
		`${escape(marker)}\\s*:?\\s*\\**\\s*(APPROVED|CHANGES[ _]REQUESTED)\\s*\\**\\s+(?:for|on)\\s+(?:commit\\s+)?\`?([0-9a-f]{7,40})\`?`,
		'gi',
	);
}

export function notionApproval(pr: PullRequest, config: NotionConfig): Approval {
	if (!config.enabled) return { kind: 'disabled' };
	const re = notionVerdictRe(config.marker);
	const texts = [
		...pr.comments.map((c) => ({ body: c.body, at: c.updatedAt })),
		...pr.reviews.map((r) => ({ body: r.body, at: r.submittedAt })),
		...pr.threads.filter((t) => t.lastAt).map((t) => ({ body: t.lastBody, at: t.lastAt as string })),
	];
	const verdicts: { approved: boolean; oid: string; at: string }[] = [];
	for (const text of texts) {
		for (const match of text.body.matchAll(re)) {
			verdicts.push({ approved: match[1].toUpperCase() === 'APPROVED', oid: match[2], at: text.at });
		}
	}
	const last = latestBy(verdicts, (v) => v.at);
	if (!last) return { kind: 'none' };
	if (!matchesOid(pr.headOid, last.oid)) return { kind: 'stale', oid: last.oid };
	return last.approved ? { kind: 'approved', at: last.at } : { kind: 'changes', at: last.at };
}
