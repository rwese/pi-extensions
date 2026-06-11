/**
 * Renderable string helpers (no I/O, no state).
 *
 * `format/formatting.ts` is a pure-string layer that the renderer
 * and the status line use to draw headers, countdowns, usage
 * summaries, and tool-call previews. It depends only on
 * `core/types` (for `SingleResult`) and `core/constants` (for
 * `WRAP_UP_GRACE_MS`).
 *
 * `formatTimeoutSuffix` is also re-exported by `core/status.ts`
 * to format the timeout suffix on per-invocation status lines.
 * That is the one upward edge into the format layer; the
 * dependency graph keeps the format layer free of side effects.
 */

import * as os from "node:os";
import { WRAP_UP_GRACE_MS } from "../core/constants.js";
import type { SingleResult } from "../core/types.js";

/**
 * Compact `H:MM:SS` / `M:SS` / `Xs` rendering of a duration in
 * milliseconds. `0` renders as `unlimited` (used to signal that
 * the caller has no timeout budget). Values < 1s render with
 * their numeric value and the `ms` suffix; < 1m as seconds;
 * < 1h as minutes; otherwise as `Hh` or `HhMm`.
 */
export function formatTimeout(timeoutMs: number): string {
	if (timeoutMs === 0) return "unlimited";
	if (timeoutMs < 1000) return `${timeoutMs}ms`;
	if (timeoutMs < 60_000) return `${Math.round(timeoutMs / 1000)}s`;
	const minutes = Math.round(timeoutMs / 60_000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	return remainingMinutes > 0 ? `${hours}h${remainingMinutes}m` : `${hours}h`;
}

/**
 * Render `timeoutMs` as a parenthesized suffix (e.g. ` (5m)`)
 * for inclusion in a status line. Returns the empty string when
 * `timeoutMs` is `undefined`.
 */
export function formatTimeoutSuffix(timeoutMs: number | undefined): string {
	return timeoutMs !== undefined ? ` (${formatTimeout(timeoutMs)})` : "";
}

/**
 * Compact `H:MM:SS` / `M:SS` / `Ss` countdown formatter.
 * `totalMs` is the remaining duration in milliseconds; values
 * <= 0 render as `0s`. Used by the renderer to draw a single
 * live timer per subagent invocation. We pick clock-style
 * (`2:13`, `0:45`) over the bulkier `2m 13s` form because the
 * tag has to fit comfortably next to the agent name in the
 * per-row header.
 */
export function formatCountdown(totalMs: number): string {
	const seconds = Math.max(0, Math.floor(totalMs / 1000));
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const secs = seconds % 60;
	if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
	if (minutes > 0) return `${minutes}:${String(secs).padStart(2, "0")}`;
	return `${secs}s`;
}

/**
 * Compact token-count formatter. < 1k uses the raw integer;
 * < 10k uses one decimal (`1.2k`); < 1M uses whole `k`; < 1B
 * uses one decimal `M`. Keeps usage lines readable even for
 * runs that touch a million tokens.
 */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

/**
 * Render a single-line usage summary (turns, input, output,
 * cache, cost, context, model). Skips zero-valued fields except
 * for `turns` (always shown when known) and `model` (always
 * shown when provided).
 */
export function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

/**
 * Render a short preview of a tool call for the live display.
 * Recognizes a handful of well-known tool names (bash, read,
 * write, edit, ls, find, grep) and shortens the relevant
 * argument (command, file path, search pattern) for the
 * collapsed view. Falls back to a JSON preview for unknown
 * tool names.
 */
export function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

/**
 * Decide what (if anything) the renderer's per-row countdown
 * tag should say for `r`, evaluated at `now`. Returns `null`
 * when no tag should be drawn: the subagent finished
 * voluntarily, was aborted, was hard-killed by the grace timer,
 * was given an unlimited budget, or has no recorded start time.
 *
 * The two non-null cases are:
 *   - Pre-notice countdown:    `⏱ <time left>` against
 *                              `startedAt + timeoutMs`.
 *   - In-grace countdown:      `⏱ grace: <time left>` against
 *                              `startedAt + timeoutMs + WRAP_UP_GRACE_MS`.
 *
 * `wrapUpStartedAt` is the canonical signal that we are inside
 * the grace window — it is set inside the notice timer's body,
 * not derived from the `WRAP_UP_GRACE_MS` constant — so the
 * renderer does not need to know the grace length and stays
 * decoupled from the timer constants.
 */
export function computeCountdownLabel(r: SingleResult, now: number): string | null {
	if (!r.startedAt || !r.timeoutMs || r.timeoutMs <= 0) return null;
	// Drop the tag once the invocation is over. The renderer
	// also drops it when `!isPartial`, but checking the result
	// fields keeps the helper safe for callers that don't pass
	// isPartial.
	if (r.timedOut) return null;
	if (r.stopReason === "aborted" || r.stopReason === "error") return null;
	const graceDeadline = r.startedAt + r.timeoutMs + WRAP_UP_GRACE_MS;
	if (r.wrapUpStartedAt) {
		// The wrap-up notice has fired. We are somewhere in the
		// [notice, notice + WRAP_UP_GRACE_MS] window. The deadline
		// for the grace kill is `graceDeadline`; we render a
		// "grace:" countdown against that.
		const left = graceDeadline - now;
		return `⏱ grace: ${formatCountdown(left)}`;
	}
	const deadline = r.startedAt + r.timeoutMs;
	if (now >= deadline) {
		// Past the original budget but the notice hasn't fired
		// yet. Race window of <1s between the timeout firing and
		// the notice timer's body running; show "grace: 5m" so
		// the user doesn't see a stale "0s" flicker.
		return `⏱ grace: ${formatCountdown(WRAP_UP_GRACE_MS)}`;
	}
	return `⏱ ${formatCountdown(deadline - now)}`;
}
