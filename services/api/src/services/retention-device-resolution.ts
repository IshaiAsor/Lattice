// Everything needed to resolve every action on one device, loaded once (F18.20).
//
// The ONE place a device's resolution input is assembled. Three readers depend on it agreeing with
// itself: `effectiveForAction` (and so the chart's tier choice), the device page's Data tab, and a
// setup page's Data tab. Were each to assemble its own input, the screen could show one list while the
// chart asked for another. The worker assembles the same input from its own bulk load
// (`loadTierIndex`) — a different process that cannot share this, which is why the rules themselves
// live in `@lattice/retention`.

import { releasedTemplateFor } from '@lattice/capability-validation';
import {
  describeResolution,
  type DataKind,
  type KindUsage,
  type PlatformTier,
  type TierResolutionInput,
  type TierScope,
} from '@lattice/retention';
import { db } from '../db';
import { kindOfImplementation, loadCatalog, listOf } from './retention-tiers.shared';

/**
 * Load one device's resolution input in a fixed number of queries, whatever its size.
 *
 * Coverage by a sealed template is resolved exactly as materialization resolves it (F18.21), and the
 * device's blueprint is its first binding, as the worker takes it. The caller owns authorisation.
 */
export async function loadDeviceResolution(
  userId: number,
  deviceId: number,
  onlyActionId?: number,
) {
  const [buckets, policies, device] = await Promise.all([
    loadCatalog(),
    db.retentionPolicy.findMany({ include: { tiers: true } }),
    db.userDevice.findUniqueOrThrow({
      where: { id: deviceId },
      select: {
        name: true,
        device: { select: { type: true, version: true, is_sealed: true } },
        blueprint_bindings: {
          select: {
            slot_key: true,
            instance: { select: { blueprint_id: true, blueprint: { select: { name: true } } } },
          },
        },
        user_device_actions: {
          where: onlyActionId === undefined ? undefined : { id: onlyActionId },
          orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            action_name: true,
            mqtt_action_name: true,
            capability: { select: { implementation_type: true } },
          },
        },
      },
    }),
  ]);

  const binding = device.blueprint_bindings[0];
  const templateId = device.device.is_sealed
    ? releasedTemplateFor(
        device.device.type,
        device.device.version,
        await db.sealedTemplateTarget.findMany({
          where: { device_type: device.device.type, template: { status: 'released' } },
          select: { template_id: true, device_type: true, version_min: true, version_max: true },
        }),
      )
    : null;

  const actions = device.user_device_actions;
  const names = actions.map((a) => a.mqtt_action_name);
  const [template, userRows, deviceRows, blueprintRows, sealedRows, actionRows] = await Promise.all(
    [
      templateId !== null
        ? db.sealedTemplate.findUnique({ where: { id: templateId }, select: { name: true } })
        : Promise.resolve(null),
      db.userRetentionTier.findMany({ where: { user_id: userId } }),
      db.deviceRetentionTier.findMany({ where: { user_device_id: deviceId } }),
      binding
        ? db.blueprintRetentionTier.findMany({
            where: {
              blueprint_id: binding.instance.blueprint_id,
              slot_key: binding.slot_key,
              action_name: { in: names },
            },
          })
        : Promise.resolve([]),
      templateId !== null
        ? db.sealedRetentionTier.findMany({
            where: { sealed_template_id: templateId, action_name: { in: names } },
          })
        : Promise.resolve([]),
      db.actionRetentionTier.findMany({
        where: { user_device_action_id: { in: actions.map((a) => a.id) } },
      }),
    ],
  );

  const policyOf = (kind: DataKind) => policies.find((p) => p.data_kind === kind);
  type Action = (typeof actions)[number];

  /** The scopes every action on this device shares: the platform's list and the user's. */
  const baseInput = (kind: DataKind): TierResolutionInput => {
    const policy = policyOf(kind);
    return {
      kind,
      buckets,
      platform:
        policy?.tiers.map((t): PlatformTier => ({
          bucket: t.bucket,
          keepDays: t.keep_days,
          maxKeepDays: t.max_keep_days,
          position: t.position,
        })) ?? [],
      user: listOf(userRows, kind),
      minBucket: policy?.min_bucket ?? null,
    };
  };

  return {
    deviceName: device.name,
    actions,
    deviceRows,
    actionRows,
    policyOf,
    /** Blueprint only reaches a bound device; sealed only a device a released template covers. */
    applies: { blueprint: binding !== undefined, sealed: templateId !== null },

    kindOf(action: Action): DataKind {
      return kindOfImplementation(action.capability.implementation_type);
    },

    /**
     * What a sensor with no device, blueprint, sealed or own list gets — the user's list, else the
     * platform's. The device card's fallback: removing the device list sends every sensor that has
     * nothing more specific here.
     */
    baseInputFor(kind: DataKind): TierResolutionInput {
      return baseInput(kind);
    },

    inputFor(action: Action, kind: DataKind): TierResolutionInput {
      const named = (r: { action_name: string }) => r.action_name === action.mqtt_action_name;
      return {
        ...baseInput(kind),
        device: listOf(deviceRows, kind),
        blueprint: listOf(blueprintRows, kind, named),
        sealed: listOf(sealedRows, kind, named),
        action: listOf(actionRows, kind, (r) => r.user_device_action_id === action.id),
      };
    },

    /**
     * The name of whatever supplied a list, for "Decided by". `user` and `platform` have none — the
     * screen says "Your settings" and "Platform" — and names are read now, so a renamed device or
     * blueprint shows its current name.
     */
    labelFor(scope: TierScope, action: Action): string | null {
      switch (scope) {
        case 'action':
          return action.action_name;
        case 'device':
          return device.name;
        case 'blueprint':
          return binding?.instance.blueprint.name ?? null;
        case 'sealed':
          return template?.name ?? null;
        default:
          return null;
      }
    },
  };
}

export type DeviceResolution = Awaited<ReturnType<typeof loadDeviceResolution>>;
type ResolvedAction = DeviceResolution['actions'][number];

/**
 * One action as every retention screen shows it: its own list, what applies and who decided, what
 * removing its own list would fall back to, where each scope stands, and what it is storing.
 *
 * Shared by the device page and the setup page so a sensor reads the same on both.
 */
export function actionRetentionView(
  r: DeviceResolution,
  a: ResolvedAction,
  stored: { scalar: KindUsage; frame: KindUsage } | undefined,
) {
  const kind = r.kindOf(a);
  const d = describeResolution(r.inputFor(a, kind), r.applies);
  return {
    actionId: a.id,
    name: a.action_name,
    mqttActionName: a.mqtt_action_name,
    dataKind: kind,
    own: listOf(r.actionRows, kind, (row) => row.user_device_action_id === a.id),
    effective: { ...d.effective, sourceLabel: r.labelFor(d.effective.source, a) },
    fallback: { ...d.fallback, sourceLabel: r.labelFor(d.fallback.source, a) },
    scopes: d.scopes,
    stored: kind === 'frame' ? stored?.frame : stored?.scalar,
  };
}
