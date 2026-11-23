export type Mergeable = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';

/** A check run or a commit status, normalised to the same shape. */
export interface CheckRun {
	name: string;
	/** QUEUED | IN_PROGRESS | COMPLETED | PENDING ... (upper case, as GitHub returns it) */
	status: string;
	/** SUCCESS | FAILURE | NEUTRAL | SKIPPED | CANCELLED ... or null while running */
	conclusion: string | null;
	startedAt: string | null;
	completedAt: string | null;
	title: string | null;
}

export interface Review {
	author: string;
	/** GitHub apps (CodeRabbit, Codex, Actions...). */
	isBot: boolean;
	state: string;
	body: string;
	submittedAt: string;
	commitOid: string | null;
}

export interface IssueComment {
	author: string;
	isBot: boolean;
	body: string;
	createdAt: string;
	updatedAt: string;
	url: string;
}

export interface ReviewThread {
	isResolved: boolean;
	/** Who opened the thread. */
	firstAuthor: string | null;
	lastAuthor: string | null;
	lastIsBot: boolean;
	lastAt: string | null;
	lastBody: string;
	/** File the thread is on, and a link to its last comment. */
	path: string | null;
	url: string | null;
}

/** One reaction on the PR description. */
export interface Reaction {
	/** THUMBS_UP | EYES | ... (upper case, as GitHub returns it) */
	content: string;
	login: string;
	at: string;
}

export interface PullRequest {
	repo: string;
	number: number;
	title: string;
	url: string;
	author: string;
	isDraft: boolean;
	/** Last time the PR left draft, or null if it never was one. */
	readyAt: string | null;
	/** Reactions on the PR description (Codex puts 👍 there when it finds nothing). */
	reactions: Reaction[];
	mergeable: Mergeable;
	updatedAt: string;
	/** Branch the PR merges into. */
	baseRef: string;
	headOid: string;
	headCommittedAt: string;
	/**
	 * Older commits a bot reviewed whose PR diff is the same as the head's: the branch was only
	 * rebased since. Their verdicts still hold. Missing in caches from older versions.
	 */
	sameChangesAs?: string[];
	checkRuns: CheckRun[];
	labels: string[];
	requestedReviewers: string[];
	reviews: Review[];
	comments: IssueComment[];
	threads: ReviewThread[];
}

export type Bot = 'coderabbit' | 'codex';

export const prKey = (pr: { repo: string; number: number }): string => `${pr.repo}#${pr.number}`;
