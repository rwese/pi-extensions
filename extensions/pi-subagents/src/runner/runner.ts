/**
 * The per-invocation orchestrator: `runSingleAgent`.
 *
 * `runner/runner.ts` glues the rest of the layers together for
 * one subagent invocation:
 *
 *   - Build the `--mode rpc --no-session` argv for the child pi.
 *   - Persist the agent's system prompt to a temp file and pass
 *     it via `--append-system-prompt`.
 *   - Spawn the child detached (POSIX) so it leads its own
 *     process group, and capture the child's start time as the
 *     identity anchor for later reaping.
 *   - Stream the `message_end` events from RPC mode into a
 *     `SingleResult` snapshot, firing `onUpdate` so the
 *     renderer can show progress.
 *   - Run the timeout-notice and 1Hz countdown timers.
 *   - On exit, run the descendant-leak reap.
 *
 * This is intentionally a single function: it has many
 * intra-call closures (the `proc`, `subagentStartTime`,
 * `childMeta`, timers) that would be painful to extract
 * separately. The layered module layout is still honored
 * because every helper lives in its own layer.
 */

import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import * as fs from "node:fs";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentConfig } from "../agents.js";
import { WRAP_UP_GRACE_MS, WRAP_UP_MESSAGE } from "../core/constants.js";
import { getFinalOutput } from "../core/messages.js";
import type { OnNoticeCallback, OnUpdateCallback, SingleResult, SubagentDetails } from "../core/types.js";
import { getPiInvocation, writePromptToTempFile } from "../process/process.js";
import { readProcessStartTime, reapLeftoverDescendants, terminateProcess } from "../process/reap.js";

/**
 * Run a single subagent invocation and return its accumulated
 * `SingleResult`. Streams partial updates to `onUpdate` (one per
 * assistant `message_end` plus 1Hz countdown ticks) and fires
 * `onNotice` when the wrap-up notice timer lands.
 */
