# Spatial Context Loop (P0c)

`@map-harness/spatial-context` owns the P0c context loop: the DecisionFrame
domain, the authoritative `decisionFrame` session projection, the bounded
pre-step snapshot injection, the versioned method cards, and the task budget
ledger. Scope and acceptance live in the task package
`.spec/specs/2026-09-24_add-spatial-context-loop/`; the target design is
`.spec/docs/2026-09-23_docs-spatial-agent-architecture_design.md` (§3.3, §5,
§5.5) — that document is a design, not an implementation record.

## Faces and composition

| Face | Entry | Mounted by | Registers |
|---|---|---|---|
| Host | `@map-harness/spatial-context` | map-web patch insert row `spatial-context` | the `decisionFrame` projection and the `spatialContext` service (resolved task budget + frame read) |
| Agent listener | `@map-harness/spatial-context/agent` | map-web host fallback `spatial-context-agent-fallback`; optional preset row `spatial-context-agent` | the `agent/pre-step` listener |

The host projection is required for the frame to fold. The map-web fallback supplies context to presets that do not mount the listener, including installed user presets; it never rewrites their files. When a preset also mounts the listener, its inner waterfall decision owns admission and its configured budget: the outer listener neither duplicates a snapshot nor bypasses a context-byte refusal. The request-local admission marker survives decision spreads but is not serialized into Session events.

## Domain and authority separation

- **GoalContract** — advanced exactly by accepted real `user/message` events
  (`source.kind === 'user'`). Plugin user-role context, model output, and tool
  results never authorize a goal, whatever seqs they cite. Each accepted real
  user message raises `goalRevision` and re-derives `questionId` from its
  source seq. Trusted-UI structured fields have no upstream extension point
  without a new event type, which P0c forbids; the seam is recorded, not
  faked.
- **PlanState** — written only by accepted `decision_update` results whose
  `decision-change` meta cites the current `goalRevision` and
  `expectedPlanRevision`. Model interpretation stays tentative; the
  `decision_update` handler and the projection fold run the same conflict
  checks (`goal-revision-stale`, `plan-revision-conflict`,
  `unknown-evidence-ref`), so an old run can never overwrite a new goal.
- **EvidenceLedger** — folded only from settled spatial tool results:
  `analysis-result`/`catalog-result`/`map-save-receipt` records become
  bounded entries with `succeeded` status; failed results fold as
  `failed-tool` entries with no applicable record. A model cannot mark
  evidence complete by assertion. Each entry keeps the headline values its
  record reported (at most `MAX_EVIDENCE_METRICS`, names and string values
  clipped to `MAX_EVIDENCE_TEXT_CHARS`), the record's claim level when it
  has one, and the goal revision current at settlement, so a later step or
  a rebuilt baseline can cite the result itself. The snapshot renders them
  as `name=value unit` and `claim=<level>`, and labels evidence settled
  under an earlier goal. The ledger records no map revision, because the
  records do not carry one.
- **mapRevision** — the authoritative map expression revision is the
  `mapContainer` projection's revision counter; the snapshot renders it as a
  read-only fact. Style/view changes do not invalidate numeric evidence;
  goal, input, or method changes re-open applicability via the plan.
- **Wider analysis families** — the ledger folds every unified spatial tool's
  real `tool/result.meta` protocol: `spatial-stat`, `spatial-decision`,
  `viz-style`, `accessibility-run`, `spatial-terrain`, and `spatial-scale`
  records decode through bounded consumer-side readers pinned to the exact
  producer schema version/kind; the entry keeps the record's own status and
  refs. A non-terminal accessibility run stays `unknown` with an explicit
  未终态 limitation — never success, and an `indeterminate` line of sight
  or slope folds as `unknown` too. A `terrain_slope` record keeps the mean
  and maximum slope and the missing-cell count. Map mutations stay budget-only (the
  map projection owns them). The folded name list stays pinned to
  `SPATIAL_MCP_TOOL_NAMES` by a parity test; the `analysis-result` reader's
  tool list stays pinned to the map-tools geo roster, and the parity test
  decodes a producer-built record for every listed tool.

