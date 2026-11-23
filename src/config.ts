import { existsSync, readFileSync } from 'node:fs';
import { configFile } from './paths.ts';
import { combineTeamFiles, layer, readTeamFile, refreshTeamFiles } from './team.ts';
import type { TeamFile } from './team.ts';
import { normLogin } from './util.ts';

export interface CodeRabbitConfig {
	enabled: boolean;
	login: string;
	/** Name of the check run CodeRabbit leaves on every commit. */
	checkName: string;
	/** Comment posted when CodeRabbit is rate limited, paused or stuck. */
	unstickCommand: string;
	/** No check run and no answer this long after a push or a request: stuck. */
	noStartAfterMinutes: number;
	/** A review still running after this long: stuck. */
	stuckAfterMinutes: number;
	/** Retry delay when the rate-limit notice does not say when the next review is available. */
	rateLimitFallbackMinutes: number;
}

export interface CodexConfig {
	enabled: boolean;
	login: string;
	command: string;
	/** A request with no answer after this long can be sent again. */
	timeoutMinutes: number;
}

export interface NotionConfig {
	enabled: boolean;
	/**
	 * Start of the line Notion AI ends its review with, followed by APPROVED or
	 * CHANGES REQUESTED and the commit: "Notion AI review: APPROVED for abc1234".
	 */
	marker: string;
}

export type NudgeMode = 'request' | 'comment' | 'both';

export interface NudgeConfig {
	/** request: GitHub's re-request button · comment: post `comment` · both. */
	mode: NudgeMode;
	/** Comment posted in comment mode. {mentions} becomes "@alice @bob". */
	comment: string;
}

export interface LabelsConfig {
	needsReview: string;
	needsAuthor: string;
	approved: string;
}

export type MergeMethod = 'merge' | 'squash' | 'rebase';

export interface FinishConfig {
	/** How "gh wpr finish" merges once CI passes. */
	mergeMethod: MergeMethod;
	/** Delete the PR's branch on GitHub after the merge (never for forks). */
	deleteBranch: boolean;
	/** Wait for CI on the rebased commit before merging. */
	waitForCi: boolean;
}

export type TrackerKind = 'none' | 'notion';

export interface TrackerConfig {
	/** Where the PR's card lives. "none" skips the card update. */
	kind: TrackerKind;
	/** Notion data source (or database) holding the cards. */
	dataSourceId: string;
	/** Property that holds the PR's URL; the card is found by it. */
	prProperty: string;
	/** Status (or select) property set after the merge. */
	statusProperty: string;
	/** Text or URL property that gets the merge commit. */
	commitProperty: string;
	/** Status to set, by the PR's base branch. Keys may use * ("hotfix/*"). */
	statusByBase: Record<string, string>;
}

export interface ClaudeConfig {
	/** Command that starts Claude Code; extra arguments are allowed ("claude --model opus"). */
	command: string;
	/** First prompt. {url}, {number} and {repo} are replaced. */
	prompt: string;
}

export interface Config {
	repos: string[];
	team: string[];
	/** Local checkout of each repo, where "gh wpr claude" starts Claude Code. */
	localPaths: Record<string, string>;
	/** macOS notifications from the menu bar plugin. */
	notify: boolean;
	claude: ClaudeConfig;
	/** Check names that never count towards CI (e.g. a flaky triage workflow). */
	ignoreChecks: string[];
	/** Refetch every PR in full at least this often, even when GitHub reports no change. */
	fullRefreshMinutes: number;
	coderabbit: CodeRabbitConfig;
	codex: CodexConfig;
	notion: NotionConfig;
	nudge: NudgeConfig;
	labels: LabelsConfig;
	finish: FinishConfig;
	tracker: TrackerConfig;
}

