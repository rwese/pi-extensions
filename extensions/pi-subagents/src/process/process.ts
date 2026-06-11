/**
 * Child-process helpers used by the runner.
 *
 * `process/process.ts` owns:
 *   - `mapWithConcurrencyLimit` for the parallel-mode
 *     fan-out scheduler.
 *   - `writePromptToTempFile` for the `--append-system-prompt`
 *     trick the runner uses to pass the agent's system prompt
 *     into the child pi.
 *   - `getPiInvocation` for picking the right `command` +
 *     `args` pair to spawn a child pi (current script under
 *     Node, `pi` on PATH, or `process.execPath` for an embedded
 *     runtime).
 *   - `debugReap` for opt-in stderr breadcrumbs from the
 *     descendant-reap path. The heavier reaping helpers live
 *     in `process/reap.ts` (separated for safety review).
 *
 * Dependencies stay restricted to the `core/` layer (types,
 * constants) plus Node built-ins and `withFileMutationQueue`
 * from `@earendil-works/pi-coding-agent`.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

/**
 * Run `fn` over `items` with at most `concurrency` in-flight
 * promises. Output order matches input order. Used by the
 * parallel-mode `tasks` array. We use an explicit worker-pool
 * (rather than a global concurrency semaphore) so each worker
 * keeps a hot loop of its own and we minimize the per-task
 * promise-microtask overhead.
 */
export async function mapWithConcurrencyLimit<TIn, TOut>(
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

/**
 * Write `prompt` to a unique temp file and return both the
 * file path and the directory (so the caller can clean up
 * both on exit). The write goes through `withFileMutationQueue`
 * so concurrent writes to the same path from sibling subagents
 * do not race. The mode is `0o600` because the prompt may
 * include secrets from the agent's system prompt.
 */
export async function writePromptToTempFile(
	agentName: string,
	prompt: string,
): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

/**
 * Decide how to spawn a child pi. Three cases:
 *   1. We are running under Node (or Bun) with a real on-disk
 *      entry script (process.argv[1] points at a file we can
 *      re-exec) — re-exec the same script with the requested
 *      args. This keeps the child's runtime identical to ours
 *      and lets `pi-extensions` in development mode propagate
 *      through to the child.
 *   2. We are running under a generic Node/Bun runtime with no
 *      on-disk script (Bun's virtual `$bunfs/root/` script) —
 *      fall back to `pi` on PATH and let it re-resolve the
 *      runtime.
 *   3. We are running under a non-generic runtime (e.g. a
 *      bundled binary) — use `process.execPath` directly with
 *      the args and assume the binary is self-resolving.
 */
export function getPiInvocation(args: string[]): { command: string; args: string[] } {
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
 * Opt-in debug breadcrumb for skipped / refused reaps. Set
 * `PI_SUBAGENT_DEBUG_REAP=1` to enable. Writes to stderr and
 * swallows any IO error so the reap path can never throw out
 * of a helper.
 */
export function debugReap(message: string): void {
	if (process.env.PI_SUBAGENT_DEBUG_REAP === "1") {
		// stderr breadcrumb; never throw out of the reap path.
		try {
			process.stderr.write(`[pi-subagents] ${message}\n`);
		} catch {
			/* ignore */
		}
	}
}
