// Event-contract lock (docs/TESTING.md): every RK payload schema must accept its canonical
// example and reject a representative mutation. Changing a payload in packages/queue/src/types.ts
// without updating schemas.ts + this file is a broken change — that's the point.

import type { Channel } from 'amqplib';
import { RK } from '../../packages/queue/src/keys';
import { EVENT_SCHEMAS } from '../../packages/queue/src/schemas';
import { publish } from '../../packages/queue/src';

interface ContractCase {
  rk: string;
  canonical: Record<string, unknown>;
  // A mutation that must FAIL validation (wrong type or missing required field).
  broken: Record<string, unknown>;
}

const CASES: ContractCase[] = [
  {
    rk: RK.TELEMETRY_ARRIVED,
    canonical: {
      userId: '1',
      deviceId: '42',
      actionName: 'temperature',
      value: 23.5,
      timestamp: new Date().toISOString(),
    },
    broken: { userId: 1, deviceId: '42', actionName: 'temperature', value: 23.5, timestamp: 'now' }, // userId must be string
  },
  {
    rk: RK.RULES_EVALUATE,
    canonical: {
      userId: '1',
      deviceId: '42',
      actionName: 'temperature',
      value: '23.5',
      timestamp: new Date().toISOString(),
    },
    broken: { userId: '1', deviceId: '42', value: '23.5', timestamp: 'now' }, // actionName missing
  },
  {
    rk: RK.PIPELINE_TRIGGER,
    canonical: {
      userId: '1',
      pipelineId: '7',
      runId: 99,
      value: '42',
      timestamp: new Date().toISOString(),
    },
    broken: { userId: '1', pipelineId: '7', runId: '99' }, // runId must be number
  },
  {
    rk: RK.PIPELINE_CANCEL,
    canonical: { userId: '1', pipelineId: '7', runId: 99 },
    broken: { userId: '1', pipelineId: 7, runId: 99 }, // pipelineId must be string
  },
  {
    rk: RK.PIPELINE_RESULT,
    canonical: { userId: '1', pipelineId: '7', pipelineRunId: '99', status: 'completed' },
    broken: { userId: '1', pipelineId: '7', pipelineRunId: '99', status: 'done' }, // not in enum
  },
  {
    rk: RK.DEVICE_STATE_CHANGED,
    canonical: {
      userId: '1',
      deviceId: '42',
      actionName: 'outlet',
      state: 'on',
      timestamp: new Date().toISOString(),
      version: 'v2.0.1',
    },
    broken: { userId: '1', deviceId: '42', actionName: 'outlet', state: 'on' }, // timestamp missing
  },
  {
    rk: RK.DEVICE_HEARTBEAT,
    canonical: {
      userId: '1',
      deviceId: '42',
      version: 'v2.0.1',
      timestamp: new Date().toISOString(),
      uptimeMs: 123456,
      freeHeap: 200000,
      rssi: -55,
    },
    broken: { userId: '1', deviceId: '42', version: 'v2.0.1', timestamp: 'now', rssi: '-55' }, // rssi must be number
  },
  {
    rk: RK.ACTION_REQUESTED,
    canonical: { userId: '1', actionId: 5, value: 'on', duration: '30' },
    broken: { userId: '1', actionId: '5', value: 'on' }, // actionId must be number
  },
  {
    rk: RK.ACTION_DISPATCH,
    canonical: {
      userId: '1',
      deviceId: '42',
      actionName: 'outlet',
      command: { value: 'on', duration: '*' },
      commandId: 'c-1',
      firmwareVersion: 'v2.0.1',
    },
    broken: { userId: '1', deviceId: '42', command: { value: 'on' } }, // actionName missing
  },
  {
    rk: RK.ACTION_RESULT,
    canonical: {
      userId: '1',
      deviceId: '42',
      actionName: 'outlet',
      status: 'ok',
      value: 'on',
      timestamp: new Date().toISOString(),
    },
    broken: {
      userId: '1',
      deviceId: '42',
      actionName: 'outlet',
      status: 'success',
      timestamp: 'now',
    }, // not in enum
  },
  {
    rk: RK.PICTURE_REQUESTED,
    canonical: {
      userId: '1',
      actionId: 5,
      commandId: 'c-1',
      timeoutMs: 8000,
      // Who asked (recorded on the capture's history row) and whether the frame should come back
      // on the bus — a manual capture's does not, it reaches the browser over the socket.
      source: { kind: 'manual' },
      deliverResult: false,
    },
    broken: { userId: '1', actionId: 5, commandId: 'c-1', timeoutMs: '8000' }, // timeoutMs must be number
  },
  {
    rk: RK.PICTURE_RESULT,
    canonical: {
      commandId: 'c-1',
      status: 'ok',
      image: 'aGVsbG8=',
      capturedAt: new Date().toISOString(),
    },
    broken: { status: 'ok', image: 'aGVsbG8=' }, // commandId missing
  },
  {
    rk: RK.PIPELINE_STAGE_SENSOR_DIGEST,
    canonical: {
      userId: '1',
      deviceId: '42',
      pipelineId: '7',
      pipelineRunId: '99',
      stageId: 's1',
      stageName: 'enrich',
      stageKind: 'sensor_digest',
      context: {},
    },
    broken: {
      userId: '1',
      deviceId: '42',
      pipelineId: '7',
      pipelineRunId: '99',
      stageId: 's1',
      stageName: 'enrich',
      stageKind: 'sensor_digest',
      context: 'none',
    }, // context must be object
  },
  {
    rk: RK.PIPELINE_STAGE_COMMAND_EXEC,
    canonical: {
      userId: '1',
      deviceId: '42',
      pipelineId: '7',
      pipelineRunId: '99',
      stageId: 's2',
      stageName: 'exec',
      stageKind: 'command_exec',
      context: { plan: 'x' },
    },
    broken: {
      userId: '1',
      pipelineId: '7',
      pipelineRunId: '99',
      stageId: 's2',
      stageName: 'exec',
      stageKind: 'command_exec',
      context: {},
    }, // deviceId missing
  },
  {
    rk: RK.PIPELINE_STAGE_DONE,
    canonical: {
      pipelineRunId: '99',
      stageId: 's1',
      status: 'completed',
      output: { summary: 'ok' },
    },
    broken: { pipelineRunId: 99, stageId: 's1', status: 'completed' }, // pipelineRunId must be string
  },
  {
    rk: RK.OTA_INCOMING,
    canonical: {
      deviceType: 'ESP32S3_MINI',
      version: 'v2.0.9',
      url: 'http://ota/download/ESP32S3_MINI/v2.0.9.bin',
      timestamp: new Date().toISOString(),
    },
    broken: { deviceType: 'ESP32S3_MINI', version: 'v2.0.9', timestamp: 'now' }, // url missing
  },
  {
    rk: RK.OTA_DISPATCH,
    canonical: {
      deviceType: 'ESP32S3_MINI',
      version: 'v2.0.9',
      url: 'http://ota/download/ESP32S3_MINI/v2.0.9.bin',
      releaseNotes: 'fixes',
      timestamp: new Date().toISOString(),
      userId: 1,
      deviceId: 6,
      firmwareVersion: 'v2.0.8', // the version it is RUNNING, not `version` above
    },
    // Device identity is required since F3.15 — there is no fleet-wide broadcast left to fall
    // back to, so a dispatch that names no device has nowhere to go and must fail at the
    // publisher rather than reach a topic nothing subscribes to.
    broken: {
      deviceType: 'ESP32S3_MINI',
      version: 'v2.0.9',
      url: 'http://x',
      timestamp: new Date().toISOString(),
    },
  },
  {
    rk: RK.SEALED_TEMPLATE_APPLIED,
    canonical: { templateId: 7, timestamp: new Date().toISOString() },
    broken: { templateId: '7', timestamp: 'now' }, // templateId must be a number
  },
  {
    rk: RK.NOTIFICATION_PUBLISH,
    canonical: { type: 'ota_available', deviceType: 'ESP32S3_MINI', version: 'v2.0.9' },
    broken: { type: 'firmware_ready', deviceType: 'ESP32S3_MINI', version: 'v2.0.9' }, // literal mismatch
  },
  {
    rk: RK.NOTIFICATION_SEND,
    canonical: {
      userId: '2',
      eventType: 'ota_available',
      data: { deviceType: 'ESP32S3_MINI', version: 'v2.0.9' },
      channels: ['in_app', 'email'],
    },
    broken: { userId: 2, eventType: 'ota_available', data: {} }, // userId must be a string
  },
  {
    rk: RK.BLUEPRINT_PHASE_ADVANCE,
    canonical: {
      userId: '2',
      instanceId: 5,
      bindingId: null,
      source: 'pipeline',
      refKey: 'ripeness_check',
    },
    // refKey is what lets the consumer re-check that the phase still names this pipeline; a message
    // without it cannot be validated on arrival, so it must not be accepted onto the queue at all.
    broken: { userId: '2', instanceId: 5, bindingId: null, source: 'pipeline' },
  },
];

