import { gh } from './github.ts';

/*
 * A rebase (or a force-push that only moves the branch onto a newer base) makes
 * a new head commit without changing what the PR changes. Reviewers looked at
 * those changes, so a verdict on the old commit still holds for the new one.
 *
 * Two commits carry the same changes when the PR diff (`base...commit`, from
 * their own merge base) adds and removes the same lines in the same files.
 * Context lines and line numbers are ignored: the base moving around the PR's
 * changes (a CHANGELOG entry above yours, say) is not a change of the PR.
 */

interface CompareFile {
	filename: string;
	status: string;
	sha: string | null;
	patch?: string;
}

interface Compare {
	files?: CompareFile[];
}

/** GitHub stops listing files in a comparison after this many. */
const MAX_FILES = 300;

/** What a PR diff changes, as a comparable string, or null when GitHub did not list all of it. */
export function changeKey(files: CompareFile[]): string | null {
	if (files.length >= MAX_FILES) return null;
	const parts = files.map((f) => {
		const lines = f.patch
			? f.patch
					.split('\n')
					.filter((l) => (l.startsWith('+') || l.startsWith('-')) && !l.startsWith('+++') && !l.startsWith('---'))
					.join('\n')
			: `blob:${f.sha ?? ''}`;
		return `${f.status}\0${f.filename}\0${lines}`;
	});
	return parts.sort().join('\n\u0001\n');
}

/** The PR changes up to `oid`; null when too big to tell, undefined when GitHub did not answer. */
async function prChanges(repo: string, base: string, oid: string): Promise<string | null | undefined> {
	try {
		const raw = await gh(['api', `repos/${repo}/compare/${encodeURIComponent(base)}...${oid}`]);
		return changeKey((JSON.parse(raw) as Compare).files ?? []);
	} catch {
		// Unknown commit (garbage-collected after a force-push), or a network hiccup.
		return undefined;
	}
}

/**
 * The commits among `candidates` whose PR diff is the same as the head's.
 * `known` caches earlier answers (keyed by `sameChangesKey`) and is updated in place.
 */
export async function sameChangesAs(
	pr: { repo: string; baseRef: string; headOid: string },
	candidates: string[],
	known: Record<string, boolean>,
): Promise<string[]> {
	const out: string[] = [];
	let head: Promise<string | null | undefined> | null = null;
	for (const oid of candidates) {
		const key = sameChangesKey(pr, oid);
		if (!(key in known)) {
			head ??= prChanges(pr.repo, pr.baseRef, pr.headOid);
			const [a, b] = await Promise.all([head, prChanges(pr.repo, pr.baseRef, oid)]);
			// Not cached when GitHub did not answer, so the next refresh tries again.
			if (a === undefined || b === undefined) continue;
			known[key] = a !== null && a === b;
		}
		if (known[key]) out.push(oid);
	}
	return out;
}

export const sameChangesKey = (pr: { repo: string; headOid: string }, oid: string): string => `${pr.repo}@${oid}..${pr.headOid}`;
