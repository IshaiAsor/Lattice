export {
  RESERVED_PHASE_KEYS,
  isParamRef,
  parseParamRef,
  findParamRefs,
  resolveParam,
  resolveParamWithSource,
  resolveText,
  validateParamRefs,
  validateParamKey,
} from './resolve';
export type {
  ParamRef,
  ParamRefKind,
  ParamContext,
  ParamSource,
  PhaseMeta,
  ResolvedText,
  ResolvedWithSource,
} from './resolve';
export { buildParamContext, EMPTY_PARAM_CONTEXT, ALL_PHASES } from './context';
export type { ParamContextSource } from './context';
export {
  isPhaseInScope,
  isInstanceRunning,
  isAutomationLive,
  effectiveLifecycle,
} from './phase-scope';
export type { InstanceLifecycle } from './phase-scope';
export {
  MAX_ACCRUED_SECONDS,
  accruedOnEnter,
  isPhaseDue,
  phaseDurationSeconds,
  resolvePhaseDuration,
  phaseElapsedSeconds,
  secondsBetween,
} from './phase-timer';
export type { PhaseAdvanceInput, PhaseDurationUnit, PhaseTimerMode } from './phase-timer';
export { resolveSeconds, resolveClock, positionalText, positionalError } from './positional';
export { evaluateThreshold, isErrorReading, isTriggerInCooldown } from './threshold';
export type { ErrorReading } from './threshold';
export {
  describeSchedule,
  firedThisMinute,
  isValidTimeZone,
  matchesSchedule,
  minutesOfDay,
  validateSchedule,
  zonedClock,
} from './schedule';
export type { ScheduleSpec } from './schedule';
