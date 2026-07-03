// Shared read-only view helpers for rendering a pipeline_run_stage row (input/output JSON,
// infer/command_exec summaries). Used by both the simulate dialog and the run history list,
// which render the same stage shape in slightly different layouts.

export interface ActionView {
  actionId: unknown;
  value: unknown;
  reasoning?: unknown;
}

export interface InferView {
  actions?: ActionView[];
  raw?: string;
  durationMs?: number;
}

export function stageJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function inferPrompt(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const prompt = (input as Record<string, unknown>)['prompt'];
  return typeof prompt === 'string' ? prompt : null;
}

function toActionViews(actions: unknown): ActionView[] {
  if (!Array.isArray(actions)) return [];
  return actions.map(a => {
    const obj = (a && typeof a === 'object') ? a as Record<string, unknown> : {};
    return { actionId: obj['user_device_action_id'], value: obj['value'], reasoning: obj['reasoning'] };
  });
}

export function inferView(output: unknown): InferView | null {
  if (!output || typeof output !== 'object') return null;
  const obj = output as Record<string, unknown>;
  if (typeof obj['text'] !== 'string') return null;

  const text = obj['text'];
  const durationMs = typeof obj['durationMs'] === 'number' ? (obj['durationMs'] as number) : undefined;

  // ml-executor parses the LLM's JSON reply and spreads the fields (an "actions" array of
  // { user_device_action_id, value, reasoning }) directly onto the output object — prefer
  // those. Falling back to re-parsing `text` only covers rows written before that change.
  if (Array.isArray(obj['actions'])) {
    return { actions: toActionViews(obj['actions']), durationMs };
  }

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  try {
    const parsed = JSON.parse((fenced ? fenced[1] : text).trim());
    if (Array.isArray(parsed.actions)) {
      return { actions: toActionViews(parsed.actions), durationMs };
    }
    return { raw: text, durationMs };
  } catch {
    return { raw: text, durationMs };
  }
}

export function formatMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

// pipeline_run_stages has no `error` column — the coordinator folds a failed stage's error
// into output._error instead (see services/ml-router coordinator.ts onStageDone), so that's
// the only place a stage-level error actually shows up.
export function stageError(output: unknown): string | null {
  if (!output || typeof output !== 'object') return null;
  const err = (output as Record<string, unknown>)['_error'];
  return typeof err === 'string' ? err : null;
}

export function isDryRunStage(output: unknown): boolean {
  return !!(output && typeof output === 'object' && 'would_execute' in (output as object));
}

export function wouldExecute(output: unknown): ActionView[] | null {
  if (!isDryRunStage(output)) return null;
  const we = (output as { would_execute: unknown }).would_execute;
  return toActionViews(we);
}
