// Which deployment a notification was sent from. `NODE_ENV` is baked to "production" in every
// service image, so it cannot tell staging from prod — `LATTICE_ENV` (env.config) does.
// Production notifications go out untouched (users shouldn't see plumbing); every other
// environment is tagged, so a staging alert landing in the same inbox/phone as a prod one is
// unmistakable. Kept pure so it's unit-testable without a stack (tests/unit/platform.notifications).

const PRODUCTION_ALIASES = new Set(['production', 'prod']);

// An unset/blank value is deliberately *not* treated as production — an untagged notification
// must mean "this really is prod", never "someone forgot to set the variable".
export function normalizeEnvironment(environment: string | undefined): string {
  const name = (environment ?? '').trim().toLowerCase();
  return name === '' ? 'unknown' : name;
}

export function isProductionEnvironment(environment: string | undefined): boolean {
  return PRODUCTION_ALIASES.has(normalizeEnvironment(environment));
}

// '[STAGING] Device offline' outside production; the title verbatim in production.
export function tagTitle(title: string, environment: string | undefined): string {
  if (isProductionEnvironment(environment)) return title;
  return `[${normalizeEnvironment(environment).toUpperCase()}] ${title}`;
}

// Footer for long-form (email) bodies, where a subject prefix alone is easy to skim past.
export function tagBody(body: string, environment: string | undefined): string {
  if (isProductionEnvironment(environment)) return body;
  return `${body}\n\n--\nSent from the ${normalizeEnvironment(environment)} environment.`;
}
