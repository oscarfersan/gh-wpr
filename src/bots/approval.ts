/**
 * Where a reviewer stands on the current head commit. A PR is done when
 * CodeRabbit, Codex and a teammate have all approved it, in any order.
 */
export type Approval =
	| { kind: 'disabled' }
	/** Approved the head commit. */
	| { kind: 'approved'; at: string }
	/** Reviewed the head commit and wants changes (or found issues). */
	| { kind: 'changes'; at: string }
	/** Its last verdict is about an older commit. */
	| { kind: 'stale'; oid: string | null }
	/** No verdict yet. */
	| { kind: 'none' }
	/** An optional reviewer nobody asked on this PR (Codex on small PRs). */
	| { kind: 'not_requested' };

export const isApproved = (a: Approval): boolean => a.kind === 'approved' || a.kind === 'disabled' || a.kind === 'not_requested';
