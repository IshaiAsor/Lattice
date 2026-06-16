export interface ParsedTopic {
  namespace: string;
  userId: string;
  deviceId: string;
  version: string;
  channel: string;
  actionName?: string;
}

export function parseTopic(topic: string): ParsedTopic | null {
  const parts = topic.split('/');

  // Minimum: namespace/userId/devices/deviceId/version/channel (6 parts)
  if (parts.length < 6) return null;

  const [namespace, userId, , deviceId, version, channel, ...rest] = parts;

  if (!namespace || !userId || !deviceId || !version || !channel) return null;

  return {
    namespace,
    userId,
    deviceId,
    version,
    channel,
    actionName: rest.length > 0 ? rest.join('/') : undefined,
  };
}
