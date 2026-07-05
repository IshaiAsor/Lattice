import { createLogger } from '@lattice/logger';
import type { Run } from './types';
import type { PipelineStagePlan } from './registry';

const log = createLogger('ml-router:pipeline:prompt');

function buildPrompt(
  currentState: unknown,
  historic: unknown,
  actions: unknown,
  detections: unknown,
  userContext: string,
): string {
  return `You are an IoT automation controller. Analyze the state and readings below and decide which device action(s) to execute.
${userContext ? `Context: ${userContext}\n` : ''}
Rules:
- You may recommend zero, one, or multiple actions — only include an action if it's actually warranted by the state/readings below.
- Each "user_device_action_id" value MUST be picked verbatim from the available_actions list — never invent your own number.
- The "value" you choose MUST satisfy that action's "valid_parameters" (when present): for type "enum" pick one of "values" verbatim; for type "range" pick an integer between "min" and "max" (or one of "aliases" if given, e.g. "on"/"off"). If "valid_parameters" is absent, infer a sensible value from the trait name instead.
- Respond with raw JSON only. No markdown, no code fences, no extra text.

Current state (right now):
${JSON.stringify(currentState, null, 2)}

Historic data (trend over the configured window):
${JSON.stringify(historic, null, 2)}
${detections !== undefined ? `\nVision detections (from a camera frame — use alongside the state/readings above):\n${JSON.stringify(detections, null, 2)}\n` : ''}
Available actions (choose one or more user_device_action_id values from this list):
${JSON.stringify(actions, null, 2)}

Response format (raw JSON, no fences):
{ "actions": [ { "user_device_action_id": <number from the list above>, "value": "<string>", "reasoning": "<one sentence>" } ] }`;
}

export async function prepareLlmPrompt(
  run: Run,
  stage: Extract<PipelineStagePlan, { type: 'infer' }>,
): Promise<void> {
  log.info({ runId: run.runId, stageId: stage.dbId }, 'preparing LLM prompt');

  // current_state, sensors (historic) + available_actions (already enriched with traits/valid_parameters)
  // come from the enrich stage that must run earlier in the plan; detections come from an earlier
  // vlm infer stage, if the pipeline has one.
  const currentState = run.context['current_state'] || {};
  const historic = run.context['sensors'] || {};
  const actions = run.context['available_actions'] || [];
  const detections = run.context['detections'];

  const userContext = stage.config?.prompt_template ?? '';

  const finalPrompt = buildPrompt(currentState, historic, actions, detections, userContext);
  run.context['prompt'] = finalPrompt;
  log.info({ runId: run.runId, stageId: stage.dbId, prompt: run.context['prompt'] }, 'LLM prompt prepared');
}
