import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { expandHome } from '../checkouts.ts';
import type { Config } from '../config.ts';
import { decideFinish, readFinishQueue, upsertFinish, writeFinishQueue } from '../finish/queue.ts';
import type { FinishEntry } from '../finish/queue.ts';
import { KEYCHAIN, notionToken, TOKEN_ENV, updateCard } from '../finish/notion.ts';
import type { CardResult } from '../finish/notion.ts';
import { rebaseOntoBase } from '../finish/rebase.ts';
import { color } from '../format.ts';
import { gh } from '../github.ts';
import type { Notice } from '../notify.ts';
import { loadSnapshot } from '../snapshot.ts';
import { resolveTarget } from '../target.ts';
import { assess } from '../turn.ts';
import { describeSkipped, finishReadiness } from '../finish/ready.ts';
import { prKey } from '../types.ts';
import { short } from '../util.ts';

export class FinishError extends Error {}

const label = (e: { repo: string; number: number }) => `${e.repo}#${e.number}`;

/** The local clone "gh wpr finish" rebases from, or null when there is none. */
export function cloneFor(config: Config, repo: string): string | null {
	const configured = config.localPaths[repo.toLowerCase()];
	if (!configured) return null;
	const dir = expandHome(configured);
	return existsSync(dir) ? dir : null;
}

const cardsWord = (n: number) => (n === 1 ? 'card' : `${n} cards`);

export function describeCard(result: CardResult, commit: string): string {
	switch (result.kind) {
		case 'updated': {
			const status = result.status ? `status "${result.status}"` : 'status unchanged (no "statusByBase" match)';
			const done = `${color.green('✓')} Updated the ${cardsWord(result.cards.length)}: ${status}, commit ${short(commit)} → ${result.cards.map((c) => c.url).join(', ')}`;
			const failed = result.failed.map((f) => `\n${color.red('✗')} Could not update ${f.card.url}: ${f.error}`).join('');
			return done + failed;
		}
		case 'would_update':
			return `${color.yellow('○')} Would update the ${cardsWord(result.cards.length)}: ${result.status ? `status "${result.status}"` : 'status unchanged'}, merge commit → ${result.cards.map((c) => c.url).join(', ')}`;
		case 'not_found':
			return `${color.yellow('!')} No card links to this PR; update it by hand`;
	}
}

async function cardStep(config: Config, entry: { repo: string; number: number; baseRef: string }, commit: string, dryRun: boolean): Promise<string> {
	if (config.tracker.kind === 'none') return color.dim('No tracker configured; no card to update');
	try {
		return describeCard(await updateCard(config.tracker, entry, commit, { dryRun }), commit);
	} catch (error) {
		return `${color.red('✗')} Card not updated: ${(error as Error).message}`;
	}
}

/**
 * The merge commit's subject, as `git merge` writes it locally, so merges made from
 * here look like the rest of the history: "Merge branch 'feature/x' into development",
 * with no " into …" when the base is master or main.
 */
export function mergeCommitTitle(entry: { headRef: string; baseRef: string }): string {
	const into = entry.baseRef === 'master' || entry.baseRef === 'main' ? '' : ` into ${entry.baseRef}`;
	return `Merge branch '${entry.headRef}'${into}`;
}

/** Merges a queued PR, deletes its branch and updates its card. */
async function mergeEntry(config: Config, entry: FinishEntry, dryRun: boolean): Promise<{ lines: string[]; commit: string | null }> {
	const lines: string[] = [];
	if (dryRun) {
		lines.push(`${color.yellow('○')} Would merge ${label(entry)} (${config.finish.mergeMethod})`);
		lines.push(await cardStep(config, entry, entry.headOid, true));
		return { lines, commit: null };
	}
	const message =
		config.finish.mergeMethod === 'merge' ? ['-f', `commit_title=${mergeCommitTitle(entry)}`, '-f', 'commit_message='] : [];
	const commit = (
		await gh(['api', '-X', 'PUT', `repos/${entry.repo}/pulls/${entry.number}/merge`, '-f', `merge_method=${config.finish.mergeMethod}`, ...message, '-f', `sha=${entry.headOid}`, '--jq', '.sha'])
	).trim();
	lines.push(`${color.green('✓')} Merged ${label(entry)} into ${entry.baseRef} as ${short(commit)}`);
	if (config.finish.deleteBranch && !entry.isCrossRepository) {
		try {
			await gh(['api', '-X', 'DELETE', `repos/${entry.repo}/git/refs/heads/${entry.headRef}`, '--silent']);
			lines.push(`${color.green('✓')} Deleted ${entry.headRef}`);
		} catch (error) {
			lines.push(`${color.yellow('!')} Could not delete ${entry.headRef}: ${(error as Error).message.split('\n')[0]}`);
		}
	}
	lines.push(await cardStep(config, entry, commit, false));
	return { lines, commit };
}

