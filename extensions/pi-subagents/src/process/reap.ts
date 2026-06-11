/**
 * Descendant reaping and pid-recycling safety.
 *
 * `process/reap.ts` is the most safety-critical module in the
 * subagent extension. A wrong kill here can either leak
 * detached sub-subagents into PID 1's tree (where they outlive
 * the parent pi session) or kill an unrelated process whose
 * pid was recycled by the kernel under load.
 *
 * Three layers of defense, in order:
 *
 *   1. **Liveness gate**: `process.kill(pid, 0)`. If the
 *      process is gone, we skip the signal entirely.
 *   2. **Identity gate**: re-read the live start time of `pid`
 *      and compare to the value captured at spawn time. If it
 *      differs, the pid was recycled — we skip.
 *   3. **Bounded walk**: `pgrep -P` is recursive but capped at
 *      `MAX_DEPTH` so a cycle reference cannot hang the parent.
 *
 * The module is intentionally separated from `process/process.ts`
 * so reviewers can focus on the signal-safety path without
 * wading through the spawn helpers.
 *
 * Dependencies: `core/constants` (for `KILL_GRACE_MS`) and
 * `process/process` (for `debugReap`). No I/O outside
 * `pgrep`/`ps`/`/proc`.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { KILL_GRACE_MS } from "../core/constants.js";
import { debugReap } from "./process.js";

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
export async function collectDescendantPids(rootPid: number): Promise<number[]> {
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
export async function readProcessStartTime(pid: number): Promise<string | null> {
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
export async function pidStillMatches(pid: number, capturedStartTime: string | null): Promise<boolean> {
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

/**
 * Signal `pid`'s process group. On Windows, fall back to a
 * direct `process.kill` (no group semantics there). On POSIX
 * we first try `process.kill(-pid, signal)` to reach the whole
 * group; if the target is not a group leader the kernel
 * returns ESRCH and we fall back to a direct kill. The parent's
 * own pid is explicitly refused on the group path so a stray
 * call cannot signal the entire parent process group.
 */
export function killProcessGroup(pid: number, signal: NodeJS.Signals) {
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
export async function terminateProcess(
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
export async function reapDetachedSurvivors(
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
export async function reapLeftoverDescendants(
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
