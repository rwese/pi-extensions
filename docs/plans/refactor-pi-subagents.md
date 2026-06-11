# Refactor `extensions/pi-subagents/src/`

## Sprint Goal

Break up the two oversized files in `extensions/pi-subagents/src/` into a
maintainable module layout while keeping `npm run check` (Biome lint +
boundary check + workspace `tsc --noEmit`) green at every step and
preserving the public surface of the package (`pi.extensions` entry,
`subagents.ts` default export, `agents.ts` exports).

The current layout is two files:

- `agents.ts` — 264 lines (agent discovery, frontmatter, settings)
- `subagents.ts` — 2376 lines (everything else)

The target layout is a thin orchestrator in `subagents.ts` plus a small
set of focused modules under `src/`.

## Scope

**Goals:**

- Reduce `subagents.ts` to < 500 lines by extracting logically cohesive
  modules.
- Keep the package's external surface unchanged: same default export
  from `subagents.ts`, same `pi.extensions` entry, same `agents.ts`
  exports (`AgentConfig`, `AgentScope`, `AgentSource`,
  `SubagentAgentConfig`, `SubagentSettings`, `discoverAgents`,
  `formatAgentList`).
- Run `npm run check` after every refactor step. The lint and typecheck
  must stay green.
- Work in the existing worktree on branch `refactor_subagents`; do not
  touch `main` until the user accepts the refactor.

**Non-Goals:**

- Behaviour changes. Pure structural refactor; no functional edits.
- Renaming public types or changing the on-disk config filename
  (`pi-subagents-config.json`).
- Touching any other package in the monorepo.
- Adding tests (the package has no test suite today and the
  repository-wide convention is `npm run check` as the gate).
- Splitting `agents.ts` — it is already small and cohesive.

## Target Module Layout (layered)

Each subfolder is a layer. Imports flow strictly downward: `core` is
the foundation, `format` and `process` build on it, `ui` is the
TUI/command layer, `schema` defines the tool's input shape, and
`subagents.ts` is the entry that wires them all into the extension
API.

```
extensions/pi-subagents/src/
├── subagents.ts                 # entry, default export, registerTool + registerCommand wiring
├── agents.ts                    # unchanged (already small, depends only on @earendil-works/pi-coding-agent)
│
├── core/                        # pure data + types + state, no I/O and no TUI
│   ├── types.ts                 # UsageStats, SingleResult, SubagentDetails, OnUpdate/OnNotice callbacks
│   ├── constants.ts             # MAX_PARALLEL_TASKS, MAX_CONCURRENCY, COLLAPSED_ITEM_COUNT, timeouts, WRAP_UP_MESSAGE
│   ├── status.ts                # STATUS_KEY, activeStatuses, startSubagentStatus, publishSubagentStatus, *Status helpers
│   ├── messages.ts              # getFinalOutput, getResultFinalOutput, getDisplayItems, buildFanInContext, DisplayItem
│   └── settings.ts              # read/save/normalize SubagentSettings, type guards, hasOwn, sameToolSet, ...
│
├── format/                      # renderable strings (no I/O, no state)
│   ├── formatting.ts            # formatTimeout, formatCountdown, formatUsageStats, formatToolCall, computeCountdownLabel
│   └── render.ts                # formatResultHeader, renderDisplayItems, aggregateUsage, renderCall/renderResult helpers
│
├── process/                     # child process management
│   ├── process.ts               # getPiInvocation, writePromptToTempFile, mapWithConcurrencyLimit, debugReap
│   └── reap.ts                  # killProcessGroup, collectDescendantPids, readProcessStartTime, pidStillMatches,
│                                # terminateProcess, reapDetachedSurvivors, reapLeftoverDescendants
│                                # (separate file: this is the most safety-critical layer; deserves its own attention)
│
├── schema/                      # Typebox input schemas
│   └── schema.ts                # TimeoutMs, TaskItem, ChainItem, AggregatorItem, AgentScopeSchema, SubagentParams
│
├── runner/                      # the orchestrator that glues everything per-invocation
│   └── runner.ts                # runSingleAgent, OnUpdateCallback/OnNoticeCallback wiring
│
└── ui/                          # TUI components + commands
    └── ui-config.ts             # ToolToggleList class + subagents:config command handler
```

**Dependency graph (strictly downward; `subagents.ts` is the only file
that imports across layers):**