The `decisionFrame` state generation is `DECISION_FRAME_STATE_VERSION`
(2). A projection cache row from another generation is discarded and the
frame re-folds from the Session log, in either direction.
- **Map facts** — the snapshot's map block composes from the current
  projection: per-layer visibility (`显示/隐藏`, clipped at 8 with an explicit
  note), the viewport (center/zoom/wkid), and the study AOI (name + bounding
  ring) render as three distinct lines — the viewport is never conflated
  with the AOI, and an unset AOI is stated. Unsettled spatial calls surface
  as a pending count. An undone layer is simply gone: composition reads the
  post-undo authoritative state. When the map container's `mapViewport`
  registry holds a camera the browser settled on, a `用户视窗` line (center,
  zoom, visible extent, wkid, 2D/3D) follows the projection viewport, and a
  `地图环境` line states the mode plus the authoritative base and compatible
  label titles (`Fixture Basemap + Fixture Labels` in the composition fixture;
  an explicit label may be absent). An increment repeats the
  `用户视窗` line only after the user moved the camera.

The commit protocol follows P0a: a mutation tool validates its candidate
before returning; only a successful, paired, first-settled result folds;
version-unknown, unpaired, duplicated, and stale records leave prior state
untouched and record a bounded read-only diagnostic. Unknown
`decision-change` versions are read-only refusals — the related domain write
is blocked, never defaulted.

## Injection algorithm

The pre-step listener, in order:

1. Calls `next()` first. A `reject` decision or an empty first step returns
   unchanged — a spatial snapshot never starts a request by itself.
2. Reads the accepted frame state (host projection) and folds the claimed
   batch's real user messages as **provisional goal candidates** — the
   claimed messages have not entered the log, so the persistent contract is
   not touched; `provisionalFrameOf` exists for composition only.
3. Composes a **baseline** (full bounded frame: goal, plan, map snapshot,
   resource candidates, evidence, selected method cards, tool-availability guidance,
   stop advisory, budget) whenever no baseline for the current goal is
   visible on the model surface — first entry, resume, fork, or after
   compaction/surface replacement hid it. Otherwise composes an
   **increment** listing the facts that settled after the newest visible
   snapshot plus every tracked line whose current text differs from its
   newest visible copy: the layer list, the visual and visual-change
   candidates, the AOI, the user viewport, and the stop advisory. It
   composes nothing when nothing changed. The elapsed counter in the budget
   line never triggers an increment, and the budget advisory names the
   exhausted counter without its live amount, so an exhausted budget is
   delivered once.
4. Deduplicates by content digest: an identical visible snapshot suppresses
   re-injection. Digests are counted from the surface, so process caches and
   compacted summaries never stand in for visibility (audit D05).
5. Admits a snapshot only when the context-byte budget still holds it plus
   the fixed-form budget notice (`composeBudgetNotice`, at most
   `STOP_NOTICE_RESERVE_BYTES`). When it does not fit, the notice is
   injected once instead: it states that later facts no longer arrive and
   that delivery is `partial`. Truncation would cut authority, units, or
   limits, so a snapshot is never shortened (design §5.5). The notice body
   does not depend on the goal, so one visible notice covers later goals;
   nothing is injected when the notice is visible or does not fit either.
6. Re-checks the cancellation signal around every await and splices the
   message right after the claimed batch.

The injection state updates only when the projection folds the snapshot
`user/message` from the accepted log — composition alone never confirms an
injection, and a cancel before admission leaves goal, plan, and injection
state untouched.

Tool availability comes from the current request's tool schemas, not a second name list in the snapshot. Method guidance does not claim a tool is mounted; missing tools remain explicit gaps. The owner-local `tests/expected/context-entry.json` snapshot checks the model-request guidance against the admitted Session message and scoped budget.

## Method cards and stop conditions

The controlled set holds eleven cards: `visualization`, whose guidance calls `viz_recommend` for data-driven selection; the two visual cards `visual-candidates` and `visual-change-candidates`; `locate`（定位）, `topology`（拓扑与几何量算：缓冲、面积、相交、距离、包含）, and `evidence-check`（证据检查）; and the analysis families `network`（路网）, `statistics`（统计）, `spatiotemporal`（时空）, `site-selection`（选址预测）, `terrain`（地形）. Each carries triggers, required data, scale, tool families, preconditions, outputs, misjudgments, stop conditions, applicability, and version (`METHOD_CARD_SET_VERSION`); the snapshot renders the required data, preconditions, outputs, stop conditions, and misjudgments.

