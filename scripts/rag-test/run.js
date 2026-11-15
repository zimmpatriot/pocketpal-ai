#!/usr/bin/env node
/**
 * S.A.M. retrieval test harness. Runs on the PC: no model, no phone.
 *
 * It loads the app's real src/services/RAGService.ts (gate + BM25 + context
 * formatting) and the bundled manuals JSON, runs every case in a cases file
 * through ragService.retrieve(), and reports what would be injected into the
 * prompt.
 *
 *   node scripts/rag-test/run.js                 run and save a results file
 *   node scripts/rag-test/run.js --compare       also diff against the previous run
 *   node scripts/rag-test/run.js --cases <file>  use another cases file
 *   node scripts/rag-test/run.js --no-save       do not write a results file
 *
 * Case fields (see cases.json):
 *   id               unique name
 *   group            core | vague | followup | trap (any label works)
 *   message          the user's message
 *   previous         optional: the previous user message (follow-ups)
 *   should_fire      true if manual text should be injected
 *   expected_manual  optional: text that must appear in the source name of at
 *                    least one injected chunk; a list means "any of these"
 *   must_contain     optional: phrases that must all appear in the injected
 *                    text (case-insensitive)
 *   expected_card    optional: quick-card id (checked once cards exist)
 *
 * Expectations never name chunk ids, so they survive re-chunking.
 */
const fs = require('fs');
const path = require('path');
const {execSync} = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const RESULTS_DIR = path.join(__dirname, 'results');

// ---------------------------------------------------------------- arguments
const args = process.argv.slice(2);
const flag = name => args.includes(name);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const casesFile = path.resolve(
  option('--cases', path.join(__dirname, 'cases.json')),
);

// ------------------------------------------------- load the app's real code
// Compile .ts on the fly with the project's own TypeScript so the harness
// runs the same source file the app bundles.
const ts = require(path.join(ROOT, 'node_modules', 'typescript'));
require.extensions['.ts'] = (module, filename) => {
  const out = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2019,
      esModuleInterop: true,
    },
    fileName: filename,
  });
  module._compile(out.outputText, filename);
};
const realLog = console.log;
console.log = () => {}; // RAGService logs its chunk count on load
const {ragService} = require(path.join(ROOT, 'src', 'services', 'RAGService.ts'));

// ------------------------------------------------------------------ helpers
/** A chunk the model should never be shown: contents page or OCR garbage. */
function isJunk(text) {
  if ((text.match(/\.{5,}/g) || []).length > 2) {
    return true;
  }
  const words = text.match(/[A-Za-z]{4,}/g) || [];
  if (words.length < 30) {
    return true;
  }
  const odd = words.filter(
    w =>
      /[a-z][A-Z]/.test(w) ||
      /[A-Z]{2}[a-z]{2}[A-Z]/.test(w) ||
      !/[aeiouy]/i.test(w),
  ).length;
  return odd / words.length > 0.15;
}

const asList = v => (v === undefined || v === null ? [] : [].concat(v));
const pct = (n, d) => (d === 0 ? '  n/a' : `${((100 * n) / d).toFixed(0)}%`.padStart(5));
const preview = text => text.replace(/\s+/g, ' ').trim().slice(0, 80);

