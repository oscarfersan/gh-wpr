import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gh } from './github.ts';
import { stateDir } from './paths.ts';

/**
 * Team settings live in each repository, so a teammate gets them without copying
 * values around. Personal settings stay in ~/.config/gh-wpr/config.json and win.
 */
export const TEAM_FILE = '.github/wpr.json';

/** Settings that are the same for the whole team and may be committed. */
export const TEAM_KEYS = ['team', 'ignoreChecks', 'coderabbit', 'codex', 'notion', 'nudge', 'labels'] as const;

/** Settings that belong to one person (paths, preferences, secrets) and never go in the team file. */
export const PERSONAL_KEYS = ['repos', 'localPaths', 'notify', 'claude', 'fullRefreshMinutes'] as const;

/** How often the team file is fetched again; a fetch that fails keeps the last copy. */
export const TEAM_TTL_MINUTES = 60;

export type Settings = Record<string, unknown>;

export type TeamFileStatus = 'found' | 'absent' | 'invalid';

export interface TeamFile {
	repo: string;
	status: TeamFileStatus;
	fetchedAt: string;
	settings?: Settings;
	error?: string;
	/** The last fetch failed (network, permissions); `status` is from the copy before it. */
	fetchError?: string;
}

export class TeamFileError extends Error {}

const isObject = (value: unknown): value is Settings => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Checks the shape of a team file. Values are validated later, together with the personal config. */
export function parseTeamFile(raw: unknown): Settings {
	if (!isObject(raw)) throw new TeamFileError('must be a JSON object');
	for (const key of Object.keys(raw)) {
		if ((PERSONAL_KEYS as readonly string[]).includes(key)) {
			throw new TeamFileError(`"${key}" is a personal setting: set it in your own config, not in ${TEAM_FILE}`);
		}
		if (!(TEAM_KEYS as readonly string[]).includes(key)) {
			throw new TeamFileError(`unknown setting "${key}" (allowed: ${TEAM_KEYS.join(', ')})`);
		}
	}
	return raw;
}

/**
 * Layers settings: later layers win, key by key. Objects (such as "coderabbit")
 * are merged one level deep, so a person can change one bot setting and keep the rest.
 */
export function layer(...layers: Settings[]): Settings {
	const out: Settings = {};
	for (const settings of layers) {
		for (const [key, value] of Object.entries(settings)) {
			const current = out[key];
			out[key] = isObject(current) && isObject(value) ? { ...current, ...value } : value;
		}
	}
	return out;
}

/**
 * Team settings from the files of every followed repo. When repos disagree, the
 * first repo listed wins and the setting is reported as a conflict.
 */
export function combineTeamFiles(files: TeamFile[]): { settings: Settings; conflicts: string[] } {
	const found = files.filter((f) => f.status === 'found' && f.settings);
	const conflicts = new Set<string>();
	const seen = new Map<string, string>();
	for (const file of found) {
		for (const [key, value] of Object.entries(file.settings ?? {})) {
			const entries: [string, unknown][] = isObject(value) ? Object.entries(value).map(([k, v]) => [`${key}.${k}`, v]) : [[key, value]];
			for (const [path, v] of entries) {
				const json = JSON.stringify(v);
				const previous = seen.get(path);
				if (previous === undefined) seen.set(path, json);
				else if (previous !== json) conflicts.add(path);
			}
		}
	}
	// layer() makes later layers win, so the first repo goes last.
	const settings = layer(...found.map((f) => f.settings ?? {}).reverse());
	return { settings, conflicts: [...conflicts].sort() };
}

const cacheDir = (): string => join(stateDir(), 'team');
const cacheFile = (repo: string): string => join(cacheDir(), `${repo.toLowerCase().replace('/', '__')}.json`);

export function readTeamFile(repo: string): TeamFile | null {
	const path = cacheFile(repo);
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, 'utf8')) as TeamFile;
	} catch {
		return null;
	}
}

function writeTeamFile(file: TeamFile): void {
	mkdirSync(cacheDir(), { recursive: true });
	writeFileSync(cacheFile(file.repo), `${JSON.stringify(file, null, 2)}\n`);
}

/** Reads `.github/wpr.json` from the repo's default branch on GitHub. */
export async function fetchTeamFile(repo: string, now = new Date()): Promise<TeamFile> {
	const fetchedAt = now.toISOString();
	let body: string;
	try {
		body = await gh(['api', `repos/${repo}/contents/${TEAM_FILE}`, '-H', 'Accept: application/vnd.github.raw']);
	} catch (error) {
		const message = (error as Error).message;
		if (/HTTP 404|Not Found/i.test(message)) return { repo, status: 'absent', fetchedAt };
		const previous = readTeamFile(repo);
		return { ...(previous ?? { repo, status: 'absent' }), fetchedAt, fetchError: message.split('\n')[0] };
	}
	try {
		return { repo, status: 'found', fetchedAt, settings: parseTeamFile(JSON.parse(body)) };
	} catch (error) {
		return { repo, status: 'invalid', fetchedAt, error: (error as Error).message };
	}
}

/** Fetches the team files older than `maxAgeMinutes` (all of them with `force`). Never throws. */
export async function refreshTeamFiles(repos: string[], options: { force?: boolean; maxAgeMinutes?: number; now?: Date } = {}): Promise<TeamFile[]> {
	const now = options.now ?? new Date();
	const maxAge = (options.maxAgeMinutes ?? TEAM_TTL_MINUTES) * 60_000;
	return Promise.all(
		repos.map(async (repo) => {
			const cached = readTeamFile(repo);
			if (!options.force && cached && now.getTime() - Date.parse(cached.fetchedAt) < maxAge) return cached;
			const fresh = await fetchTeamFile(repo, now);
			try {
				writeTeamFile(fresh);
			} catch {
				// A read-only state folder only means fetching again next time.
			}
			return fresh;
		}),
	);
}
