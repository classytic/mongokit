/**
 * `@classytic/mongokit/kernel-conformance` — the executable Kernel Construction Standard.
 *
 * A Mongo-backed `@classytic/*` kernel wires this into its OWN test directory and passes it;
 * passing IS conformance. See {@link describeKernelConformance} for the rationale, the check
 * list and a usage example.
 *
 * Test-only, but dependency-free: it imports nothing beyond `mongoose` and mongokit's own
 * `ModelCollisionError`, and the test runner is INJECTED (`runner: { describe, it }`) rather
 * than imported — so mongokit never carries vitest, and the suite runs under any runner.
 *
 * Explicit named re-exports only (no `export *`): the public surface of a contract package
 * must be enumerable at a glance.
 */
export { describeKernelConformance } from './suite.js';
export {
  conformanceEvent,
  createConformanceTransport,
  type InstrumentedTransport,
  instrumentTransport,
} from './transport.js';
export {
  CONDITIONAL_CHECKS,
  type ConformanceCheck,
  type ConformanceCheckOutcome,
  type ConformanceCheckStatus,
  type ConformanceConnect,
  type ConformanceConnectionHandle,
  type ConformanceEvent,
  type ConformanceRunner,
  type ConformanceSkip,
  type EventTransportLike,
  KERNEL_CONFORMANCE_CHECKS,
  type KernelBindContext,
  type KernelBlueprintLike,
  type KernelConformanceOptions,
  type KernelConformanceReport,
} from './types.js';
