/**
 * @ui-inspector/acceptance-engine — public API surface (v1, frozen per docs/AI-ACCEPTANCE-PLAN.md §2.3).
 *
 * Stage 0/1 scaffold: modules are declared here so the phase gates
 * (typecheck, adapter round-trip) have a stable import surface to target.
 * Implementations migrate in stages 2–5; each module's header must cite
 * the exact source file it was relocated from.
 */

// Stage 1: types (migrated from screen-mirror-mac/src/types/aiAcceptance.ts
//          + src/types/verify.ts, de-Electronized)
export * from './types.js';

// Stage 1: adapters
export * from './adapters/figma.js';
export * from './adapters/app.js';

// Stage 2: matching engine v2 (from acceptance/core.ts)
export * from './match/index.js';

// Stage 3: rule-based diffing (from acceptance/core.ts + visuals.ts)
export * from './diff/index.js';
export * from './visuals.js';

// Shared geometry
export * from './pixel.js';

// Stage 4: annotation (from acceptance/annotation.ts)
export * from './annotate.js';

// Stage 5: AI review abstraction (from acceptance/ai.ts call layer)
export * from './ai/index.js';
