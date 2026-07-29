import { createLogger } from '@lattice/logger';
import { resolveText } from '@lattice/params';
import type { Run } from './types';
import type { PipelineStagePlan } from './registry';

const log = createLogger('ml-router:pipeline:prompt');

function buildPrompt(
  currentState: unknown,
  historic: unknown,
  actions: unknown,
  detections: unknown,
  userContext: string,
  expectedRanges: unknown,
  hasImage: boolean,
): string {
  return `You are an IoT automation controller. Analyze the state and readings below and decide which device action(s) to execute.
${userContext ? `Context: ${userContext}\n` : ''}${hasImage ? 'A camera frame is attached to this message. Examine it directly — identify and, where relevant, count what you see — and weigh it alongside the state/readings below when deciding.\n' : ''}
Rules:
- You may recommend zero, one, or multiple actions — only include an action if it's actually warranted by the state/readings below.
- Each "user_device_action_id" value MUST be picked verbatim from the available_actions list — never invent your own number.
- The "value" you choose MUST satisfy that action's "valid_parameters" (when present): for type "enum" pick one of "values" verbatim; for type "range" pick an integer between "min" and "max" (or one of "aliases" if given, e.g. "on"/"off"). If "valid_parameters" is absent, infer a sensible value from the trait name instead.
- Respond with raw JSON only. No markdown, no code fences, no extra text.

Current state (right now):
${JSON.stringify(currentState, null, 2)}

Historic data (trend over the configured window):
${JSON.stringify(historic, null, 2)}
${expectedRanges !== undefined ? `\nExpected ranges (what "normal" means right now — a reading outside its band is what warrants action):\n${JSON.stringify(expectedRanges, null, 2)}\n` : ''}${detections !== undefined ? `\nVision detections (from a camera frame — use alongside the state/readings above):\n${JSON.stringify(detections, null, 2)}\n` : ''}
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
  const expectedRanges = run.context['expected_ranges'];
  // The enrich stage captures the camera frame into run.context.image; it rides along in the
  // stage payload and the executor attaches it to the multimodal LLM message. Instruct the model
  // to look at it only when one is actually present.
  const hasImage = typeof run.context['image'] === 'string';

  // A blueprint-derived pipeline's template embeds references mid-sentence ("This loop is in its
  // @phase.name phase. @phase.context_notes"), so the whole text is substituted rather than
  // matched as a single value. Unresolvable references are dropped, never left verbatim — sending
  // the model a literal "@phase.name" is worse than saying nothing. A hand-built pipeline has no
  // references and resolves to itself.
  const { text: userContext, unresolved } = resolveText(
    stage.prompt_template ?? '',
    run.plan.params,
  );
  log.debug(
    {
      runId: run.runId,
      stageId: stage.dbId,
      phase: run.plan.params.phase?.key ?? null,
      template: stage.prompt_template ?? null,
      resolved: userContext,
      expectedRanges,
    },
    'prompt: template resolved against the instance parameter context',
  );
  if (unresolved.length > 0) {
    log.warn(
      { runId: run.runId, stageId: stage.dbId, unresolved },
      'prompt template references parameters that did not resolve — dropped from the prompt',
    );
  }

  const finalPrompt = buildPrompt(
    currentState,
    historic,
    actions,
    detections,
    userContext,
    expectedRanges,
    hasImage,
  );
  run.context['prompt'] = finalPrompt;
  log.info(
    { runId: run.runId, stageId: stage.dbId, prompt: run.context['prompt'] },
    'LLM prompt prepared',
  );
}
