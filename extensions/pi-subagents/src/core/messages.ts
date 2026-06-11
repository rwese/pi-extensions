/**
 * Pure functions over `Message[]` and `SingleResult`.
 *
 * `core/messages.ts` projects the raw RPC-mode message stream
 * down to the things the renderer and the fan-in step actually
 * need: the final assistant text, a list of human-friendly
 * display items (text + tool calls), and a markdown context
 * block for aggregator fan-in.
 *
 * No I/O and no state — the only dependencies are external
 * (`@earendil-works/pi-ai` for `Message`) and intra-core
 * (`SingleResult` from `core/types.ts`).
 */

import type { Message } from "@earendil-works/pi-ai";
import type { SingleResult } from "./types.js";

/**
 * Flattened view of a subagent's message stream, the unit the
 * renderer iterates over. Text parts become `text` items; tool
 * calls become `toolCall` items with their args intact.
 */
export type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, any> };

/**
 * Walk the message stream and return only the parts the
 * renderer cares about (assistant text and tool calls), in
 * stream order. System / user / toolResult messages are
 * skipped — they are bookkeeping the user should not see.
 */
export function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall")
					items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

/**
 * Extract the final assistant text from a message stream.
 * Returns the last text part of the last assistant message;
 * empty string if the stream has no assistant text. Used as
 * the canonical "final output" of a subagent invocation for
 * both the renderer and the chain handoff.
 */
export function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

/**
 * Prefer the cached `finalOutput` set by the runner's
 * `emitUpdate` hook (so streaming updates show consistent
 * output) and fall back to a fresh walk of the message
 * stream. The two are equivalent for finished invocations;
 * the cache exists so the rendered output doesn't flicker
 * while the subagent is still streaming.
 */
export function getResultFinalOutput(result: SingleResult): string {
	return result.finalOutput ?? getFinalOutput(result.messages);
}

/**
 * Build the markdown context block delivered to the
 * aggregator / fan-in step. Each parallel task becomes a
 * section with its agent name, status, original task, and
 * either the final output or the captured error. The
 * aggregator can reference this block by the literal token
 * `{previous}` in its own task.
 */
export function buildFanInContext(results: SingleResult[]): string {
	return results
		.map((result, index) => {
			const status = result.exitCode === 0 ? "completed" : result.exitCode === -1 ? "running" : "failed";
			const output = getResultFinalOutput(result);
			const error = result.errorMessage || result.stderr.trim();
			return [
				`## Result ${index + 1}: ${result.agent} (${status})`,
				`Task: ${result.task}`,
				output ? `Output:\n${output}` : error ? `Error:\n${error}` : "Output: (no output)",
			].join("\n\n");
		})
		.join("\n\n---\n\n");
}
