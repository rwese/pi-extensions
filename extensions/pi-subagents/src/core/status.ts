/**
 * Subagent status line.
 *
 * `core/status.ts` owns the `STATUS_KEY` the runner pushes
 * subagent activity into via the Pi UI's `setStatus` hook. It
 * also builds the per-invocation status strings (`singleStatus`,
 * `chainStatus`, `parallelStatus`, `fanInStatus`) that the
 * `execute` body updates as work progresses.
 *
 * The only allowed dependency from `core/` into the `format/`
 * layer is `formatTimeoutSuffix` (a pure-string helper). That
 * keeps the layered graph strict: `format/formatting.ts` has
 * no I/O and no state, so depending on it from `core/status.ts`
 * does not break the "core has no I/O" rule.
 */

import { formatTimeoutSuffix } from "../format/formatting.js";

/** UI status key reserved by the subagent extension. */
export const STATUS_KEY = "subagents";

/**
 * Map of `toolCallId` -> last status string. We keep a single
 * status line per tool call: when a parallel run fires several
 * subagents, the UI displays the first and tags a `+N` for the
 * remaining. Cleared when the runner reports the tool call done.
 */
export const activeStatuses = new Map<string, string>();

/** Minimal surface from the Pi `ui` context the status helpers need. */
export interface StatusContext {
	ui: { setStatus: (key: string, value: string | undefined) => void };
}

/**
 * Begin a status tracking session for `toolCallId`. Returns an
 * object with `update(next)` to push a new status and `clear()`
 * to remove the tool call from the active set when the runner
 * is done. `clear()` is idempotent so a `finally` block can
 * always call it without coordinating with the success path.
 */
export function startSubagentStatus(ctx: StatusContext, toolCallId: string, status: string) {
	let cleared = false;

	const update = (nextStatus: string) => {
		if (cleared) return;
		activeStatuses.set(toolCallId, nextStatus);
		publishSubagentStatus(ctx);
	};

	update(status);

	return {
		update,
		clear() {
			if (cleared) return;
			cleared = true;
			activeStatuses.delete(toolCallId);
			publishSubagentStatus(ctx);
		},
	};
}

/**
 * Push the consolidated status string into the Pi UI. If no
 * tool calls are active, the slot is cleared; otherwise we show
 * the most recent status and a `+N` tail to signal additional
 * parallel subagents.
 */
export function publishSubagentStatus(ctx: StatusContext) {
	const statuses = [...activeStatuses.values()];
	if (statuses.length === 0) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}

	const suffix = statuses.length > 1 ? ` +${statuses.length - 1}` : "";
	ctx.ui.setStatus(STATUS_KEY, `${statuses[0]}${suffix}`);
}

/** Status line for a single-agent invocation. */
export function singleStatus(agent: string, timeoutMs?: number): string {
	return `🧑‍🤝‍🧑 ${agent}${formatTimeoutSuffix(timeoutMs)}`;
}

/** Status line for a chain step. `agent` is optional because the
 *  initial chain kickoff may not know the first agent yet. */
export function chainStatus(step: number, total: number, agent?: string, timeoutMs?: number): string {
	return `🧑‍🤝‍🧑 chain ${step}/${total}${agent ? ` ${agent}` : ""}${formatTimeoutSuffix(timeoutMs)}`;
}

/** Status line for the parallel mode aggregate. */
export function parallelStatus(done: number, total: number, running: number, timeoutMs?: number): string {
	return `🧑‍🤝‍🧑 parallel ${done}/${total} done${running > 0 ? ` ${running} running` : ""}${formatTimeoutSuffix(timeoutMs)}`;
}

/** Status line for the parallel-mode aggregator / fan-in step. */
export function fanInStatus(agent: string, timeoutMs?: number): string {
	return `🧑‍🤝‍🧑 fan-in ${agent}${formatTimeoutSuffix(timeoutMs)}`;
}
