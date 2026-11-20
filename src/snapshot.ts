import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.ts';
import { graphql } from './github.ts';
import { stateDir } from './paths.ts';
import type { CheckRun, Mergeable, PullRequest } from './types.ts';
import { prKey } from './types.ts';
import { minutesSince, normLogin } from './util.ts';

/*
 * Two-step fetch: a light search lists open PRs with their `updatedAt`, then the
 * heavy per-PR query (comments, reviews, checks) runs only for PRs that changed.
 * Bots sometimes edit comments without bumping `updatedAt`, so every PR is
 * refetched in full at least every `fullRefreshMinutes`.
 */

const PR_FIELDS = `
	number title url state isDraft mergeable updatedAt headRefOid
	author { login }
	repository { nameWithOwner }
	labels(first: 30) { nodes { name } }
	reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } ... on Bot { login } } } }
	reviews(last: 40) { nodes { author { login __typename } state body submittedAt commit { oid } } }
	comments(last: 40) { nodes { author { login __typename } body createdAt updatedAt url } }
	reviewThreads(last: 60) { nodes { isResolved path
		first: comments(first: 1) { nodes { author { login } } }
		last: comments(last: 1) { nodes { author { login __typename } createdAt body url } } } }
	commits(last: 1) { nodes { commit { oid committedDate statusCheckRollup { contexts(first: 80) { nodes {
		__typename
		... on CheckRun { name status conclusion startedAt completedAt title }
		... on StatusContext { context state createdAt }
	} } } } } }
`;

const LIGHT_QUERY = `
query($q: String!, $cursor: String) {
	viewer { login }
	search(query: $q, type: ISSUE, first: 50, after: $cursor) {
		pageInfo { hasNextPage endCursor }
		nodes { ... on PullRequest { number updatedAt headRefOid repository { nameWithOwner } } }
	}
}`;

interface LightPr {
	number: number;
	updatedAt: string;
	headRefOid: string;
	repository: { nameWithOwner: string };
}

interface LightResult {
	viewer: { login: string };
	search: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: (LightPr | Record<string, never>)[] };
}

type Login = { login: string; __typename?: string } | null;

interface RawContext {
	__typename: string;
	name?: string;
	status?: string;
	conclusion?: string | null;
	startedAt?: string | null;
	completedAt?: string | null;
	title?: string | null;
	context?: string;
	state?: string;
	createdAt?: string;
}

interface RawPr {
	number: number;
	title: string;
	url: string;
	/** OPEN | CLOSED | MERGED */
	state: string;
	isDraft: boolean;
	mergeable: Mergeable;
	updatedAt: string;
	headRefOid: string;
	author: Login;
	repository: { nameWithOwner: string };
	labels: { nodes: { name: string }[] };
	reviewRequests: { nodes: { requestedReviewer: Login | Record<string, never> }[] };
	reviews: { nodes: { author: Login; state: string; body: string; submittedAt: string; commit: { oid: string } | null }[] };
	comments: { nodes: { author: Login; body: string; createdAt: string; updatedAt: string; url: string }[] };
	reviewThreads: {
		nodes: {
			isResolved: boolean;
			path: string | null;
			first: { nodes: { author: Login }[] };
			last: { nodes: { author: Login; createdAt: string; body: string; url: string }[] };
		}[];
	};
	commits: {
		nodes: {
			commit: {
				oid: string;
				committedDate: string;
				statusCheckRollup: { contexts: { nodes: RawContext[] } } | null;
			};
		}[];
	};
}

function toCheckRun(raw: RawContext): CheckRun | null {
	if (raw.__typename === 'CheckRun' && raw.name) {
		return {
			name: raw.name,
			status: raw.status ?? 'COMPLETED',
			conclusion: raw.conclusion ?? null,
			startedAt: raw.startedAt ?? null,
			completedAt: raw.completedAt ?? null,
			title: raw.title ?? null,
		};
	}
	if (raw.__typename === 'StatusContext' && raw.context) {
		const pending = raw.state === 'PENDING' || raw.state === 'EXPECTED';
		return {
			name: raw.context,
			status: pending ? 'IN_PROGRESS' : 'COMPLETED',
			conclusion: pending ? null : (raw.state ?? null),
			startedAt: raw.createdAt ?? null,
			completedAt: pending ? null : (raw.createdAt ?? null),
			title: null,
		};
	}
	return null;
}

export function mapPullRequest(raw: RawPr): PullRequest {
	const head = raw.commits.nodes[0]?.commit;
	return {
		repo: raw.repository.nameWithOwner,
		number: raw.number,
		title: raw.title,
		url: raw.url,
		author: normLogin(raw.author?.login),
		isDraft: raw.isDraft,
		mergeable: raw.mergeable,
		updatedAt: raw.updatedAt,
		headOid: head?.oid ?? raw.headRefOid,
		headCommittedAt: head?.committedDate ?? raw.updatedAt,
		checkRuns: (head?.statusCheckRollup?.contexts.nodes ?? [])
			.map(toCheckRun)
			.filter((c): c is CheckRun => c !== null),
		labels: raw.labels.nodes.map((l) => l.name),
		requestedReviewers: raw.reviewRequests.nodes
			.map((n) => (n.requestedReviewer && 'login' in n.requestedReviewer ? normLogin(n.requestedReviewer.login) : null))
			.filter((l): l is string => l !== null),
		reviews: raw.reviews.nodes.map((r) => ({
			author: normLogin(r.author?.login),
			isBot: r.author?.__typename === 'Bot',
			state: r.state,
			body: r.body ?? '',
			submittedAt: r.submittedAt,
			commitOid: r.commit?.oid ?? null,
		})),
		comments: raw.comments.nodes.map((c) => ({
			author: normLogin(c.author?.login),
			isBot: c.author?.__typename === 'Bot',
			body: c.body,
			createdAt: c.createdAt,
			updatedAt: c.updatedAt,
			url: c.url,
		})),
		threads: raw.reviewThreads.nodes.map((t) => {
			const first = t.first.nodes[0];
			const last = t.last.nodes[0];
			return {
				isResolved: t.isResolved,
				firstAuthor: first ? normLogin(first.author?.login) : null,
				lastAuthor: last ? normLogin(last.author?.login) : null,
				lastIsBot: last?.author?.__typename === 'Bot',
				lastAt: last?.createdAt ?? null,
				lastBody: last?.body ?? '',
				path: t.path ?? null,
				url: last?.url ?? null,
			};
		}),
	};
}

