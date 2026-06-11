/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	getAgentDir,
	getMarkdownTheme,
	withFileMutationQueue,
	DynamicBorder,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	Markdown,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
import {
	type AgentConfig,
	type AgentScope,
	type AgentSource,
	type SubagentAgentConfig,
	type SubagentSettings,
	discoverAgents,
	formatAgentList,
} from "./agents.js";
import type {
	OnNoticeCallback,
	OnUpdateCallback,
	SingleResult,
	SubagentDetails,
} from "./core/types.js";
import {
	COLLAPSED_ITEM_COUNT,
	DEFAULT_TIMEOUT_MS,
	KILL_GRACE_MS,
	MAX_AGENTS_IN_DESCRIPTION,
	MAX_CONCURRENCY,
	MAX_PARALLEL_TASKS,
	WRAP_UP_GRACE_MS,
	WRAP_UP_MESSAGE,
} from "./core/constants.js";
import {
	computeCountdownLabel,
	formatTimeout,
	formatTimeoutSuffix,
	formatToolCall,
	formatUsageStats,
} from "./format/formatting.js";
import { aggregateUsage, renderDisplayItems } from "./format/render.js";
import {
	chainStatus,
	fanInStatus,
	parallelStatus,
	singleStatus,
	startSubagentStatus,
} from "./core/status.js";
import {
	type DisplayItem,
	buildFanInContext,
	getDisplayItems,
	getFinalOutput,
	getResultFinalOutput,
} from "./core/messages.js";
import {
	hasAnyAgentOverride,
	hasOwn,
	readSubagentSettings,
	sameToolSet,
	saveSubagentConfig,
	uniqueToolNames,
} from "./core/settings.js";
import {
	debugReap,
	getPiInvocation,
	mapWithConcurrencyLimit,
	writePromptToTempFile,
} from "./process/process.js";
import {
	collectDescendantPids,
	pidStillMatches,
	readProcessStartTime,
	reapDetachedSurvivors,
	reapLeftoverDescendants,
	terminateProcess,
} from "./process/reap.js";
import { runSingleAgent } from "./runner/runner.js";
import { SubagentParams } from "./schema/schema.js";
import { registerConfigCommand } from "./ui/ui-config.js";

