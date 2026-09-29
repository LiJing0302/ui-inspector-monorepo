# @ui-inspector/acceptance-engine

Runtime-neutral UI acceptance engine, extracted from the Electron app's
`src/main/acceptance/` module. Pure TypeScript, zero Node/Electron/VS Code/RN
dependencies — the same constraint as `@ui-inspector/protocol`.

Execution plan: [`docs/AI-ACCEPTANCE-PLAN.md`](../../docs/AI-ACCEPTANCE-PLAN.md).

## What lives here

| Module | Responsibility | Migrated from |
|---|---|---|
| `src/types.ts` | `CanonicalNode`, `NodeMatch`, `AcceptanceIssue`, `AcceptanceResult`, `AcceptanceProfile`, … | `screen-mirror-mac/src/types/aiAcceptance.ts` + `types/verify.ts` (AppNode/DesignNode/Rect) |
| `src/adapters/figma.ts` | `FrameSchema`/`SchemaNode` → `CanonicalDocument` | new (mapping spec in plan §1) |
| `src/adapters/app.ts` | `AppNode` snapshot → `CanonicalDocument` | new |
| `src/match/` | v2 engine: L2 text anchors → L3a ancestor vote → L3b sibling → L3c calibrated position | `acceptance/core.ts` |
| `src/diff/` | rule-based diffing → `AcceptanceIssue[]` | `acceptance/core.ts` |
| `src/visuals.ts` | CIEDE2000 DeltaE / pHash / SSIM | `acceptance/visuals.ts` |
| `src/pixel.ts` | design → app pixel projection | `acceptance/pixelTransform.ts` |
| `src/annotate.ts` | numbered diff annotation images | `acceptance/annotation.ts` |
| `src/ai/` | `AiReviewer` interface + OpenAI-compatible default reviewer | `acceptance/ai.ts` (call layer) |

## Constraints

- No imports from `apps/*`, Electron, Node builtins, or RN.
- All inputs/outputs JSON-serializable (CI / server / CLI friendly).
- `AcceptanceResult` / `NodeMatch` / `AcceptanceIssue` field semantics are the v1
  contract — field changes require a version bump.
- The matching algorithm itself is **frozen** (behavior parity gates in plan §3);
  this package relocates it, it does not redesign it.