export interface FinishRun {
	lines: string[];
	notices: Notice[];
}

/** Merges the queued PRs whose CI passed. Runs on every tick. */
export async function runFinishQueue(config: Config, options: { dryRun: boolean }): Promise<FinishRun> {
	const entries = readFinishQueue();
	if (entries.length === 0) return { lines: [], notices: [] };
	const snapshot = await loadSnapshot(config, { fresh: entries.map(prKey) });
	const byKey = new Map(snapshot.prs.map((pr) => [prKey(pr), pr]));
	const kept: FinishEntry[] = [];
	const lines: string[] = [];
	const notices: Notice[] = [];
	const now = new Date();

	for (const entry of entries) {
		const pr = byKey.get(prKey(entry));
		if (!pr) {
			// Merged by hand while it waited: still update the card.
			const merged = await gh(['api', `repos/${entry.repo}/pulls/${entry.number}`, '--jq', 'select(.merged) | .merge_commit_sha']).then((s) => s.trim(), () => '');
			if (merged) {
				const card = await cardStep(config, entry, merged, options.dryRun);
				lines.push(`${color.green('✓')} ${label(entry)} was merged on GitHub`, card);
				notices.push({ title: `Merged #${entry.number}`, body: card.replace(/\x1b\[[0-9;]*m/g, ''), url: entry.url });
			} else lines.push(color.dim(`− ${label(entry)}: dropped (closed)`));
			continue;
		}
		const decision = decideFinish(entry, pr, config, now);
		if (decision.decision === 'keep') {
			kept.push(entry);
			continue;
		}
		if (decision.decision === 'drop') {
			lines.push(`${color.yellow('!')} ${label(entry)}: not merged, ${decision.why}`);
			notices.push({ title: `Not merged: #${entry.number}`, body: decision.why, url: entry.url });
			continue;
		}
		try {
			const result = await mergeEntry(config, entry, options.dryRun);
			lines.push(...result.lines);
			if (options.dryRun) kept.push(entry);
			else notices.push({ title: `Merged #${entry.number}`, body: result.lines.slice(1).join(' · ').replace(/\x1b\[[0-9;]*m/g, ''), url: entry.url });
		} catch (error) {
			const message = (error as Error).message.split('\n')[0];
			lines.push(`${color.red('✗')} ${label(entry)}: merge failed: ${message}`);
			notices.push({ title: `Merge failed: #${entry.number}`, body: message, url: entry.url });
		}
	}
	if (!options.dryRun) writeFinishQueue(kept);
	return { lines, notices };
}

/**
 * Finishes an approved PR: rebases it onto its base in a worktree, force-pushes
 * with a lease, then merges it once CI passes and updates its card.
 */
export async function finish(config: Config, target: string, repo: string | undefined, options: { dryRun: boolean; claude: boolean }): Promise<number> {
	const snapshot = await loadSnapshot(config);
	const found = resolveTarget(target, repo, config, snapshot.prs);
	const fresh = await loadSnapshot(config, { fresh: [prKey(found)] });
	const pr = fresh.prs.find((p) => prKey(p) === prKey(found));
	if (!pr) throw new FinishError(`${label(found)} is no longer open`);
	const queued = readFinishQueue().find((e) => prKey(e) === prKey(pr) && e.headOid === pr.headOid);
	if (queued) {
		// After our own push the bots' approvals are on the old commit, so do not check them again.
		const decision = decideFinish(queued, pr, config, new Date());
		console.log(`${label(pr)} is already being finished: ${decision.why}`);
		if (decision.decision !== 'keep') for (const line of (await runFinishQueue(config, { dryRun: options.dryRun })).lines) console.log(line);
		return 0;
	}
	const a = assess(pr, config, fresh.viewer, new Date());

	const ready = finishReadiness(a.approvals, pr.isDraft, config);
	if (!ready.ok) throw new FinishError(`${label(pr)} cannot be finished: ${ready.why}`);
	if (!pr.headRef) throw new FinishError(`Could not read the branch of ${label(pr)}; run "gh wpr status --full" and try again`);
	if (pr.isCrossRepository) throw new FinishError(`${label(pr)} comes from a fork; rebase it there`);
	const clone = cloneFor(config, pr.repo);
	if (!clone) throw new FinishError(`No local clone of ${pr.repo} to rebase in. Run "gh wpr init" to find it, or set "localPaths".`);
	if (config.tracker.kind === 'notion' && !(await notionToken())) {
		throw new FinishError(`The card could not be updated: no Notion token. Run "gh wpr auth notion" or set ${TOKEN_ENV}.`);
	}

	console.log(`Finishing ${label(pr)} ${color.dim(`${pr.headRef} → ${pr.baseRef}`)}`);
	if (ready.skipping.length > 0) console.log(color.yellow(`! Going ahead without the optional reviews: ${describeSkipped(ready.skipping)}`));
	const rebase = await rebaseOntoBase(clone, { repo: pr.repo, number: pr.number, baseRef: pr.baseRef, headRef: pr.headRef, headOid: pr.headOid }, { dryRun: options.dryRun });
	let headOid = pr.headOid;
	let pushed = false;
	switch (rebase.kind) {
		case 'conflict': {
			console.log(`${color.red('✗')} Conflicts rebasing onto ${pr.baseRef}; nothing was pushed.`);
			for (const file of rebase.files) console.log(`    ${file}`);
			console.log(`Resolve them in ${rebase.worktree} ("git rebase --continue" when done), then run "gh wpr finish ${pr.number}" again.`);
			if (options.claude) return openClaude(config, rebase.worktree, pr.baseRef, rebase.files);
			console.log(color.dim(`Or let Claude Code do it: gh wpr finish ${pr.number} --claude`));
			return 1;
		}
		case 'up_to_date':
			console.log(`${color.green('✓')} Already on top of ${pr.baseRef}; nothing to push`);
			break;
		case 'would_push':
			console.log(`${color.yellow('○')} Would rebase onto ${pr.baseRef} and force-push ${pr.headRef} (lease on ${short(rebase.from)})`);
			break;
		case 'pushed':
			console.log(`${color.green('✓')} Rebased onto ${pr.baseRef} and pushed ${short(rebase.from)} → ${short(rebase.headOid)}`);
			headOid = rebase.headOid;
			pushed = true;
			break;
	}

	const entry: FinishEntry = {
		repo: pr.repo,
		number: pr.number,
		url: pr.url,
		baseRef: pr.baseRef,
		headRef: pr.headRef,
		headOid,
		isCrossRepository: false,
		pushed,
		createdAt: new Date().toISOString(),
	};
	if (options.dryRun) {
		console.log(color.dim(config.finish.waitForCi ? 'Then: wait for CI, merge, and update the card' : 'Then: merge and update the card'));
		console.log((await mergeEntry(config, entry, true)).lines.join('\n'));
		return 0;
	}
	writeFinishQueue(upsertFinish(readFinishQueue(), entry));
	const run = await runFinishQueue(config, { dryRun: false });
	for (const line of run.lines) console.log(line);
	if (readFinishQueue().some((e) => prKey(e) === prKey(entry))) {
		console.log(color.dim(`Waiting for CI; the menu bar (or "gh wpr tick") merges it when it passes.`));
	}
	return 0;
}

/** Opens Claude Code in the worktree to resolve the rebase conflicts. */
function openClaude(config: Config, worktree: string, base: string, files: string[]): Promise<number> {
	const [command, ...args] = config.claude.command.split(/\s+/).filter(Boolean);
	const prompt = `A rebase onto ${base} stopped with conflicts in ${files.join(', ')}. Resolve them keeping both sides' intent, run the tests that cover those files, then "git add" them and "git rebase --continue". Do not push.`;
	return new Promise((resolvePromise) => {
		const child = spawn(command, [...args, prompt], { cwd: worktree, stdio: 'inherit' });
		child.on('error', (error) => {
			console.error(`${color.red('error')} Could not start "${command}": ${error.message}`);
			resolvePromise(1);
		});
		child.on('exit', (code) => resolvePromise(code ?? 0));
	});
}

/** Stores the Notion token in the macOS keychain; `security` asks for it, so it never passes through here. */
export async function auth(service: string | undefined): Promise<number> {
	if (service !== 'notion') throw new FinishError('Usage: gh wpr auth notion');
	if (process.platform !== 'darwin') {
		console.log(`Set ${TOKEN_ENV} in your environment (the keychain is macOS only).`);
		return 1;
	}
	console.log('Paste a Notion token below; it is stored in your keychain. Either:');
	console.log('  · a personal access token (notion.so/developers/tokens, "Notion API" capability): it acts as you, no sharing needed;');
	console.log('  · an internal integration secret (notion.so/profile/integrations): share the database with it (••• → Connections).');
	return new Promise((resolvePromise) => {
		const child = spawn('security', ['add-generic-password', '-U', '-s', KEYCHAIN.service, '-a', KEYCHAIN.account, '-w'], { stdio: 'inherit' });
		child.on('exit', (code) => {
			if (code === 0) console.log(`${color.green('✓')} Saved. Check it with "gh wpr doctor".`);
			resolvePromise(code ?? 1);
		});
	});
}
