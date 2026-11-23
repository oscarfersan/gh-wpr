/** GitHub logins are case-insensitive, and REST adds a `[bot]` suffix that GraphQL omits. */
export const normLogin = (login: string | null | undefined): string =>
	(login ?? 'ghost').replace(/\[bot\]$/i, '').toLowerCase();

export const minutesSince = (iso: string, now: Date): number => (now.getTime() - Date.parse(iso)) / 60_000;

export const addMs = (iso: string, ms: number): string => new Date(Date.parse(iso) + ms).toISOString();

export const isAfter = (a: string, b: string): boolean => Date.parse(a) > Date.parse(b);

export const short = (oid: string | null | undefined): string => (oid ?? '').slice(0, 7);

export function latestBy<T>(items: T[], date: (item: T) => string | null): T | null {
	let best: T | null = null;
	let bestAt = -Infinity;
	for (const item of items) {
		const at = date(item);
		const ms = at ? Date.parse(at) : -Infinity;
		if (best === null || ms > bestAt) {
			best = item;
			bestAt = ms;
		}
	}
	return best;
}

export function formatAgo(iso: string, now: Date): string {
	const min = Math.max(0, Math.round(minutesSince(iso, now)));
	if (min < 60) return `${min} min`;
	const h = Math.floor(min / 60);
	if (h < 48) return `${h} h`;
	return `${Math.floor(h / 24)} d`;
}

export function formatClock(iso: string): string {
	const d = new Date(iso);
	return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** True when a short or full sha names the given commit. */
export const matchesOid = (oid: string, sha: string): boolean => sha.length >= 7 && oid.toLowerCase().startsWith(sha.toLowerCase());

/** True when two shas, short or full, name the same commit. */
export const sameOid = (a: string, b: string): boolean => (a.length >= b.length ? matchesOid(a, b) : matchesOid(b, a));

/** True when a sha names the head, or a commit with the same changes that the branch was rebased from. */
export const isHeadChanges = (pr: { headOid: string; sameChangesAs?: string[] }, sha: string): boolean =>
	matchesOid(pr.headOid, sha) || (pr.sameChangesAs ?? []).some((oid) => sameOid(oid, sha));

/**
 * When the current head became reviewable: the later of its commit and the PR
 * leaving draft. Bots skip drafts, so anything they did before that is stale.
 */
export const reviewableSince = (pr: { headCommittedAt: string; readyAt: string | null }): string =>
	pr.readyAt && isAfter(pr.readyAt, pr.headCommittedAt) ? pr.readyAt : pr.headCommittedAt;
