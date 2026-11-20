import { execFile } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { loadConfig } from '../config.ts';
import { color } from '../format.ts';
import { notices, postedNotices, readMemory, remember, writeMemory } from '../notify.ts';
import type { Notice } from '../notify.ts';
import { readQueue } from '../queue.ts';
import { loadSnapshot } from '../snapshot.ts';
import { renderError, renderMenu } from '../swiftbar.ts';
import { assessAll } from '../turn.ts';
import { runQueue } from './tick.ts';

const execFileAsync = promisify(execFile);

const PLUGIN_NAME = 'wpr.1m.sh';
const PLUGIN_SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), '../../swiftbar', PLUGIN_NAME);

async function sendNotice(notice: Notice): Promise<void> {
	const plugin = process.env.SWIFTBAR_PLUGIN_PATH;
	if (!plugin) return;
	const query = new URLSearchParams({
		plugin: plugin.split('/').pop() ?? PLUGIN_NAME,
		title: notice.title,
		body: notice.body,
		href: notice.url,
	});
	// URLSearchParams encodes spaces as "+", which SwiftBar would show literally.
	await execFileAsync('open', ['-g', `swiftbar://notify?${query.toString().replace(/\+/g, '%20')}`]).catch(() => undefined);
}

/** Prints the menu for SwiftBar. Never throws: errors become a warning icon in the menu bar. */
export async function swiftbarMenu(): Promise<void> {
	try {
		const config = loadConfig();
		const now = new Date();
		let snapshot = await loadSnapshot(config);
		const tick = await runQueue(config, snapshot, { dryRun: false });
		if (tick.posted > 0) snapshot = await loadSnapshot(config);
		const queue = readQueue();
		const items = assessAll(snapshot.prs, config, snapshot.viewer, now, queue);

		if (config.notify) {
			const memory = readMemory();
			for (const notice of [...postedNotices(tick.postedEntries, items), ...notices(memory, items)]) await sendNotice(notice);
		}
		writeMemory(remember(items));

		const plugin = process.env.GH_WPR_PLUGIN ?? process.env.SWIFTBAR_PLUGIN_PATH ?? PLUGIN_SOURCE;
		process.stdout.write(renderMenu(items, { plugin, now, viewer: snapshot.viewer, queued: queue.length, tickLines: tick.lines }));
	} catch (error) {
		process.stdout.write(renderError(error instanceof Error ? error.message : String(error)));
	}
}

async function swiftbarPluginDir(): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync('defaults', ['read', 'com.ameba.SwiftBar', 'PluginDirectory']);
		return stdout.trim() || null;
	} catch {
		return null;
	}
}

/** Copies the plugin into SwiftBar's plugin folder. */
export async function swiftbarInstall(dir: string | undefined): Promise<number> {
	const target = dir ?? (await swiftbarPluginDir());
	if (!target) {
		console.log(
			`${color.yellow('!')} Could not find SwiftBar's plugin folder. Open SwiftBar once and choose one, or pass --dir <folder>.`,
		);
		return 1;
	}
	const folder = target.replace(/^~(?=\/|$)/, process.env.HOME ?? '~');
	if (!existsSync(PLUGIN_SOURCE)) {
		console.log(`${color.red('✗')} Plugin source not found at ${PLUGIN_SOURCE}`);
		return 1;
	}
	mkdirSync(folder, { recursive: true });
	const destination = join(folder, PLUGIN_NAME);
	copyFileSync(PLUGIN_SOURCE, destination);
	chmodSync(destination, 0o755);
	console.log(`${color.green('✓')} Installed ${destination}`);
	console.log(color.dim('SwiftBar picks it up on its next refresh. Run this again after "gh extension upgrade wpr".'));
	return 0;
}
