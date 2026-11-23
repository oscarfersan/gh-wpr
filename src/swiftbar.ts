import type { Approval } from './bots/approval.ts';
import type { CodeRabbitState } from './bots/coderabbit.ts';
import type { CodexState } from './bots/codex.ts';
import { nudgeTargets } from './commands/nudge.ts';
import { GROUP_TITLE } from './format.ts';
import type { Config } from './config.ts';
import type { Assessment, Group } from './turn.ts';
import { GROUP_ORDER, openerName } from './turn.ts';
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
	config: Config;
	/** Features that need setting up; shown in the footer and opened with `gh wpr doctor`. */
	setupIssues?: number;
	/** `claude.command` can be run; when it cannot, the Claude Code action is hidden. */
	claudeAvailable?: boolean;
	/** PRs being finished (rebased and waiting for CI before the merge). */
	finishing?: { repo: string; number: number }[];
	/** Repos with a local clone, where "Finish" can rebase. */
	finishRepos?: string[];
}

const GROUP_ICON: Record<Group, string> = {
	author: 'exclamationmark.circle',
	review: 'eye',
	waiting_ai: 'hourglass',
	ready: 'checkmark.circle',
	draft: 'pencil.circle',
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

export function coderabbitLine(state: CodeRabbitState, now: Date, approval?: Approval): string {
	switch (state.kind) {
		case 'disabled':
			return '';
		case 'reviewed':
			if (approval?.kind === 'approved') return 'CodeRabbit: approved the last commit';
			if (approval?.kind === 'changes') return 'CodeRabbit: changes requested on the last commit';
			return 'CodeRabbit: reviewed the last commit, no approve yet';
		case 'skipped':
			return approval?.kind === 'approved' ? 'CodeRabbit: approved (nothing new to review)' : 'CodeRabbit: nothing to review';
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

export function codexLine(state: CodexState, queued: boolean, now: Date, approval?: Approval): string {
	if (queued) return 'Codex: queued until CodeRabbit finishes';
	switch (state.kind) {
		case 'disabled':
			return '';
		case 'reviewed':
			if (approval?.kind === 'approved') return 'Codex: approved the last commit 👍';
			if (approval?.kind === 'changes') return 'Codex: found issues in the last commit';
			return 'Codex: reviewed the last commit';
		case 'running':
			return `Codex: reviewing (${formatAgo(state.since, now)})`;
		case 'outdated':
			return `Codex: reviewed an older commit (${short(state.reviewedOid)})`;
		case 'timed_out':
			return 'Codex: no answer to the last request';
		case 'never':
			return 'Codex: not requested (optional)';
	}
}

export function humanLine(approval: Approval & { by?: string[] }): string {
	const by = approval.by?.length ? ` by ${approval.by.join(', ')}` : '';
	switch (approval.kind) {
		case 'approved':
			return `Reviewer: approved${by}`;
		case 'changes':
			return `Reviewer: changes requested${by}`;
		default:
			return 'Reviewer: no approve yet';
	}
}

export function notionLine(approval: Approval): string {
	switch (approval.kind) {
		case 'disabled':
		case 'not_requested':
			return '';
		case 'approved':
			return 'Notion AI: approved the last commit';
		case 'changes':
			return 'Notion AI: changes requested on the last commit';
		case 'stale':
			return 'Notion AI: reviewed an older commit';
		case 'none':
			return 'Notion AI: not reviewed yet';
	}
}

function prItem(a: Assessment, ctx: MenuContext): string[] {
	const lines: string[] = [];
	const ref = a.pr.url;
	lines.push(
		// An action of its own keeps SwiftBar from drawing the item disabled; hovering still opens the submenu.
		`#${a.pr.number} ${menuText(a.pr.title)} | sfimage=${GROUP_ICON[a.group]} href=${a.pr.url} tooltip=${quote(menuText(`${a.pr.author} · ${a.reason}`, 120))}`,
	);
	// Every line links somewhere: SwiftBar greys out lines without an action.
	const threadsFirst = a.mine && a.pendingThreads.length > 0;
	const reasonHref = threadsFirst && a.pendingThreads[0].url ? a.pendingThreads[0].url : a.pr.url;
	lines.push(`--${menuText(`${a.pr.author} · ${a.reason}`, 80)} | size=12 href=${reasonHref}`);
	if (threadsFirst && a.pendingThreads.length > 1) {
		for (const t of a.pendingThreads.slice(0, 5)) {
			if (!t.url) continue;
			const where = t.path ? t.path.split('/').slice(-2).join('/') : 'conversation';
			lines.push(`----${menuText(`${openerName(t.firstAuthor, ctx.config)} · ${where}`, 70)} | size=12 href=${t.url}`);
		}
	}
	if (a.pr.isDraft) {
		const notion = notionLine(a.approvals.notion);
		if (notion) lines.push(`--${notion} | size=12 href=${a.pr.url}`);
	} else {
		const cr = coderabbitLine(a.coderabbit, ctx.now, a.approvals.coderabbit);
		if (cr) lines.push(`--${cr} | size=12 href=${a.pr.url}/checks`);
		const codex = codexLine(a.codex, a.queued.some((e) => e.bot === 'codex'), ctx.now, a.approvals.codex);
		if (codex) lines.push(`--${codex} | size=12 href=${a.pr.url}`);
		lines.push(`--${humanLine(a.approvals.human)} | size=12 href=${a.pr.url}/files`);
	}
	lines.push('-----');
	if (a.aiActionable) lines.push(`--Request AI review | sfimage=sparkles ${action(ctx, ['ai', ref])}`);
	// CodeRabbit reviewed the head without approving it. The "again" submenu below is hidden while
	// another AI action is pending, so this one stays reachable on its own.
	const crWithoutApprove = a.coderabbit.kind === 'reviewed' && a.approvals.coderabbit.kind !== 'approved';
	if (crWithoutApprove && a.aiActionable) {
		lines.push(`--Ask CodeRabbit to review again | sfimage=arrow.counterclockwise ${action(ctx, ['ai', ref, '--bot', 'coderabbit', '--force'])}`);
	}
	const blocked = a.pr.isDraft || a.pr.mergeable === 'CONFLICTING';
	if (!a.aiActionable && !a.aiBusy && !blocked) {
		// Both bots are done with this commit. Asking again is deliberate, so it sits one level deeper.
		lines.push('--Request AI review again | sfimage=arrow.counterclockwise');
		const crOn = a.coderabbit.kind !== 'disabled';
		const codexOn = a.codex.kind !== 'disabled';
		if (crOn && codexOn) lines.push(`----CodeRabbit, then Codex | ${action(ctx, ['ai', ref, '--force'])}`);
		if (crOn) lines.push(`----Only CodeRabbit (full review) | ${action(ctx, ['ai', ref, '--bot', 'coderabbit', '--force'])}`);
		if (codexOn) lines.push(`----Only Codex | ${action(ctx, ['ai', ref, '--bot', 'codex', '--force'])}`);
	}
	if (a.mine && !a.pr.isDraft && a.approvals.human.kind !== 'approved') {
		const who = nudgeTargets(a.pr, ctx.config, ctx.viewer);
		if (who.length > 0) lines.push(`--${menuText(`Ask ${who.join(', ')} to review`, 60)} | sfimage=bell ${action(ctx, ['nudge', ref])}`);
	}
	if (a.mine && ctx.claudeAvailable !== false && (a.group === 'author' || a.threadsAwaitingAuthor > 0)) {
		lines.push(`--Triage comments with Claude Code | sfimage=terminal ${action(ctx, ['claude', ref], { terminal: true })}`);
	}
	const finishing = ctx.finishing?.some((f) => f.repo === a.pr.repo && f.number === a.pr.number);
	if (finishing) {
		lines.push(`--Finishing: merges when CI passes | sfimage=hourglass href=${a.pr.url}/checks`);
	} else if (a.mine && a.done && !a.pr.isDraft && ctx.finishRepos?.some((r) => r.toLowerCase() === a.pr.repo.toLowerCase())) {
		lines.push(`--Finish: rebase, merge and update the card | sfimage=checkmark.seal ${action(ctx, ['finish', ref], { terminal: true })}`);
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
	const setup = ctx.setupIssues ?? 0;
	if (setup > 0) {
		out.push(`${setup} feature${setup > 1 ? 's' : ''} not set up | sfimage=gearshape ${action(ctx, ['doctor'], { terminal: true })}`);
	}
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
		'Fix it in a terminal (gh wpr doctor shows what is missing), then refresh | size=11 color=#8a8f98',
		'Refresh | refresh=true',
		'',
	].join('\n');
}
