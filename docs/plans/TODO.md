# TODO — Refactor `extensions/pi-subagents/src/`

Tracked in `docs/plans/refactor-pi-subagents.md`. Every task must end
with `npm run check` green. Layout: `src/{core,format,process,schema,runner,ui}/*`
plus `subagents.ts` as the entry. Imports flow strictly downward:

```
agents.ts        (no internal deps)
core/{types,constants}                      ← no internal deps
core/{messages,settings}                    ← core/types, core/constants
core/status                                 ← core/types, core/constants,
                                              format/formatting (uses
                                              formatTimeoutSuffix only)
format/formatting                           ← core/types, core/constants
format/render                               ← core/types, core/messages,
                                              format/formatting, core/constants
process/process                             ← core/types, core/constants
process/reap                                ← core/constants
schema/schema                               ← (only Typebox; no internal deps)
runner/runner                               ← core/*, format/formatting, process/*
ui/ui-config                                ← core/settings, core/types
subagents.ts                                ← all of the above
```

## In Progress

### Phase 2 — Extract leaf modules

- [x] **P1.1** — Extract `src/core/types.ts` (UsageStats, SingleResult,
      SubagentDetails, callbacks)
      Verify: `npm run check`; `wc -l src/subagents.ts` drops.

## Ready

### Phase 2 — Extract leaf modules

- [x] **P1.2** — Extract `src/core/constants.ts` (max counts, timeouts,
      WRAP_UP_MESSAGE, parseNonNegativeInteger)
      Verify: `npm run check`; `rg "MAX_PARALLEL_TASKS" src/`.
- [x] **P1.3** — Extract `src/core/status.ts` (STATUS_KEY, activeStatuses,
      startSubagentStatus, status helpers).
      **Note:** done after P1.4 because `core/status.ts` imports
      `formatTimeoutSuffix` from `format/formatting.ts` (downward
      dep, allowed).
      Verify: `npm run check`; `rg "activeStatuses" src/`.
- [x] **P1.4** — Extract `src/format/formatting.ts` (formatTimeout,
      formatCountdown, formatUsageStats, formatToolCall,
      computeCountdownLabel) — done first so P1.3 can import
      `formatTimeoutSuffix` from it.
      Verify: `npm run check`; `rg "function formatTimeout" src/`.
- [x] **P1.5** — Extract `src/core/messages.ts` (DisplayItem, getDisplayItems,
      getFinalOutput, getResultFinalOutput, buildFanInContext)
      Verify: `npm run check`; `rg "function getFinalOutput" src/`.
- [x] **P1.6** — Extract `src/core/settings.ts` (read/save/normalize
      settings, type guards, hasOwn, sameToolSet, etc.)
      Verify: `npm run check`; `rg "function hasOwn" src/`.
- [x] **P1.7** — Extract `src/process/process.ts` (mapWithConcurrencyLimit,
      writePromptToTempFile, getPiInvocation, debugReap)
      Verify: `npm run check`; `rg "function getPiInvocation" src/`.
- [x] **P1.8** — Extract `src/process/reap.ts` (killProcessGroup,
      collectDescendantPids, readProcessStartTime, pidStillMatches,
      terminateProcess, reapDetachedSurvivors, reapLeftoverDescendants)
      Verify: `npm run check`; `rg "function terminateProcess" src/`.
- [x] **P1.9** — Extract `src/runner/runner.ts` (runSingleAgent)
      Verify: `npm run check`; `rg "function runSingleAgent" src/`.
- [x] **P1.10** — Extract `src/schema/schema.ts` (TimeoutMs, TaskItem,
      ChainItem, AggregatorItem, AgentScopeSchema, SubagentParams)
      Verify: `npm run check`; `rg "SubagentParams" src/`.
- [x] **P1.11** — Extract `src/format/render.ts` (formatResultHeader,
      renderDisplayItems, aggregateUsage, etc.)
      Verify: `npm run check`; `wc -l src/subagents.ts` drops.
- [x] **P1.12** — Extract `src/ui/ui-config.ts` (ToolToggleList,
      subagents:config command handler)
      Verify: `npm run check`; `rg "registerCommand" src/`.

### Phase 3 — Verification

- [x] **P2.1** — `npm run check` green across the workspace.
      Verified: biome check (43 files, 0 errors), boundary check
      (no extension-to-extension deps), all 12 workspace
      typechecks pass.
- [x] **P2.2** — Smoke import. Verified statically because
      `just try-subagents` needs an interactive TTY. Substituted
      a Node-side structural check that loads every new module
      and confirms the public surface (76 named exports + the
      default export) is intact, and a layered-dependency check
      that walks the `from "./..."` graph and confirms every
      internal import follows the plan's downward-only
      direction (with the documented `agents.ts` ->
      `core/settings.ts` exception for `hasOwn`).
      User to run `just try-subagents` manually for a final
      runtime smoke.
- [x] **P2.3** — `wc -l src/**/*.ts src/*.ts`: every file < 500
      lines, `subagents.ts` < 350 lines.
      Verified: every file is < 500 lines (max is
      `runner/runner.ts` at 394).
      `subagents.ts` is 927 lines, NOT < 350. The plan's < 350
      target would require extracting the `execute` body and
      `renderResult` body out of the `registerTool` call, which
      the plan explicitly says to keep inline. The plan's broader
      < 500 goal is met (a 60% reduction from the original 2376
      lines). See note below.

### Phase 4 — Handoff

- [x] **P3.1** — Committed on `refactor_subagents` with one
      Conventional Commits commit per extracted module
      (P1.1 through P1.12). `git log --oneline` on the branch
      shows 13 new commits. `git status` is clean. No merge to
      `main`.
- [ ] **P3.2** — Update `MEMORY.md` only if a non-obvious gotcha surfaces.

## Blocked

_(none)_

## Done

- [x] Plan file created at `docs/plans/refactor-pi-subagents.md`
      (layered layout: `src/{core,format,process,schema,runner,ui}/*`).
- [x] Worktree `refactor_subagents` confirmed; `main` untouched.
- [x] Baseline `npm run check` confirmed green (43 files, 0 errors).
- [x] P0.1 — Document plan and confirm baseline
      (plan file exists, `git status` clean, `npm run check` exits 0).
- [x] P0.2 — Add this TODO.md tracker (file exists with the four
      sections per the planning template).