export const DEFAULTS: Omit<Config, 'repos' | 'team' | 'localPaths'> = {
	notify: true,
	claude: {
		command: 'claude',
		prompt: 'Triage the open review comments on {url}',
	},
	ignoreChecks: [],
	fullRefreshMinutes: 10,
	coderabbit: {
		enabled: true,
		login: 'coderabbitai',
		checkName: 'CodeRabbit',
		unstickCommand: '@coderabbitai full review',
		noStartAfterMinutes: 10,
		stuckAfterMinutes: 30,
		rateLimitFallbackMinutes: 10,
	},
	codex: {
		enabled: true,
		login: 'chatgpt-codex-connector',
		command: '@codex review',
		timeoutMinutes: 15,
	},
	notion: {
		enabled: true,
		marker: 'Notion AI review',
	},
	nudge: {
		mode: 'request',
		comment: '{mentions} review',
	},
	labels: {
		needsReview: 'needs-review',
		needsAuthor: 'needs-author-action',
		approved: 'approved',
	},
	finish: {
		mergeMethod: 'merge',
		deleteBranch: true,
		waitForCi: true,
	},
	tracker: {
		kind: 'none',
		dataSourceId: '',
		prProperty: 'PR',
		statusProperty: 'Status',
		commitProperty: 'Merge commit',
		statusByBase: {},
	},
};

export class ConfigError extends Error {}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringList(value: unknown, field: string): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
		throw new ConfigError(`"${field}" must be a list of strings`);
	}
	return value as string[];
}

function merge<T extends object>(base: T, override: unknown, field: string): T {
	if (override === undefined) return { ...base };
	if (!isObject(override)) throw new ConfigError(`"${field}" must be an object`);
	const defaults = base as Record<string, unknown>;
	const out: Record<string, unknown> = { ...defaults };
	for (const [key, value] of Object.entries(override)) {
		if (!(key in defaults)) throw new ConfigError(`Unknown setting "${field}.${key}"`);
		const expected = typeof defaults[key];
		if (typeof value !== expected) throw new ConfigError(`"${field}.${key}" must be a ${expected}`);
		out[key] = value;
	}
	return out as T;
}

const NUDGE_MODES: NudgeMode[] = ['request', 'comment', 'both'];

function parseNudge(raw: unknown): NudgeConfig {
	const nudge = merge(DEFAULTS.nudge, raw, 'nudge');
	if (!NUDGE_MODES.includes(nudge.mode)) throw new ConfigError(`"nudge.mode" must be one of ${NUDGE_MODES.join(', ')}`);
	if (nudge.mode !== 'request' && !nudge.comment.includes('{mentions}')) {
		throw new ConfigError('"nudge.comment" needs {mentions} to say who should review');
	}
	return nudge;
}

const MERGE_METHODS: MergeMethod[] = ['merge', 'squash', 'rebase'];
const TRACKER_KINDS: TrackerKind[] = ['none', 'notion'];

function parseFinish(raw: unknown): FinishConfig {
	const finish = merge(DEFAULTS.finish, raw, 'finish');
	if (!MERGE_METHODS.includes(finish.mergeMethod)) throw new ConfigError(`"finish.mergeMethod" must be one of ${MERGE_METHODS.join(', ')}`);
	return finish;
}

function parseTracker(raw: unknown): TrackerConfig {
	const tracker = merge(DEFAULTS.tracker, raw, 'tracker');
	if (!TRACKER_KINDS.includes(tracker.kind)) throw new ConfigError(`"tracker.kind" must be one of ${TRACKER_KINDS.join(', ')}`);
	if (!isObject(tracker.statusByBase) || Object.values(tracker.statusByBase).some((v) => typeof v !== 'string')) {
		throw new ConfigError('"tracker.statusByBase" must map branch names to status names');
	}
	if (tracker.kind === 'notion' && !tracker.dataSourceId) throw new ConfigError('"tracker.dataSourceId" is needed when "tracker.kind" is "notion"');
	return tracker;
}

