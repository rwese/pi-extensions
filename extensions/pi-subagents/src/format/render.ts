/**
 * Render helpers used by the `subagent` tool's `renderResult`.
 *
 * `format/render.ts` houses the two pure helpers that the
 * `renderResult` method used to declare as inline closures:
 * `renderDisplayItems` (text + tool-call list rendering with
 * an `expanded`/`limit` pair) and `aggregateUsage` (sum the
 * per-result usage into a single roll-up). Extracting them
 * keeps `renderResult` itself in `subagents.ts` (so
 * `registerTool` stays in one place) while letting the helpers
 * be unit-tested or replaced independently.
 *
 * Dependencies: `core/messages` (for `DisplayItem`),
 * `core/types` (for `SingleResult`), `format/formatting` (for
 * `formatToolCall` and `formatUsageStats`). The theme
 * parameter is a structural subset of `@earendil-works/pi-tui`'s
 * `Theme` — we only use `theme.fg` and `theme.fg.bind` here.
 */

import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import type { DisplayItem } from "../core/messages.js";
import type { SingleResult } from "../core/types.js";
import { formatToolCall, formatUsageStats } from "./formatting.js";

/**
 * Structural subset of the Pi tui theme the renderer needs.
 * We accept just `fg` and `fg.bind` so callers do not have
 * to thread the full `Theme` instance through helper APIs.
 */
export interface RenderTheme {
	fg: (color: ThemeColor, text: string) => string;
}

/**
 * Render a list of `DisplayItem`s as a multi-line preview.
 *
 *   - `limit` (optional): only show the last `limit` items and
 *     prepend a `... N earlier items` line. Used by the
 *     collapsed view to keep the output bounded.
 *   - `expanded`: when true, show full text content; when
 *     false, cap each text item at three lines. Tool calls
 *     are always shown in full regardless of `expanded` (the
 *     `formatToolCall` helper handles its own truncation).
 *
 * The returned string has no trailing newline; callers can
 * append their own.
 */
export function renderDisplayItems(
	items: DisplayItem[],
	theme: RenderTheme,
	expanded: boolean,
	limit?: number,
): string {
	const toShow = limit ? items.slice(-limit) : items;
	const skipped = limit && items.length > limit ? items.length - limit : 0;
	let text = "";
	if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
	for (const item of toShow) {
		if (item.type === "text") {
			const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
			text += `${theme.fg("toolOutput", preview)}\n`;
		} else {
			text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
		}
	}
	return text.trimEnd();
}

/**
 * Sum the per-result `usage` fields into a single roll-up
 * object. The shape mirrors the subset of `UsageStats` that
 * `formatUsageStats` reads so the caller can pass the result
 * straight through:
 *
 *   `formatUsageStats(aggregateUsage(results))`
 *
 * The aggregation is intentionally shallow — it does not
 * collapse model names, since a chain/parallel call may use
 * different models per step and the total line is meant to
 * remain model-agnostic.
 */
export function aggregateUsage(results: SingleResult[]): {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
} {
	const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
	for (const r of results) {
		total.input += r.usage.input;
		total.output += r.usage.output;
		total.cacheRead += r.usage.cacheRead;
		total.cacheWrite += r.usage.cacheWrite;
		total.cost += r.usage.cost;
		total.turns += r.usage.turns;
	}
	return total;
}
