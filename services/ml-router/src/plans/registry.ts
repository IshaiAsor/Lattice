import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { ModelId } from '@lattice/ml';

// A plan is the orchestrator's policy: which model handles a given chatMode, and what
// enrichment runs before inference. Keyed by the client's chatMode (e.g. 'free',
// 'device-context', 'build'). Analogous to the executor's models.json registry.
export interface InferStage { type: 'infer'; model: ModelId; }
export interface EnrichStage { type: 'enrich'; enricher: string; }
export type PlanStage = InferStage | EnrichStage;

export interface Plan {
  chatMode: string;
  stages: PlanStage[];
}

let _plans: Map<string, Plan> | undefined;

export function loadPlans(): Map<string, Plan> {
  if (_plans) return _plans;
  const path = resolve(__dirname, '..', '..', 'plans.json');
  const entries = JSON.parse(readFileSync(path, 'utf8')) as Plan[];
  _plans = new Map(entries.map((p) => [p.chatMode, p]));
  return _plans;
}

export function getPlan(chatMode: string): Plan | undefined {
  return loadPlans().get(chatMode);
}

export function listPlans(): string[] {
  return [...loadPlans().keys()];
}
