import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { stateDir } from '../paths.ts';

const execFileAsync = promisify(execFile);

/*
 * Menu actions that need a terminal (Finish, Claude Code, doctor) used SwiftBar's
 * `terminal=true`, which drives Terminal with Apple Events. macOS asks for the
 * Automation permission for that, and on managed Macs granting it can need an
 * admin password. Opening a `.command` file with `open` goes through Launch
 * Services instead, which needs no permission.
 */

/** Quotes a word for bash. */
export const shellQuote = (word: string): string => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`);

/**
 * A script that runs `gh wpr <args>` (through the SwiftBar plugin when there is
 * one, so it gets the plugin's PATH) and keeps the window open to read the result.
 */
export function terminalScript(args: string[], plugin: string | undefined, self: string): string {
	const command = plugin ? [plugin, ...args] : ['gh', 'wpr', ...args];
	return [
		'#!/bin/bash',
		`rm -f ${shellQuote(self)}`,
		'clear',
		command.map(shellQuote).join(' '),
		'status=$?',
		'echo',
		'read -n 1 -s -r -p "Finished (exit $status). Press any key to close this window."',
		'echo',
		'',
	].join('\n');
}

const runDir = (): string => join(stateDir(), 'run');

/** Removes scripts left behind by windows that never ran them. */
function sweep(now = Date.now()): void {
	try {
		for (const name of readdirSync(runDir())) {
			const file = join(runDir(), name);
			if (now - statSync(file).mtimeMs > 24 * 60 * 60_000) rmSync(file, { force: true });
		}
	} catch {
		// nothing to clean
	}
}

/** Opens a Terminal window that runs `gh wpr <args>`. */
export async function openInTerminal(args: string[]): Promise<number> {
	if (args.length === 0) throw new Error('Usage: gh wpr terminal <command> [args]');
	sweep();
	mkdirSync(runDir(), { recursive: true });
	const file = join(runDir(), `wpr-${args[0]}-${Date.now()}.command`);
	writeFileSync(file, terminalScript(args, process.env.GH_WPR_PLUGIN, file));
	chmodSync(file, 0o700);
	await execFileAsync('open', ['-a', 'Terminal', file]);
	return 0;
}
