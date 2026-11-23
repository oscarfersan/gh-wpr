import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { changeKey } from '../src/rebase.ts';

const file = (patch: string, filename = 'CHANGELOG.md') => ({ filename, status: 'modified', sha: 'x', patch });

describe('changeKey', () => {
	it('ignores line numbers and context that the base moved', () => {
		const before = changeKey([file('@@ -1,3 +1,4 @@\n # Changelog\n+- My fix\n ## 2.120.1')]);
		const after = changeKey([file('@@ -1,5 +1,6 @@\n # Changelog\n+- My fix\n ## 2.120.2\n- Hotfix\n')]);
		// The second hunk removes a line, so it is not the same change.
		assert.notEqual(before, after);
		const moved = changeKey([file('@@ -9,3 +9,4 @@\n ## 2.120.2\n+- My fix\n ## 2.120.1')]);
		assert.equal(before, moved);
	});

	it('does not depend on file order', () => {
		const a = file('@@ -1 +1 @@\n-a\n+b', 'a.ts');
		const b = file('@@ -1 +1 @@\n-c\n+d', 'b.ts');
		assert.equal(changeKey([a, b]), changeKey([b, a]));
	});

	it('tells apart different changes', () => {
		assert.notEqual(changeKey([file('@@ -1 +1 @@\n-a\n+b')]), changeKey([file('@@ -1 +1 @@\n-a\n+c')]));
	});

	it('gives up when GitHub truncated the file list', () => {
		assert.equal(changeKey(Array.from({ length: 300 }, (_, i) => file('+x', `f${i}`))), null);
	});
});
