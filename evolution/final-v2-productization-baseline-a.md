# FINAL-V2 Productization Baseline A

Generated: 2026-05-20
Scope: read-only productization mapping from the local `workspace-main` prototype layer into the `openclaw` source repository.

## Baseline

- Source repository: `C:\Users\36371\openclaw`
- Prototype workspace: `C:\Users\36371\.openclaw\workspace-main`
- Current source HEAD during audit: `0e1e75edb6 Validate runtime bus observe mode`
- Source worktree state during audit: clean
- Latest source verification before this audit: targeted runtime observe tests PASS, `node scripts/run-tsgo.mjs` PASS, `node scripts/build-all.mjs` PASS
- No gateway restart, no global config write, no continuous auto-loop enablement.

## Productization Rule

Product code belongs in `src/runtime`, `src/gateway`, `src/agents`, `src/commands`, or a stable script entrypoint under `scripts`.
Workspace data, live returns, archives, candidates, generated indexes, and per-run state must remain outside the source repo.
Prototype PowerShell scripts should not be copied wholesale into runtime code. Each migration needs a typed contract, a small runtime module, scoped tests, and an observe-only path before any apply path.

## Current Source Anchors

| Area | Source anchor | Current state | Productization status |
| --- | --- | --- | --- |
| Runtime event bus | `src/runtime/event-bus.ts` | JSONL event append/read, source registry | Keep and expand |
| Task state | `src/runtime/task-state-machine.ts` | Task JSONL read, old-dir reconciliation, policy record | Keep and expand |
| Policy engine | `src/runtime/policy-engine.ts` | Rule load/evaluate with fallback human gate | Keep and expand |
| Policy dry-run actions | `src/runtime/policy-action-executor.ts` | Dry-run plan/audit, hard blocks | Keep and expand |
| Auto dispatcher | `src/runtime/auto-dispatcher.ts` | Dry-run dispatch plan, currently stale batch-6 scoped | Replace with generic DAG-ready planner |
| Runtime loop | `src/runtime/runtime-loop.ts` | Observe tick plus apply-smoke path | Keep observe core, gate apply paths |
| Scheduler | `src/runtime/task-scheduler.ts` | Scheduler loop into `evolution/run-auto-progress-tick.ps1` | Migrate away from workspace script dependency |
| HUD API | `src/gateway/server-hud-api.ts` | HTTP HUD endpoints over runtime files/scripts | Keep API, replace workspace script dependency |
| Control UI HUD | `ui/src/ui/components/TaskHUD.ts` | UI consumer for `/api/hud/*` | Keep after API contract stabilizes |
| Model fallback | `src/agents/model-fallback.ts`, `src/agents/agent-command.ts`, `src/agents/agent-scope.ts` | Fallback chain implemented in agent run path | Runtime-ready, config-dependent |
| Sessions spawn fallbacks | `src/agents/tools/sessions-spawn-tool.ts` | Accepts `fallbacks` and forwards them | Runtime-ready, needs live default config validation |
| Memory embeddings | `src/memory-host-sdk`, `src/agents/memory-search.ts` | Hybrid memory/embedding host exists | Product exists, FINAL-V2 KB policy not yet integrated |

## Workspace Prototype Inventory

### Promote To Source Runtime

| Domain | Prototype files | Recommended source target | Rationale |
| --- | --- | --- | --- |
| D3 auto progression | `evolution/run-auto-progress-tick.ps1`, `run-controlled-auto-tick.ps1`, `run-return-progress-step.ps1`, `run-pdl-tick.ps1`, `run-pdl-graph-update.ps1`, `run-pdl-completion-followup.ps1` | `src/runtime/progression/*` | Core control loop should be typed, testable, and independent of `workspace-main/evolution`. |
| D4 HUD state generation | `system/patrol/generate-hud-state.ps1`, `evolution/runtime/patrol-agent.ps1`, `runtime/patrol/patrol-daily.ps1` | `src/runtime/hud/*` plus existing `src/gateway/server-hud-api.ts` | Gateway already exposes HUD routes; state generation should be a runtime module, not a workspace script. |
| D5 return processing | `system/returns/process-return.ps1`, `return-consumer.ps1`, `scan-inbox.ps1`, `promote-to-gate.ps1`, `evolution/scan-return.ps1`, `watch-returns.ps1` | `src/runtime/returns/*` | Return/receipt chain is central runtime behavior and needs schema-validated source modules. |
| D6 task graph | `evolution/task-graph-v1.md`, `validate-task-graph.ps1`, `runtime/main/task-graph/task-graph-mvp.ps1` | `src/runtime/task-graph/*` | DAG state and ready-node resolution should replace stale batch-specific dispatch logic. |
| D7 lifecycle and control | `evolution/generate-lifecycle-state.ps1`, `scan-control-signals.ps1`, `write-control-signal.ps1`, `apply-recovery-decision.ps1`, `scan-recovery-candidates.ps1` | `src/runtime/lifecycle/*` and `src/runtime/control-signals/*` | Session lifecycle and pause/cancel/recover are product safety primitives. |
| D7 execution lease | `evolution/evaluate-execution-lease.ps1`, `lease-human-gate-bridge.ps1`, `scripts/evaluate-execution-lease.ps1`, `scripts/monitor-execution-lease.ps1` | `src/runtime/leases/*` | Lease verdicts should be a typed runtime service shared by scheduler, HUD, and human gate. |
| D8 KB refresh and recall | `evolution/refresh-kb-index.ps1`, `keyword-search.ps1`, `recall-for-dispatch.ps1`, `kb-match-utils.ps1`, `runtime/main/refresh-kb-index.ps1` | `src/runtime/kb/*` or memory host integration | Keyword recall exists as prototype; semantic/vector policy needs a stable product boundary. |
| D9 promote gate | `evolution/d9-promote-gate-runtime.mjs`, `promote-gate.ps1`, `promotion-candidate-gate.ps1`, `extract-case.ps1` | `src/runtime/distillation/*` | Promotion must be gated and schema-backed before any auto-evolution path. |
| D10 mirror loop | `evolution/run-mirror-observe.ps1`, `run-mirror-loop.ps1`, `mirror-distill-check.ps1`, `mirror-skill-candidate-gen.ps1`, `mirror-sandbox-validate.ps1` | `src/runtime/mirror/*` | Mirror loop exists as prototype, but must stay observe-only until D7/D9 are stable in source. |
| D12 watchdog | `evolution/runtime/watchdog.ps1`, `run-stability-check.ps1`, `cleanup-auto-progress-artifacts.ps1` | `src/runtime/health/*` | Health/watchdog should expose stable state to HUD and CLI. |

