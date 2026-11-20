import type { CodeRabbitState } from './bots/coderabbit.ts';
import type { CodexState } from './bots/codex.ts';
import type { CiState } from './ci.ts';
import type { Assessment, Group } from './turn.ts';
import { GROUP_ORDER } from './turn.ts';
import { formatAgo, formatClock } from './util.ts';

const useColor = (): boolean => Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

const paint =
	(code: number) =>
	(text: string): string =>
		useColor() ? `\x1b[${code}m${text}\x1b[0m` : text;

export const color = {
	green: paint(32),
	yellow: paint(33),
	red: paint(31),
	magenta: paint(35),
	blue: paint(34),
	dim: paint(2),
	bold: paint(1),
};

export const GROUP_TITLE: Record<Group, string> = {
	author: 'Your turn (author)',
	review: 'Your turn to review',
	waiting_ai: 'Waiting for the AI',
	ready: 'Ready to merge',
	others: 'Someone else’s turn',
};

/** Short label + tone, shared by the terminal table and the menu bar. */
export interface Chip {
	text: string;
	tone: 'ok' | 'busy' | 'warn' | 'bad' | 'none';
}

export function coderabbitChip(state: CodeRabbitState): Chip {
	switch (state.kind) {
		case 'disabled':
			return { text: '', tone: 'none' };
		case 'reviewed':
			return { text: '✓', tone: 'ok' };
		case 'skipped':
			return { text: 'skip', tone: 'ok' };
		case 'reviewing':
		case 'requested':
			return { text: '…', tone: 'busy' };
		case 'rate_limited':
			return { text: `⏱${formatClock(state.retryAt)}`, tone: 'warn' };
		case 'needs_unstick':
			return { text: state.reason === 'paused' ? 'paused' : 'stuck', tone: 'bad' };
	}
}

export function codexChip(state: CodexState, queued: boolean): Chip {
	if (queued) return { text: '⇢', tone: 'busy' };
	switch (state.kind) {
		case 'disabled':
			return { text: '', tone: 'none' };
		case 'reviewed':
			return { text: '✓', tone: 'ok' };
		case 'running':
			return { text: '…', tone: 'busy' };
		case 'outdated':
			return { text: 'old', tone: 'warn' };
		case 'timed_out':
			return { text: 'late', tone: 'bad' };
		case 'never':
			return { text: '–', tone: 'none' };
	}
}

export function ciChip(state: CiState): Chip {
	switch (state) {
		case 'success':
			return { text: '✓', tone: 'ok' };
		case 'failure':
			return { text: '✗', tone: 'bad' };
		case 'pending':
			return { text: '…', tone: 'busy' };
		case 'none':
			return { text: '–', tone: 'none' };
	}
}

const TONE: Record<Chip['tone'], (s: string) => string> = {
	ok: color.green,
	busy: color.magenta,
	warn: color.yellow,
	bad: color.red,
	none: color.dim,
};

const pad = (text: string, width: number): string => text + ' '.repeat(Math.max(0, width - [...text].length));
const chipCell = (chip: Chip, width: number): string => TONE[chip.tone](pad(chip.text, width));

export function renderTable(items: Assessment[], now: Date, showRepo: boolean): string {
	if (items.length === 0) return color.dim('No open pull requests.');
	const lines: string[] = [];
	for (const group of GROUP_ORDER) {
		const rows = items.filter((a) => a.group === group);
		if (rows.length === 0) continue;
		lines.push('', color.bold(`${GROUP_TITLE[group]} · ${rows.length}`));
		lines.push(color.dim(`  ${pad('PR', showRepo ? 28 : 7)}${pad('CR', 8)}${pad('CX', 5)}${pad('CI', 4)}TITLE`));
		for (const a of rows) {
			const id = showRepo ? `${a.pr.repo.split('/')[1]}#${a.pr.number}` : `#${a.pr.number}`;
			const queuedCodex = a.queued.some((e) => e.bot === 'codex');
			lines.push(
				`  ${pad(id, showRepo ? 28 : 7)}` +
					chipCell(coderabbitChip(a.coderabbit), 8) +
					chipCell(codexChip(a.codex, queuedCodex), 5) +
					chipCell(ciChip(a.ci), 4) +
					a.pr.title,
			);
			lines.push(color.dim(`  ${pad('', showRepo ? 28 : 7)}${a.pr.author} · ${a.reason} · updated ${formatAgo(a.pr.updatedAt, now)} ago`));
		}
	}
	lines.push('', color.dim('CR CodeRabbit · CX Codex · ✓ reviewed head · … running · ⏱ retry at · ⇢ queued after CodeRabbit · old reviewed an older commit'));
	return lines.join('\n').replace(/^\n/, '');
}
