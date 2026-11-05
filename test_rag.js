// node test_rag.js [path/to/army_manuals_rag_light.json] -- replicates RAGService.ts (patched) shouldUseRAG + search()
const fs = require('fs');
const chunks = JSON.parse(fs.readFileSync(process.argv[2] || 'army_manuals_rag_light.json', 'utf8'))
  .map(i => ({text: (i.text || '').trim(), source: i.source || 'Unknown Manual', section: i.section || ''}));
const STOPWORDS = new Set(['the','and','for','with','that','this','from','have','what','how','can','you','are','was','were','will','would','could','should','about','into','when','where','which','your','my']);
const triggers = ['manual','fm ','atp ','field manual','army','surviv','first aid','wound','bleed','fracture','burn','shelter','water','purify','fire','cold','frost','hypotherm','navi','compass','signal','evasion','trap','food','plant','snake','insect','heat','dehydrat','tourniquet','dressing','splint','cpr','breath','shock','cut','injury','medical',
  'azimuth','bearing','coordinate','contour','terrain','elevation','declination','protractor','pace count','orient','latitude','longitude','landmark','north','resection','intersection','dead reckoning','lensatic','land nav'];
const wordTriggers = /\b(maps?|grids?|mgrs|utm)\b/;
const oldTriggers = triggers.slice(0, 38);
const shouldUseRAG = q => { q = q.toLowerCase(); return triggers.some(t => q.includes(t)) || wordTriggers.test(q); };
function search(query, topK = 4) {
  const terms = query.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(t => t.length > 2 && !STOPWORDS.has(t));
  if (!terms.length) return [];
  return chunks.map(c => {
    const hay = `${c.section} ${c.text}`.toLowerCase(); let score = 0;
    for (const t of terms) { if (!hay.includes(t)) continue; if (c.section.toLowerCase().includes(t)) score += 2; score += Math.min(hay.split(t).length - 1, 3); }
    return {...c, score};
  }).filter(c => c.score >= 2).sort((a, b) => b.score - a.score).slice(0, topK);
}
const qs = process.argv.length > 3 ? process.argv.slice(3) : ['how do I shoot an azimuth', 'how to read a grid coordinate', 'what is magnetic declination', 'how do I use a lensatic compass at night', 'how do I find my location on a map with resection'];
for (const q of qs) {
  const old = oldTriggers.some(t => q.toLowerCase().includes(t));
  const r = shouldUseRAG(q) ? search(q) : [];
  console.log(`\nQ: ${q}\n  trigger old=${old} new=${shouldUseRAG(q)}`);
  r.forEach(c => console.log(`  [${c.score}] ${c.source} ${c.section}: ${c.text.slice(0, 90).replace(/\s+/g, ' ')}`));
}
