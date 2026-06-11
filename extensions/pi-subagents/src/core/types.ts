/**
 * Shared types for the subagent extension.
 *
 * `core/types.ts` is the foundation of the layered module layout
 * (see `docs/plans/refactor-pi-subagents.md`). It depends on
 * `agents.ts` for the agent-source / agent-scope enums and on
 * `@earendil-works/pi-ai` for the `Message` shape. No other
 * internal modules are imported here.
 */

import type { Message } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AgentScope, AgentSource } from "../agents.js";

/**
 * Token / cost accounting for a single subagent invocation.
 * Populated incrementally as assistant messages stream in via
 * RPC mode `message_end` events.
 */
export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

/**
 * One subagent invocation's worth of state — what mode it ran
 * in, what it was asked, the streaming message list, accumulated
 * usage, and timing / timeout metadata used by the renderer to
 * draw a live countdown.
 *
 * `startedAt` is wall-clock ms when this subagent invocation
 * started. The renderer pairs it with `timeoutMs` to draw a
 * live "time left" countdown against
 * `startedAt + timeoutMs` (or `startedAt + timeoutMs + WRAP_UP_GRACE_MS`
 * once the wrap-up notice has fired).
 *
 * `wrapUpStartedAt` is wall-clock ms when the wrap-up notice
 * was delivered to the subagent. Undefined before the notice
 * fires; set inside the notice timer's body so the renderer
 * can switch the countdown from "X left" to "grace: X left"
 * without re-deriving from the constant.
 */
export interface SingleResult {
	agent: string;
	agentSource: AgentSource | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	finalOutput?: string;
	timedOut?: boolean;
	timeoutMs?: number;
	startedAt?: number;
	wrapUpStartedAt?: number;
}

/**
 * The shape of the `details` payload that `registerTool` returns
 * to the Pi runtime. Captures the mode (single / parallel / chain),
 * the resolved agent scope, the discovered project-agents directory
 * (for confirmation prompts), and the per-step results.
 *
 * `aggregator` is populated only for parallel mode when an
 * aggregator fan-in step is provided.
 */
export interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
	aggregator?: SingleResult;
}

/** Streaming-update callback for `runSingleAgent`. */
export type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

/** Wrap-up notice callback; fired when the timeout-notice timer lands. */
export type OnNoticeCallback = (agentName: string) => void;
