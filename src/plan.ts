import { coderabbitDone, coderabbitState } from './bots/coderabbit.ts';
import type { CodeRabbitState, UnstickReason } from './bots/coderabbit.ts';
import { codexState } from './bots/codex.ts';
import type { Config } from './config.ts';
import type { Bot, PullRequest } from './types.ts';
import { formatAgo, formatClock, short } from './util.ts';

export type PlannedAction =
	| { kind: 'post'; bot: Bot; body: string; why: string }
	| { kind: 'schedule'; bot: 'coderabbit'; body: string; at: string; why: string }
	| { kind: 'enqueue'; bot: 'codex'; body: string; why: string; force?: boolean }
	| { kind: 'skip'; bot: Bot; why: string };

export interface PlanOptions {
	force?: boolean;
	/** Only act on one bot. Asking for Codex explicitly skips the wait for CodeRabbit. */
	only?: Bot;
	/** Leave Codex out of PRs where nobody asked it yet (it is optional). */
	codexOnlyInPlay?: boolean;
}

export interface Plan {
	blocked: string | null;
	actions: PlannedAction[];
}

const UNSTICK_WHY: Record<UnstickReason, string> = {
	paused: 'paused its automatic reviews',
	failed: 'failed its last review',
	no_response: 'has not reviewed this commit',
	too_slow: 'has been reviewing for too long',
};

export function blockedReason(pr: PullRequest): string | null {
	if (pr.isDraft) return 'the PR is a draft';
	if (pr.mergeable === 'CONFLICTING') return 'the PR has merge conflicts';
	return null;
}

function planCodeRabbit(state: CodeRabbitState, config: Config, pr: PullRequest, now: Date, force: boolean): PlannedAction | null {
	const body = config.coderabbit.unstickCommand;
	const post = (why: string): PlannedAction => ({ kind: 'post', bot: 'coderabbit', body, why });
	const skip = (why: string): PlannedAction => ({ kind: 'skip', bot: 'coderabbit', why });
	switch (state.kind) {
		case 'disabled':
			return null;
		case 'reviewed':
			return force ? post('forced') : skip(`already reviewed ${short(pr.headOid)}`);
		case 'skipped':
			return force ? post('forced') : skip('no files to review in this commit');
		case 'reviewing':
			return force ? post('forced') : skip(`reviewing for ${formatAgo(state.since, now)}`);
		case 'requested':
			return force ? post('forced') : skip(`full review requested ${formatAgo(state.at, now)} ago, waiting`);
		case 'rate_limited':
			if (Date.parse(state.retryAt) <= now.getTime()) return post('rate limit is over');
			if (force) return post(`forced, although rate limited until ${formatClock(state.retryAt)}`);
			return {
				kind: 'schedule',
				bot: 'coderabbit',
				body,
				at: state.retryAt,
				why: `rate limited until ${formatClock(state.retryAt)}`,
			};
		case 'needs_unstick':
			if (state.alreadyRequested && !force) {
				return skip(`${UNSTICK_WHY[state.reason]} even after a request for this commit; use --force to ask again`);
			}
			return post(UNSTICK_WHY[state.reason]);
	}
}

/** Decides what to post so that CodeRabbit is reviewed first and Codex right after. */
export function planAi(pr: PullRequest, config: Config, now: Date, options: PlanOptions = {}): Plan {
	const blocked = blockedReason(pr);
	if (blocked) return { blocked, actions: [] };

	const force = options.force ?? false;
	const actions: PlannedAction[] = [];
	const cr = coderabbitState(pr, config.coderabbit, now);

	if (options.only !== 'codex') {
		const action = planCodeRabbit(cr, config, pr, now, force);
		if (action) actions.push(action);
	}

	if (options.only !== 'coderabbit') {
		const codex = codexState(pr, config.codex, now);
		const body = config.codex.command;
		// If CodeRabbit is about to review again (even when forced), Codex waits for it.
		const crWillRun = actions.some((a) => a.bot === 'coderabbit' && (a.kind === 'post' || a.kind === 'schedule'));
		const crReady = options.only === 'codex' || (coderabbitDone(cr) && !crWillRun);
		const forced = (): PlannedAction =>
			crReady
				? { kind: 'post', bot: 'codex', body, why: 'forced' }
				: { kind: 'enqueue', bot: 'codex', body, why: 'forced, queued until CodeRabbit reviews again', force: true };
		switch (codex.kind) {
			case 'disabled':
				break;
			case 'never':
				if (options.codexOnlyInPlay && options.only !== 'codex') {
					actions.push({ kind: 'skip', bot: 'codex', why: 'not requested on this PR; use --bot codex to ask it' });
					break;
				}
				actions.push(crReady ? { kind: 'post', bot: 'codex', body, why: 'not reviewed yet' } : { kind: 'enqueue', bot: 'codex', body, why: `queued until CodeRabbit reviews ${short(pr.headOid)}` });
				break;
			case 'reviewed':
				actions.push(force ? forced() : { kind: 'skip', bot: 'codex', why: `already reviewed ${short(pr.headOid)}` });
				break;
			case 'running':
				actions.push(
					force ? forced() : { kind: 'skip', bot: 'codex', why: `review in progress for ${formatAgo(codex.since, now)}` },
				);
				break;
			default: {
				const why =
					codex.kind === 'timed_out'
						? 'last request got no answer'
						: codex.kind === 'outdated'
							? `last reviewed ${short(codex.reviewedOid)}`
							: 'not reviewed yet';
				if (crReady) actions.push({ kind: 'post', bot: 'codex', body, why });
				else actions.push({ kind: 'enqueue', bot: 'codex', body, why: `queued until CodeRabbit reviews ${short(pr.headOid)}` });
			}
		}
	}

	return { blocked: null, actions };
}