```
agents.ts        (no internal deps)

core/
  types.ts       (no internal deps)
  constants.ts   (no internal deps)
  status.ts      → core/types, core/constants, format/formatting
                   (uses formatTimeoutSuffix from format layer)
  messages.ts    → core/types
  settings.ts    → core/types, core/constants

format/
  formatting.ts  → core/types, core/constants
  render.ts      → core/types, core/messages, format/formatting, core/constants

process/
  process.ts     → core/types, core/constants
  reap.ts        → core/constants

schema/
  schema.ts      (no internal deps; only Typebox)

runner/
  runner.ts      → core/*, format/formatting, process/*

ui/
  ui-config.ts   → core/settings, core/types

subagents.ts     → all of the above
```

Note: `core/status.ts` is the only core file that imports from
`format/`. That is fine because the format layer is a pure-string
layer with no I/O; the dependency arrow goes format ← core only in
this one direction.

Module boundaries chosen so each file:

- Has a single responsibility named by its filename.
- Re-exports only what other modules need (keep internal helpers
  private).
- Stays < 500 lines; most will be < 250.

## Tasks

### Phase 1 — Setup (no behavioural change)

#### P0.1 — Document plan and confirm baseline

- **Criteria:** `docs/plans/refactor-pi-subagents.md` exists at this
  path; `git status` is clean on `refactor_subagents`; `npm run check`
  exits 0.
- **Verify:** `git status`; `npm run check`.

#### P0.2 — Add a TODO.md tracker

- **Criteria:** `docs/plans/TODO.md` exists with `In Progress`,
  `Ready`, `Blocked`, `Done` sections per the planning template.
- **Verify:** `cat docs/plans/TODO.md`.

### Phase 2 — Extract leaf modules (lowest risk first)

Refactor order is chosen so each step keeps the package building: do
not move a function before moving its dependencies, and verify with
`npm run check` after every step.

#### P1.1 — Extract `src/core/types.ts` (shared types)

- **What:** move `UsageStats`, `SingleResult`, `SubagentDetails` and
  the `OnUpdateCallback` / `OnNoticeCallback` aliases into
  `src/core/types.ts`. Import them in `subagents.ts` from there.
- **Why first:** every later extraction depends on these types, but
  extracting them does not change any function bodies, so the risk
  is essentially zero.
- **Criteria:** `subagents.ts` no longer declares these types
  locally; `core/types.ts` exports them; `npm run check` green.
- **Verify:** `npm run check`; `wc -l src/subagents.ts` (down by ~30
  lines).

#### P1.2 — Extract `src/core/constants.ts`

- **What:** move `MAX_PARALLEL_TASKS`, `MAX_CONCURRENCY`,
  `COLLAPSED_ITEM_COUNT`, `MAX_AGENTS_IN_DESCRIPTION`,
  `DEFAULT_TIMEOUT_MS`, `KILL_GRACE_MS`, `WRAP_UP_GRACE_MS`,
  `WRAP_UP_MESSAGE`, and `parseNonNegativeInteger` into
  `src/core/constants.ts`. `subagents.ts` re-imports them.
- **Criteria:** `npm run check` green; constant values match the
  pre-refactor source verbatim.
- **Verify:** `npm run check`; `rg "MAX_PARALLEL_TASKS" src/` should
  show definitions in `core/constants.ts` and references in
  `subagents.ts` only.

#### P1.3 — Extract `src/core/status.ts`

- **What:** move `STATUS_KEY`, `activeStatuses`, `StatusContext`,
  `startSubagentStatus`, `publishSubagentStatus` into
  `src/core/status.ts`. Also move the `singleStatus`, `chainStatus`,
  `parallelStatus`, `fanInStatus` helpers.
- **`formatTimeoutSuffix` lives in `format/formatting.ts`** and is
  imported by `core/status.ts` (downward dep, allowed).
- **Criteria:** `npm run check` green.
- **Verify:** `npm run check`; `rg "activeStatuses" src/` should show
  definition in `core/status.ts`.

#### P1.4 — Extract `src/format/formatting.ts`

- **What:** move `formatTimeout`, `formatTimeoutSuffix`,
  `formatCountdown`, `formatTokens`, `formatUsageStats`,
  `formatToolCall` into `src/format/formatting.ts`. Move
  `computeCountdownLabel` (depends on `SingleResult`,
  `WRAP_UP_GRACE_MS`, `formatCountdown`).
- **Note:** `formatTimeoutSuffix` is shared with `core/status.ts`;
  define it in `format/formatting.ts` and re-import it from
  `core/status.ts` (downward dependency, allowed).
