#!/usr/bin/env python3
"""
army_rag_chunk.py - append a field manual PDF to S.A.M.'s army_manuals_rag_light.json

Matches the existing export exactly:
  * records: {"text": str, "source": str, "section": "chunk_<n>"}  (n from 0 per manual)
  * fixed character windows: 600 chars, step 500 (100-char overlap), no stripping
  * text style: single '\n' line breaks, no blank lines (page breaks become '\n')
  * output: JSON array, indent=2, ensure_ascii=False, UTF-8, no trailing newline

Also dedupes: drops any record whose (source, text) already appeared earlier
(keeps the first occurrence, preserving order), and replaces any existing
records with the same source name (so re-running is idempotent).

Usage:
  python army_rag_chunk.py <pdf> <source_name> <existing_json> <output_json> [--engine pdftotext|pypdf]

Text extraction: pdftotext (poppler, no -layout) if on PATH, else pypdf (pip install pypdf).
"""
import argparse, json, re, shutil, subprocess, sys
from collections import Counter

CHUNK_SIZE = 600
STEP = 500  # 100-char overlap


def extract_text(pdf, engine):
    if engine == "auto":
        engine = "pdftotext" if shutil.which("pdftotext") else "pypdf"
    if engine == "pdftotext":
        out = subprocess.run(["pdftotext", "-enc", "UTF-8", pdf, "-"],
                             check=True, capture_output=True).stdout.decode("utf-8", "replace")
    else:
        from pypdf import PdfReader  # pip install pypdf
        out = "\n".join((p.extract_text() or "") for p in PdfReader(pdf).pages)
    return engine, out


def normalize(text):
    text = text.replace("\r\n", "\n").replace("\r", "\n").replace("\f", "\n")
    return re.sub(r"\n{2,}", "\n", text)  # existing export never contains blank lines


def chunk(text, source):
    recs, n = [], 0
    for i in range(0, len(text), STEP):
        piece = text[i:i + CHUNK_SIZE]
        if i > 0 and len(piece) <= CHUNK_SIZE - STEP:
            break  # tail fully contained in previous window's overlap
        if not piece.strip():
            continue
        recs.append({"text": piece, "source": source, "section": f"chunk_{n}"})
        n += 1
    return recs


def dedupe(records):
    seen, out, dropped = set(), [], 0
    for r in records:
        key = (r.get("source"), r.get("text"))
        if key in seen:
            dropped += 1
            continue
        seen.add(key)
        out.append(r)
    return out, dropped


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf"); ap.add_argument("source"); ap.add_argument("existing"); ap.add_argument("output")
    ap.add_argument("--engine", default="auto", choices=["auto", "pdftotext", "pypdf"])
    a = ap.parse_args()

    with open(a.existing, encoding="utf-8") as f:
        existing = json.load(f)
    before = Counter(r.get("source") for r in existing)

    kept = [r for r in existing if r.get("source") != a.source]
    kept, dropped = dedupe(kept)

    engine, raw = extract_text(a.pdf, a.engine)
    new = chunk(normalize(raw), a.source)
    if not new:
        sys.exit("ERROR: no text extracted (scanned PDF? needs OCR)")

    result = kept + new
    with open(a.output, "w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(result, indent=2, ensure_ascii=False))

    # validate
    with open(a.output, encoding="utf-8") as f:
        check = json.load(f)
    after = Counter(r["source"] for r in check)
    for s in after:
        texts = [r["text"] for r in check if r["source"] == s]
        assert len(texts) == len(set(texts)), f"duplicate texts remain in {s}"
    print(f"engine={engine}  extracted_chars={len(raw)}  new_chunks={len(new)}  dupes_removed={dropped}")
    print("before:", dict(before))
    print("after: ", dict(after), " total", len(check))


if __name__ == "__main__":
    main()
