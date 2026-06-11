/**
 * Subagent config persistence and type guards.
 *
 * `core/settings.ts` owns the on-disk
 * `~/.pi/agent/pi-subagents-config.json` format: reading,
 * validating, and writing. It also exports the small set of
 * type guards (`isPlainObject`, `isStringArray`,
 * `isPositiveNumber`) used by the normalizers.
 *
 * `hasOwn` is re-exported from here so `agents.ts` can
 * de-duplicate its own copy of the helper. Both files then
 * depend on a single canonical `hasOwn`.
 *
 * Dependencies are restricted to `core/types` (for nothing
 * here directly, but kept for layered consistency), the
 * `agents.ts` module (for the persisted config types), Node
 * `fs`/`path`, and the `getAgentDir` helper from
 * `@earendil-works/pi-coding-agent`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SubagentAgentConfig, SubagentSettings } from "../agents.js";

/**
 * Object.hasOwn is available on Node 18+; we wrap it for
 * readability and to give callers a stable function reference
 * when the value is borrowed from a non-`Object.prototype`
 * object.
 */
export function hasOwn(obj: object, key: PropertyKey): boolean {
	return Object.hasOwn(obj, key);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function isPositiveNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 1;
}

/**
 * Normalize one agent's config block. Returns `undefined` for
 * shapes we cannot trust (wrong types, no known fields), so
 * the caller's outer loop can drop the entry silently.
 */
export function normalizeAgentSettings(value: unknown): SubagentAgentConfig | undefined {
	if (!isPlainObject(value)) return undefined;

	const config: SubagentAgentConfig = {};
	let hasKnownField = false;

	if (hasOwn(value, "tools")) {
		if (!isStringArray(value.tools)) return undefined;
		config.tools = value.tools;
		hasKnownField = true;
	}

	if (hasOwn(value, "model")) {
		if (value.model !== null && typeof value.model !== "string") return undefined;
		config.model = value.model;
		hasKnownField = true;
	}

	if (hasOwn(value, "timeoutMs")) {
		if (value.timeoutMs !== null && !isPositiveNumber(value.timeoutMs)) return undefined;
		config.timeoutMs = value.timeoutMs;
		hasKnownField = true;
	}

	return hasKnownField ? config : undefined;
}

/**
 * Normalize the full subagent settings object. Returns
 * `undefined` for shapes we cannot trust; returns `{}` for the
 * empty-but-valid case (no `agents` key).
 */
export function normalizeSubagentSettings(value: unknown): SubagentSettings | undefined {
	if (!isPlainObject(value)) return undefined;
	if (!hasOwn(value, "agents")) return {};
	if (!isPlainObject(value.agents)) return undefined;

	const agents: Record<string, SubagentAgentConfig> = {};
	for (const [name, rawConfig] of Object.entries(value.agents)) {
		const config = normalizeAgentSettings(rawConfig);
		if (config) agents[name] = config;
	}

	return Object.keys(agents).length > 0 ? { agents } : {};
}

/**
 * Read the on-disk subagent config. Returns `undefined` if
 * the file is missing, unreadable, or contains a shape that
 * fails normalization. We swallow JSON-parse errors so a
 * corrupted config does not crash the parent session.
 */
export function readSubagentSettings(): SubagentSettings | undefined {
	const configPath = path.join(getAgentDir(), "pi-subagents-config.json");
	if (!fs.existsSync(configPath)) return undefined;
	try {
		return normalizeSubagentSettings(JSON.parse(fs.readFileSync(configPath, "utf-8")));
	} catch {
		return undefined;
	}
}

/**
 * Persist the subagent config. Creates the agent directory
 * if needed; writes a pretty-printed, tab-indented JSON file
 * with a trailing newline.
 */
export function saveSubagentConfig(settings: SubagentSettings): void {
	const agentDir = getAgentDir();
	fs.mkdirSync(agentDir, { recursive: true });

	const configPath = path.join(agentDir, "pi-subagents-config.json");
	fs.writeFileSync(configPath, `${JSON.stringify(settings, null, "\t")}\n`, "utf-8");
}

/** Drop duplicates while preserving the input order. */
export function uniqueToolNames(tools: string[]): string[] {
	return [...new Set(tools)];
}

/**
 * Order-insensitive equality on two tool lists. Used by the
 * config command to detect "the user's selection matches the
 * built-in default" so we can remove the override.
 */
export function sameToolSet(left: string[], right: string[]): boolean {
	const leftSet = new Set(left);
	const rightSet = new Set(right);
	if (leftSet.size !== rightSet.size) return false;
	return [...leftSet].every((tool) => rightSet.has(tool));
}

/** True when `config` has at least one user-tunable field set. */
export function hasAnyAgentOverride(config: SubagentAgentConfig): boolean {
	return hasOwn(config, "tools") || hasOwn(config, "model") || hasOwn(config, "timeoutMs");
}