### Keep As Workspace Data

| Data class | Examples | Reason |
| --- | --- | --- |
| Live returns and receipts | `system/returns/archive/**`, `system/returns/processed/**`, `system/returns/inbox/**` | Runtime data, not source. |
| Human gate records | `runtime/human-gate/archive/**`, candidates, review JSON | Operator decisions and historical audit data. |
| Case and skill libraries | `system/case-library/*.json`, `system/skill-library/*.json` | User/workspace knowledge assets; source should only carry schema and loader code. |
| KB index output | `system/kb-index/*.json` | Generated index. Source should own builder and schema, not generated local data. |
| Position state and handoffs | `system/positions/state/**`, `system/positions/handoffs/**` | Workspace-specific runtime state. |
| Memory state events | `system/state/memory-events/**`, local `MEMORY.md`, `NEXT_ACTION.md`, `OPEN_LOOPS.md` | Truth/memory state; do not commit or auto-promote. |
| Cleanup archives and temporary scripts | `archive/**`, `runtime/main/tmp/**` | Historical/debug residue. Useful for audit, not product code. |

### Defer Or Discard

| Class | Examples | Decision |
| --- | --- | --- |
| Debug scratch scripts | `_debug.ps1`, `_test_regex.ps1`, `runtime/main/tmp/*debug*.ps1`, one-off verify scripts | Do not migrate. Recreate as tests only when needed. |
| Historical backup variants | `*.bak-*`, mojibake backups, phase backup folders | Do not migrate. |
| Mock-only fixtures embedded in runtime folders | old `mock-return-package*`, smoke-only archives | Convert to unit fixtures only if a source test needs them. |
| Batch-specific task remnants | `P1-BATCH*` special files and dispatch lease artifacts | Do not productize by name; extract generic behavior only. |

## Domain Status After Mapping

| Domain | Productized source state | Workspace prototype state | Next action |
| --- | --- | --- | --- |
| D1 memory/truth/continuity | Partial via memory host and config | Rich workspace truth files and memory events | Keep truth files external; migrate only schema/controlled-apply helpers later. |
| D2 role system | Strong in agent config, sessions, subagent spawn | Position files and resolver scripts | Validate config-driven role defaults and fallback model behavior. |
| D3 auto progression | Partial scheduler/runtime-loop source | Mature PowerShell progression scripts | Migrate controlled tick planner first, observe-only. |
| D4 HUD/patrol | Gateway API and UI exist | HUD generator/patrol scripts exist | Productize HUD state generator into source runtime. |
| D5 return/receipt | Partial task-state/policy-action source | Mature return scripts and schemas | Migrate return scanner/consumer next after DAG contract. |
| D6 DAG task graph | Not yet first-class in source | MVP graph docs/scripts exist | Build typed `task-graph` module before generic dispatcher. |
| D7 pause/cancel/recover | Apply-smoke and lease hooks partial | Lifecycle, control signal, recovery scripts exist | Migrate lifecycle/control-signals as typed source modules. |
| D8 KB/vector recall | Memory/embedding platform exists | KB keyword and semantic prototypes exist | Align FINAL-V2 KB with memory-search provider config. |
| D9 case/skill/rule distillation | Not productized | Promote gate and distill scripts exist | Keep gated; migrate schema + dry-run evaluator before any apply. |
| D10 Mirror Loop | Not productized | Observe/mirror scripts exist | Defer until D7 + D9 are source-stable. |
| D11 Auto-Evolution | Not productized | Design/prototype only | Keep frozen. |
| D12 stability/installer | Core build/install exists; runtime health partial | Watchdog/cleanup scripts exist | Productize health state after HUD. |

## Immediate Development Slices

1. `task-graph` source module
   - Add typed graph state, node status, dependency resolver, ready-node resolver.
   - Input/output remains local JSON under workspace root.
   - No dispatch, no apply, no restart.

2. Generic observe-only dispatch planner
   - Replace `P1-BATCH6-` special handling with graph-ready candidate selection.
   - Keep `wouldDispatch: false` in observe mode.
   - Preserve hard blocks for A1, EP-8, EP-9, build, restart, config, and rules.

3. Runtime HUD generator module
   - Move `generate-hud-state.ps1` behavior into a typed runtime function.
   - Keep existing `/api/hud/*` routes.
   - CLI/script wrapper can call the runtime function.

4. Lifecycle/control signal module
   - Port taskId-exact matching from `generate-lifecycle-state.ps1`.
   - Ambiguous signals must be recorded and must not change lifecycle state.
   - Keep pause/cancel/recover human-gated.

## Stop Conditions

- Any write to `MEMORY.md`, `ENGINEERING_RULES.md`, truth files, or workspace production task graph requires explicit approval.
- Any continuous auto-loop enablement requires explicit approval.
- Any gateway restart requires explicit approval.
- Any source migration that changes live dispatch/apply behavior must first land observe-only tests.
