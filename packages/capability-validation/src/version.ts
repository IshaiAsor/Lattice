// Firmware version comparison for sealed-device templates. Versions are `vX.Y.Z` (e.g.
// `v2.0.260`); a sealed template targets a `[min, max]` range and a device matches when its
// baked-in version falls inside. Shared so release-time validation (api) and device-time
// resolution (device-gateway) use identical range logic — a mismatch would materialize the
// wrong config.

// Parse `vX.Y.Z` (leading `v` optional) into [major, minor, patch]. Missing/extra segments
// default to 0, so `v2` == `v2.0.0`. Returns null for anything non-numeric.
export function parseVersion(version: string): [number, number, number] | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(version.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

// -1 / 0 / 1 (a<b / a==b / a>b). Unparseable versions sort last but stay deterministic via
// string compare, so bad data never throws mid-resolution.
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return a === b ? 0 : a < b ? -1 : 1;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

// Inclusive membership: min <= version <= max.
export function versionInRange(version: string, min: string, max: string): boolean {
  return compareVersions(version, min) >= 0 && compareVersions(version, max) <= 0;
}

// True when two [min,max] ranges intersect — used to reject overlapping released templates
// for the same device type (a device must resolve to exactly one template).
export function rangesOverlap(aMin: string, aMax: string, bMin: string, bMax: string): boolean {
  return compareVersions(aMin, bMax) <= 0 && compareVersions(bMin, aMax) <= 0;
}
