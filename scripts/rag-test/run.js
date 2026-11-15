#!/usr/bin/env node
/**
 * S.A.M. retrieval test harness. Runs on the PC: no model, no phone.
 *
 * It loads the app's real src/services/RAGService.ts (gate + BM25 + context
 * formatting) and the bundled manuals JSON, runs every case in a cases file
 * through ragService.retrieve(), and reports what would be injected into the
 * prompt.
 *
 *   node scripts/rag-test/run.js                 term check, run, save results
 *   node scripts/rag-test/run.js --compare       also diff against the previous run
 *   node scripts/rag-test/run.js --terms-only    only check must_contain wording
 *   node scripts/rag-test/run.js --cases <file>  use another cases file
 *   node scripts/rag-test/run.js --no-save       do not write a results file
 *
 * Case fields (see cases.json):
 *   id               unique name
 *   group            core | modern | vague | followup | trap (any label works)
 *   message          the user's message
 *   previous         optional: the previous user message (follow-ups)
 *   expect           "hit"   the right manual text should come back
 *                    "gap"   should fire, but the manuals do not cover it
 *                    "none"  nothing should be injected
 *   expected_manual  text found in the manual's source name, e.g. "4-25.11";
 *                    a list means "any of these"
 *   must_contain     phrases, case-insensitive; any one counts
 *   safety           optional true: listed first in the report
 *   review           optional true: a doubtful result is shown as REVIEW
 *                    instead of FAIL
 *   expected_card    optional quick-card id (checked once cards exist)
 *   note             optional free text shown in the report
 *
 * A hit means: at least one injected excerpt is from an expected manual AND
 * contains one of the must_contain phrases. Expectations never name chunk
 * ids, so they survive re-chunking.
 */
const fs = require('fs');
const path = require('path');
const {execSync} = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const RESULTS_DIR = path.join(__dirname, 'results');
const MANUALS_JSON = path.join(ROOT, 'src', 'assets', 'rag', 'army_manuals_rag_light.json');
const EXCERPT_CHARS = 500; // formatContext shows the first 500 characters of a chunk

// ---------------------------------------------------------------- arguments
const args = process.argv.slice(2);
const flag = name => args.includes(name);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const casesFile = path.resolve(option('--cases', path.join(__dirname, 'cases.json')));

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
const say = console.log;
console.log = () => {}; // RAGService logs its chunk count on load
const {ragService} = require(path.join(ROOT, 'src', 'services', 'RAGService.ts'));

// ------------------------------------------------------------------ helpers
/** A chunk the model should never be shown: contents page or OCR garbage. */
function isGarbage(text) {
  if ((text.match(/\.{5,}/g) || []).length > 2) {
    return true;
  }
  const words = text.match(/[A-Za-z]{4,}/g) || [];
  if (words.length < 30) {
    return true;
  }
  const odd = words.filter(
    w => /[a-z][A-Z]/.test(w) || /[A-Z]{2}[a-z]{2}[A-Z]/.test(w) || !/[aeiouy]/i.test(w),
  ).length;
  return odd / words.length > 0.15;
}

