import envConfig from '../config/env.config';
import { redisService } from './redis.service';
import { vlmRepository, type DeviceVlmConfigFull } from '../dal/vlm.repository';
import { vlmLogRepository } from '../dal/vlm.log.repository';
import { sensorHistoryRepository } from '../dal/sensor.history.repository';
import { userDevicesActionsRepository } from '../dal/user.devices.actions.repository';
import { rulesEngineService } from './rules.engine.service';
import crypto from 'crypto';

export interface VlmDetection {
  className: string;
  count: number;
  confidence: number;
}

export interface VlmResult {
  modelName: string;
  timestamp: Date;
  detections: VlmDetection[];
  decision?: string;
  sensor_snapshot?: Record<string, string>;
}

interface LlmConfig {
  enabled: boolean;
  type?: string;
  endpoint_url?: string;
  model?: string;
  prompt?: string;
  history_hours?: number;
}

interface VlmModelConfig {
  headers?: Record<string, string>;
  debug?: boolean;
  llm?: LlmConfig;
}

const CAMERA_IMPL_TYPES = new Set([
  'LiveStreamAction', 'TakePictureAction',
  'LiveStreamHttpAction', 'TakePictureHttpAction',
]);

const REDIS_KEY = (actionId: number) => `vlm:action:${actionId}`;

class VlmService {
  async runAnalysis(cfg: DeviceVlmConfigFull): Promise<void> {
    const userId = cfg.user_device_action.user_device.user_id;
    const actionId = cfg.user_device_action_id;

    const action = await userDevicesActionsRepository.getById(actionId);
    if (!action) return;

    if (!action.current_state) {
      // TODO(F8/F11): surface vlm_error to the UI via the new stack.
      return;
    }

    const frameAge = action.updated_at
      ? (Date.now() - new Date(action.updated_at).getTime()) / 1000
      : Infinity;

    if (frameAge > cfg.analysis_interval_sec * 1.5) {
      // TODO(F8/F11): surface vlm_error (stale frame) to the UI via the new stack.
      return;
    }

    const modelCfg = (cfg.vlm_model.config ?? {}) as VlmModelConfig;

    // Stage 1: vision inference
    const detections = await this.callVlmServer(cfg.vlm_model.endpoint_url, cfg.vlm_model.type, action.current_state, modelCfg.headers);

    let decision: string | undefined;
    let sensorSnapshot: Record<string, string> | undefined;

    // Stage 2: LLM decision (optional, future)
    if (modelCfg.llm?.enabled) {
      const llmResult = await this.runLlmDecision(detections, userId, modelCfg.llm);
      decision = llmResult.decision;
      sensorSnapshot = llmResult.sensorSnapshot;
    }

    const result: VlmResult = {
      modelName: cfg.vlm_model.name,
      timestamp: new Date(),
      detections,
      decision,
      sensor_snapshot: sensorSnapshot,
    };

    const ttl = cfg.analysis_interval_sec * 2;
    await redisService.setTempData(REDIS_KEY(actionId), result, ttl);

    if (modelCfg.debug) {
      const imageHash = crypto.createHash('sha256')
        .update(action.current_state)
        .digest('hex')
        .slice(0, 16);
      vlmLogRepository.insert({
        device_vlm_config_id: cfg.id,
        input_image_hash: imageHash,
        input_detections: detections,
        input_sensors: sensorSnapshot,
        decision,
      }).catch(err => console.error('[VLM] Log insert error:', err));
    }

    await vlmRepository.updateLastAnalyzed(cfg.id);
    rulesEngineService.evaluateForUser(userId);
  }

  private async callVlmServer(
    endpointUrl: string,
    type: string,
    base64Image: string,
    headers?: Record<string, string>,
  ): Promise<VlmDetection[]> {
    const url = `${endpointUrl.replace(/\/$/, '')}/api/v2/analyze`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, config: { headers }, image: base64Image }),
    });

    if (!res.ok) {
      throw new Error(`vlm-server returned ${res.status}: ${await res.text()}`);
    }

    const body = await res.json() as { detections?: VlmDetection[] };
    return body.detections ?? [];
  }

  private async runLlmDecision(
    detections: VlmDetection[],
    userId: number,
    llmConfig: LlmConfig,
  ): Promise<{ decision: string; sensorSnapshot: Record<string, string> }> {
    const actions = await userDevicesActionsRepository.getAllByUserId(userId);
    const sensorSnapshot: Record<string, string> = {};

    for (const a of actions) {
      if (!CAMERA_IMPL_TYPES.has(a.action.implementation_type) && a.current_state) {
        sensorSnapshot[a.action_name] = a.current_state;
      }
    }

    const historyHours = llmConfig.history_hours ?? 6;
    const history = await sensorHistoryRepository.getRecentForUser(userId, historyHours);

    const context = {
      vision_detections: detections,
      current_sensors: sensorSnapshot,
      sensor_history: history.map((h: any) => ({
        action_name: h.user_device_action?.action_name ?? '',
        value: h.value,
        recorded_at: h.recorded_at,
      })),
    };

    const endpointUrl = llmConfig.endpoint_url ?? envConfig.ollama.baseUrl;
    const model = llmConfig.model ?? 'qwen2.5:3b';
    const systemPrompt = llmConfig.prompt ?? 'Analyze the sensor data and vision detections. Return a concise decision string.';

    // OpenAI-compatible call (works with Ollama and future cloud LLMs)
    const llmRes = await fetch(`${endpointUrl.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: JSON.stringify(context) },
        ],
      }),
    });

    if (!llmRes.ok) {
      throw new Error(`LLM returned ${llmRes.status}: ${await llmRes.text()}`);
    }

    const llmBody = await llmRes.json() as { choices?: Array<{ message?: { content?: string } }> };
    const decision = llmBody.choices?.[0]?.message?.content?.trim() ?? '';

    return { decision, sensorSnapshot };
  }

  async getCachedResult(actionId: number): Promise<VlmResult | null> {
    return redisService.getTempData<VlmResult>(REDIS_KEY(actionId));
  }
}

export const vlmService = new VlmService();