function gitInfo() {
  try {
    const run = cmd => execSync(cmd, {cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore']}).toString().trim();
    return {
      commit: run('git rev-parse --short HEAD'),
      dirty: run('git status --porcelain -- src/services src/assets/rag') !== '',
    };
  } catch (e) {
    return {commit: 'unknown', dirty: false};
  }
}

function loadCases(file) {
  const cases = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(cases)) {
    throw new Error(`${file}: expected a JSON array of cases`);
  }
  const seen = new Set();
  cases.forEach((c, i) => {
    for (const key of ['id', 'group', 'message']) {
      if (typeof c[key] !== 'string' || !c[key]) {
        throw new Error(`${file}: case #${i + 1} needs a "${key}" string`);
      }
    }
    if (typeof c.should_fire !== 'boolean') {
      throw new Error(`${file}: case "${c.id}" needs should_fire true or false`);
    }
    if (seen.has(c.id)) {
      throw new Error(`${file}: duplicate case id "${c.id}"`);
    }
    seen.add(c.id);
  });
  return cases;
}

// ------------------------------------------------------------- run one case
async function runCase(c) {
  const res = await ragService.retrieve(c.message, c.previous);
  const context = res.context || '';
  const injected = context !== '';
  // formatContext may drop trailing chunks that do not fit the budget
  const shownCount = injected ? context.split('\n\n---\n\n').length : 0;
  const shown = res.chunks.slice(0, shownCount);
  const lower = context.toLowerCase();

  const reasons = [];
  if (c.should_fire) {
    if (!res.fired) {
      reasons.push('gate did not fire');
    } else if (!injected) {
      reasons.push('no chunk passed scoring');
    } else {
      const manuals = asList(c.expected_manual);
      if (
        manuals.length &&
        !shown.some(ch =>
          manuals.some(m => ch.source.toLowerCase().includes(m.toLowerCase())),
        )
      ) {
        reasons.push(`no chunk from ${manuals.join(' / ')}`);
      }
      for (const phrase of asList(c.must_contain)) {
        if (!lower.includes(phrase.toLowerCase())) {
          reasons.push(`missing "${phrase}"`);
        }
      }
    }
  } else if (injected) {
    reasons.push('false trigger');
  }

  let cardNote = '';
  if (c.expected_card) {
    const got = res.card && res.card.id;
    if (got === undefined) {
      cardNote = 'card check skipped (cards not implemented)';
    } else if (got !== c.expected_card) {
      reasons.push(`card ${got || 'none'}, expected ${c.expected_card}`);
    }
  }

  return {
    id: c.id,
    group: c.group,
    message: c.message,
    previous: c.previous,
    should_fire: c.should_fire,
    fired: res.fired,
    injected,
    pass: reasons.length === 0,
    reasons,
    cardNote,
    junk: shown.filter(ch => isJunk(ch.text)).length,
    top: shown.map(ch => ({
      manual: ch.source,
      score: Number((ch.score || 0).toFixed(1)),
      junk: isJunk(ch.text),
      preview: preview(ch.text),
    })),
  };
}

// ------------------------------------------------------------------ summary
function summarise(results) {
  const tally = rows => {
    const want = rows.filter(r => r.should_fire);
    const traps = rows.filter(r => !r.should_fire);
    const chunks = rows.reduce((n, r) => n + r.top.length, 0);
    return {
      cases: rows.length,
      passed: rows.filter(r => r.pass).length,
      should_fire: want.length,
      hits: want.filter(r => r.pass).length,
      misses: want.filter(r => !r.pass).length,
      should_not_fire: traps.length,
      false_triggers: traps.filter(r => r.injected).length,
      chunks,
      junk_chunks: rows.reduce((n, r) => n + r.junk, 0),
    };
  };
  const groups = {};
  for (const g of [...new Set(results.map(r => r.group))]) {
    groups[g] = tally(results.filter(r => r.group === g));
  }
  return {total: tally(results), groups};
}

function printSummary(summary) {
  const row = (name, t) =>
    `  ${name.padEnd(10)} ${String(t.cases).padStart(5)}  ` +
    `${pct(t.hits, t.should_fire)} (${t.hits}/${t.should_fire})`.padEnd(15) +
    `${pct(t.misses, t.should_fire)} (${t.misses}/${t.should_fire})`.padEnd(15) +
    `${pct(t.false_triggers, t.should_not_fire)} (${t.false_triggers}/${t.should_not_fire})`.padEnd(16) +
    `${pct(t.junk_chunks, t.chunks)} (${t.junk_chunks}/${t.chunks})`;
  realLog('\nSUMMARY');
  realLog('  group      cases  hit rate       miss rate      false triggers  junk chunks');
  for (const [g, t] of Object.entries(summary.groups)) {
    realLog(row(g, t));
  }
  realLog(row('TOTAL', summary.total));
  const f = summary.groups.followup;
  if (f) {
    realLog(`\n  Follow-up hit rate: ${pct(f.hits, f.should_fire).trim()} (${f.hits}/${f.should_fire})`);
  }
  realLog(
    '\n  hit = injected text meets every expectation; miss = it should have and did not;\n' +
      '  false trigger = text injected for a message that should get none;\n' +
      '  junk = an injected chunk that is a contents page or OCR garbage.',
  );
}

// ------------------------------------------------------------------ compare
function previousRun() {
  if (!fs.existsSync(RESULTS_DIR)) {
    return null;
  }
  const files = fs.readdirSync(RESULTS_DIR).filter(f => /^run-.*\.json$/.test(f)).sort();
  if (!files.length) {
    return null;
  }
  const file = files[files.length - 1];
  return {file, ...JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, file), 'utf8'))};
}