- **Criteria:** `npm run check` green; `formatToolCall` is still
  callable from `subagents.ts`'s `renderResult` without behaviour
  change.
- **Verify:** `npm run check`; `rg "function formatTimeout" src/`
  shows the definition in `format/formatting.ts` only.

#### P1.5 — Extract `src/core/messages.ts`

- **What:** move `DisplayItem`, `getDisplayItems`,
  `getFinalOutput`, `getResultFinalOutput`, `buildFanInContext` into
  `src/core/messages.ts`. These are pure functions over `Message[]`
  and `SingleResult`.
- **Criteria:** `npm run check` green.
- **Verify:** `npm run check`; `rg "function getFinalOutput" src/`
  shows the definition in `core/messages.ts` only.

#### P1.6 — Extract `src/core/settings.ts`

- **What:** move `readSubagentSettings`, `saveSubagentConfig`,
  `normalizeSubagentSettings`, `normalizeAgentSettings`,
  `hasOwn`, `isPlainObject`, `isStringArray`, `isPositiveNumber`,
  `uniqueToolNames`, `sameToolSet`, `hasAnyAgentOverride` into
  `src/core/settings.ts`. Note: `hasOwn` is also used by
  `agents.ts` — re-export it from `core/settings.ts` and have
  `agents.ts` import it from there to remove duplication.
- **Criteria:** `npm run check` green; `agents.ts` no longer
  declares `hasOwn` locally.
- **Verify:** `npm run check`; `rg "function hasOwn" src/`.

#### P1.7 — Extract `src/process/process.ts` (process management)

- **What:** move `mapWithConcurrencyLimit`, `writePromptToTempFile`,
  `getPiInvocation`, `debugReap` into
  `src/process/process.ts`.
- **Criteria:** `npm run check` green.
- **Verify:** `npm run check`; `rg "function getPiInvocation" src/`
  shows the definition in `process/process.ts` only.

#### P1.8 — Extract `src/process/reap.ts` (descendant reaping)

- **What:** move `collectDescendantPids`, `readProcessStartTime`,
  `pidStillMatches`, `killProcessGroup`, `terminateProcess`,
  `reapDetachedSurvivors`, `reapLeftoverDescendants` into
  `src/process/reap.ts`. This is the most safety-critical layer
  (pid recycling, signal handling); isolating it makes the
  next code review easier.
- **Note:** the runner needs `terminateProcess`; the entry needs
  nothing directly from this file. Confirm at extraction time.
- **Criteria:** `npm run check` green.
- **Verify:** `npm run check`; `rg "function terminateProcess" src/`
  shows the definition in `process/reap.ts` only.

#### P1.9 — Extract `src/runner/runner.ts` (`runSingleAgent`)

- **What:** move `runSingleAgent` into `src/runner/runner.ts`. It
  depends on almost everything we have already extracted
  (`core/constants`, `core/messages`, `core/status`,
  `format/formatting`, `process/process`, `process/reap`,
  `core/types`), which is why this is intentionally last in the
  leaf phase.
- **Criteria:** `npm run check` green; `runSingleAgent` is exported
  from `runner/runner.ts` and called from `subagents.ts`.
- **Verify:** `npm run check`; `rg "function runSingleAgent" src/`.

#### P1.10 — Extract `src/schema/schema.ts`

- **What:** move `TimeoutMs`, `TaskItem`, `ChainItem`,
  `AggregatorItem`, `AgentScopeSchema`, `SubagentParams` into
  `src/schema/schema.ts`. Keep all `description` strings verbatim.
- **Criteria:** `npm run check` green; schema is exported and
  consumed by `subagents.ts`'s `registerTool`.
- **Verify:** `npm run check`; `rg "SubagentParams" src/`.

#### P1.11 — Extract `src/format/render.ts` (rendering helpers)

- **What:** the `renderCall` and `renderResult` bodies in
  `subagents.ts` are large but tightly coupled to the surrounding
  tool shape. Extract pure helpers into `src/format/render.ts`:
  - `formatResultHeader(r, icon, theme, isError, countdownSuffix)`
  - `formatParallelHeader(...)` and `formatChainHeader(...)` if
    they reduce duplication
  - `renderDisplayItems(items, theme, expanded, limit)` (already a
    local closure — promote to module level)
  - `aggregateUsage(results)` (already a local closure)