const asList = v => (v === undefined || v === null ? [] : [].concat(v));
const pct = (n, d) => (d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(0)}%`);
const frac = (n, d) => `${pct(n, d)} (${n}/${d})`;
const preview = text => text.replace(/\s+/g, ' ').trim().slice(0, 80);
const fromManual = (source, manuals) =>
  manuals.some(m => source.toLowerCase().includes(String(m).toLowerCase()));

function gitInfo() {
  try {
    const run = cmd =>
      execSync(cmd, {cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore']}).toString().trim();
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
    if (!['hit', 'gap', 'none'].includes(c.expect)) {
      throw new Error(`${file}: case "${c.id}" needs expect "hit", "gap" or "none"`);
    }
    if (c.expect === 'hit' && !asList(c.expected_manual).length && !asList(c.must_contain).length) {
      throw new Error(`${file}: case "${c.id}" expects a hit but has no expected_manual or must_contain`);
    }
    if (seen.has(c.id)) {
      throw new Error(`${file}: duplicate case id "${c.id}"`);
    }
    seen.add(c.id);
  });
  return cases;
}

// --------------------------------------------------------------- term check
/**
 * must_contain phrases are guesses at the manuals' wording. Count how many
 * chunks of the expected manual(s) contain each one, so a wrong guess can be
 * fixed instead of being counted as a retrieval miss.
 */
function checkTerms(cases) {
  const manuals = JSON.parse(fs.readFileSync(MANUALS_JSON, 'utf8')).map(c => ({
    source: c.source || '',
    text: (c.text || '').toLowerCase(),
  }));
  const report = new Map();
  for (const c of cases) {
    const phrases = asList(c.must_contain);
    if (!phrases.length) {
      continue;
    }
    const wanted = asList(c.expected_manual);
    const terms = phrases.map(phrase => {
      const p = phrase.toLowerCase();
      const elsewhere = {};
      let inExpected = 0;
      for (const m of manuals) {
        if (!m.text.includes(p)) {
          continue;
        }
        if (!wanted.length || fromManual(m.source, wanted)) {
          inExpected++;
        } else {
          elsewhere[m.source] = (elsewhere[m.source] || 0) + 1;
        }
      }
      return {phrase, inExpected, elsewhere};
    });
    report.set(c.id, {terms, unscorable: terms.every(t => t.inExpected === 0)});
  }
  return report;
}

function printTermCheck(cases, report) {
  say('TERM CHECK (must_contain wording against the manuals)');
  let flagged = 0;
  for (const c of cases) {
    const entry = report.get(c.id);
    if (!entry) {
      continue;
    }
    for (const t of entry.terms.filter(x => x.inExpected === 0)) {
      flagged++;
      const where = Object.entries(t.elsewhere).map(([s, n]) => `${s} (${n})`).join(', ');
      const target = asList(c.expected_manual).join(' / ') || 'any manual';
      say(`  ${c.id}: "${t.phrase}" is in no chunk of ${target}` + (where ? `; found in ${where}` : '; found nowhere'));
    }
    if (entry.unscorable && c.expect === 'hit') {
      say(`  ${c.id}: no usable phrase, so this case is reported as TERMS, not as a miss`);
    }
  }
  if (!flagged) {
    say('  every phrase appears in its expected manual');
  }
}

// ------------------------------------------------------------- run one case
async function runCase(c, termReport) {
  const res = await ragService.retrieve(c.message, c.previous);
  const context = res.context || '';
  const injected = context !== '';
  // formatContext may drop trailing chunks that do not fit the budget
  const shownCount = injected ? context.split('\n\n---\n\n').length : 0;
  const manuals = asList(c.expected_manual);
  const phrases = asList(c.must_contain).map(p => p.toLowerCase());

  const top = res.chunks.slice(0, shownCount).map(ch => {
    const shown = ch.text.slice(0, EXCERPT_CHARS).toLowerCase();
    const manualOk = !manuals.length || fromManual(ch.source, manuals);
    const phraseOk = !phrases.length || phrases.some(p => shown.includes(p));
    return {
      manual: ch.source,
      score: Number((ch.score || 0).toFixed(1)),
      garbage: isGarbage(ch.text),
      match: manualOk && phraseOk,
      preview: preview(ch.text),
    };
  });
  const matched = top.some(t => t.match);

  let status;
  const reasons = [];
  if (c.expect === 'hit') {
    const terms = termReport.get(c.id);
    if (matched) {
      status = 'PASS';
    } else if (terms && terms.unscorable) {
      status = 'TERMS';
      reasons.push('no must_contain phrase exists in the expected manual');
    } else {
      status = 'FAIL';
      if (!res.fired) {
        reasons.push('gate did not fire');
      } else if (!injected) {
        reasons.push('no chunk passed scoring');
      } else if (manuals.length && !top.some(t => fromManual(t.manual, manuals))) {
        reasons.push(`no excerpt from ${manuals.join(' / ')}`);
      } else {
        reasons.push('no excerpt from the expected manual contains a must_contain phrase');
      }
    }
  } else if (c.expect === 'gap') {
    // Nothing injected is the clean outcome. Anything injected needs a human
    // look: junk shown for an uncovered topic is worse than nothing.
    status = injected ? 'REVIEW' : 'PASS';
    if (injected) {
      reasons.push(matched && phrases.length ? 'manual text injected and it matches must_contain' : 'manual text injected for a topic marked as not covered');
    }
    if (!res.fired) {
      reasons.push('gate did not fire, so no fallback or label would apply');
    }
  } else {
    status = !injected ? 'PASS' : c.review ? 'REVIEW' : 'FAIL';
    if (injected) {
      reasons.push('false trigger');
    }
  }

  let cardNote = '';
  if (c.expected_card) {
    const got = res.card && res.card.id;
    if (got === undefined) {
      cardNote = 'card check skipped (cards not implemented)';
    } else if (got !== c.expected_card) {
      status = 'FAIL';
      reasons.push(`card ${got || 'none'}, expected ${c.expected_card}`);
    }
  }

  return {
    id: c.id,
    group: c.group,
    expect: c.expect,
    safety: !!c.safety,
    message: c.message,
    previous: c.previous,
    note: c.note,
    fired: res.fired,
    injected,
    status,
    reasons,
    cardNote,
    top,
  };
}

// ------------------------------------------------------------------ summary
function summarise(results) {
  const tally = rows => {
    const hits = rows.filter(r => r.expect === 'hit');
    const scorable = hits.filter(r => r.status !== 'TERMS');
    const gaps = rows.filter(r => r.expect === 'gap');
    const nones = rows.filter(r => r.expect === 'none');
    const excerpts = rows.reduce((n, r) => n + r.top.length, 0);
    const garbage = rows.reduce((n, r) => n + r.top.filter(t => t.garbage).length, 0);
    // everything injected for a "none" case is off-topic by definition
    const offTopic = nones.reduce((n, r) => n + r.top.filter(t => !t.garbage).length, 0);
    return {
      cases: rows.length,
      hit_cases: scorable.length,
      hits: scorable.filter(r => r.status === 'PASS').length,
      misses: scorable.filter(r => r.status === 'FAIL').length,
      terms: hits.length - scorable.length,
      none_cases: nones.length,
      false_triggers: nones.filter(r => r.injected).length,
      gap_cases: gaps.length,
      gap_injected: gaps.filter(r => r.injected).length,
      review: rows.filter(r => r.status === 'REVIEW').length,
      excerpts,
      junk: garbage + offTopic,
    };
  };
  const groups = {};
  for (const g of [...new Set(results.map(r => r.group))]) {
    groups[g] = tally(results.filter(r => r.group === g));
  }
  return {total: tally(results), safety: tally(results.filter(r => r.safety)), groups};
}

function printSummary(summary) {
  const cols = [10, 6, 14, 14, 16, 14, 7, 14];
  const line = cells => '  ' + cells.map((c, i) => String(c).padEnd(cols[i])).join('');
  const row = (name, t) =>
    line([
      name,
      t.cases,
      frac(t.hits, t.hit_cases),
      frac(t.misses, t.hit_cases),
      frac(t.false_triggers, t.none_cases),
      frac(t.gap_injected, t.gap_cases),
      t.review,
      frac(t.junk, t.excerpts),
    ]);
  say('\nSUMMARY');
  say(line(['group', 'cases', 'hit rate', 'miss rate', 'false triggers', 'gap injected', 'review', 'junk excerpts']));
  for (const [g, t] of Object.entries(summary.groups)) {
    say(row(g, t));
  }
  say(row('TOTAL', summary.total));
  say(row('safety', summary.safety));
  const f = summary.groups.followup;
  if (f) {
    say(`\n  Follow-up hit rate: ${frac(f.hits, f.hit_cases)}`);
  }
  if (summary.total.terms) {
    say(`  ${summary.total.terms} case(s) left out of hit and miss rates: their must_contain wording is not in the manual (see TERM CHECK).`);
  }
  say(
    '\n  hit            an injected excerpt is from the expected manual and has a must_contain phrase\n' +
      '  false trigger  text injected for a message that should get none (includes review cases)\n' +
      '  gap injected   text injected for a topic marked as not covered; check it by eye\n' +
      '  junk excerpts  OCR garbage or contents pages, plus everything injected for "none" cases',
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
  say(`\nCOMPARED WITH ${prev.file} (commit ${prev.commit}${prev.dirty ? ', uncommitted changes' : ''})`);
  const statusOf = c => c.status || (c.pass ? 'PASS' : 'FAIL');
  const top1 = c => (c.top[0] ? `${c.top[0].manual} ${c.top[0].score}` : 'nothing');
  const before = new Map(prev.cases.map(c => [c.id, c]));
  const after = new Map(now.cases.map(c => [c.id, c]));
  let changed = 0;
  for (const c of now.cases) {
    const old = before.get(c.id);
    if (!old) {
      say(`  new      ${c.id}: ${c.status}`);
      changed++;
    } else if (statusOf(old) !== c.status) {
      const word = c.status === 'PASS' ? 'FIXED   ' : statusOf(old) === 'PASS' ? 'BROKEN  ' : 'changed ';
      say(`  ${word} ${c.id}: ${statusOf(old)} -> ${c.status}${c.reasons.length ? ' (' + c.reasons.join('; ') + ')' : ''}`);
      changed++;
    } else if (top1(old) !== top1(c) || old.top.length !== c.top.length) {
      say(`  moved    ${c.id}: top ${top1(old)} -> ${top1(c)}; excerpts ${old.top.length} -> ${c.top.length}`);
      changed++;
    }
  }
  for (const id of before.keys()) {
    if (!after.has(id)) {
      say(`  removed  ${id}`);
      changed++;
    }
  }
  if (!changed) {
    say('  no per-case changes');
  }
  const a = prev.summary.total;
  const b = now.summary.total;
  say('  totals:');
  for (const [label, key] of [
    ['cases', 'cases'],
    ['hits', 'hits'],
    ['misses', 'misses'],
    ['false triggers', 'false_triggers'],
    ['gap injected', 'gap_injected'],
    ['review', 'review'],
    ['junk excerpts', 'junk'],
  ]) {
    const x = a[key];
    const y = b[key];
    if (x === undefined) {
      say(`  ${label.padEnd(15)} (not in previous run) -> ${y}`);
    } else {
      const d = y - x;
      say(`  ${label.padEnd(15)} ${x} -> ${y}${d ? ` (${d > 0 ? '+' : ''}${d})` : ''}`);
    }
  }
}

// --------------------------------------------------------------------- main
function printCase(r) {
  say(`\n[${r.status}] ${r.id} (${r.group}, expect ${r.expect}${r.safety ? ', SAFETY' : ''})`);
  if (r.previous) {
    say(`  previous: ${r.previous}`);
  }
  say(`  message:  ${r.message}`);
  say(
    '  got:      ' +
      (r.injected ? `${r.top.length} excerpt(s)` : r.fired ? 'gate fired, nothing injected' : 'gate did not fire'),
  );
  r.top.forEach((t, i) =>
    say(
      `    ${i + 1}. ${t.match && r.expect !== 'none' ? '*' : ' '} ${t.manual.padEnd(26)} ${String(t.score).padStart(5)}${t.garbage ? '  GARBAGE' : ''}  ${t.preview}`,
    ),
  );
  if (r.reasons.length) {
    say(`  why:      ${r.reasons.join('; ')}`);
  }
  if (r.note) {
    say(`  note:     ${r.note}`);
  }
  if (r.cardNote) {
    say(`  note:     ${r.cardNote}`);
  }
}

(async () => {
  const cases = loadCases(casesFile);
  const termReport = checkTerms(cases);
  printTermCheck(cases, termReport);
  if (flag('--terms-only')) {
    return;
  }

  const results = [];
  for (const c of cases) {
    results.push(await runCase(c, termReport));
  }

  const safety = results.filter(r => r.safety);
  if (safety.length) {
    say('\n================ SAFETY CASES ================');
    safety.forEach(printCase);
    say('\n================ OTHER CASES =================');
  }
  results.filter(r => !r.safety).forEach(printCase);
  say('\n  * marks an excerpt from the expected manual that contains a must_contain phrase');

  const summary = summarise(results);
  printSummary(summary);

  // local time, e.g. run-20261114-235020.json
  const now = new Date();
  const stamp = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '-')
    .slice(0, 15);
  const flaggedTerms = [];
  for (const [id, entry] of termReport) {
    for (const t of entry.terms.filter(x => x.inExpected === 0)) {
      flaggedTerms.push({id, phrase: t.phrase, elsewhere: t.elsewhere});
    }
  }
  const run = {
    timestamp: now.toISOString(),
    ...gitInfo(),
    casesFile: path.relative(ROOT, casesFile).replace(/\\/g, '/'),
    summary,
    flaggedTerms,
    cases: results,
  };

  if (flag('--compare')) {
    const prev = previousRun();
    if (prev) {
      printCompare(prev, run);
    } else {
      say('\nNo previous run to compare with.');
    }
  }

  if (!flag('--no-save')) {
    fs.mkdirSync(RESULTS_DIR, {recursive: true});
    const out = path.join(RESULTS_DIR, `run-${stamp}.json`);
    fs.writeFileSync(out, JSON.stringify(run, null, 2) + '\n');
    say(`\nSaved ${path.relative(ROOT, out).replace(/\\/g, '/')} (commit ${run.commit}${run.dirty ? ', uncommitted changes' : ''})`);
  }
})().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
