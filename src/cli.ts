import { ai } from './commands/ai.ts';
import { claude } from './commands/claude.ts';
import { doctor } from './commands/doctor.ts';
import { init } from './commands/init.ts';
import { nudge, open } from './commands/nudge.ts';
import { status } from './commands/status.ts';
import { swiftbarInstall, swiftbarMenu } from './commands/swiftbar.ts';
import { tick } from './commands/tick.ts';
import { ConfigError, loadConfigFresh } from './config.ts';
import { color } from './format.ts';
import { GhError } from './github.ts';
import { TargetError } from './target.ts';
import type { Bot } from './types.ts';

const HELP = `gh wpr — see whose turn it is on your PRs and request AI reviews in order

Usage
  gh wpr [status] [--json] [--full] [--tick]   Open PRs grouped by whose turn it is
  gh wpr ai <pr>... [--bot coderabbit|codex] [--force] [--dry-run]
                                               Unstick CodeRabbit if needed, then Codex
  gh wpr ai --mine [--dry-run]                 Same, for every PR of yours that needs it
  gh wpr tick [--dry-run] [--quiet]            Post queued requests that are due
  gh wpr nudge <pr> [--dry-run]                Ask your teammate to review again ("nudge.mode" in the config)
  gh wpr open <pr>                             Open the PR in the browser
  gh wpr claude <pr>                           Start Claude Code in the repo with a prompt about the PR
  gh wpr swiftbar                              Print the SwiftBar menu (used by the plugin)
  gh wpr swiftbar install [--dir <folder>]     Install the SwiftBar plugin
  gh wpr init [--repo owner/name]... [--team a,b] [--ignore-check name]... [--yes] [--force]
                                               Set up, or fill in what is missing
  gh wpr doctor [--json]                       Check every feature and say how to fix what is missing

<pr> is a number, #number, owner/repo#number or a PR URL. Use --repo when you follow
several repositories and the number is ambiguous.
`;

interface Parsed {
	positional: string[];
	flags: Map<string, string[]>;
}

const VALUE_FLAGS = new Set(['repo', 'bot', 'team', 'ignore-check', 'dir']);

export function parseArgs(argv: string[]): Parsed {
	const positional: string[] = [];
	const flags = new Map<string, string[]>();
	const add = (name: string, value: string) => flags.set(name, [...(flags.get(name) ?? []), value]);
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '-h') {
			add('help', 'true');
		} else if (arg.startsWith('--')) {
			const [name, inline] = arg.slice(2).split(/=(.*)/s, 2);
			if (inline !== undefined) add(name, inline);
			else if (VALUE_FLAGS.has(name)) {
				const value = argv[++i];
				if (value === undefined) throw new UsageError(`--${name} needs a value`);
				add(name, value);
			} else add(name, 'true');
		} else positional.push(arg);
	}
	return { positional, flags };
}

class UsageError extends Error {}

const KNOWN: Record<string, string[]> = {
	status: ['json', 'full', 'tick'],
	ai: ['bot', 'force', 'dry-run', 'mine', 'repo'],
	tick: ['dry-run', 'quiet'],
	nudge: ['dry-run', 'repo'],
	open: ['repo'],
	claude: ['repo'],
	swiftbar: ['dir'],
	init: ['repo', 'team', 'ignore-check', 'yes', 'force'],
	doctor: ['json'],
};

async function main(argv: string[]): Promise<number> {
	const { positional, flags } = parseArgs(argv);
	const has = (name: string) => flags.has(name);
	const one = (name: string) => flags.get(name)?.at(-1);
	const many = (name: string) => (flags.get(name) ?? []).flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);

	if (has('help') || positional[0] === 'help') {
		console.log(HELP);
		return 0;
	}
	const command = positional[0] ?? 'status';
	const args = positional.slice(1);
	const allowed = KNOWN[command];
	if (!allowed) throw new UsageError(`Unknown command "${command}". Run "gh wpr --help".`);
	const unknown = [...flags.keys()].filter((f) => !allowed.includes(f));
	if (unknown.length) throw new UsageError(`"${command}" does not take --${unknown.join(', --')}`);

	if (command === 'init') {
		return init({ repos: many('repo'), team: many('team'), ignoreChecks: many('ignore-check'), yes: has('yes'), force: has('force') });
	}

	if (command === 'doctor') return doctor({ json: has('json') });

	if (command === 'swiftbar') {
		if (args[0] === 'install') return swiftbarInstall(one('dir'));
		if (args.length > 0) throw new UsageError('Usage: gh wpr swiftbar [install [--dir <folder>]]');
		await swiftbarMenu();
		return 0;
	}

	const { config } = await loadConfigFresh();
	switch (command) {
		case 'status':
			await status(config, { json: has('json'), full: has('full'), tick: has('tick') });
			return 0;
		case 'ai': {
			const bot = one('bot');
			if (bot !== undefined && bot !== 'coderabbit' && bot !== 'codex') {
				throw new UsageError('--bot must be "coderabbit" or "codex"');
			}
			return ai(config, {
				targets: args,
				repo: one('repo'),
				mine: has('mine'),
				dryRun: has('dry-run'),
				force: has('force'),
				only: bot as Bot | undefined,
			});
		}
		case 'tick':
			await tick(config, { dryRun: has('dry-run'), quiet: has('quiet') });
			return 0;
		case 'nudge':
			if (!args[0]) throw new UsageError('Which PR? Usage: gh wpr nudge <pr>');
			return nudge(config, args[0], one('repo'), has('dry-run'));
		case 'open':
			if (!args[0]) throw new UsageError('Which PR? Usage: gh wpr open <pr>');
			await open(config, args[0], one('repo'));
			return 0;
		case 'claude':
			if (!args[0]) throw new UsageError('Which PR? Usage: gh wpr claude <pr>');
			return claude(config, args[0], one('repo'));
	}
	return 0;
}

main(process.argv.slice(2)).then(
	(code) => {
		process.exitCode = code;
	},
	(error: unknown) => {
		const expected = [UsageError, ConfigError, GhError, TargetError].some((E) => error instanceof E);
		const message = error instanceof Error ? error.message : String(error);
		console.error(`${color.red('error')} ${message}`);
		if (!expected && error instanceof Error && process.env.GH_WPR_DEBUG) console.error(error.stack);
		process.exitCode = expected ? 1 : 2;
	},
);
