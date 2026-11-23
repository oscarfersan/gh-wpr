import type { Approval } from '../bots/approval.ts';
import { isApproved } from '../bots/approval.ts';
import type { Config } from '../config.ts';
import type { Approvals } from '../turn.ts';

export interface SkippedBot {
	name: string;
	/** It reviewed the head and asked for changes, rather than not approving yet. */
	changes: boolean;
}

export type FinishReadiness =
	| { ok: true; /** Bots that have not approved the head; finishing goes ahead without them. */ skipping: SkippedBot[] }
	| { ok: false; why: string };

function skipped(name: string, approval: Approval): SkippedBot | null {
	return isApproved(approval) ? null : { name, changes: approval.kind === 'changes' };
}

/** "CodeRabbit asked for changes, Codex has not approved" */
export const describeSkipped = (bots: SkippedBot[]): string =>
	bots.map((b) => `${b.name} ${b.changes ? 'asked for changes' : 'has not approved'}`).join(', ');

/** Short form for the menu: "without CodeRabbit (changes), Codex" */
export const shortSkipped = (bots: SkippedBot[]): string =>
	bots.length === 0 ? '' : `without ${bots.map((b) => (b.changes ? `${b.name} (changes)` : b.name)).join(', ')}`;

/**
 * Whether a PR can be finished. A teammate's approval is what counts; the bots'
 * reviews are optional unless `finish.requireBots` is set.
 */
export function finishReadiness(approvals: Approvals, isDraft: boolean, config: Config): FinishReadiness {
	if (isDraft) return { ok: false, why: 'it is a draft' };
	if (approvals.human.kind === 'changes') return { ok: false, why: `${approvals.human.by?.join(', ') || 'a reviewer'} asked for changes` };
	if (approvals.human.kind !== 'approved') return { ok: false, why: 'no teammate has approved it yet' };
	const skipping = [skipped('CodeRabbit', approvals.coderabbit), skipped('Codex', approvals.codex)].filter((b): b is SkippedBot => b !== null);
	if (config.finish.requireBots && skipping.length > 0) return { ok: false, why: `${describeSkipped(skipping)} ("finish.requireBots" is on)` };
	return { ok: true, skipping };
}