function printCompare(prev, now) {
  realLog(`\nCOMPARED WITH ${prev.file} (commit ${prev.commit}${prev.dirty ? ', uncommitted changes' : ''})`);
  const before = new Map(prev.cases.map(c => [c.id, c]));
  const after = new Map(now.cases.map(c => [c.id, c]));
  const status = c => (c.pass ? 'PASS' : 'FAIL');
  const top1 = c => (c.top[0] ? `${c.top[0].manual} ${c.top[0].score}` : 'nothing');
  let changed = 0;
  for (const c of now.cases) {
    const old = before.get(c.id);
    if (!old) {
      realLog(`  new      ${c.id}: ${status(c)}`);
      changed++;
    } else if (old.pass !== c.pass) {
      realLog(`  ${c.pass ? 'FIXED   ' : 'BROKEN  '} ${c.id}: ${status(old)} -> ${status(c)}${c.reasons.length ? ' (' + c.reasons.join('; ') + ')' : ''}`);
      changed++;
    } else if (top1(old) !== top1(c) || old.top.length !== c.top.length) {
      realLog(`  moved    ${c.id}: top ${top1(old)} -> ${top1(c)}; chunks ${old.top.length} -> ${c.top.length}`);
      changed++;
    }
  }
  for (const id of before.keys()) {
    if (!after.has(id)) {
      realLog(`  removed  ${id}`);
      changed++;
    }
  }
  if (!changed) {
    realLog('  no per-case changes');
  }
  const a = prev.summary.total;
  const b = now.summary.total;
  const delta = (label, x, y) => {
    const d = y - x;
    realLog(`  ${label.padEnd(15)} ${x} -> ${y}${d ? ` (${d > 0 ? '+' : ''}${d})` : ''}`);
  };
  realLog('  totals:');
  delta('cases', a.cases, b.cases);
  delta('passed', a.passed, b.passed);
  delta('hits', a.hits, b.hits);
  delta('misses', a.misses, b.misses);
  delta('false triggers', a.false_triggers, b.false_triggers);
  delta('junk chunks', a.junk_chunks, b.junk_chunks);
}

// --------------------------------------------------------------------- main
(async () => {
  const cases = loadCases(casesFile);
  const results = [];
  for (const c of cases) {
    results.push(await runCase(c));
  }

  for (const r of results) {
    realLog(`\n[${r.pass ? 'PASS' : 'FAIL'}] ${r.id} (${r.group})`);
    if (r.previous) {
      realLog(`  previous: ${r.previous}`);
    }
    realLog(`  message:  ${r.message}`);
    realLog(
      `  expected: ${r.should_fire ? 'manual text' : 'nothing'}   got: ` +
        (r.injected ? `${r.top.length} chunk(s)` : r.fired ? 'gate fired, nothing injected' : 'gate did not fire'),
    );
    r.top.forEach((t, i) =>
      realLog(`    ${i + 1}. ${t.manual}  ${String(t.score).padStart(5)}${t.junk ? '  JUNK' : ''}  ${t.preview}`),
    );
    if (r.reasons.length) {
      realLog(`  why:      ${r.reasons.join('; ')}`);
    }
    if (r.cardNote) {
      realLog(`  note:     ${r.cardNote}`);
    }
  }

  const summary = summarise(results);
  printSummary(summary);

  // local time, e.g. run-20261114-235020.json
  const now = new Date();
  const stamp = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '-')
    .slice(0, 15);
  const run = {
    timestamp: new Date().toISOString(),
    ...gitInfo(),
    casesFile: path.relative(ROOT, casesFile).replace(/\\/g, '/'),
    summary,
    cases: results,
  };

  if (flag('--compare')) {
    const prev = previousRun();
    if (prev) {
      printCompare(prev, run);
    } else {
      realLog('\nNo previous run to compare with.');
    }
  }

  if (!flag('--no-save')) {
    fs.mkdirSync(RESULTS_DIR, {recursive: true});
    const out = path.join(RESULTS_DIR, `run-${stamp}.json`);
    fs.writeFileSync(out, JSON.stringify(run, null, 2) + '\n');
    realLog(`\nSaved ${path.relative(ROOT, out).replace(/\\/g, '/')} (commit ${run.commit}${run.dirty ? ', uncommitted changes' : ''})`);
  }
})().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
