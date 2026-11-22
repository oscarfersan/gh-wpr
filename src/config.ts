import { existsSync, readFileSync } from 'node:fs';
import { configFile } from './paths.ts';
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

export interface LabelsConfig {
	needsReview: string;
	needsAuthor: string;
	approved: string;
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
	labels: LabelsConfig;
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
	labels: {
		needsReview: 'needs-review',
		needsAuthor: 'needs-author-action',
		approved: 'approved',
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
		labels: merge(DEFAULTS.labels, raw.labels, 'labels'),
	};
}

export function loadConfig(path: string = configFile()): Config {
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
		return parseConfig(raw);
	} catch (error) {
		throw new ConfigError(`${path}: ${(error as Error).message}`);
	}
}