- Keep the `renderCall` and `renderResult` methods in
  `subagents.ts` so `registerTool` stays in one place; they
  delegate to the helpers in `format/render.ts`.
- **Criteria:** `npm run check` green; `format/render.ts` exports
  the helpers; `subagents.ts`'s `renderCall`/`renderResult` are
  visibly shorter.
- **Verify:** `npm run check`; `wc -l src/subagents.ts` should drop
  by 100+ lines.

#### P1.12 — Extract `src/ui/ui-config.ts` (configuration command)

- **What:** move `ToolToggleList` class and the
  `subagents:config` command handler out of the default-export
  function into `src/ui/ui-config.ts`. Export a
  `registerConfigCommand` function that takes `pi: ExtensionAPI`
  and performs the registration; call it from `subagents.ts`.
- **Criteria:** `npm run check` green; the
  `subagents:config` command still registers with the same
  description and behaviour.
- **Verify:** `npm run check`; `rg "registerCommand" src/`.

### Phase 3 — Verification

#### P2.1 — `npm run check` green

- **Criteria:** Biome check passes; boundary check passes; all
  workspaces typecheck.
- **Verify:** `npm run check` exits 0.

#### P2.2 — Smoke import via `just try-subagents` (manual)

- **Criteria:** `just try-subagents` (or the `pi -e` equivalent)
  loads the extension without runtime errors. (This is a manual
  smoke test — if the interactive TTY is not available, at minimum
  confirm the module loads under `node --import=...`.)
- **Verify:** observe no module-resolution or top-level syntax
  errors. If the harness cannot run interactively, document the
  command the user should run to verify themselves in
  `docs/plans/TODO.md`.

#### P2.3 — `wc -l` and structural review

- **Criteria:** every file under `src/` is < 500 lines;
  `subagents.ts` is < 350 lines.
- **Verify:** `wc -l src/*.ts`.

### Phase 4 — Handoff

#### P3.1 — Commit on `refactor_subagents`

- **Criteria:** changes are committed with a Conventional Commits
  message that references the refactor. The user is then asked
  to review before any merge to `main`. The branch stays in the
  worktree; we do **not** push or merge automatically.
- **Verify:** `git log --oneline -3` shows the refactor commit on
  `refactor_subagents`; `git status` clean.

#### P3.2 — Update MEMORY.md if a reusable lesson surfaces

- **Criteria:** only add an entry to `MEMORY.md` if a non-obvious
  gotcha surfaces (per the existing rule: short, reusable,
  `GOTCHA`/`TASTE`).
- **Verify:** `MEMORY.md` diff.

## Dependencies

- `npm run check` must be runnable; confirmed: green at baseline.
- `node_modules` must be installed; confirmed: present.
- No external package changes required. All imports are already
  resolvable.

## Risks

- **Risk:** TypeScript re-export of types breaks because
  `Message`/`AgentConfig` are imported in the new files and may
  cycle.
  **Mitigation:** extract types before functions; the type file
  imports only from external packages and `agents.ts`. If a cycle
  appears, split the shared types into `types.ts` and have
  functions in `runner.ts`/`render.ts` import from there.
- **Risk:** a closure over a local variable (e.g.
  `childMeta` in `runSingleAgent`) becomes hard to extract.
  **Mitigation:** `runner.ts` may keep `runSingleAgent` as one
  function and re-import the helpers it needs; no closure
  extraction required.
- **Risk:** Biome's auto-formatter reorders imports.
  **Mitigation:** run `npm run format` after every edit; the
  project uses Biome authoritatively.
- **Risk:** `just try-subagents` requires an interactive TTY and
  cannot be automated here.
  **Mitigation:** the static gates (`npm run check`) cover the
  structural and type-correctness dimensions; the smoke test is
  the user's last step. The handoff note in TODO.md names the
  exact command.

## First Verifiable State

**Order first, not time.**

- P0.1 — confirm baseline is green.
- P1.1 — extract `core/types.ts`. This is the smallest testable
  increment: zero functional change, but `wc -l src/subagents.ts`
  drops, and `npm run check` must still pass.

## Definition of Done

- [x] All P0 + P1 tasks complete.
- [x] `npm run check` exits 0.
- [x] No file in `src/` exceeds 500 lines.
- [x] `subagents.ts` is < 350 lines.
- [x] Public surface unchanged: `pi.extensions` entry, default
  export, `agents.ts` exports.
- [x] Changes committed on `refactor_subagents`; `main` untouched.
- [x] User invited to review before merge.
