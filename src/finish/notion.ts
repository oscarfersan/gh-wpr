import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { TrackerConfig } from '../config.ts';

const execFileAsync = promisify(execFile);

/*
 * Updates the PR's card in a Notion database after the merge: finds it by the PR
 * URL, sets its status from the base branch and writes the merge commit.
 * The token comes from GH_WPR_NOTION_TOKEN or the macOS keychain, never from a file.
 */

export const TOKEN_ENV = 'GH_WPR_NOTION_TOKEN';
export const KEYCHAIN = { service: 'gh-wpr', account: 'notion' } as const;
const API = 'https://api.notion.com/v1';
const VERSION = '2025-09-03';

export class TrackerError extends Error {}

export async function notionToken(): Promise<string | null> {
	const fromEnv = process.env[TOKEN_ENV]?.trim();
	if (fromEnv) return fromEnv;
	if (process.platform !== 'darwin') return null;
	try {
		const { stdout } = await execFileAsync('security', ['find-generic-password', '-s', KEYCHAIN.service, '-a', KEYCHAIN.account, '-w']);
		return stdout.trim() || null;
	} catch {
		return null;
	}
}

type Json = Record<string, unknown>;

async function call(token: string, method: string, path: string, body?: Json): Promise<Json> {
	const response = await fetch(`${API}${path}`, {
		method,
		headers: { Authorization: `Bearer ${token}`, 'Notion-Version': VERSION, 'Content-Type': 'application/json' },
		body: body ? JSON.stringify(body) : undefined,
	});
	const json = (await response.json().catch(() => ({}))) as Json;
	if (!response.ok) {
		const message = typeof json.message === 'string' ? json.message : response.statusText;
		throw new TrackerError(`Notion ${response.status}: ${message}`);
	}
	return json;
}

export interface PropertySchema {
	type: string;
	/** Option names of a status or select property. */
	options: string[];
}

export interface Schema {
	dataSourceId: string;
	properties: Record<string, PropertySchema>;
}

/** Reads the data source; a database id is accepted too and resolved to its first data source. */
export async function readSchema(token: string, id: string): Promise<Schema> {
	let source: Json;
	try {
		source = await call(token, 'GET', `/data_sources/${id}`);
	} catch (error) {
		if (!/ 404:/.test((error as Error).message)) throw error;
		const database = await call(token, 'GET', `/databases/${id}`);
		const first = (database.data_sources as { id: string }[] | undefined)?.[0];
		if (!first) throw new TrackerError(`Notion database ${id} has no data source`);
		source = await call(token, 'GET', `/data_sources/${first.id}`);
	}
	const properties: Record<string, PropertySchema> = {};
	for (const [name, raw] of Object.entries((source.properties ?? {}) as Record<string, Json>)) {
		const type = String(raw.type);
		const options = ((raw[type] as { options?: { name: string }[] } | undefined)?.options ?? []).map((o) => o.name);
		properties[name] = { type, options };
	}
	return { dataSourceId: String(source.id), properties };
}

const TEXT_TYPES = ['url', 'rich_text', 'title'];
const STATUS_TYPES = ['status', 'select'];
const COMMIT_TYPES = ['rich_text', 'url'];

/** What is wrong with the configured properties, if anything. */
export function schemaProblems(schema: Schema, tracker: TrackerConfig): string[] {
	const problems: string[] = [];
	const need = (name: string, types: string[], what: string) => {
		const prop = schema.properties[name];
		if (!prop) problems.push(`no property "${name}" (${what})`);
		else if (!types.includes(prop.type)) problems.push(`"${name}" is a ${prop.type} property; ${what} needs ${types.join(' or ')}`);
	};
	need(tracker.prProperty, TEXT_TYPES, 'tracker.prProperty');
	need(tracker.statusProperty, STATUS_TYPES, 'tracker.statusProperty');
	need(tracker.commitProperty, COMMIT_TYPES, 'tracker.commitProperty');
	const status = schema.properties[tracker.statusProperty];
	if (status && STATUS_TYPES.includes(status.type)) {
		for (const value of Object.values(tracker.statusByBase)) {
			if (!status.options.includes(value)) problems.push(`"${tracker.statusProperty}" has no option "${value}"`);
		}
	}
	if (Object.keys(tracker.statusByBase).length === 0) problems.push('"tracker.statusByBase" is empty, so no status would be set');
	return problems;
}

