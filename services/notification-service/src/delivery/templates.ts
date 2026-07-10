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

export function render(eventType: string, data: Record<string, unknown>): Rendered {
  const renderer = RENDERERS[eventType];
  if (renderer) return renderer(data);
  // Unknown event type — deliver something rather than dropping it.
  return { title: eventType.replace(/_/g, ' '), body: JSON.stringify(data) };
}