export default function (pi: ExtensionAPI) {
	// When spawned as a subagent, the parent passes two env vars:
	//   PI_SUBAGENT_PARENT_PID — the parent's pi process pid
	//   PI_SUBAGENT_CHILD_ID   — uuid for this specific invocation
	// Announce our pid (and the parent pid we read back) on the RPC
	// stream so the parent can track us and any descendants we spawn.
	// The parent's processLine handles `customType: "subagent_meta"`
	// specially: it stashes the payload and skips pushing it into
	// currentResult.messages. The parent's renderer never sees the
	// meta message, but its terminateProcess can read the recorded
	// pid + parentPid for accurate descendant walking and logging.
	//
	// Why deferred: at registration time, the runtime's action
	// methods (pi.sendMessage, etc.) are throwing stubs — they only
	// become real after the parent calls bindCore on us. session_start
	// and agent_start both fire after bindCore, so we use one of
	// them. We pick agent_start: in RPC mode the subagent runs
	// exactly one agent run (the initial prompt), so agent_start
	// fires once and before the first assistant message_end. A
	// `metaSent` guard prevents a duplicate if the session is later
	// reloaded or re-prompted.
	const childId = process.env.PI_SUBAGENT_CHILD_ID;
	if (childId) {
		const parentPidRaw = process.env.PI_SUBAGENT_PARENT_PID;
		const parentPid = parentPidRaw ? Number.parseInt(parentPidRaw, 10) : null;
		const parentPidNum = Number.isFinite(parentPid) ? (parentPid as number) : null;
		let metaSent = false;
		const emitMeta = () => {
			if (metaSent) return;
			metaSent = true;
			pi.sendMessage({
				customType: "subagent_meta",
				content: "",
				display: false,
				details: {
					childPid: process.pid,
					parentPid: parentPidNum,
					childId,
				},
			});
		};
		pi.on("session_start", emitMeta);
		pi.on("agent_start", emitMeta);
	}

	// Discover available agents at registration time so the tool description
	// can advertise the current roster to the model. The execute path
	// re-validates against ctx.cwd, so this is an upper-bound hint that may
	// be pruned at call time when agentScope is "user".
	const initialAgentRoster = discoverAgents(process.cwd(), "both");
	const initialAgentList = formatAgentList(initialAgentRoster.agents, MAX_AGENTS_IN_DESCRIPTION);
	const agentsHint =
		initialAgentList.remaining > 0
			? `Available agents: ${initialAgentList.text}; ... +${initialAgentList.remaining} more.`
			: `Available agents: ${initialAgentList.text}.`;

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			"Parallel mode may include an aggregator fan-in step that receives all task outputs.",
			'Default agent scope is "user" (from ~/.pi/agent/agents).',
			'To enable project-local agents in .pi/agents, set agentScope: "both" (or "project").',
			agentsHint,
		].join(" "),
		promptSnippet:
			"Delegate independent research, review, verification, or multi-step work to isolated Pi subagents.",
		promptGuidelines: [
			"Use subagent for independent read-only research, broad codebase reconnaissance, high-volume command output, multi-domain parallel investigation, or an independent reviewer after implementation.",
			"Use subagent parallel mode when work splits into independent tasks; prefer read-only agents such as scout or reviewer for fan-out and serialize write-heavy implementation that touches the same files.",
			"Do not use subagent for simple answers, quick targeted edits, latency-sensitive one-step work, or tasks requiring frequent user back-and-forth.",
			'Do not use subagent with project-local agents unless the user explicitly wants project agents or sets agentScope to "project" or "both"; keep confirmation enabled for untrusted repositories.',
			"When using subagent, write self-contained tasks with file paths, context, expected output, and whether the subagent may edit files.",
		],
		parameters: SubagentParams,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const config = readSubagentSettings();
			const discovery = discoverAgents(ctx.cwd, agentScope, config);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;
			const resolveTimeoutMs = (agentName: string, localTimeoutMs?: number) =>
				localTimeoutMs ??
				params.timeoutMs ??
				agents.find((agent) => agent.name === agentName)?.timeoutMs ??
				DEFAULT_TIMEOUT_MS;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[], aggregator?: SingleResult): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
					aggregator,
				});

			if (modeCount !== 1 || (params.aggregator && !hasTasks)) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				const reason =
					modeCount !== 1
						? "Provide exactly one mode."
						: "Aggregator is only valid with parallel tasks.";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. ${reason}\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.aggregator) requestedAgentNames.add(params.aggregator.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";
				const status = startSubagentStatus(ctx, toolCallId, chainStatus(0, params.chain.length));

				try {
					for (let i = 0; i < params.chain.length; i++) {
						const step = params.chain[i];
						status.update(
							chainStatus(i + 1, params.chain.length, step.agent, resolveTimeoutMs(step.agent, step.timeoutMs)),
						);
						const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

						// Create update callback that includes all previous results
						const chainUpdate: OnUpdateCallback | undefined = onUpdate
							? (partial) => {
									// Combine completed results with current streaming result
									const currentResult = partial.details?.results[0];
									if (currentResult) {
										const allResults = [...results, currentResult];
										onUpdate({
											content: partial.content,
											details: makeDetails("chain")(allResults),
										});
									}
								}
							: undefined;

						const result = await runSingleAgent(
							ctx.cwd,
							agents,
							step.agent,
							taskWithContext,
							step.cwd,
							i + 1,
							signal,
							resolveTimeoutMs(step.agent, step.timeoutMs),
							chainUpdate,
							makeDetails("chain"),
							(noticedAgent) => status.update(`🧑‍🤝‍🧑 ${noticedAgent} wrapping up (5m)`),
						);
						results.push(result);

						const isError =
							result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
						if (isError) {
							const errorMsg = result.errorMessage || result.stderr || getResultFinalOutput(result) || "(no output)";
							return {
								content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
								details: makeDetails("chain")(results),
								isError: true,
							};
						}
						previousOutput = getResultFinalOutput(result);
					}
					return {
						content: [{ type: "text", text: getResultFinalOutput(results[results.length - 1]) || "(no output)" }],
						details: makeDetails("chain")(results),
					};
				} finally {
					status.clear();
				}
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				// Use the longest resolved task timeout for the aggregate status line so
				// the user can see when the last task is allowed to run.
				const parallelMaxTimeoutMs = Math.max(
					...params.tasks.map((t) => resolveTimeoutMs(t.agent, t.timeoutMs)),
				);
				const status = startSubagentStatus(
					ctx,
					toolCallId,
					parallelStatus(0, params.tasks.length, params.tasks.length, parallelMaxTimeoutMs),
				);

				try {
					// Track all results for streaming updates
					const allResults: SingleResult[] = new Array(params.tasks.length);

					// Initialize placeholder results
					for (let i = 0; i < params.tasks.length; i++) {
						allResults[i] = {
							agent: params.tasks[i].agent,
							agentSource: "unknown",
							task: params.tasks[i].task,
							exitCode: -1, // -1 = still running
							messages: [],
							stderr: "",
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
							finalOutput: "",
						};
					}

					let doneCount = 0;
					let runningCount = params.tasks.length;

					const emitParallelUpdate = () => {
						status.update(parallelStatus(doneCount, allResults.length, runningCount, parallelMaxTimeoutMs));
						if (onUpdate) {
							onUpdate({
								content: [
									{
										type: "text",
										text: `Parallel: ${doneCount}/${allResults.length} done, ${runningCount} running...`,
									},
								],
								details: makeDetails("parallel")([...allResults]),
							});
						}
					};

					const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
						const result = await runSingleAgent(
							ctx.cwd,
							agents,
							t.agent,
							t.task,
							t.cwd,
							undefined,
							signal,
							resolveTimeoutMs(t.agent, t.timeoutMs),
							// Per-task update callback
							(partial) => {
								if (partial.details?.results[0]) {
									allResults[index] = { ...partial.details.results[0], exitCode: -1 };
									emitParallelUpdate();
								}
							},
							makeDetails("parallel"),
							(noticedAgent) => status.update(`🧑‍🤝‍🧑 ${noticedAgent} wrapping up (5m)`),
						);
						allResults[index] = result;
						doneCount += 1;
						runningCount -= 1;
						emitParallelUpdate();
						return result;
					});

					let aggregatorResult: SingleResult | undefined;
					if (params.aggregator) {
						const aggregator = params.aggregator;
						const aggregatorTimeoutMs = resolveTimeoutMs(aggregator.agent, aggregator.timeoutMs);
						status.update(fanInStatus(aggregator.agent, aggregatorTimeoutMs));
						const fanInContext = buildFanInContext(results);
						const aggregatorTask = aggregator.task.includes("{previous}")
							? aggregator.task.replace(/\{previous\}/g, fanInContext)
							: `${aggregator.task}\n\nParallel task outputs:\n\n${fanInContext}`;
						aggregatorResult = await runSingleAgent(
							ctx.cwd,
							agents,
							aggregator.agent,
							aggregatorTask,
							aggregator.cwd,
							undefined,
							signal,
							aggregatorTimeoutMs,
							(partial) => {
								status.update(fanInStatus(aggregator.agent, aggregatorTimeoutMs));
								if (onUpdate && partial.details?.results[0]) {
									onUpdate({
										content: partial.content,
										details: makeDetails("parallel")(results, partial.details.results[0]),
									});
								}
							},
							makeDetails("parallel"),
							(noticedAgent) => status.update(`🧑‍🤝‍🧑 ${noticedAgent} wrapping up (5m)`),
						);
					}

					const successCount = results.filter((r) => r.exitCode === 0).length;
					const summaries = results.map((r) => {
						const output = getResultFinalOutput(r);
						const error = r.errorMessage || r.stderr.trim();
						const summaryText = output || error;
						const preview = summaryText.slice(0, 160) + (summaryText.length > 160 ? "..." : "");
						return `[${r.agent}] ${r.exitCode === 0 ? "completed" : "failed"}: ${preview || "(no output)"}`;
					});
					const aggregatorOutput = aggregatorResult ? getResultFinalOutput(aggregatorResult) : "";
					const aggregatorError = aggregatorResult?.errorMessage || aggregatorResult?.stderr.trim() || "";
					return {
						content: [
							{
								type: "text",
								text: aggregatorResult
									? aggregatorOutput || aggregatorError || `(aggregator ${aggregatorResult.agent} produced no output)`
									: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
							},
						],
						details: makeDetails("parallel")(results, aggregatorResult),
						isError: aggregatorResult
							? aggregatorResult.exitCode !== 0 ||
								aggregatorResult.stopReason === "error" ||
								aggregatorResult.stopReason === "aborted"
							: undefined,
					};
				} finally {
					status.clear();
				}
			}

			if (params.agent && params.task) {
				const singleTimeoutMs = resolveTimeoutMs(params.agent, params.timeoutMs);
				const status = startSubagentStatus(ctx, toolCallId, singleStatus(params.agent, singleTimeoutMs));

				try {
					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						params.agent,
						params.task,
						params.cwd,
						undefined,
						signal,
						singleTimeoutMs,
						onUpdate,
						makeDetails("single"),
						(noticedAgent) => status.update(`🧑‍🤝‍🧑 ${noticedAgent} wrapping up (5m)`),
					);
					const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
					if (isError) {
						const errorMsg = result.errorMessage || result.stderr || getResultFinalOutput(result) || "(no output)";
						return {
							content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
							details: makeDetails("single")([result]),
							isError: true,
						};
					}
					return {
						content: [{ type: "text", text: getResultFinalOutput(result) || "(no output)" }],
						details: makeDetails("single")([result]),
					};
				} finally {
					status.clear();
				}
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			// Always show the effective timeout (top-level override, else
			// DEFAULT_TIMEOUT_MS) so the user can see the budget that will
			// actually apply to the subagent subprocess.
			const topTimeoutSuffix = theme.fg(
				"muted",
				` (${formatTimeout(args.timeoutMs ?? DEFAULT_TIMEOUT_MS)})`,
			);
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`) +
					topTimeoutSuffix;
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					const stepTimeoutSuffix = theme.fg(
						"muted",
						` (${formatTimeout(step.timeoutMs ?? args.timeoutMs ?? DEFAULT_TIMEOUT_MS)})`,
					);
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						stepTimeoutSuffix +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				// Calculate effective max timeout: use explicit top-level timeout, or the max of task timeouts.
				const effectiveParallelTimeout = args.timeoutMs ?? Math.max(...args.tasks.map((t) => t.timeoutMs ?? DEFAULT_TIMEOUT_MS));
				const parallelTimeoutSuffix = theme.fg("muted", ` (${formatTimeout(effectiveParallelTimeout)})`);
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`) +
					parallelTimeoutSuffix;
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					const taskTimeoutSuffix = theme.fg(
						"muted",
						` (${formatTimeout(t.timeoutMs ?? args.timeoutMs ?? DEFAULT_TIMEOUT_MS)})`,
					);
					text += `\n  ${theme.fg("accent", t.agent)}${taskTimeoutSuffix}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				if (args.aggregator) {
					const preview =
						args.aggregator.task.length > 40 ? `${args.aggregator.task.slice(0, 40)}...` : args.aggregator.task;
					const aggregatorTimeoutSuffix = theme.fg(
						"muted",
						` (${formatTimeout(args.aggregator.timeoutMs ?? args.timeoutMs ?? DEFAULT_TIMEOUT_MS)})`,
					);
					text += `\n  ${theme.fg("muted", "fan-in → ")}${theme.fg("accent", args.aggregator.agent)}${aggregatorTimeoutSuffix}${theme.fg(
						"dim",
						` ${preview}`,
					)}`;
				}
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`) +
				topTimeoutSuffix;
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, options, theme, _context) {
			const { expanded, isPartial } = options;
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getResultFinalOutput(r);
				// Live per-row countdown. computeCountdownLabel returns null
				// for finished/errored/limited-budget invocations, so the tag
				// only appears while the subagent is still streaming. The
				// helper internally checks the result fields; the
				// `isPartial` guard is belt-and-braces in case the runtime
				// re-runs renderResult after the tool has settled.
				const countdown = isPartial ? computeCountdownLabel(r, Date.now()) : null;
				const countdownSuffix = countdown ? ` ${theme.fg("warning", countdown)}` : "";

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					header += countdownSuffix;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				text += countdownSuffix;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, theme, expanded, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getResultFinalOutput(r);
						// Chain steps are sequential: only the in-flight step
						// still has a non-zero `wrapUpStartedAt`/live timer;
						// earlier steps are already settled and their helper
						// returns null, so the tag only appears on the active
						// row during streaming.
						const countdown = isPartial ? computeCountdownLabel(r, Date.now()) : null;
						const countdownSuffix = countdown ? ` ${theme.fg("warning", countdown)}` : "";

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}${countdownSuffix}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					const countdown = isPartial ? computeCountdownLabel(r, Date.now()) : null;
					const countdownSuffix = countdown ? ` ${theme.fg("warning", countdown)}` : "";
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}${countdownSuffix}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, theme, expanded, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const failCount = details.results.filter((r) => r.exitCode > 0).length;
				const aggregator = details.aggregator;
				const aggregatorRunning = aggregator?.exitCode === -1;
				const aggregatorFailed = aggregator ? aggregator.exitCode > 0 || aggregator.stopReason === "error" : false;
				const isRunning = running > 0 || aggregatorRunning;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0 || aggregatorFailed
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? aggregatorRunning
						? `${successCount + failCount}/${details.results.length} done, fan-in running`
						: `${successCount + failCount}/${details.results.length} done, ${running} running`
					: aggregator
						? `${successCount}/${details.results.length} tasks + fan-in`
						: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getResultFinalOutput(r);
						// Parallel call is "partial" until every task and the
						// aggregator finish. The per-row helper only returns
						// a non-null label for the rows that are still
						// running; settled rows get a clean header.
						const countdown = isPartial ? computeCountdownLabel(r, Date.now()) : null;
						const countdownSuffix = countdown ? ` ${theme.fg("warning", countdown)}` : "";

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}${countdownSuffix}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					if (aggregator) {
						const rIcon = aggregator.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(aggregator.messages);
						const finalOutput = getResultFinalOutput(aggregator);
						const aggCountdown = isPartial ? computeCountdownLabel(aggregator, Date.now()) : null;
						const aggCountdownSuffix = aggCountdown ? ` ${theme.fg("warning", aggCountdown)}` : "";

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", "─── fan-in → ") + theme.fg("accent", aggregator.agent)} ${rIcon}${aggCountdownSuffix}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", aggregator.task), 0, 0));
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
						const fanInUsage = formatUsageStats(aggregator.usage, aggregator.model);
						if (fanInUsage) container.addChild(new Text(theme.fg("dim", fanInUsage), 0, 0));
					}

					const usageResults = aggregator ? [...details.results, aggregator] : details.results;
					const usageStr = formatUsageStats(aggregateUsage(usageResults));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: r.exitCode === 0
								? theme.fg("success", "✓")
								: theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					const countdown = isPartial ? computeCountdownLabel(r, Date.now()) : null;
					const countdownSuffix = countdown ? ` ${theme.fg("warning", countdown)}` : "";
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}${countdownSuffix}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, theme, expanded, 5)}`;
				}
				if (aggregator) {
					const rIcon =
						aggregator.exitCode === -1
							? theme.fg("warning", "⏳")
							: aggregator.exitCode === 0
								? theme.fg("success", "✓")
								: theme.fg("error", "✗");
					const displayItems = getDisplayItems(aggregator.messages);
					const aggCountdown = isPartial ? computeCountdownLabel(aggregator, Date.now()) : null;
					const aggCountdownSuffix = aggCountdown ? ` ${theme.fg("warning", aggCountdown)}` : "";
					text += `\n\n${theme.fg("muted", "─── fan-in → ")}${theme.fg("accent", aggregator.agent)} ${rIcon}${aggCountdownSuffix}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", aggregator.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, theme, expanded, 5)}`;
				}
				if (!isRunning) {
					const usageResults = aggregator ? [...details.results, aggregator] : details.results;
					const usageStr = formatUsageStats(aggregateUsage(usageResults));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});

	// ---- Configuration command ----

	registerConfigCommand(pi);
}
