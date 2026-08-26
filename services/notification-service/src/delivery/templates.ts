// Payload-driven templating: a producer sends `eventType` + `data`; we render a channel-agnostic
// title + body here. (Email HTML bodies can specialise later; for now text/body is shared.)
// Kept pure + Arduino-free so it's unit-testable without a stack.

export interface Rendered {
  title: string;
  body: string;
}

type Renderer = (data: Record<string, unknown>) => Rendered;

function str(data: Record<string, unknown>, key: string, fallback = ''): string {
  const v = data[key];
  return typeof v === 'string' ? v : v == null ? fallback : String(v);
}

const RENDERERS: Record<string, Renderer> = {
  ota_available: (d) => ({
    title: 'Firmware update available',
    body: `A new firmware version ${str(d, 'version')} is available for your ${str(d, 'deviceType')} device.`,
  }),
  emergency: (d) => ({
    title: str(d, 'title', 'Emergency alert'),
    body: str(d, 'message', 'An emergency rule was triggered.'),
  }),
  rule_fired: (d) => ({
    title: 'Automation triggered',
    body: `Rule "${str(d, 'ruleName', 'automation')}" fired.`,
  }),
  blueprint_updated: (d) => ({
    title: 'Your setup was updated',
    body: `"${str(d, 'instanceName', 'Your setup')}" was updated to version ${str(d, 'version', 'a new version')}: ${str(d, 'applied', '0')} change(s) applied${Number(d['skipped']) > 0 ? `, ${str(d, 'skipped')} left alone because you had edited them` : ''}.`,
  }),
  blueprint_phase_advanced: (d) => ({
    title: 'Setup moved to a new phase',
    body: `"${str(d, 'instanceName', 'Your setup')}" moved from ${str(d, 'fromPhase', 'its previous phase')} to ${str(d, 'toPhase', 'the next phase')}. Its automations now use the new phase's targets.`,
  }),
  retention_trimmed: (d) => ({
    title: 'Your history settings were adjusted',
    body: `An administrator lowered the maximum ${str(d, 'dataKindLabel', 'history')} retention to ${str(d, 'ceiling')} days. Your ${str(d, 'bucketLabel', 'setting')} was ${str(d, 'previous')} and has been reduced to fit. Anything past the new limit is removed on the next cleanup.`,
  }),
  device_offline: (d) => ({
    title: 'Device offline',
    body: `${str(d, 'deviceName', 'A device')} went offline.`,
  }),
  email_verification: (d) => ({
    title: 'Verify your email address',
    body: `Hi ${str(d, 'username', 'there')}, please confirm your email address: ${str(d, 'verifyUrl')}`,
  }),
  password_reset: (d) => ({
    title: 'Reset your password',
    body: `Hi ${str(d, 'username', 'there')}, reset your password using this link: ${str(d, 'resetUrl')}. If you didn't request this, ignore this message.`,
  }),
};

/** Where the event happened (F10.7). Optional — most producers have no area to report. */
export interface NotificationContext {
  area_id: number;
  area_name: string;
}

export function render(
  eventType: string,
  data: Record<string, unknown>,
  context?: NotificationContext,
): Rendered {
  const renderer = RENDERERS[eventType];
  const rendered = renderer
    ? renderer(data)
    : // Unknown event type — deliver something rather than dropping it.
      { title: eventType.replace(/_/g, ' '), body: JSON.stringify(data) };

  // Prefixed once here rather than inside each renderer: the area is cross-cutting, and a user
  // with several areas needs to tell three otherwise-identical alerts apart from the title alone
  // (notification surfaces truncate the body, and push shows the title first).
  if (context?.area_name) {
    return { ...rendered, title: `${context.area_name} · ${rendered.title}` };
  }
  return rendered;
}
