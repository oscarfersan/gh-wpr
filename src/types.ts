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
	state: string;
	submittedAt: string;
	commitOid: string | null;
}

export interface IssueComment {
	author: string;
	body: string;
	createdAt: string;
	updatedAt: string;
	url: string;
}

export interface ReviewThread {
	isResolved: boolean;
	lastAuthor: string | null;
}

export interface PullRequest {
	repo: string;
	number: number;
	title: string;
	url: string;
	author: string;
	isDraft: boolean;
	mergeable: Mergeable;
	updatedAt: string;
	headOid: string;
	headCommittedAt: string;
	checkRuns: CheckRun[];
	labels: string[];
	requestedReviewers: string[];
	reviews: Review[];
	comments: IssueComment[];
	threads: ReviewThread[];
}

export type Bot = 'coderabbit' | 'codex';

export const prKey = (pr: { repo: string; number: number }): string => `${pr.repo}#${pr.number}`;
