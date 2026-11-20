import type { CodeRabbitState } from './bots/coderabbit.ts';
import type { CodexState } from './bots/codex.ts';
import { GROUP_TITLE } from './format.ts';
import type { Assessment, Group } from './turn.ts';
import { GROUP_ORDER } from './turn.ts';
import { formatAgo, formatClock, short } from './util.ts';

/*
 * Renders the SwiftBar menu (xbar format): header lines, then `---`, then one
 * line per item as `Text | key=value ...`. Submenu items start with `--`.
 * Every action runs the plugin script itself, which sets PATH and forwards the
 * arguments to `gh wpr`.
 */

export interface MenuContext {
	/** Absolute path of the plugin script; actions run it with gh wpr arguments. */
	plugin: string;
	now: Date;
	viewer: string;
	queued: number;
	tickLines?: string[];
}

const GROUP_ICON: Record<Group, string> = {
	author: 'exclamationmark.circle',
	review: 'eye',
	waiting_ai: 'hourglass',
	ready: 'checkmark.circle',
	others: 'circle.dotted',
};

/** Menu text cannot contain the parameter separator and must not look like a separator or submenu. */
export function menuText(text: string, max = 60): string {
	const clean = text.replace(/\|/g, '∣').replace(/[\r\n]+/g, ' ').replace(/^-+/, '').trim();
	return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

const quote = (value: string): string => `"${value.replace(/"/g, '\\"')}"`;

function action(ctx: MenuContext, args: string[], options: { terminal?: boolean } = {}): string {
	const params = args.map((arg, i) => `param${i + 1}=${quote(arg)}`).join(' ');
	return `bash=${quote(ctx.plugin)} ${params} terminal=${options.terminal ? 'true' : 'false'} refresh=true`;
}

export function coderabbitLine(state: CodeRabbitState, now: Date): string {
	switch (state.kind) {
		case 'disabled':
			return '';
		case 'reviewed':
			return 'CodeRabbit: reviewed the last commit';
		case 'skipped':
			return 'CodeRabbit: nothing to review';
		case 'reviewing':
			return `CodeRabbit: reviewing (${formatAgo(state.since, now)})`;
		case 'requested':
			return `CodeRabbit: full review requested ${formatAgo(state.at, now)} ago`;
		case 'rate_limited':
			return Date.parse(state.retryAt) > now.getTime()
				? `CodeRabbit: rate limited until ${formatClock(state.retryAt)}`
				: 'CodeRabbit: rate limit over, needs a full review';
		case 'needs_unstick':
			return `CodeRabbit: ${state.reason === 'paused' ? 'paused' : 'stuck'}${state.alreadyRequested ? ' (already asked once)' : ''}`;
	}
}

export function codexLine(state: CodexState, queued: boolean, now: Date): string {
	if (queued) return 'Codex: queued until CodeRabbit finishes';
	switch (state.kind) {
		case 'disabled':
			return '';
		case 'reviewed':
			return 'Codex: reviewed the last commit';
		case 'running':
			return `Codex: reviewing (${formatAgo(state.since, now)})`;
		case 'outdated':
			return `Codex: reviewed an older commit (${short(state.reviewedOid)})`;
		case 'timed_out':
			return 'Codex: no answer to the last request';
		case 'never':
			return 'Codex: not requested';
	}
}

function prItem(a: Assessment, ctx: MenuContext): string[] {
	const lines: string[] = [];
	const ref = a.pr.url;
	lines.push(
		`#${a.pr.number} ${menuText(a.pr.title)} | sfimage=${GROUP_ICON[a.group]} tooltip=${quote(menuText(`${a.pr.author} · ${a.reason}`, 120))}`,
	);
	lines.push(`--${menuText(`${a.pr.author} · ${a.reason}`, 80)} | size=12`);
	const cr = coderabbitLine(a.coderabbit, ctx.now);
	if (cr) lines.push(`--${cr} | size=12`);
	const codex = codexLine(a.codex, a.queued.some((e) => e.bot === 'codex'), ctx.now);
	if (codex) lines.push(`--${codex} | size=12`);
	lines.push('-----');
	if (a.aiActionable) lines.push(`--Request AI review | sfimage=sparkles ${action(ctx, ['ai', ref])}`);
	if (a.mine && a.group === 'others') {
		lines.push(`--Ask for review again | sfimage=bell ${action(ctx, ['nudge', ref])}`);
	}
	if (a.mine && (a.group === 'author' || a.threadsAwaitingAuthor > 0)) {
		lines.push(`--Triage comments with Claude Code | sfimage=terminal ${action(ctx, ['claude', ref], { terminal: true })}`);
	}
	lines.push(`--Open on GitHub | sfimage=safari href=${a.pr.url}`);
	return lines;
}

export function renderMenu(items: Assessment[], ctx: MenuContext): string {
	const count = (group: Group) => items.filter((a) => a.group === group).length;
	const yourTurn = count('author') + count('review');
	const waiting = count('waiting_ai');
	const title = [yourTurn > 0 ? String(yourTurn) : '', waiting > 0 ? `⧗${waiting}` : ''].filter(Boolean).join(' ');

	const out: string[] = [`${title || ' '} | sfimage=arrow.triangle.pull`, '---'];
	for (const group of GROUP_ORDER) {
		const rows = items.filter((a) => a.group === group);
		if (rows.length === 0) continue;
		out.push(`${GROUP_TITLE[group]} · ${rows.length} | size=11 color=#8a8f98`);
		for (const a of rows) out.push(...prItem(a, ctx));
		out.push('---');
	}
	if (items.length === 0) out.push('No open pull requests | size=12', '---');

	const actionableMine = items.filter((a) => a.mine && a.group === 'author' && a.aiActionable).length;
	if (actionableMine > 0) {
		out.push(`Request AI review on my PRs (${actionableMine}) | sfimage=sparkles ${action(ctx, ['ai', '--mine'])}`);
	}
	if (ctx.queued > 0) out.push(`${ctx.queued} request${ctx.queued > 1 ? 's' : ''} queued | sfimage=tray.full size=12`);
	for (const line of ctx.tickLines ?? []) out.push(`${menuText(line.replace(/\x1b\[[0-9;]*m/g, ''), 90)} | size=11`);
	out.push(`Refresh | sfimage=arrow.clockwise refresh=true`);
	out.push(`Signed in as ${ctx.viewer} · ${formatClock(ctx.now.toISOString())} | size=11 color=#8a8f98`);
	return `${out.join('\n')}\n`;
}

/** Splits long text into menu lines instead of cutting it off. */
export function wrap(text: string, width = 70): string[] {
	const lines: string[] = [];
	for (const paragraph of text.split('\n')) {
		let line = '';
		for (const word of paragraph.split(/\s+/).filter(Boolean)) {
			if (line && line.length + word.length + 1 > width) {
				lines.push(line);
				line = word;
			} else line = line ? `${line} ${word}` : word;
		}
		if (line) lines.push(line);
	}
	return lines;
}

export function renderError(message: string): string {
	return [
		'⚠︎ | sfimage=exclamationmark.triangle',
		'---',
		...wrap(message).map((l) => `${menuText(l, 200)} | size=12`),
		'---',
		'Fix it in a terminal, then refresh | size=11 color=#8a8f98',
		'Refresh | refresh=true',
		'',
	].join('\n');
}