/**
 * GitHub's search index lags a few minutes behind merges, so `is:open` can still
 * return a PR that was just merged or closed. Its own `state` is authoritative.
 */
export const isOpen = (raw: { state: string }): boolean => raw.state === 'OPEN';

const BATCH = 8;

async function fetchDetails(targets: { repo: string; number: number }[]): Promise<PullRequest[]> {
	const out: PullRequest[] = [];
	for (let i = 0; i < targets.length; i += BATCH) {
		const batch = targets.slice(i, i + BATCH);
		// Repo names are validated in config (owner/name with safe characters), so inlining is safe.
		const parts = batch.map((t, j) => {
			const [owner, name] = t.repo.split('/');
			return `p${j}: repository(owner: "${owner}", name: "${name}") { pullRequest(number: ${Number(t.number)}) { ${PR_FIELDS} } }`;
		});
		const data = await graphql<Record<string, { pullRequest: RawPr | null } | null>>(`query { ${parts.join('\n')} }`);
		for (let j = 0; j < batch.length; j++) {
			const pr = data[`p${j}`]?.pullRequest;
			if (pr && isOpen(pr)) out.push(mapPullRequest(pr));
		}
	}
	return out;
}

interface Cache {
	version: 4;
	fullAt: string | null;
	prs: Record<string, PullRequest>;
}

const cacheFile = (): string => join(stateDir(), 'snapshot.json');

function readCache(): Cache {
	try {
		const parsed = JSON.parse(readFileSync(cacheFile(), 'utf8')) as Cache;
		if (parsed.version === 4) return parsed;
	} catch {
		// Missing or corrupt cache: start over.
	}
	return { version: 4, fullAt: null, prs: {} };
}

function writeCache(cache: Cache): void {
	mkdirSync(stateDir(), { recursive: true });
	const tmp = `${cacheFile()}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(cache));
	renameSync(tmp, cacheFile());
}

export interface Snapshot {
	viewer: string;
	fetchedAt: string;
	prs: PullRequest[];
}

export interface SnapshotOptions {
	/** Refetch every PR in full, ignoring the cache. */
	full?: boolean;
	/** Refetch these PRs in full (keys from `prKey`), e.g. right before acting on them. */
	fresh?: string[];
}

export async function loadSnapshot(config: Config, options: SnapshotOptions = {}): Promise<Snapshot> {
	const now = new Date();
	const query = ['is:pr', 'is:open', 'archived:false', ...config.repos.map((r) => `repo:${r}`)].join(' ');

	let viewer = '';
	const light: LightPr[] = [];
	let cursor: string | null = null;
	for (let page = 0; page < 6; page++) {
		const variables: Record<string, string> = { q: query };
		if (cursor) variables.cursor = cursor;
		const data: LightResult = await graphql<LightResult>(LIGHT_QUERY, variables);
		viewer = normLogin(data.viewer.login);
		for (const node of data.search.nodes) if ('number' in node) light.push(node as LightPr);
		if (!data.search.pageInfo.hasNextPage) break;
		cursor = data.search.pageInfo.endCursor;
	}

	const cache = readCache();
	const full = options.full || !cache.fullAt || minutesSince(cache.fullAt, now) >= config.fullRefreshMinutes;
	const fresh = new Set(options.fresh ?? []);
	const stale = light.filter((p) => {
		const key = prKey({ repo: p.repository.nameWithOwner, number: p.number });
		const cached = cache.prs[key];
		return full || fresh.has(key) || !cached || cached.updatedAt !== p.updatedAt || cached.headOid !== p.headRefOid;
	});

	const fetched = await fetchDetails(stale.map((p) => ({ repo: p.repository.nameWithOwner, number: p.number })));
	const byKey = new Map(fetched.map((pr) => [prKey(pr), pr]));

	const prs: PullRequest[] = [];
	const next: Cache = { version: 4, fullAt: full ? now.toISOString() : cache.fullAt, prs: {} };
	for (const p of light) {
		const key = prKey({ repo: p.repository.nameWithOwner, number: p.number });
		const refetched = stale.some((s) => s.repository.nameWithOwner === p.repository.nameWithOwner && s.number === p.number);
		const pr = byKey.get(key) ?? (refetched ? undefined : cache.prs[key]);
		if (!pr) continue;
		prs.push(pr);
		next.prs[key] = pr;
	}
	writeCache(next);

	return { viewer, fetchedAt: now.toISOString(), prs };
}
