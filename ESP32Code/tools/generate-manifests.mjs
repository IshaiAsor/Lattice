#!/usr/bin/env node
// Builds + runs the host manifest generator once per `-prod` firmware env and writes one
// manifest JSON per device-type to tools/manifest-gen/out/.
//
// Device identity (type / version / HAS_CAMERA) is parsed straight out of the firmware
// platformio.ini — the same source the CI firmware matrix parses — so the manifest
// version always tracks the firmware that will actually ship.
//
//   node tools/generate-manifests.mjs            # write out/*.json
//   node tools/generate-manifests.mjs --print    # also print combined array to stdout
//
// Requires `pio` (PlatformIO Core) and a host C++ compiler (g++) accessible on PATH or
// at their known Windows install locations.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const esp32Dir = join(__dirname, '..');            // ESP32Code/
const genDir = join(__dirname, 'manifest-gen');    // ESP32Code/tools/manifest-gen/
const outDir = join(genDir, 'out');
const platformioIni = join(esp32Dir, 'platformio.ini');
const isWin = process.platform === 'win32';
const programPath = join(genDir, '.pio', 'build', 'gen', isWin ? 'program.exe' : 'program');

// Resolve `pio` executable — PlatformIO installs into its own venv, often not on PATH.
function resolvePio() {
  if (!isWin) return 'pio';
  const candidates = [
    join(process.env.USERPROFILE ?? '', '.platformio', 'penv', 'Scripts', 'pio.exe'),
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'platformio', 'pio.exe'),
  ];
  for (const c of candidates) {
    try { readFileSync(c); return c; } catch { /* not found */ }
  }
  return 'pio';
}

// Locate the MinGW g++ bin directory on Windows (WinGet install, not always on PATH).
// Returns the bin dir string to prepend to PATH, or null if g++ is already reachable.
function findMinGWBin() {
  if (!isWin) return null;
  // Already on PATH?
  const check = spawnSync('g++', ['--version'], { encoding: 'utf8', shell: true });
  if (check.status === 0) return null;

  // WinGet installs BrechtSanders.WinLibs.POSIX.UCRT under %LOCALAPPDATA%\Microsoft\WinGet\Packages\
  const pkgBase = join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Packages');
  try {
    for (const entry of readdirSync(pkgBase)) {
      if (!entry.startsWith('BrechtSanders.WinLibs')) continue;
      const bin = join(pkgBase, entry, 'mingw64', 'bin');
      try { readFileSync(join(bin, 'g++.exe')); return bin; } catch { /* wrong dir */ }
    }
  } catch { /* pkgBase doesn't exist */ }
  return null;
}

const pioBin = resolvePio();
const mingwBin = findMinGWBin();
if (mingwBin) console.error(`[manifest-gen] Using g++ from: ${mingwBin}`);

// Build child-process env: inject g++ bin dir into PATH if needed.
function childEnv(extraVars = {}) {
  const env = { ...process.env, ...extraVars };
  if (mingwBin) env.PATH = `${mingwBin};${env.PATH ?? ''}`;
  return env;
}

// Parse platformio.ini → [{ env, deviceType, version, hasCamera }] for `-prod` envs only.
function parseProdEnvs(iniText) {
  const envs = [];
  let cur = null;
  for (const raw of iniText.split(/\r?\n/)) {
    const section = raw.match(/^\[env:([^\]]+)\]/);
    if (section) {
      if (cur) envs.push(cur);
      cur = { env: section[1].trim(), deviceType: null, version: null, hasCamera: false, sealed: false };
      continue;
    }
    if (!cur) continue;
    // platformio.ini escapes quotes: -D DEVICE_TYPE_STR=\"ESP32S3_MINI\"
    const type = raw.match(/DEVICE_TYPE_STR\s*=\s*\\?"?([A-Za-z0-9_]+)/);
    if (type) cur.deviceType = type[1].trim();
    const ver = raw.match(/DEVICE_VERSION_STR\s*=\s*\\?"?([A-Za-z0-9_.\-]+)/);
    if (ver) cur.version = ver[1].trim();
    if (/-D\s*HAS_CAMERA\b/.test(raw)) cur.hasCamera = true;
    // SEALED = factory-soldered: catalog marks the type is_sealed; config comes from an admin
    // template, not the user. A top-level manifest flag (capabilities are emitted the same way).
    if (/-D\s*SEALED\b/.test(raw)) cur.sealed = true;
  }
  if (cur) envs.push(cur);
  return envs.filter((e) => e.env.endsWith('-prod') && e.deviceType && e.version);
}

function generateOne({ deviceType, version, hasCamera }) {
  const flags = [
    `-DGEN_DEVICE_TYPE=${deviceType}`,
    `-DGEN_DEVICE_VERSION=${version}`,
    ...(hasCamera ? ['-DHAS_CAMERA'] : []),
  ].join(' ');

  const build = spawnSync(pioBin, ['run', '-d', genDir, '-e', 'gen'], {
    env: childEnv({ PLATFORMIO_BUILD_FLAGS: flags }),
    stdio: ['ignore', 'inherit', 'inherit'],
    shell: isWin,
  });
  if (build.status !== 0) throw new Error(`pio build failed for ${deviceType} (exit ${build.status})`);

  const run = spawnSync(programPath, [], { encoding: 'utf8', env: childEnv() });
  if (run.status !== 0) throw new Error(`generator run failed for ${deviceType}: ${run.stderr || run.error}`);
  return JSON.parse(run.stdout);
}

function main() {
  const prodEnvs = parseProdEnvs(readFileSync(platformioIni, 'utf8'));
  if (prodEnvs.length === 0) throw new Error('No -prod envs with DEVICE_TYPE_STR/DEVICE_VERSION_STR found in platformio.ini');

  mkdirSync(outDir, { recursive: true });
  const manifests = [];
  const seen = new Set();
  for (const e of prodEnvs) {
    const key = `${e.deviceType}@${e.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    console.error(`[manifest-gen] ${key}${e.hasCamera ? ' (camera)' : ''}${e.sealed ? ' (sealed)' : ''}`);
    const manifest = generateOne(e);
    if (e.sealed) manifest.sealed = true;
    writeFileSync(join(outDir, `${e.deviceType}.json`), JSON.stringify(manifest, null, 2) + '\n');
    manifests.push(manifest);
  }
  console.error(`[manifest-gen] wrote ${manifests.length} manifest(s) to ${outDir}`);
  if (process.argv.includes('--print')) process.stdout.write(JSON.stringify(manifests, null, 2) + '\n');
}

main();