Selection is deterministic and bounded to at most `MAX_RENDERED_CARDS` (4) per snapshot. CJK triggers match as substrings; ASCII triggers match whole words, so `contain` never fires inside `container`. The evidence-check card needs settled evidence, except for causal wording (`因果`, `导致`, `归因`, `影响因素`), which selects it before any evidence exists; it ranks first because it guards conclusions. Cards the current question selects rank next, then cards the accepted plan names in `methods` by card id: the plan carries its method across follow-up questions such as "继续", and ranks after the current question because it is the model's candidate. The rest stay discoverable, not injected. `locate` covers counting questions: it requires a study area, deduplication, and a stated POI source coverage before a number is reported. Cards remind the model of conditions,
never assert that an analysis happened, and retrieved external material
cannot override the execution rules they state. The negative guidance is
part of the contract: a buffer never impersonates a road network, an unknown
CRS refuses, a rate without a positive denominator is not a rate, correlation
never impersonates causation, and a view cone is not a viewshed.

`evaluateStops` renders the honest advisory: `blocked` for blocked gaps,
`not_applicable` when required data is missing and no evidence has settled,
`partial` for open gaps with partial evidence, `budget` when a counter is
exhausted. `unknown`/`not_applicable`/`partial`/`blocked` evidence never
renders as success. Every accepted real user message raises the goal
revision, including a follow-up; a plan written for an earlier revision
keeps counting its gaps, and both the plan line and the advisory label it
as written for an earlier goal and name the `goal_revision` a new update
must cite.

A `decision_update` citation missing from the ledger is refused with
`UNKNOWN_EVIDENCE_REF`. When the ledger is full and the citation is older
than its oldest entry, the detail reports it as evicted and names the oldest
retained seq; otherwise it reports the citation as never settled.

## Budget

`BudgetConfig` is validated plugin config (`budget` on either face):
`maxModelSteps`, `maxMetaBytes`, `maxContextBytes`, `maxScanFeatures`,
`maxElapsedMs`, `maxGapRetries`. `maxModelSteps` has no default: steps are
counted and rendered as `steps N/不限` but never limited unless a
composition sets it; the shipped map presets set none. The ledger folds from accepted events —
model steps, serialized spatial meta bytes (including large map-change
copies), admitted snapshot bytes, consumed features — and lives outside the
plan: a `planRevision` update, retry, or resume can never reset it, and
cancellation refunds nothing. `decision_update` runs the preflight before
composing its record and refuses with `BUDGET_EXHAUSTED`; repeated re-opens
of one gap id beyond `maxGapRetries` refuse the same way. Provider cost is
only ever an estimate and is not a limit.

## The `decision_update` tool

Owned by `map-tools` (like every model-facing handler), delegating its
domain checks to this package. Input cites `goal_revision` and
`expected_plan_revision` plus the bounded update; refusals carry stable
codes (`GOAL_REVISION_STALE`, `PLAN_REVISION_CONFLICT`,
`UNKNOWN_EVIDENCE_REF`, `BUDGET_EXHAUSTED`). The four `type:'json'`
arguments (`methods`, `steps`, `gaps`, `evidence_refs`) accept either the
parsed value or a JSON string; a malformed string is `INVALID_ARGUMENT`
naming the parameter, and a decoded value still fails the existing shape
checks. The 68-name fixed spatial tool set
completes the design §15.4 catalog; the unified identity table, the MCP
provider registration, and the model assemble all cross-check against it.

## Tests

`pnpm --filter @map-harness/spatial-context run test` runs six suites:
domain units, budget units, basemap context identity, the real-Session projection fold (including
parity of the consumer-side record readers with the map-tools producer
codecs), snapshot composition units, and the real-loop keyless fixtures that
assert the actual model requests — baseline admission, dedupe, mid-turn
increments, compaction rebuild, reject/empty/cancel containment, fork replay,
and the tool refusal matrix.
