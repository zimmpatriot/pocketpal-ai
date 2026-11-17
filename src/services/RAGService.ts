import armyManuals from '../assets/rag/army_manuals_rag_light.json';

export interface RAGChunk {
  text: string;
  source: string;
  section: string;
  score?: number;
}

export interface RAGResult {
  /** the keyword gate judged the message survival-related */
  fired: boolean;
  /** chunks that passed scoring, best first */
  chunks: RAGChunk[];
  /** the text injected into the prompt; '' when nothing is injected */
  context: string;
  /** the lookup used the previous user message together with this one */
  followUp?: boolean;
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'what',
  'how', 'can', 'you', 'are', 'was', 'were', 'will', 'would', 'could',
  'should', 'about', 'into', 'when', 'where', 'which', 'your', 'my',
  'does', 'did', 'not', 'but', 'they', 'them', 'there', 'their', 'has',
  'had', 'its', 'use', 'get', 'make', 'need', 'want', 'best', 'way', 'any',
  'some', 'out', 'who', 'why', 'tell', 'give', 'show', 'please', 'like',
  'just', 'been', 'than', 'then', 'also', 'one', 'all', 'if', 'is', 'it',
  'in', 'on', 'of', 'to', 'do', 'me', 'an', 'be', 'or', 'as', 'at', 'by',
  'we', 'so', 'no', 'up', 'am',
]);

/** Very light stemming so "bites"/"bite" and "splinting"/"splint" match. */
const stem = (w: string): string =>
  w.length > 4 && w.endsWith('ing')
    ? w.slice(0, -3)
    : w.length > 3 && w.endsWith('es')
    ? w.slice(0, -2)
    : w.length > 3 && w.endsWith('s') && !w.endsWith('ss')
    ? w.slice(0, -1)
    : w;

/** Whole-word tokens: "shoot" no longer matches inside "offshoot". */
const tokenize = (s: string): string[] =>
  (s.toLowerCase().match(/[a-z0-9]+/g) || [])
    .filter(w => w.length > 1 && !STOPWORDS.has(w))
    .map(stem);

/** Minimum BM25 score for a chunk to be used. Raise to be stricter. */
const MIN_SCORE = 6;

/**
 * The manuals are only for the S.A.M. Pal. The Pal is created in-app, so it
 * is recognised by name: "S.A.M.", "SAM", "S.A.M. - Survival AI Mentor", ...
 * (but not "Samantha").
 */
export function isSamPal(palName?: string | null): boolean {
  return /\bs\.?a\.?m\b/i.test(palName || '');
}