export function parseConfig(raw: unknown): Config {
	if (!isObject(raw)) throw new ConfigError('The config must be a JSON object');
	const repos = stringList(raw.repos, 'repos');
	if (repos.length === 0) throw new ConfigError('"repos" needs at least one "owner/name"');
	const bad = repos.find((r) => !REPO_RE.test(r));
	if (bad) throw new ConfigError(`"${bad}" is not a valid "owner/name" repository`);

	const fullRefreshMinutes = raw.fullRefreshMinutes ?? DEFAULTS.fullRefreshMinutes;
	if (typeof fullRefreshMinutes !== 'number') throw new ConfigError('"fullRefreshMinutes" must be a number');

	const notify = raw.notify ?? DEFAULTS.notify;
	if (typeof notify !== 'boolean') throw new ConfigError('"notify" must be true or false');

	const localPaths: Record<string, string> = {};
	if (raw.localPaths !== undefined) {
		if (!isObject(raw.localPaths)) throw new ConfigError('"localPaths" must map "owner/name" to a folder');
		for (const [repo, path] of Object.entries(raw.localPaths)) {
			if (typeof path !== 'string') throw new ConfigError(`"localPaths.${repo}" must be a folder path`);
			localPaths[repo.toLowerCase()] = path;
		}
	}

	const coderabbit = merge(DEFAULTS.coderabbit, raw.coderabbit, 'coderabbit');
	const codex = merge(DEFAULTS.codex, raw.codex, 'codex');
	coderabbit.login = normLogin(coderabbit.login);
	codex.login = normLogin(codex.login);

	return {
		repos,
		team: stringList(raw.team, 'team').map(normLogin),
		localPaths,
		notify,
		claude: merge(DEFAULTS.claude, raw.claude, 'claude'),
		ignoreChecks: stringList(raw.ignoreChecks, 'ignoreChecks'),
		fullRefreshMinutes,
		coderabbit,
		codex,
		notion: merge(DEFAULTS.notion, raw.notion, 'notion'),
		nudge: parseNudge(raw.nudge),
		labels: merge(DEFAULTS.labels, raw.labels, 'labels'),
		finish: parseFinish(raw.finish),
		tracker: parseTracker(raw.tracker),
	};
}

export interface TeamSource {
	repo: string;
	status: TeamFile['status'];
	/** Why the file was ignored: bad JSON, a personal key, a wrong value. */
	error?: string;
	fetchError?: string;
	/** Never fetched yet (no network so far, or a repo just added). */
	missing?: boolean;
}

export interface LoadedConfig {
	config: Config;
	path: string;
	/** One entry per followed repo, in order. */
	teamFiles: TeamSource[];
	/** Team settings that followed repos set to different values; the first repo wins. */
	conflicts: string[];
}

function readPersonal(path: string): Record<string, unknown> {
	if (!existsSync(path)) {
		throw new ConfigError(`No config at ${path}. Run "gh wpr init" to create one.`);
	}
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, 'utf8'));
	} catch (error) {
		throw new ConfigError(`${path} is not valid JSON: ${(error as Error).message}`);
	}
	try {
		parseConfig(raw);
	} catch (error) {
		throw new ConfigError(`${path}: ${(error as Error).message}`);
	}
	return raw as Record<string, unknown>;
}

/**
 * Builds the config from the personal settings on top of the team files of the
 * followed repos. A team file with a wrong value is left out instead of breaking
 * everyone's menu; `teamFiles` says why.
 */
export function buildConfig(personal: Record<string, unknown>, files: (TeamFile | null)[], repos: string[]): Omit<LoadedConfig, 'path'> {
	const sources: TeamSource[] = [];
	const usable: TeamFile[] = [];
	repos.forEach((repo, i) => {
		const file = files[i];
		if (!file) {
			sources.push({ repo, status: 'absent', missing: true });
			return;
		}
		const source: TeamSource = { repo, status: file.status, error: file.error, fetchError: file.fetchError };
		if (file.status === 'found' && file.settings) {
			try {
				parseConfig({ ...file.settings, repos: [repo] });
				usable.push(file);
			} catch (error) {
				source.status = 'invalid';
				source.error = (error as Error).message;
			}
		}
		sources.push(source);
	});
	const team = combineTeamFiles(usable);
	return { config: parseConfig(layer(team.settings, personal)), teamFiles: sources, conflicts: team.conflicts };
}

/** Reads the config using the team files already fetched; no network. */
export function loadConfigDetails(path: string = configFile()): LoadedConfig {
	const personal = readPersonal(path);
	const repos = personal.repos as string[];
	return { path, ...buildConfig(personal, repos.map(readTeamFile), repos) };
}

export function loadConfig(path: string = configFile()): Config {
	return loadConfigDetails(path).config;
}

/** Same, after fetching team files that are older than an hour (all of them with `force`). */
export async function loadConfigFresh(options: { force?: boolean; path?: string } = {}): Promise<LoadedConfig> {
	const path = options.path ?? configFile();
	const personal = readPersonal(path);
	await refreshTeamFiles(personal.repos as string[], { force: options.force });
	return loadConfigDetails(path);
}