describe('queue event contracts', () => {
  it('every routing key has a schema', () => {
    for (const rk of Object.values(RK)) {
      expect(EVENT_SCHEMAS[rk]).toBeDefined();
    }
  });

  it('every schema is covered by a contract case', () => {
    const covered = new Set(CASES.map((c) => c.rk));
    for (const rk of Object.values(RK)) {
      expect(covered.has(rk)).toBe(true);
    }
  });

  describe.each(CASES)('$rk', ({ rk, canonical, broken }) => {
    it('accepts the canonical payload', () => {
      const result = EVENT_SCHEMAS[rk].safeParse(canonical);
      if (!result.success) throw new Error(result.error.message);
      expect(result.success).toBe(true);
    });

    it('rejects the broken payload', () => {
      expect(EVENT_SCHEMAS[rk].safeParse(broken).success).toBe(false);
    });
  });

  // publish() enforcement — a stub channel is enough because validation happens before the
  // channel is touched. NODE_ENV is not 'production' under Jest, so validation is active.
  describe('publish() enforcement', () => {
    const stubChannel = { publish: () => true } as unknown as Channel;

    it('throws on an off-contract payload', () => {
      expect(() =>
        publish(stubChannel, RK.ACTION_REQUESTED, { userId: '1', actionId: 'five' }),
      ).toThrow(/event contract violation/);
    });

    it('passes a canonical payload through to the channel', () => {
      const sent: string[] = [];
      const ch = {
        publish: (_ex: string, rk: string) => {
          sent.push(rk);
          return true;
        },
      } as unknown as Channel;
      publish(ch, RK.ACTION_REQUESTED, { userId: '1', actionId: 5, value: 'on' });
      expect(sent).toEqual([RK.ACTION_REQUESTED]);
    });

    it('skips validation for unknown (dynamic ML-stage) routing keys', () => {
      expect(() =>
        publish(stubChannel, 'pipeline.stage.vlm.scene.v1', { anything: true }),
      ).not.toThrow();
    });
  });
});
