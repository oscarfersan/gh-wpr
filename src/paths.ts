import { homedir } from 'node:os';
import { join } from 'node:path';

export const configDir = (): string =>
	process.env.GH_WPR_CONFIG_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'gh-wpr');

export const configFile = (): string => join(configDir(), 'config.json');

export const stateDir = (): string =>
	process.env.GH_WPR_STATE_DIR ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'gh-wpr');