export async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	timeoutMs: number,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	onNotice: OnNoticeCallback | undefined,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
			finalOutput: "",
		};
	}

	const args: string[] = ["--mode", "rpc", "--no-session"];
	if (agent.model) args.push("--model", agent.model);
	if (Array.isArray(agent.tools)) {
		if (agent.tools.length > 0) args.push("--tools", agent.tools.join(","));
		else args.push("--no-tools");
	}

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;
	// Captured in the try block (after spawn resolves) so the
	// finally block can reap any detached grandchildren that
	// escaped the subagent's process group at normal-exit time.
	// TypeScript's `try`/`finally` block scoping does not let the
	// `finally` clause see `let` declarations from inside the
	// `try` block, so we declare here and assign later. The type
	// is the `stdio: ["pipe", "pipe", "pipe"]` overload's return
	// type (`ChildProcessByStdio<Writable, Readable, Readable>`)
	// so `proc.stdin.write` etc. are non-nullable inside the
	// inner Promise callback.
	let proc: ChildProcessByStdio<Writable, Readable, Readable> = null as unknown as ChildProcessByStdio<
		Writable,
		Readable,
		Readable
	>;
	let subagentStartTime: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: agent.model ?? undefined,
		step,
		timeoutMs,
		startedAt: Date.now(),
	};

	const emitUpdate = () => {
		currentResult.finalOutput = getFinalOutput(currentResult.messages);
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: currentResult.finalOutput || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		let wasAborted = false;
		let timedOut = false;

		const invocation = getPiInvocation(args);
		// Per-invocation uuid so the parent can correlate the meta
		// event back to this runSingleAgent call even if pids are
		// reused (rare, but possible after fast spawn/exit cycles).
		const childId = crypto.randomUUID();
		proc = spawn(invocation.command, invocation.args, {
			cwd: cwd ?? defaultCwd,
			detached: process.platform !== "win32",
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
			env: {
				...process.env,
				PI_SUBAGENT_PARENT_PID: String(process.pid),
				PI_SUBAGENT_CHILD_ID: childId,
			},
		}) as ChildProcessByStdio<Writable, Readable, Readable>;
		// Capture the subagent's start time at spawn time. We use it
		// as a stable identity tuple (pid, start_time) so a recycled
		// pid can never trick us into killing an unrelated process in
		// the descendant walk. Read it asynchronously after spawn
		// returns; ps / /proc reads are fast (<5ms in practice).
		subagentStartTime = proc.pid
			? await readProcessStartTime(proc.pid).catch(() => null)
			: null;

		const exitCode = await new Promise<number>((resolve) => {
			let settled = false;
			let noticeTimer: NodeJS.Timeout | undefined;
			let graceTimer: NodeJS.Timeout | undefined;
			// 1Hz tick that re-pushes the current snapshot through onUpdate
			// so the renderer's per-row countdown header stays live while
			// the subagent is still streaming. Cheap (re-runs renderResult
			// over an unchanged message list) and `.unref()`'d so it never
			// keeps the event loop alive on its own. Cleared in `finish`
			// and on `agent_end`.
			let countdownTimer: NodeJS.Timeout | undefined;
			// Track whether the agent has already produced a final agent_end
			// event. RPC mode keeps the subprocess alive after agent_end, so
			// we close stdin once the agent is done to let it exit. After
			// that, the wrap-up notice is a no-op.
			let agentEnded = false;
			// Populated by processLine when the child emits its
			// subagent_meta custom message. Used by terminateProcess to
			// reap descendants of the child process group.
			let childMeta: {
				childPid: number;
				parentPid: number | null;
				childId: string | null;
			} | null = null;
			const finish = (code: number) => {
				if (settled) return;
				settled = true;
				if (noticeTimer) clearTimeout(noticeTimer);
				if (graceTimer) clearTimeout(graceTimer);
				if (countdownTimer) clearInterval(countdownTimer);
				resolve(code);
			};

			// Shared closure for the original timeoutMs site and the new grace
			// timer. Both paths mutate the same result fields and call
			// terminateProcess. The notice timer only fires the steer + grace;
			// the grace timer fires this.
			const markTimedOut = (message: string) => {
				timedOut = true;
				currentResult.timedOut = true;
				currentResult.stopReason = "timeout";
				currentResult.errorMessage = message;
				currentResult.stderr += `${currentResult.stderr ? "\n" : ""}${message}.`;
				emitUpdate();
				// Fire-and-forget: terminateProcess is async because it
				// walks descendants via pgrep before SIGTERM. The grace
				// timer that calls us is sync; we cannot await here.
				terminateProcess(proc, subagentStartTime).catch(() => {});
			};

			let buffer = "";

			// Initial prompt. RPC mode consumes commands as JSON lines on stdin
			// and emits AgentSessionEvent objects on stdout. Use the documented
			// `prompt` command so the subprocess uses its normal model/tool flow.
			proc.stdin.write(`${JSON.stringify({ type: "prompt", message: `Task: ${task}` })}\n`);

			if (timeoutMs > 0) {
				// At the timeoutMs threshold, deliver a one-shot wrap-up steer
				// to the subprocess and schedule the hard-kill for the grace
				// window. The subprocess gets a chance to finish its current
				// turn and return a summary. The hard-kill timer is cleared
				// by `finish` if the subprocess exits before then.
				noticeTimer = setTimeout(() => {
					if (proc.killed || proc.exitCode !== null || agentEnded) return;
					proc.stdin.write(`${JSON.stringify({ type: "steer", message: WRAP_UP_MESSAGE })}\n`);
					if (onNotice) onNotice(agentName);
					// Mark the wall-clock instant the wrap-up notice landed.
					// The renderer uses this to switch the per-row countdown
					// from "X left" to "grace: X left" without re-deriving
					// from the WRAP_UP_GRACE_MS constant. Fire an update
					// immediately so the label flips on the next render
					// without waiting up to a second for the interval tick.
					currentResult.wrapUpStartedAt = Date.now();
					emitUpdate();
					graceTimer = setTimeout(
						() => markTimedOut(`Subagent timed out after ${timeoutMs}ms + ${WRAP_UP_GRACE_MS}ms grace`),
						WRAP_UP_GRACE_MS,
					);
					graceTimer.unref();
				}, timeoutMs);
				noticeTimer.unref();

				// 1Hz countdown tick. Re-uses the existing onUpdate path
				// (emitUpdate) so the renderResult re-runs with the new
				// `Date.now()` for computeCountdownLabel. Re-render is
				// cheap; the message list is not touched.
				countdownTimer = setInterval(() => {
					if (settled) return;
					emitUpdate();
				}, 1000);
				countdownTimer.unref();
			}

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				// Recognize the subagent_meta custom message emitted by
				// the child extension on startup. Stash the payload and
				// skip pushing the message into currentResult.messages so
				// the renderer never sees it. The parent uses childMeta
				// in terminateProcess for accurate descendant reaping.
				if (
					event.type === "message_end" &&
					event.message?.role === "custom" &&
					event.message?.customType === "subagent_meta" &&
					event.message?.details
				) {
					childMeta = event.message.details as typeof childMeta;
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					// RPC mode emits message_end for user, assistant, and
					// toolResult roles. Tool results arrive as a single
					// message_end with role "toolResult" instead of a
					// separate tool_result_end event.
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				// RPC mode keeps the subprocess alive across turns. When the
				// agent emits agent_end, the work is done — close stdin so
				// the subprocess shuts down cleanly via its onInputEnd
				// handler. The proc.on("close") listener then resolves the
				// promise. We only close once; subsequent agent_end events
				// (e.g. after a wrap-up steer) are no-ops.
				if (event.type === "agent_end" && !agentEnded) {
					agentEnded = true;
					proc.stdin.end();
					// Drop the countdown tick. The renderer's final pass
					// will fire from finish() through onUpdate; while
					// agentEnded is set, computeCountdownLabel returns
					// null (we still need to stop the interval so it
					// doesn't keep ticking the parent's renderResult
					// against a dead subagent). Clear here AND in finish
					// for the abort-during-grace path, which never emits
					// agent_end.
					if (countdownTimer) {
						clearInterval(countdownTimer);
						countdownTimer = undefined;
					}
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				finish(timedOut ? 124 : (code ?? 0));
			});

			proc.on("error", (error) => {
				currentResult.errorMessage = error.message;
				currentResult.stderr += `${currentResult.stderr ? "\n" : ""}${error.message}`;
				finish(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					currentResult.stopReason = "aborted";
					currentResult.errorMessage = "Subagent was aborted";
					// Fire-and-forget; see markTimedOut.
					terminateProcess(proc, subagentStartTime).catch(() => {});
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		currentResult.finalOutput = getFinalOutput(currentResult.messages);
		if (wasAborted && !timedOut) throw new Error("Subagent was aborted");
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
		// Normal-exit reap. If the subagent exited cleanly but
		// backgrounded a detached grandchild (e.g. `bash -c "(sleep
		// 30 &) ; echo done"`), the grandchild is reparented to PID
		// 1 and the descendant walker inside terminateProcess
		// never ran. Walk `pgrep -P <subagent_pid>` one more time
		// here, verify each candidate's (pid, start_time) identity
		// against the captured start time, and SIGKILL any
		// survivor. The walker is bounded at MAX_DEPTH and a no-op
		// if it finds nothing, so the common case is one `pgrep`
		// call that returns empty.
		if (proc?.pid) {
			await reapLeftoverDescendants(proc.pid, subagentStartTime);
		}
	}
}
