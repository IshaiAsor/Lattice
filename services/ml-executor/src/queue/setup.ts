import type { Channel } from 'amqplib';
import { assertMlQueue, type PipelineStagePayload } from '@lattice/queue';
import { loadRegistry, type ModelConfig } from '../models';
import { OnnxVlmProvider } from '../handlers/onnx-provider.service';
import { OllamaProviderService } from '../handlers/ollama-provider.service';
import { parseLlmOutput } from '../handlers/parse-llm-output';
import { advancePipeline } from './advance-pipeline';
import type { Logger } from 'pino';

function makeConsumer(model: ModelConfig, ch: Channel, log: Logger) {
  const vlmProvider = model.kind === 'vlm' ? new OnnxVlmProvider(model) : null;
  const llmProvider = model.kind === 'llm' && model.ollamaModel
    ? new OllamaProviderService(model.ollamaModel)
    : null;

  return async (payload: PipelineStagePayload): Promise<void> => {
    const label = `${model.kind}/${model.name}/${model.version}`;
    log.info({ pipelineRunId: payload.pipelineRunId, stageId: payload.stageId }, `[${label}] stage received`);

    try {
      let output: Record<string, unknown>;
      let stageError: string | undefined;

      if (vlmProvider) {
        const image = payload.context['image'] as string;
        if (!image) throw new Error('context.image missing for vlm stage');
        const start = Date.now();
        const detections = await vlmProvider.detect([{ role: 'user', content: '', image }]);
        output = { detections, durationMs: Date.now() - start };
      } else if (llmProvider) {
        const prompt = payload.context['prompt'] as string;
        if (!prompt) throw new Error('context.prompt missing for llm stage');
        // TODO: current cluster hardware can't run qwen2.5vl multimodal inference (with the raw
        // frame attached) in reasonable time — text-only prompt (which already carries the VLM
        // stage's detections as JSON, see prompt.ts) for now. Re-attach payload.context['image']
        // here once running on hardware that can handle vision inference at acceptable latency.
        const messages = [{ role: 'user' as const, content: prompt }];
        const result = await llmProvider.generate(messages, { json: true });
        const parsed = parseLlmOutput(result.text ?? '', result.durationMs);
        output = parsed.output;
        stageError = parsed.error;
        if (stageError) {
          log.warn(
            { pipelineRunId: payload.pipelineRunId, stageId: payload.stageId, error: stageError },
            `[${label}] LLM output failed JSON validation`,
          );
        }
      } else {
        throw new Error(`no provider for model ${label}`);
      }

      await advancePipeline(ch, payload, output, stageError);
      log.info({ pipelineRunId: payload.pipelineRunId }, `[${label}] stage ${stageError ? 'failed' : 'completed'}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ pipelineRunId: payload.pipelineRunId, err: message }, `[${label}] stage failed`);
      await advancePipeline(ch, payload, null, message);
    }
  };
}

export async function setupModelQueues(ch: Channel, log: Logger): Promise<void> {
  const registry = loadRegistry();
  for (const model of registry.values()) {
    const prefetch = model.kind === 'llm' ? 1 : 4;
    const queue = await assertMlQueue(ch, model.kind, model.name, model.version, prefetch);
    const consumer = makeConsumer(model, ch, log);

    await ch.consume(queue, async (msg) => {
      if (!msg) return;
      try {
        const payload = JSON.parse(msg.content.toString()) as PipelineStagePayload;
        await consumer(payload);
        ch.ack(msg);
      } catch {
        ch.nack(msg, false, false);
      }
    });

    log.info({ queue, model: `${model.kind}/${model.name}/${model.version}` }, 'model queue ready');
  }
}
