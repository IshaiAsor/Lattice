// Telemetry/command values arrive as arbitrary JSON; persist them as a stable string.
export function asString(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}
