import { parseConfig } from '../src/config.ts';
import type { Config } from '../src/config.ts';
import type { CheckRun, IssueComment, PullRequest, Review, ReviewThread } from '../src/types.ts';

/** Synthetic data only: this repo is public, so nothing here comes from real PRs. */

export const NOW = new Date('2030-01-15T12:00:00Z');
export const HEAD = 'aaaaaaa1111111111111111111111111111111111';
export const OLD = 'bbbbbbb2222222222222222222222222222222222';

export const minutesAgo = (m: number): string => new Date(NOW.getTime() - m * 60_000).toISOString();
export const minutesFromNow = (m: number): string => new Date(NOW.getTime() + m * 60_000).toISOString();

export const config: Config = parseConfig({
	repos: ['acme/api'],
	team: ['alice', 'bob'],
	ignoreChecks: ['Triage'],
});

export function makePr(overrides: Partial<PullRequest> = {}): PullRequest {
	return {
		repo: 'acme/api',
		number: 42,
		title: 'Add the thing',
		url: 'https://github.com/acme/api/pull/42',
		author: 'alice',
		isDraft: false,
		mergeable: 'MERGEABLE',
		updatedAt: minutesAgo(1),
		headOid: HEAD,
		headCommittedAt: minutesAgo(60),
		checkRuns: [],
		labels: [],
		requestedReviewers: [],
		reviews: [],
		comments: [],
		threads: [],
		...overrides,
	};
}

export function check(overrides: Partial<CheckRun> = {}): CheckRun {
	return {
		name: 'CodeRabbit',
		status: 'COMPLETED',
		conclusion: 'SUCCESS',
		startedAt: minutesAgo(55),
		completedAt: minutesAgo(50),
		title: 'Finished',
		...overrides,
	};
}

export const crRateLimited = (startedMinutesAgo = 55): CheckRun =>
	check({ conclusion: 'NEUTRAL', title: 'Review rate limited', startedAt: minutesAgo(startedMinutesAgo), completedAt: minutesAgo(startedMinutesAgo) });
export const crPaused = (): CheckRun => check({ conclusion: 'SKIPPED', title: 'Review paused' });
export const crRunning = (startedMinutesAgo: number): CheckRun =>
	check({ status: 'IN_PROGRESS', conclusion: null, title: 'Review in progress', startedAt: minutesAgo(startedMinutesAgo), completedAt: null });

const BOTS = new Set(['coderabbitai', 'chatgpt-codex-connector', 'github-actions']);

export function comment(author: string, body: string, createdMinutesAgo: number, updatedMinutesAgo = createdMinutesAgo): IssueComment {
	return {
		author,
		isBot: BOTS.has(author),
		body,
		createdAt: minutesAgo(createdMinutesAgo),
		updatedAt: minutesAgo(updatedMinutesAgo),
		url: `https://github.com/acme/api/pull/42#issuecomment-${createdMinutesAgo}`,
	};
}

export function review(author: string, commitOid: string, submittedMinutesAgo: number, state = 'COMMENTED', body = ''): Review {
	return { author, isBot: BOTS.has(author), state, body, submittedAt: minutesAgo(submittedMinutesAgo), commitOid };
}

export function thread(firstAuthor: string, lastAuthor: string, overrides: Partial<ReviewThread> = {}): ReviewThread {
	return {
		isResolved: false,
		firstAuthor,
		lastAuthor,
		lastIsBot: BOTS.has(lastAuthor),
		lastAt: minutesAgo(5),
		lastBody: 'why?',
		path: 'src/service/repository.ts',
		url: `https://github.com/acme/api/pull/42#discussion_${firstAuthor}`,
		...overrides,
	};
}

export const rateLimitNotice = (wait: string, updatedMinutesAgo: number): IssueComment =>
	comment(
		'coderabbitai',
		`<!-- This is an auto-generated comment: rate limited by coderabbit.ai -->\n> ## Review limit reached\n> **Next included review available in ${wait}.**`,
		updatedMinutesAgo,
	);

export const codexSummary = (sha: string, status: string, updatedMinutesAgo: number): IssueComment =>
	comment(
		'chatgpt-codex-connector',
		`<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 {"code_review":{"commit_sha":"${sha}","status":"${status}"}} -->\nSummary`,
		updatedMinutesAgo,
	);