/** The message asks for something or describes a lack. */
const ASKS =
  /\?|\b(how|what|whats|which|where|when|why|can|could|should|is it|do i|help|need|no|without|don'?t have|do not have|lost|stuck|out of|show|tell|explain|teach|treat|build|find|start|make|walk|steps?|guide|apply|applying|i'?m|i am|we'?re|we are|it'?s|it is|there'?s|there is)\b/;

/** Only run RAG when the question looks technical / survival-related. */
export function shouldUseRAG(query: string): boolean {
  const q = query.toLowerCase();
  const triggers = [
    'manual', 'fm ', 'atp ', 'field manual', 'army',
    'surviv', 'first aid', 'wound', 'bleed', 'fracture', 'burn',
    'shelter', 'water', 'purify', 'fire', 'cold', 'frost', 'hypotherm',
    'navi', 'compass', 'signal', 'evasion', 'trap', 'food', 'plant',
    'snake', 'insect', 'heat', 'dehydrat', 'tourniquet', 'dressing',
    'splint', 'cpr', 'breath', 'shock', 'cut', 'injury', 'medical',
    // map reading / land navigation (FM 3-25.26)
    'azimuth', 'bearing', 'coordinate', 'contour', 'terrain', 'elevation',
    'declination', 'protractor', 'pace count', 'orient', 'latitude',
    'longitude', 'landmark', 'north', 'resection', 'intersection',
    'dead reckoning', 'lensatic', 'land nav',
  ];
  // short terms that need word boundaries (avoid 'bitmap', 'utmost', 'gridlock')
  const wordTriggers = /\b(maps?|grids?|mgrs|utm)\b/;
  // leading word boundary only, so stems ('surviv', 'hypotherm') still match
  // but 'cut' no longer fires on 'execute' or 'heat' on 'cheat'
  const toStems = (list: string[]) =>
    new RegExp(`\\b(${list.map(t => t.trim()).join('|')})`);
  if (!toStems(triggers).test(q) && !wordTriggers.test(q)) {
    return false;
  }

  // Everyday words also turn up in small talk ("my friend moved north last
  // year", "the fire drill at work"). On their own they only count when the
  // message asks for something, describes a lack, or is a bare topic.
  const everyday = [
    'manual', 'army', 'water', 'fire', 'cold', 'signal', 'trap', 'food',
    'plant', 'heat', 'dressing', 'cut', 'bearing', 'terrain', 'elevation',
    'orient', 'landmark', 'north', 'intersection',
  ];
  const specific = triggers.filter(t => !everyday.includes(t)).concat([
    'mgrs', 'utm', 'heat ?stroke', 'heat exhaustion', 'heat cramp',
    'pressure dressing', 'field dressing',
    'cut (my|his|her|our|their|your)', 'cut (my|him|her|your)self',
  ]);
  if (toStems(specific).test(q)) {
    return true;
  }
  const wordCount = (q.match(/[a-z0-9']+/g) || []).length;
  return ASKS.test(q) || wordCount <= 3;
}

/** One short line for the reply footer and logcat: what the lookup did. */
export function describeRAG(result: RAGResult): string {
  if (!result.fired) return 'none: gate';
  if (!result.context) return 'none: no-hit';
  const used = result.chunks.slice(
    0,
    result.context.split('\n\n---\n\n').length,
  );
  const manuals = Array.from(
    new Set(used.map(c => c.source.split('_').slice(0, 2).join(' '))),
  );
  return `${used.length} excerpts · ${manuals.join(', ')} · top score ${(
    used[0].score || 0
  ).toFixed(1)}${result.followUp ? ' · follow-up' : ''}`;
}

class RAGService {
  private chunks: RAGChunk[] = [];
  private isLoaded = false;
  /** term -> flat postings list [chunkIndex, termFrequency, ...] */
  private index = new Map<string, number[]>();

  async load(): Promise<void> {
    if (this.isLoaded) return;
    this.chunks = (armyManuals as Array<{text?: string; source?: string; section?: string}>).map(
      item => ({
        text: (item.text || '').trim(),
        source: item.source || 'Unknown Manual',
        section: item.section || '',
      }),
    )
      // drop table-of-contents pages (rows of dot leaders)
      .filter(c => (c.text.match(/\.{5,}/g) || []).length <= 2);

    this.chunks.forEach((chunk, i) => {
      const tf = new Map<string, number>();
      for (const w of tokenize(chunk.text)) {
        tf.set(w, (tf.get(w) || 0) + 1);
      }
      tf.forEach((n, w) => {
        let postings = this.index.get(w);
        if (!postings) {
          postings = [];
          this.index.set(w, postings);
        }
        postings.push(i, n);
      });
    });
    this.isLoaded = true;
    console.log(`[RAGService] Loaded ${this.chunks.length} chunks`);
  }

  search(query: string, topK: number = 4): RAGChunk[] {
    if (!this.isLoaded || this.chunks.length === 0) return [];

    const terms = Array.from(new Set(tokenize(query))).filter(w =>
      this.index.has(w),
    );
    if (terms.length === 0) return [];

    // BM25 without length normalisation (chunks are all ~600 chars).
    const N = this.chunks.length;
    const k1 = 1.2;
    const scores = new Map<number, number>();
    const hits = new Map<number, number>();
    for (const term of terms) {
      const postings = this.index.get(term)!;
      const df = postings.length / 2;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      for (let j = 0; j < postings.length; j += 2) {
        const i = postings[j];
        const tf = postings[j + 1];
        scores.set(
          i,
          (scores.get(i) || 0) + (idf * tf * (k1 + 1)) / (tf + k1),
        );
        hits.set(i, (hits.get(i) || 0) + 1);
      }
    }

    // A chunk must match two different query words when the query has two.
    const need = Math.min(2, terms.length);
    return Array.from(scores.entries())
      .filter(([i, s]) => (hits.get(i) || 0) >= need && s >= MIN_SCORE)
      .sort((a, b) => b[1] - a[1])
      .slice(0, topK)
      .map(([i, s]) => ({...this.chunks[i], score: s}));
  }

  /**
   * The whole lookup for one message: gate, search, format. The chat hook and
   * scripts/rag-test both call this, so the test harness measures exactly
   * what the app does. `previous` is the prior user message, passed only
   * when that message got manual excerpts.
   */
  async retrieve(message: string, previous?: string): Promise<RAGResult> {
    const fired = shouldUseRAG(message);
    let chunks: RAGChunk[] = [];
    if (fired) {
      await this.load();
      chunks = this.search(message, 3);
    }
    // Nothing found for the message by itself, and it asks for something:
    // look it up together with the previous message. A message that finds
    // its own excerpts is a new topic (or complete as it is) and stays alone.
    if (
      previous &&
      chunks.length === 0 &&
      ASKS.test(message.toLowerCase()) &&
      shouldUseRAG(`${previous} ${message}`)
    ) {
      await this.load();
      // Excerpts must also mention something from the new message, so
      // "tell me a joke" does not bring the last topic's excerpts back.
      const mine = Array.from(new Set(tokenize(message))).filter(w =>
        this.index.has(w),
      );
      const both = this.search(`${previous} ${message}`, 30)
        .filter(c => {
          if (mine.length === 0) return true;
          const words = new Set(tokenize(c.text));
          return mine.some(w => words.has(w));
        })
        .slice(0, 3);
      if (both.length > 0) {
        return {
          fired: true,
          chunks: both,
          context: this.formatContext(both),
          followUp: true,
        };
      }
    }
    return {fired, chunks, context: this.formatContext(chunks)};
  }

  /** Keep context short so we don't blow the model window. */
  formatContext(chunks: RAGChunk[], maxChars: number = 2300): string {
    if (chunks.length === 0) return '';

    const parts: string[] = [];
    let total = 0;

    for (const chunk of chunks) {
      const header = chunk.section
        ? `[${chunk.source} – ${chunk.section}]`
        : `[${chunk.source}]`;
      // trim very long chunks
      const body =
        chunk.text.length > 500
          ? chunk.text.slice(0, 500).trim() + '…'
          : chunk.text;
      const block = `${header}\n${body}`;
      if (total + block.length > maxChars) break;
      parts.push(block);
      total += block.length;
    }

    return parts.join('\n\n---\n\n');
  }
}

export const ragService = new RAGService();