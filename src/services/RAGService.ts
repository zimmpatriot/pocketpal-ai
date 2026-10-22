import armyManuals from '../assets/rag/army_manuals_rag_light.json';

export interface RAGChunk {
  text: string;
  source: string;
  section: string;
  score?: number;
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'what',
  'how', 'can', 'you', 'are', 'was', 'were', 'will', 'would', 'could',
  'should', 'about', 'into', 'when', 'where', 'which', 'your', 'my',
]);

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
  ];
  return triggers.some(t => q.includes(t));
}

class RAGService {
  private chunks: RAGChunk[] = [];
  private isLoaded = false;

  async load(): Promise<void> {
    if (this.isLoaded) return;
    this.chunks = (armyManuals as Array<{text?: string; source?: string; section?: string}>).map(
      item => ({
        text: (item.text || '').trim(),
        source: item.source || 'Unknown Manual',
        section: item.section || '',
      }),
    );
    this.isLoaded = true;
    console.log(`[RAGService] Loaded ${this.chunks.length} chunks`);
  }

  search(query: string, topK: number = 4): RAGChunk[] {
    if (!this.isLoaded || this.chunks.length === 0) return [];

    const terms = query
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 2 && !STOPWORDS.has(t));

    if (terms.length === 0) return [];

    const scored = this.chunks.map(chunk => {
      const hay = `${chunk.section} ${chunk.text}`.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (!hay.includes(term)) continue;
        // section match is more valuable
        if (chunk.section.toLowerCase().includes(term)) score += 2;
        // count occurrences in text (cap so long chunks don't dominate)
        const matches = hay.split(term).length - 1;
        score += Math.min(matches, 3);
      }
      return {...chunk, score};
    });

    return scored
      .filter(c => (c.score || 0) >= 2)
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, topK);
  }

  /** Keep context short so we don't blow the model window. */
  formatContext(chunks: RAGChunk[], maxChars: number = 1800): string {
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