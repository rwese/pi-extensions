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

_(none)_

## Ready

### Phase 1 — Setup

- [ ] P0.1 — Document plan and confirm baseline
      Criteria: plan file exists, `git status` clean,
      `npm run check` exits 0.
- [ ] P0.2 — Add this TODO.md tracker
      Criteria: file exists with the four sections.

### Phase 2 — Extract leaf modules

- [ ] P1.1 — Extract `src/core/types.ts` (UsageStats, SingleResult, SubagentDetails, callbacks)
      Verify: `npm run check`; `wc -l src/subagents.ts` drops.
- [ ] P1.2 — Extract `src/core/constants.ts` (max counts, timeouts, WRAP_UP_MESSAGE, parseNonNegativeInteger)
      Verify: `npm run check`; `rg "MAX_PARALLEL_TASKS" src/`.
- [ ] P1.3 — Extract `src/core/status.ts` (STATUS_KEY, activeStatuses, startSubagentStatus, status helpers)
      Verify: `npm run check`; `rg "activeStatuses" src/`.
- [ ] P1.4 — Extract `src/format/formatting.ts` (formatTimeout, formatCountdown, formatUsageStats, formatToolCall, computeCountdownLabel)
      Verify: `npm run check`; `rg "function formatTimeout" src/`.
- [ ] P1.5 — Extract `src/core/messages.ts` (DisplayItem, getDisplayItems, getFinalOutput, getResultFinalOutput, buildFanInContext)
      Verify: `npm run check`; `rg "function getFinalOutput" src/`.
- [ ] P1.6 — Extract `src/core/settings.ts` (read/save/normalize settings, type guards, hasOwn, sameToolSet, etc.)
      Verify: `npm run check`; `rg "function hasOwn" src/`.
- [ ] P1.7 — Extract `src/process/process.ts` (mapWithConcurrencyLimit, writePromptToTempFile, getPiInvocation, debugReap)
      Verify: `npm run check`; `rg "function getPiInvocation" src/`.
- [ ] P1.8 — Extract `src/process/reap.ts` (killProcessGroup, collectDescendantPids, readProcessStartTime, pidStillMatches, terminateProcess, reapDetachedSurvivors, reapLeftoverDescendants)
      Verify: `npm run check`; `rg "function terminateProcess" src/`.
- [ ] P1.9 — Extract `src/runner/runner.ts` (runSingleAgent)
      Verify: `npm run check`; `rg "function runSingleAgent" src/`.
- [ ] P1.10 — Extract `src/schema/schema.ts` (TimeoutMs, TaskItem, ChainItem, AggregatorItem, AgentScopeSchema, SubagentParams)
      Verify: `npm run check`; `rg "SubagentParams" src/`.
- [ ] P1.11 — Extract `src/format/render.ts` (formatResultHeader, renderDisplayItems, aggregateUsage, etc.)
      Verify: `npm run check`; `wc -l src/subagents.ts` drops.
- [ ] P1.12 — Extract `src/ui/ui-config.ts` (ToolToggleList, subagents:config command handler)
      Verify: `npm run check`; `rg "registerCommand" src/`.

### Phase 3 — Verification

- [ ] P2.1 — `npm run check` green across the workspace.
- [ ] P2.2 — Smoke import. Manual step: run `just try-subagents` to
      confirm the extension loads. (Cannot be automated in this
      harness; user to confirm.)
- [ ] P2.3 — `wc -l src/**/*.ts src/*.ts`: every file < 500 lines,
      `subagents.ts` < 350 lines.

### Phase 4 — Handoff

- [ ] P3.1 — Commit on `refactor_subagents` with a Conventional Commits
      message. Do not merge to `main`; await user review.
- [ ] P3.2 — Update `MEMORY.md` only if a non-obvious gotcha surfaces.

## Blocked

_(none)_

## Done

- [x] Plan file created at `docs/plans/refactor-pi-subagents.md`
      (layered layout: `src/{core,format,process,schema,runner,ui}/*`).
- [x] Worktree `refactor_subagents` confirmed; `main` untouched.
- [x] Baseline `npm run check` confirmed green (43 files, 0 errors).
