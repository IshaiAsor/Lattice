import type { Channel } from 'amqplib';
import { assertMlQueue, type PipelineStagePayload } from '@lattice/queue';
import { loadRegistry, type ModelConfig } from '../models';
import { OnnxVlmProvider } from '../handlers/onnx-provider.service';
import { OllamaProviderService } from '../handlers/ollama-provider.service';
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
      if (vlmProvider) {
        const image = payload.context['image'] as string;
        if (!image) throw new Error('context.image missing for vlm stage');
        const start = Date.now();
        const detections = await vlmProvider.detect([{ role: 'user', content: '', image }]);
        output = { detections, durationMs: Date.now() - start };
      } else if (llmProvider) {
        const prompt = payload.context['prompt'] as string;
        if (!prompt) throw new Error('context.prompt missing for llm stage');
        const image = payload.context['image'] as string | undefined;
        const messages = [{ role: 'user' as const, content: prompt, ...(image ? { image } : {}) }];
        const result = await llmProvider.generate(messages);
        output = result as unknown as Record<string, unknown>;
      } else {
        throw new Error(`no provider for model ${label}`);
      }
      await advancePipeline(ch, payload, output);
      log.info({ pipelineRunId: payload.pipelineRunId }, `[${label}] stage completed`);
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
