// Platform: the enforcement behind docs/TEST-PLAN.md — "the list derives the implementation".
//
// This suite parses TEST-PLAN.md and the Jest test sources and fails when they drift:
//   - a file the plan marks ✅ doesn't exist,
//   - a planned case (top-level bullet under a ✅ file) has no matching test title,
//   - a test exists whose title is not in the plan.
//
// Plan grammar it relies on (see the header of TEST-PLAN.md):
//   ### <Domain> — `<file>` ✅|⬜|⏸        starts a file section
//   - <exact test title>                   enforced case
//   - ⬜ <description>                     planned case, not enforced yet
//     - <indented line>                    commentary, ignored
// Sections end at the next heading or horizontal rule.

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..', '..');
const PLAN_PATH = path.join(ROOT, 'docs', 'TEST-PLAN.md');
const TESTS_DIR = path.join(ROOT, 'tests');

interface PlanFile {
  file: string;
  status: '✅' | '⬜' | '⏸';
  cases: string[];
}

function parsePlan(markdown: string): PlanFile[] {
  const files: PlanFile[] = [];
  let current: PlanFile | null = null;

  for (const raw of markdown.split(/\r?\n/)) {
    const heading = raw.match(/^#{2,3}\s+.*`([^`]+)`\s*(✅|⬜|⏸)/);
    if (heading) {
      current = { file: heading[1], status: heading[2] as PlanFile['status'], cases: [] };
      files.push(current);
      continue;
    }
    if (/^#{1,3}\s/.test(raw) || /^---/.test(raw)) {
      current = null; // heading without a file, or a rule — closes the section
      continue;
    }
    if (!current) continue;
    const bullet = raw.match(/^- (.+)$/); // top-level bullets only; indented lines ignored
    if (!bullet) continue;
    const text = bullet[1].trim();
    if (text.startsWith('⬜') || text.startsWith('⏸')) continue; // planned within a ✅ file
    current.cases.push(text);
  }
  return files;
}

function findTestFile(basename: string): string | null {
  const stack = [TESTS_DIR];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === basename) return full;
    }
  }
  return null;
}

// Extract test titles from source: direct it/test/itStack/itDisruptive/itBroker calls, plus
// the title argument of it.each(...)(...) / test.each(...)(...) template calls.
function extractTitles(source: string): string[] {
  const titles = new Set<string>();
  const direct = /\b(?:it|test|itStack|itDisruptive|itBroker)\s*\(\s*(['"`])((?:(?!\1).)*)\1/g;
  for (const m of source.matchAll(direct)) titles.add(m[2]);
  const each = /\b(?:it|test)\.each\s*\(([\s\S]*?)\)\s*\(\s*(['"`])((?:(?!\2).)*)\2/g;
  for (const m of source.matchAll(each)) titles.add(m[3]);
  return [...titles];
}

const plan = parsePlan(fs.readFileSync(PLAN_PATH, 'utf8'));
const implemented = plan.filter((p) => p.status === '✅');

describe('test-plan sync (docs/TEST-PLAN.md is the source of truth)', () => {
  it('every ✅ plan file exists on disk', () => {
    const missing = implemented.filter((p) => findTestFile(p.file) === null).map((p) => p.file);
    expect(missing).toEqual([]);
  });

  it('every test file on disk is listed in the plan as implemented', () => {
    const listed = new Set(implemented.map((p) => p.file));
    const onDisk: string[] = [];
    const stack = [TESTS_DIR];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (/\.test\.(ts|js)$/.test(entry.name)) onDisk.push(entry.name);
      }
    }
    const unlisted = onDisk.filter((f) => !listed.has(f));
    expect(unlisted).toEqual([]); // add the file (and its cases) to docs/TEST-PLAN.md first
  });

  it('every implemented plan case exists as a test in its file', () => {
    const failures: string[] = [];
    for (const p of implemented) {
      const filePath = findTestFile(p.file);
      if (!filePath) continue; // reported by the existence check
      const titles = new Set(extractTitles(fs.readFileSync(filePath, 'utf8')));
      for (const c of p.cases) {
        if (!titles.has(c)) failures.push(`${p.file}: planned case not implemented → "${c}"`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('no test exists that is not in the plan', () => {
    const failures: string[] = [];
    for (const p of implemented) {
      const filePath = findTestFile(p.file);
      if (!filePath) continue;
      const planned = new Set(p.cases);
      for (const title of extractTitles(fs.readFileSync(filePath, 'utf8'))) {
        if (!planned.has(title)) {
          failures.push(
            `${p.file}: test not in TEST-PLAN.md → "${title}" (add it to the plan first)`,
          );
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
