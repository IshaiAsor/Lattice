import { Router } from 'express';
import { createLogger } from '@lattice/logger';
import type { ModelId, InferResponse } from '@lattice/ml';
import { getModel } from '../models';
import { OnnxVlmProvider } from '../handlers/onnx-provider.service';
import { OllamaProviderService } from '../handlers/ollama-provider.service';

const log = createLogger('ml-executor:http');
export const inferRouter = Router();

inferRouter.post('/api/infer', async (req, res) => {
  const { model, messages } = req.body as { model: ModelId; messages: unknown[] };

  if (!model?.kind || !model?.name || !model?.version || !Array.isArray(messages)) {
    res.status(422).json({ error: 'model (kind/name/version) and messages[] are required' });
    return;
  }

  const cfg = getModel(model.kind, model.name, model.version);
  if (!cfg) {
    res.status(404).json({ error: `Model ${model.kind}/${model.name}/${model.version} not found` });
    return;
  }

  try {
    let result: InferResponse;
    if (cfg.kind === 'vlm') {
      const start = Date.now();
      const detections = await new OnnxVlmProvider(cfg).detect(messages as any);
      result = { detections, durationMs: Date.now() - start };
    } else {
      if (!cfg.ollamaModel) throw new Error(`llm ${cfg.name} has no ollamaModel`);
      result = await new OllamaProviderService(cfg.ollamaModel).generate(messages as any);
    }
    log.info({ model: `${model.kind}/${model.name}/${model.version}`, durationMs: result.durationMs }, 'HTTP infer complete');
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, model }, 'HTTP infer error');
    res.status(500).json({ error: message });
  }
});
