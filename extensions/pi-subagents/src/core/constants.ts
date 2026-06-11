/**
 * Constants and parsing helpers shared by every layer of the
 * subagent extension.
 *
 * `core/constants.ts` is the foundation of the layered module
 * layout (see `docs/plans/refactor-pi-subagents.md`). It depends
 * on no other internal modules — only the Node `process` global
 * for environment-variable lookup.
 *
 * Centralizing these values here means a tuning change (e.g.
 * bumping `WRAP_UP_GRACE_MS`) is a one-file edit instead of a
 * hunt-and-replace, and lets us enforce the layered dependency
 * graph: e.g. `process/reap.ts` is allowed to read
 * `KILL_GRACE_MS` but not the renderer.
 */

/** Maximum number of entries in a single parallel `tasks` array. */
export const MAX_PARALLEL_TASKS = 8;

/** Maximum number of parallel pi subprocesses we will run at once. */
export const MAX_CONCURRENCY = 4;

/** Maximum number of display items shown in the collapsed view. */
export const COLLAPSED_ITEM_COUNT = 10;

/** Maximum number of agents listed in the tool description hint. */
export const MAX_AGENTS_IN_DESCRIPTION = 20;

/** Default per-subagent timeout. Overridable via PI_SUBAGENT_TIMEOUT_MS. */
export const DEFAULT_TIMEOUT_MS = parseNonNegativeInteger(process.env.PI_SUBAGENT_TIMEOUT_MS) ?? 10 * 60 * 1000;

/**
 * Grace period after SIGTERM before the runner escalates to
 * SIGKILL during `terminateProcess`. Long enough for a cooperative
 * pi process to clean up; short enough that a stuck subprocess
 * does not block the parent for long.
 */
export const KILL_GRACE_MS = 5000;

/**
 * Grace period after the wrap-up notice is delivered before the
 * runner hard-kills the subagent. Gives the subagent a chance to
 * finish its current turn and return a concise summary.
 */
export const WRAP_UP_GRACE_MS = 5 * 60 * 1000;

/** Wrap-up message delivered to the subagent at the timeout-notice boundary. */
export const WRAP_UP_MESSAGE =
	"Subagent timeout approaching. Wrap up the current task and return a concise summary within 5 minutes, then exit.";

/**
 * Parse a non-negative integer from an environment variable.
 * Returns `undefined` if the value is missing, empty, not a
 * finite number, or negative. Used to safely read
 * `PI_SUBAGENT_TIMEOUT_MS` into a runtime `DEFAULT_TIMEOUT_MS`.
 */
export function parseNonNegativeInteger(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}
