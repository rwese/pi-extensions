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
import { StringEnum } from "@earendil-works/pi-ai";
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
	type SelectItem,
	SelectList,
	Key,
	matchesKey,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
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

const STATUS_KEY = "subagents";
const activeStatuses = new Map<string, string>();

interface StatusContext {
	ui: { setStatus: (key: string, value: string | undefined) => void };
}

function startSubagentStatus(ctx: StatusContext, toolCallId: string, status: string) {
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

function publishSubagentStatus(ctx: StatusContext) {
	const statuses = [...activeStatuses.values()];
	if (statuses.length === 0) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}

	const suffix = statuses.length > 1 ? ` +${statuses.length - 1}` : "";
	ctx.ui.setStatus(STATUS_KEY, `${statuses[0]}${suffix}`);
}

function formatTimeout(timeoutMs: number): string {
	if (timeoutMs === 0) return "unlimited";
	if (timeoutMs < 1000) return `${timeoutMs}ms`;
	if (timeoutMs < 60_000) return `${Math.round(timeoutMs / 1000)}s`;
	const minutes = Math.round(timeoutMs / 60_000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	return remainingMinutes > 0 ? `${hours}h${remainingMinutes}m` : `${hours}h`;
}

function formatTimeoutSuffix(timeoutMs: number | undefined): string {
	return timeoutMs !== undefined ? ` (${formatTimeout(timeoutMs)})` : "";
}

function singleStatus(agent: string, timeoutMs?: number): string {
	return `🧑‍🤝‍🧑 ${agent}${formatTimeoutSuffix(timeoutMs)}`;
}

function chainStatus(step: number, total: number, agent?: string, timeoutMs?: number): string {
	return `🧑‍🤝‍🧑 chain ${step}/${total}${agent ? ` ${agent}` : ""}${formatTimeoutSuffix(timeoutMs)}`;
}

function parallelStatus(done: number, total: number, running: number, timeoutMs?: number): string {
	return `🧑‍🤝‍🧑 parallel ${done}/${total} done${running > 0 ? ` ${running} running` : ""}${formatTimeoutSuffix(timeoutMs)}`;
}

function fanInStatus(agent: string, timeoutMs?: number): string {
	return `🧑‍🤝‍🧑 fan-in ${agent}${formatTimeoutSuffix(timeoutMs)}`;
}

/**
 * Compact `H:MM:SS` / `M:SS` / `Ss` countdown formatter. `totalMs` is the
 * remaining duration in milliseconds; values <= 0 render as `0s`. Used by
 * the renderer to draw a single live timer per subagent invocation. We
 * pick clock-style (`2:13`, `0:45`) over the bulkier `2m 13s` form because
 * the tag has to fit comfortably next to the agent name in the per-row
 * header.
 */
function formatCountdown(totalMs: number): string {
	const seconds = Math.max(0, Math.floor(totalMs / 1000));
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const secs = seconds % 60;
	if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
	if (minutes > 0) return `${minutes}:${String(secs).padStart(2, "0")}`;
	return `${secs}s`;
}

/**
 * Decide what (if anything) the renderer's per-row countdown tag should
 * say for `r`, evaluated at `now`. Returns `null` when no tag should be
 * drawn: the subagent finished voluntarily, was aborted, was hard-killed
 * by the grace timer, was given an unlimited budget, or has no recorded
 * start time.
 *
 * The two non-null cases are:
 *   - Pre-notice countdown:    `⏱ <time left>` against
 *                              `startedAt + timeoutMs`.
 *   - In-grace countdown:      `⏱ grace: <time left>` against
 *                              `startedAt + timeoutMs + WRAP_UP_GRACE_MS`.
 *
 * `wrapUpStartedAt` is the canonical signal that we are inside the grace
 * window — it is set inside the notice timer's body, not derived from the
 * `WRAP_UP_GRACE_MS` constant — so the renderer does not need to know the
 * grace length and stays decoupled from the timer constants.
 */
function computeCountdownLabel(r: SingleResult, now: number): string | null {
	if (!r.startedAt || !r.timeoutMs || r.timeoutMs <= 0) return null;
	// Drop the tag once the invocation is over. The renderer also drops it
	// when `!isPartial`, but checking the result fields keeps the helper
	// safe for callers that don't pass isPartial.
	if (r.timedOut) return null;
	if (r.stopReason === "aborted" || r.stopReason === "error") return null;
	const graceDeadline = r.startedAt + r.timeoutMs + WRAP_UP_GRACE_MS;
	if (r.wrapUpStartedAt) {
		// The wrap-up notice has fired. We are somewhere in the
		// [notice, notice + WRAP_UP_GRACE_MS] window. The deadline
		// for the grace kill is `graceDeadline`; we render a "grace:"
		// countdown against that.
		const left = graceDeadline - now;
		return `⏱ grace: ${formatCountdown(left)}`;
	}
	const deadline = r.startedAt + r.timeoutMs;
	if (now >= deadline) {
		// Past the original budget but the notice hasn't fired yet.
		// Race window of <1s between the timeout firing and the notice
		// timer's body running; show "grace: 5m" so the user doesn't
		// see a stale "0s" flicker.
		return `⏱ grace: ${formatCountdown(WRAP_UP_GRACE_MS)}`;
	}
	return `⏱ ${formatCountdown(deadline - now)}`;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
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

function formatToolCall(
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

function getFinalOutput(messages: Message[]): string {
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

function getResultFinalOutput(result: SingleResult): string {
	return result.finalOutput ?? getFinalOutput(result.messages);
}

function buildFanInContext(results: SingleResult[]): string {
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

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

/**
 * Walk the process tree rooted at `rootPid` and return every
 * descendant pid (including the root). Uses `pgrep -P` recursively
 * on macOS and Linux. We walk by parent-pid (not by process group)
 * so we catch sub-subagents that the subagent pi itself spawned
 * with `detached: true` — those children are leaders of their own
 * process groups and would be invisible to a negative-pgid SIGTERM.
 *
 * Windows is unsupported; the helper throws on win32 because we
 * have not yet ported the walk to `wmic`/`tasklist`. The first
 * terminateProcess on Windows falls back to the original
 * single-process-group behavior.
 */
async function collectDescendantPids(rootPid: number): Promise<number[]> {
	if (process.platform === "win32") {
		throw new Error("collectDescendantPids: Windows not implemented");
	}
	if (!Number.isInteger(rootPid) || rootPid <= 0) return [];
	// Refuse to walk from PID 1 — that would be the entire system
	// init tree, not a subagent's descendants. Defense in depth: the
	// caller should never pass 1, but if some other code path does,
	// the walker must not turn it into a system-wide kill.
	if (rootPid === 1) return [];

	const out = new Set<number>([rootPid]);
	const stack: number[] = [rootPid];
	// Bound the walk so a pathological /proc with cycle references
	// cannot hang the parent. Subagent trees are < 10 deep in
	// practice; cap at 64 levels of nesting for safety.
	const MAX_DEPTH = 64;
	let depth = 0;
	while (stack.length > 0 && depth < MAX_DEPTH) {
		depth++;
		// Snapshot current frontier; we'll push next-level children
		// onto the same stack for BFS.
		const frontier = stack.splice(0, stack.length);
		for (const parent of frontier) {
			const childrenStdout = await new Promise<string>((resolve) => {
				const p = spawn("pgrep", ["-P", String(parent)], {
					stdio: ["ignore", "pipe", "ignore"],
					shell: false,
				});
				let buf = "";
				p.stdout.on("data", (d) => {
					buf += d.toString();
				});
				p.on("close", () => resolve(buf));
				p.on("error", () => resolve(""));
			});
			for (const line of childrenStdout.split("\n")) {
				const pid = Number.parseInt(line.trim(), 10);
				if (Number.isFinite(pid) && pid > 0 && pid !== process.pid && !out.has(pid)) {
					out.add(pid);
					stack.push(pid);
				}
			}
		}
	}
	return [...out];
}

/**
 * Read a process's start time as a stable string identity for
 * pid-recycling protection. A bare pid is just an integer; the
 * kernel can recycle it within seconds under load. We pair each
 * pid we captured at spawn time with a start-time string and
 * re-verify before signaling, so a recycled pid can never trick
 * us into killing an unrelated process.
 *
 *   - macOS:  `ps -o lstart= -p <pid>` — e.g. "Thu Jun 11 09:30:42 2026"
 *   - Linux:  /proc/<pid>/stat field 22 (starttime in clock ticks
 *             since boot). Clock ticks come from `getconf CLK_TCK`
 *             (defaults to 100 on every modern Linux).
 */
async function readProcessStartTime(pid: number): Promise<string | null> {
	if (!Number.isInteger(pid) || pid <= 0) return null;
	if (process.platform === "darwin") {
		return await new Promise<string | null>((resolve) => {
			const p = spawn("ps", ["-o", "lstart=", "-p", String(pid)], {
				stdio: ["ignore", "pipe", "ignore"],
				shell: false,
			});
			let buf = "";
			p.stdout.on("data", (d) => {
				buf += d.toString();
			});
			p.on("close", () => resolve(buf.trim() || null));
			p.on("error", () => resolve(null));
		});
	}
	if (process.platform === "linux") {
		const stat = await new Promise<string | null>((resolve) => {
			fs.readFile(`/proc/${pid}/stat`, "utf-8", (err, data) => {
				if (err) resolve(null);
				else resolve(data);
			});
		});
		if (!stat) return null;
		// /proc/<pid>/stat has the format "pid (comm) state ppid pgrp
		// session tty_nr tpgid flags minflt cminflt majflt cmajflt
		// utime stime cutime cstime priority nice num_threads itrealvalue
		// starttime vsize ...". The comm field can contain spaces and
		// parens, so we split on the LAST ")". Field 22 (1-indexed) is
		// starttime, which is the 22nd field AFTER the ")", i.e. the
		// 20th whitespace-separated token after the ")".
		const rpar = stat.lastIndexOf(")");
		if (rpar < 0) return null;
		const tail = stat.slice(rpar + 1).trim();
		const fields = tail.split(/\s+/);
		// tail starts with " state ppid pgrp ...", so starttime is at
		// index 19 (state,ppid,pgrp,session,tty,tpgid,flags,minflt,
		// cminflt,majflt,cmajflt,utime,stime,cutime,cstime,priority,
		// nice,num_threads,itrealvalue,starttime).
		const starttime = fields[19];
		if (!starttime) return null;
		return starttime;
	}
	return null;
}

/**
 * Identity check: is `pid` still the same process whose start
 * time we captured at spawn time? Returns false if the pid is
 * gone, was recycled to an unrelated process, or if we cannot
 * read its current start time.
 */
async function pidStillMatches(pid: number, capturedStartTime: string | null): Promise<boolean> {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	if (!capturedStartTime) return false;
	// Liveness gate: ESCH => recycled or gone.
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}
	const live = await readProcessStartTime(pid);
	return live !== null && live === capturedStartTime;
}

/** Opt-in debug breadcrumb for skipped / refused reaps. */
function debugReap(message: string): void {
	if (process.env.PI_SUBAGENT_DEBUG_REAP === "1") {
		// stderr breadcrumb; never throw out of the reap path.
		try {
			process.stderr.write(`[pi-subagents] ${message}\n`);
		} catch {
			/* ignore */
		}
	}
}

function killProcessGroup(pid: number, signal: NodeJS.Signals) {
	if (process.platform === "win32") {
		try {
			process.kill(pid, signal);
		} catch {
			/* gone */
		}
		return;
	}
	// Refuse to signal the parent's own pid via the negative-pgid
	// path. process.kill(-process.pid, ...) would signal the entire
	// parent's process group, not a subagent's. If we ever do this
	// by accident, the user would see their pi session die on the
	// next reap. Guarded here at the bottom of the call stack.
	if (pid === process.pid) {
		debugReap(`killProcessGroup: refusing to signal parent's own pid ${pid}`);
		return;
	}
	try {
		// Negative pid = whole process group. process.kill(-pid) only
		// reaches the group that the target leads; if the target is
		// not a group leader, the kernel returns ESRCH and we fall
		// back to a direct kill.
		process.kill(-pid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {
			/* gone */
		}
	}
}

/**
 * Terminate the subagent subprocess and all of its descendants.
 *
 * The subagent pi is spawned with `detached: true`, so it is the
 * leader of its own process group. A bare `process.kill(-pid, ...)`
 * only reaches that group — not any nested sub-subagents that the
 * subagent pi spawned via the `subagent` tool (those are detached
 * leaders of their own groups). We walk the descendant tree by
 * ppid using `pgrep -P` and SIGTERM each node's process group, so
 * a subagent and any grandchildren die together.
 *
 * Three layers of safety against the pid-recycling race:
 *
 *  1. **Liveness gate**: `process.kill(proc.pid, 0)`. If the
 *     subagent is already gone, skip the walker; just call
 *     `reapLeftoverDescendants` for the leak fix.
 *  2. **Identity gate**: re-read the live start time of `proc.pid`
 *     and compare to the value captured at spawn time. If it
 *     differs, the pid was recycled — skip the group-kill (we have
 *     no idea what's there now).
 *  3. **Walker fallback**: if the group-kill did not take within
 *     `KILL_GRACE_MS`, the subagent must have detached
 *     grandchildren holding the group open. Walk by ppid and
 *     signal each one with the same identity check.
 *
 * Falls back to a single-process SIGTERM if the walk fails
 * (Windows, no `pgrep`, transient ps hiccup).
 */
async function terminateProcess(
	proc: ReturnType<typeof spawn>,
	capturedStartTime: string | null,
): Promise<void> {
	if (proc.killed) return;
	const procPid = proc.pid;
	if (!procPid) {
		try {
			proc.kill("SIGTERM");
		} catch {
			/* gone */
		}
		return;
	}

	// Liveness gate. If the subagent is already gone, we cannot
	// kill its process group (the pid may be recycled) — just
	// attempt a single reap pass for any detached grandchildren
	// that escaped our process group at normal-exit time.
	if (process.platform !== "win32") {
		const alive = (() => {
			try {
				process.kill(procPid, 0);
				return true;
			} catch {
				return false;
			}
		})();
		if (!alive) {
			await reapLeftoverDescendants(procPid, capturedStartTime);
			return;
		}
		const stillOurs = await pidStillMatches(procPid, capturedStartTime);
		if (!stillOurs) {
			debugReap(`pid ${procPid} was recycled before terminate; skipping group kill`);
			await reapLeftoverDescendants(procPid, capturedStartTime);
			return;
		}
	}

	if (process.platform === "win32") {
		// Windows descendant walk is unimplemented; fall back to
		// single-process termination via the original signal-handler
		// path (rpc-mode.js's killTrackedDetachedChildren runs on
		// the child's SIGTERM).
		killProcessGroup(procPid, "SIGTERM");
		setTimeout(() => killProcessGroup(procPid, "SIGKILL"), KILL_GRACE_MS).unref();
		return;
	}

	// Common case: subagent is a session leader (detached: true on
	// POSIX) so its pid is its own pgid. One group-kill reaches
	// the subagent + all non-detached children. No pgrep churn,
	// no pid-recycling exposure in the hot path.
	killProcessGroup(procPid, "SIGTERM");
	setTimeout(() => {
		// After KILL_GRACE_MS, the subagent has had time to clean up.
		// If it is still alive, the only way that can be true is that
		// it has detached children holding the group open. Walk the
		// tree, verify each candidate's identity, then SIGKILL the
		// walkers. We do NOT SIGKILL the subagent itself here — it
		// is a legitimate user-owned process; the user may have
		// detoured it intentionally.
		void reapDetachedSurvivors(proc, capturedStartTime);
	}, KILL_GRACE_MS).unref();
}

/**
 * Walk the descendant tree of `proc.pid`, verify each candidate
 * against the captured start time, and SIGKILL any survivor that
 * still matches. Used as the fallback inside `terminateProcess`
 * after the group-kill grace window expires.
 */
async function reapDetachedSurvivors(
	proc: ReturnType<typeof spawn>,
	capturedStartTime: string | null,
): Promise<void> {
	if (!proc.pid) return;
	let descendants: number[];
	try {
		descendants = await collectDescendantPids(proc.pid);
	} catch {
		return;
	}
	for (const pid of descendants) {
		if (pid === proc.pid) continue;
		const matches = await pidStillMatches(pid, capturedStartTime);
		if (!matches) {
			debugReap(`descendant pid ${pid} failed identity check; skipping`);
			continue;
		}
		killProcessGroup(pid, "SIGKILL");
	}
}

/**
 * Best-effort reap of detached grandchildren that escaped the
 * subagent's process group at normal-exit time (reparented to
 * PID 1). Walks `pgrep -P <rootPid>` once, filters out the
 * subagent itself, then for each candidate verifies the (pid,
 * start_time) identity tuple before signaling. If the walker
 * returns no candidates, this is a no-op.
 *
 * `PI_SUBAGENT_REAP_LEAKS=0` disables the behavior (for users
 * who intentionally background long-running jobs from a subagent).
 */
async function reapLeftoverDescendants(
	rootPid: number,
	capturedStartTime: string | null,
): Promise<void> {
	if (process.env.PI_SUBAGENT_REAP_LEAKS === "0") return;
	if (!Number.isInteger(rootPid) || rootPid <= 0) return;
	if (rootPid === 1) return;
	if (process.platform === "win32") return;
	let descendants: number[];
	try {
		descendants = await collectDescendantPids(rootPid);
	} catch {
		return;
	}
	// Filter out the root itself — we only want grandchildren, not
	// a re-kill of the subagent that already exited.
	const targets = descendants.filter((p) => p !== rootPid);
	if (targets.length === 0) return;
	for (const pid of targets) {
		const matches = await pidStillMatches(pid, capturedStartTime);
		if (!matches) {
			debugReap(`leak reap: pid ${pid} failed identity check; skipping`);
			continue;
		}
		killProcessGroup(pid, "SIGKILL");
	}
	debugReap(`leak reap: signaled ${targets.length} detached descendant(s) of ${rootPid}`);
}

async function runSingleAgent(
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

const TimeoutMs = Type.Number({
	description:
		"Hard timeout in milliseconds for each subagent subprocess. 0 = unlimited. Defaults to PI_SUBAGENT_TIMEOUT_MS or 600000.",
	minimum: 0,
});

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	timeoutMs: Type.Optional(TimeoutMs),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	timeoutMs: Type.Optional(TimeoutMs),
});

const AggregatorItem = Type.Object({
	agent: Type.String({ description: "Name of the fan-in agent to invoke after parallel tasks complete" }),
	task: Type.String({ description: "Fan-in task. Use {previous} to include all parallel outputs." }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the aggregator process" })),
	timeoutMs: Type.Optional(TimeoutMs),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
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

// ---- Settings helpers ----

function hasOwn(obj: object, key: PropertyKey): boolean {
	return Object.hasOwn(obj, key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isPositiveNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 1;
}

function normalizeAgentSettings(value: unknown): SubagentAgentConfig | undefined {
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

function normalizeSubagentSettings(value: unknown): SubagentSettings | undefined {
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

function readSubagentSettings(): SubagentSettings | undefined {
	const configPath = path.join(getAgentDir(), "pi-subagents-config.json");
	if (!fs.existsSync(configPath)) return undefined;
	try {
		return normalizeSubagentSettings(JSON.parse(fs.readFileSync(configPath, "utf-8")));
	} catch {
		return undefined;
	}
}

function saveSubagentConfig(settings: SubagentSettings): void {
	const agentDir = getAgentDir();
	fs.mkdirSync(agentDir, { recursive: true });

	const configPath = path.join(agentDir, "pi-subagents-config.json");
	fs.writeFileSync(configPath, `${JSON.stringify(settings, null, "\t")}\n`, "utf-8");
}

function uniqueToolNames(tools: string[]): string[] {
	return [...new Set(tools)];
}

function sameToolSet(left: string[], right: string[]): boolean {
	const leftSet = new Set(left);
	const rightSet = new Set(right);
	if (leftSet.size !== rightSet.size) return false;
	return [...leftSet].every((tool) => rightSet.has(tool));
}

function hasAnyAgentOverride(config: SubagentAgentConfig): boolean {
	return hasOwn(config, "tools") || hasOwn(config, "model") || hasOwn(config, "timeoutMs");
}

// ---- Tool toggle component ----

class ToolToggleList {
	private items: { name: string; selected: boolean }[];
	private cursor = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];
	onDone?: (selected: string[]) => void;
	onCancel?: () => void;

	constructor(tools: string[], selected: Set<string>) {
		this.items = tools.map((name) => ({ name, selected: selected.has(name) }));
	}

	private getSelectedNames(): string[] {
		return this.items.filter((i) => i.selected).map((i) => i.name);
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.onCancel?.();
			return;
		}
		if (data === "s" || data === "S") {
			this.onDone?.(this.getSelectedNames());
			return;
		}
		if (this.items.length === 0) return;

		if (matchesKey(data, Key.up) && this.cursor > 0) {
			this.cursor--;
			this.invalidate();
		} else if (matchesKey(data, Key.down) && this.cursor < this.items.length - 1) {
			this.cursor++;
			this.invalidate();
		} else if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
			this.items[this.cursor].selected = !this.items[this.cursor].selected;
			this.invalidate();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		this.cachedWidth = width;
		this.cachedLines = this.items.map((item, i) => {
			const pointer = i === this.cursor ? ">" : " ";
			const check = item.selected ? "✓" : "○";
			return truncateToWidth(`${pointer} ${check} ${item.name}`, width);
		});
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

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

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
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
			};

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
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
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
			};

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
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
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
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
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
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
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

	pi.registerCommand("subagents:config", {
		description: "Configure which tools each subagent can use",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				return;
			}

			// Get current settings
			const currentSettings = readSubagentSettings() ?? {};
			const currentAgents = currentSettings.agents ?? {};

			// Discover agents to show which ones are available
			const discovery = discoverAgents(ctx.cwd, "user", currentSettings);
			const agents = discovery.agents;

			if (agents.length === 0) {
				ctx.ui.notify("No agents found", "warning");
				return;
			}

			// Loop: agent selection → tool toggle (Esc in tools returns here)
			while (true) {
				// Step 1: pick an agent to configure
				const agentItems: SelectItem[] = agents.map((a) => {
					const cfg = currentAgents[a.name];
					const hasToolsOverride = cfg ? hasOwn(cfg, "tools") : false;
					const toolSummary = hasToolsOverride
						? cfg?.tools && cfg.tools.length > 0
							? cfg.tools.join(", ")
							: "none"
						: "defaults";
					return {
						value: a.name,
						label: a.name,
						description: `${a.source} · tools: ${toolSummary}`,
					};
				});

				const agentName = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
					const container = new Container();
					container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
					container.addChild(
						new Text(theme.fg("accent", theme.bold("Subagent Tool Configuration")), 1, 0),
					);
					container.addChild(new Spacer(1));
					container.addChild(
						new Text(theme.fg("muted", "Select an agent to configure its allowed tools:"), 1, 0),
					);
					container.addChild(new Spacer(1));
					const selectList = new SelectList(agentItems, Math.min(agentItems.length + 2, 15), {
						selectedPrefix: (t: string) => theme.fg("accent", t),
						selectedText: (t: string) => theme.fg("accent", t),
						description: (t: string) => theme.fg("muted", t),
						scrollInfo: (t: string) => theme.fg("dim", t),
						noMatch: (t: string) => theme.fg("warning", t),
					});
					selectList.onSelect = (item) => done(item.value);
					selectList.onCancel = () => done(null);
					container.addChild(selectList);
					container.addChild(
						new Text(theme.fg("dim", "↑↓ navigate · enter select · esc cancel"), 1, 0),
					);
					container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
					return {
						render: (w: number) => container.render(w),
						invalidate: () => container.invalidate(),
						handleInput: (data: string) => {
							selectList.handleInput(data);
							tui.requestRender();
						},
					};
				});

				if (!agentName) return;

				const agent = agents.find((a) => a.name === agentName);
				if (!agent) return;

				// Step 2: toggle tools for the selected agent
				// Discover without overrides to get original built-in/frontmatter defaults.
				// The main discovery above applies saved overrides, so agent.tools is already
				// overridden — using it for the reset-to-default comparison would match the
				// override against itself and silently delete it on a no-op save.
				const defaultDiscovery = discoverAgents(ctx.cwd, "user");
				const defaultTools = defaultDiscovery.agents.find((a) => a.name === agentName)?.tools;
				const currentAgentSettings = currentAgents[agentName];
				const configuredTools =
					currentAgentSettings && hasOwn(currentAgentSettings, "tools")
						? (currentAgentSettings.tools ?? [])
						: undefined;

				// Get all available tools from pi's registry
				const allTools = uniqueToolNames(pi.getAllTools().map((t) => t.name)).sort((a, b) =>
					a.localeCompare(b),
				);
				const currentTools = uniqueToolNames(configuredTools ?? defaultTools ?? allTools);
				// Sort: currently selected tools first, then rest alphabetically. Preserve
				// unavailable configured tools so saving does not silently drop them.
				const currentSet = new Set(currentTools);
				const selectedFirst = [...currentTools, ...allTools.filter((t) => !currentSet.has(t))];

				const selectedTools = await ctx.ui.custom<string[] | null>((tui, theme, _kb, done) => {
					const toggleList = new ToolToggleList(selectedFirst, currentSet);

					const container = new Container();
					container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
					container.addChild(
						new Text(
							theme.fg("accent", theme.bold(`${agentName} tools`)) +
								theme.fg("muted", ` (${agent.source})`),
							1,
							0,
						),
					);
					container.addChild(new Spacer(1));
					container.addChild(
						new Text(theme.fg("muted", "Toggle tools with Enter/Space. S to save, Esc to cancel."), 1, 0),
					);
					container.addChild(new Spacer(1));

					const listContainer = new Container();
					listContainer.addChild({
						render: (w: number) => toggleList.render(w),
						invalidate: () => toggleList.invalidate(),
					});
					container.addChild(listContainer);

					container.addChild(new Spacer(1));
					container.addChild(
						new Text(theme.fg("dim", "↑↓ navigate · enter/space toggle · S save · esc cancel"), 1, 0),
					);
					container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

					toggleList.onDone = (tools) => done(tools);
					toggleList.onCancel = () => done(null);

					return {
						render: (w: number) => container.render(w),
						invalidate: () => container.invalidate(),
						handleInput: (data: string) => {
							toggleList.handleInput(data);
							tui.requestRender();
						},
					};
				});

				// null means user cancelled — loop back to agent selection
				if (selectedTools === null) continue;

				// Save to global settings
				const updatedAgents = { ...currentAgents };
				let restoredDefaults = false;

				const isSameAsDefault =
					defaultTools === undefined
						? sameToolSet(selectedTools, allTools)
						: sameToolSet(selectedTools, defaultTools);

				if (isSameAsDefault) {
					// Tools match defaults — remove only the tools override.
					// Keep other settings (model, timeoutMs) if present.
					const existing = updatedAgents[agentName];
					if (existing) {
						const nextConfig = { ...existing };
						delete nextConfig.tools;
						if (hasAnyAgentOverride(nextConfig)) updatedAgents[agentName] = nextConfig;
						else delete updatedAgents[agentName];
					}
					restoredDefaults = true;
				} else {
					updatedAgents[agentName] = {
						...updatedAgents[agentName],
						tools: selectedTools,
					};
				}

				const newSettings: SubagentSettings = {
					...currentSettings,
					agents: Object.keys(updatedAgents).length > 0 ? updatedAgents : undefined,
				};

				saveSubagentConfig(newSettings);
				const message = restoredDefaults
					? `${agentName}: defaults restored`
					: `${agentName}: ${selectedTools.length} tool${selectedTools.length !== 1 ? "s" : ""} configured`;
				ctx.ui.notify(message, "info");
				// Saved — exit the loop
				break;
			}
		},
	});
}
