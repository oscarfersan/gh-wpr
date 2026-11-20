import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class GhError extends Error {}

/** Runs the GitHub CLI with the user's own authentication. */
export async function gh(args: string[]): Promise<string> {
	try {
		const { stdout } = await execFileAsync('gh', args, { maxBuffer: 64 * 1024 * 1024 });
		return stdout;
	} catch (error) {
		const err = error as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
		if (err.code === 'ENOENT') {
			throw new GhError('Cannot find "gh" in PATH. Install it from https://cli.github.com and run "gh auth login".');
		}
		const detail = (err.stderr || err.stdout || err.message).trim();
		throw new GhError(detail);
	}
}

interface GraphqlResponse<T> {
	data?: T;
	errors?: { message: string }[];
}

export async function graphql<T>(query: string, variables: Record<string, string | number> = {}): Promise<T> {
	const args = ['api', 'graphql', '-f', `query=${query}`];
	for (const [key, value] of Object.entries(variables)) {
		args.push(typeof value === 'number' ? '-F' : '-f', `${key}=${value}`);
	}
	let raw: string;
	try {
		raw = await gh(args);
	} catch (error) {
		// gh exits non-zero on GraphQL errors but still prints the JSON body.
		const message = (error as Error).message;
		if (message.startsWith('{')) raw = message;
		else throw error;
	}
	const parsed = JSON.parse(raw) as GraphqlResponse<T>;
	if (parsed.errors?.length) throw new GhError(parsed.errors.map((e) => e.message).join('; '));
	if (!parsed.data) throw new GhError('GitHub returned an empty GraphQL response');
	return parsed.data;
}

/** Posts an issue comment on a PR and returns its URL. */
export async function postComment(repo: string, number: number, body: string): Promise<string> {
	const out = await gh(['api', `repos/${repo}/issues/${number}/comments`, '-f', `body=${body}`, '--jq', '.html_url']);
	return out.trim();
}

/** Requests (or re-requests) a review, which notifies the reviewer like the button on github.com. */
export async function requestReviewers(repo: string, number: number, logins: string[]): Promise<void> {
	const args = ['api', '-X', 'POST', `repos/${repo}/pulls/${number}/requested_reviewers`, '--silent'];
	for (const login of logins) args.push('-f', `reviewers[]=${login}`);
	await gh(args);
}

export async function openInBrowser(url: string): Promise<void> {
	await execFileAsync(process.platform === 'darwin' ? 'open' : 'xdg-open', [url]);
}

export async function currentRepo(): Promise<string | null> {
	try {
		return (await gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])).trim() || null;
	} catch {
		return null;
	}
}
