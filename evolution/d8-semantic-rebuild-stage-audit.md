# D8 Semantic Rebuild Stage Audit

Generated: 2026-05-25
Scope: source-level audit for FINAL-V2 D8 semantic/vector rebuild readiness.

## Baseline

- Source repository: `C:\Users\36371\openclaw`
- Current source HEAD during audit: `33858cf59c HUD: show semantic rebuild status`
- Worktree state before audit: clean
- No gateway restart, no global config write, no vector index rebuild, no embedding provider calls.

## Completed Source Chain

| Stage | Endpoint or module | Current behavior | Write scope |
| --- | --- | --- | --- |
| Semantic boundary observe | `GET /api/kb/state` | Reports keyword index availability and memory search semantic boundary from config. | None |
| Rebuild plan | `POST /api/kb/semantic-rebuild-plan` | Writes dry-run plan report with planned outputs and constraints. | Dry-run report only |
| Plan state | `GET /api/kb/semantic-rebuild-plan/state` | Reads latest semantic rebuild plan report. | None |
| Acceptance dry-run | `GET /api/kb/semantic-rebuild-plan/acceptance` | Checks whether latest plan is ready for human gate. | None |
| Acceptance record | `POST /api/kb/semantic-rebuild-plan/acceptance` | Writes human-gated acceptance record when proposal is stable. | Acceptance record only |
| Acceptance records | `GET /api/kb/semantic-rebuild-plan/acceptance-records` | Lists accepted proposal records. | None |
| Rebuild preflight | `GET /api/kb/semantic-rebuild-plan/rebuild-preflight` | Verifies latest acceptance still matches current plan and workspace summary. | None |
| Execution dry-run | `GET /api/kb/semantic-rebuild-plan/rebuild-dry-run` | Plans execution after preflight without calling embeddings or writing indexes. | None |
| Approval dry-run | `GET /api/kb/semantic-rebuild-plan/rebuild-approval` | Previews human rebuild approval record. | None |
| Approval record | `POST /api/kb/semantic-rebuild-plan/rebuild-approval` | Writes human rebuild approval intent. | Approval record only |
| Approval records | `GET /api/kb/semantic-rebuild-plan/rebuild-approval-records` | Lists rebuild approval records and latest approval. | None |
| Execution entry | `GET/POST /api/kb/semantic-rebuild-plan/rebuild-execution` | Reports ready or blocked for future real executor; `POST` still does not execute. | None |
| Status summary | `GET /api/kb/semantic-rebuild-plan/status` | Aggregates plan, acceptance, preflight, approval, and execution entry stage. | None |
| HUD visibility | `src/runtime/hud-state-refresh.ts` and `src/runtime/hud-state.ts` | Adds `semanticRebuild` summary to HUD state from existing dry-run records. | HUD snapshot only during normal HUD refresh |

## Safety Properties Preserved

- `embeddingCalls` remains `no`.
- `vectorIndexWritten` remains `no`.
- `realRebuildTriggered` remains `no`.
- `applied` remains `no`.
- Execution entry always returns `wouldExecute: false` and `executed: false`.
- Human gate is explicit: acceptance record and rebuild approval record are separate stages.
- Drift checks are present before approval-ready execution: proposal, source summary, planned batch count, acceptance record, and approval record must remain aligned.

## Verification Already Landed

| Area | Test anchor |
| --- | --- |
| KB API chain and method gates | `src/gateway/server-kb-api.test.ts` |
| HTTP fast path routing | `src/gateway/server-http.probe.test.ts` |
| HUD state carry-through | `src/runtime/hud-state.test.ts` |
| HUD refresh record scan | `src/runtime/hud-state-refresh.semantic-rebuild.test.ts` |

Recent validation after the latest HUD integration:

- `pnpm test src/runtime/hud-state.test.ts src/runtime/hud-state-refresh.test.ts src/runtime/hud-state-refresh.semantic-rebuild.test.ts`
- `pnpm exec oxfmt --check src/runtime/hud-state.ts src/runtime/hud-state.test.ts src/runtime/hud-state-refresh.ts src/runtime/hud-state-refresh.semantic-rebuild.test.ts`
- `node scripts/run-tsgo.mjs`
- `pnpm build`

## Remaining Gaps Before Real Rebuild

1. Executor contract is not implemented.
   - Need a typed executor input derived from the approved dry-run plan.
   - Need idempotency key based on proposal ID and approval ID.
   - Need a durable execution record separate from approval record.

2. Embedding provider invocation is still absent.
   - Need provider selection through existing `agents.memorySearch` configuration.
   - Need explicit timeout, retry, and failure recording.
   - Need no silent fallback if provider config is invalid.

3. Vector and semantic output writers are still absent.
   - Need atomic write behavior for `system/kb-index/semantic-index.json`.
   - Need explicit decision on `system/kb-index/vector-index.sqlite` format and ownership.
   - Need rollback or staged output paths before replacing active indexes.

4. Runtime execution must remain human-gated.
   - `rebuild-execution` can become a real action only after the executor contract, output staging, and failure behavior are reviewed.
   - Continuous auto-loop must not call this path.

5. HUD currently reads record files directly.
   - This is acceptable for observability.
   - A later cleanup can share a typed read-only summary module between gateway KB API and HUD refresh.

## Recommended Next Slice

Implement `semantic rebuild executor design contract` without execution:

- Add typed execution request and execution record shapes.
- Add a `GET /api/kb/semantic-rebuild-plan/rebuild-execution-contract` or equivalent internal helper returning the exact executor input.
- Keep all constraints at `embeddingCalls: "no"`, `vectorIndexWritten: "no"`, `realRebuildTriggered: "no"`, and `applied: "no"`.
- Add tests for idempotency key, staged output paths, blocked states, and no writes.

## Stop Conditions

- Do not call an embedding provider without explicit approval.
- Do not write or replace `system/kb-index/semantic-index.json` without explicit approval.
- Do not write or replace `system/kb-index/vector-index.sqlite` without explicit approval.
- Do not add any fallback provider behavior that silently masks config errors.
- Do not connect rebuild execution to scheduler, auto-dispatch, or continuous auto-loop.
