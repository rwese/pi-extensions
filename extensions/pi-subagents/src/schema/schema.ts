/**
 * Typebox schemas for the `subagent` tool's input shape.
 *
 * `schema/schema.ts` is the only module that knows the exact
 * shape of the JSON the parent agent sends into the
 * `subagent` tool. The runtime `execute` path in
 * `subagents.ts` reads these schemas to register the tool with
 * the Pi runtime; description strings are surfaced to the
 * model verbatim, so we keep them precise.
 *
 * The module has no internal dependencies — only the
 * `Typebox` builder helpers and `StringEnum` from
 * `@earendil-works/pi-ai` (used for the agent-scope enum).
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

/**
 * Hard per-subagent timeout in milliseconds.
 *
 * `0` means unlimited — the runner will never fire the
 * wrap-up notice and the subprocess runs until it exits
 * naturally. Defaults are resolved at the call site from
 * `PI_SUBAGENT_TIMEOUT_MS` or `DEFAULT_TIMEOUT_MS`.
 */
export const TimeoutMs = Type.Number({
	description:
		"Hard timeout in milliseconds for each subagent subprocess. 0 = unlimited. Defaults to PI_SUBAGENT_TIMEOUT_MS or 600000.",
	minimum: 0,
});

/** Per-task entry in the parallel-mode `tasks` array. */
export const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	timeoutMs: Type.Optional(TimeoutMs),
});

/** Per-step entry in the chain-mode `chain` array. The `{previous}`
 *  placeholder inside `task` is replaced with the prior step's
 *  final output at run time. */
export const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	timeoutMs: Type.Optional(TimeoutMs),
});

/** Fan-in / aggregator step that runs after parallel `tasks` complete. */
export const AggregatorItem = Type.Object({
	agent: Type.String({ description: "Name of the fan-in agent to invoke after parallel tasks complete" }),
	task: Type.String({ description: "Fan-in task. Use {previous} to include all parallel outputs." }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the aggregator process" })),
	timeoutMs: Type.Optional(TimeoutMs),
});

/** Which agent directories to draw from. `both` includes project-local. */
export const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

/** Top-level `subagent` tool input. Exactly one of `agent+task`,
 *  `tasks`, or `chain` must be set. `aggregator` is only valid
 *  alongside `tasks`. */
export const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	aggregator: Type.Optional(AggregatorItem),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	timeoutMs: Type.Optional(TimeoutMs),
});