/** The status for a base branch; keys may use * as a wildcard. An exact key wins over a pattern. */
export function statusForBase(statusByBase: Record<string, string>, base: string): string | null {
	if (statusByBase[base] !== undefined) return statusByBase[base];
	for (const [pattern, status] of Object.entries(statusByBase)) {
		const re = new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
		if (re.test(base)) return status;
	}
	return null;
}

/** Whether a property's text points at this PR (and not at #12 when looking for #1). */
export function mentionsPr(text: string, repo: string, number: number): boolean {
	const clean = text.replace(/\\/g, '').toLowerCase();
	return new RegExp(`github\\.com/${repo.toLowerCase().replace(/[.]/g, '\\.')}/pull/${number}(?!\\d)`).test(clean);
}

function propertyText(prop: Json | undefined): string {
	if (!prop) return '';
	if (prop.type === 'url') return String(prop.url ?? '');
	const parts = (prop[String(prop.type)] ?? []) as { plain_text?: string; href?: string | null }[];
	return Array.isArray(parts) ? parts.map((p) => `${p.plain_text ?? ''} ${p.href ?? ''}`).join(' ') : '';
}

export interface Card {
	id: string;
	url: string;
}

export async function findCards(token: string, schema: Schema, tracker: TrackerConfig, repo: string, number: number): Promise<Card[]> {
	const type = schema.properties[tracker.prProperty]?.type ?? 'rich_text';
	const body = { filter: { property: tracker.prProperty, [type]: { contains: `/pull/${number}` } }, page_size: 100 };
	const result = await call(token, 'POST', `/data_sources/${schema.dataSourceId}/query`, body);
	const pages = (result.results ?? []) as Json[];
	return pages
		.filter((page) => mentionsPr(propertyText((page.properties as Record<string, Json>)?.[tracker.prProperty]), repo, number))
		.map((page) => ({ id: String(page.id), url: String(page.url ?? '') }));
}

export function cardUpdate(schema: Schema, tracker: TrackerConfig, status: string | null, commit: string): Json {
	const properties: Json = {};
	const statusType = schema.properties[tracker.statusProperty]?.type;
	if (status && statusType) properties[tracker.statusProperty] = { [statusType]: { name: status } };
	const commitType = schema.properties[tracker.commitProperty]?.type;
	if (commitType === 'url') properties[tracker.commitProperty] = { url: commit };
	else if (commitType) properties[tracker.commitProperty] = { rich_text: [{ type: 'text', text: { content: commit } }] };
	return { properties };
}

export type CardResult =
	| { kind: 'updated'; card: Card; status: string | null }
	| { kind: 'would_update'; card: Card; status: string | null }
	| { kind: 'not_found' }
	| { kind: 'ambiguous'; cards: Card[] };

/** Finds the PR's card and sets its status and merge commit. More than one match changes nothing. */
export async function updateCard(
	tracker: TrackerConfig,
	pr: { repo: string; number: number; baseRef: string },
	commit: string,
	options: { dryRun: boolean },
): Promise<CardResult> {
	const token = await notionToken();
	if (!token) throw new TrackerError(`No Notion token: run "gh wpr auth notion" or set ${TOKEN_ENV}`);
	const schema = await readSchema(token, tracker.dataSourceId);
	const problems = schemaProblems(schema, tracker).filter((p) => !p.includes('statusByBase'));
	if (problems.length > 0) throw new TrackerError(`Notion card settings: ${problems.join('; ')}`);
	const cards = await findCards(token, schema, tracker, pr.repo, pr.number);
	if (cards.length === 0) return { kind: 'not_found' };
	if (cards.length > 1) return { kind: 'ambiguous', cards };
	const status = statusForBase(tracker.statusByBase, pr.baseRef);
	if (options.dryRun) return { kind: 'would_update', card: cards[0], status };
	await call(token, 'PATCH', `/pages/${cards[0].id}`, cardUpdate(schema, tracker, status, commit));
	return { kind: 'updated', card: cards[0], status };
}
