#!/usr/bin/env python3
"""Vocabulary closure test — does the edge ontology COVER your corpus's relations?

Standalone adaptation of the TLDR-G vocabulary-closure census. Any relation a
frontier reader proposes that has NO nearest family in the ontology is a gap =
a candidate family for your domain pack.

Two phases:
  extract : an LLM (any OpenAI-compatible /v1/chat/completions endpoint, e.g.
            vLLM) reads corpora (one subdir per REGISTER under --corpus-root)
            and proposes [head, relation, tail] triples in its OWN idiom (NOT
            family-constrained) -> edges.json. Stdlib-only.
  map     : embeds the family glosses (from ../edge-ontology.json) + every
            distinct proposed relation, maps each relation to its nearest
            family by cosine, buckets covered/gap at a calibrated threshold,
            and clusters the gap residue -> coverage.json + printed report.
            Requires: sentence-transformers + numpy
            (pip install sentence-transformers)

Threshold calibration: by default the threshold is the 5th percentile of the
similarities between the ontology's known string->family mappings and their
true family's gloss (keep ~95% of known-good mappings covered). Override with
--threshold.
"""
from __future__ import annotations

import argparse, json, sys, time, urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ONTOLOGY_JSON = Path(__file__).resolve().parent.parent / "edge-ontology.json"

PROMPT = ("Extract knowledge-graph edges from the TEXT as a JSON array of "
          "[head, relation, tail] triples. head and tail MUST be named entities copied "
          "verbatim from the TEXT. relation is a short natural-language phrase in YOUR OWN "
          "words describing how head relates to tail (do NOT restrict to any fixed list). "
          "Output ONLY the JSON array.\n\nTEXT:\n{text}")


# ---------------------------------------------------------------- phase 1: extract
def _chunks(text: str, cap: int = 3200):
    out, buf = [], ""
    for para in text.split("\n\n"):
        if len(buf) + len(para) > cap and buf:
            out.append(buf); buf = para
        else:
            buf = f"{buf}\n\n{para}" if buf else para
    if buf.strip():
        out.append(buf)
    return out


def _llm_call(host, model, text):
    body = json.dumps({"model": model,
                       "messages": [{"role": "user", "content": PROMPT.format(text=text)}],
                       "temperature": 0, "max_tokens": 800}).encode()
    req = urllib.request.Request(f"{host}/v1/chat/completions", data=body,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            msg = json.loads(r.read())["choices"][0]["message"]["content"]
    except Exception as exc:
        print(f"  req error: {exc}", file=sys.stderr); return []
    triples = []
    try:
        for tr in json.loads(msg[msg.find("["): msg.rfind("]") + 1]):
            if isinstance(tr, (list, tuple)) and len(tr) == 3:
                h, rel, t = (str(x).strip() for x in tr)
                if h and rel and t:
                    triples.append([h, rel, t])
    except Exception:
        pass
    return triples


def extract(args):
    root = Path(args.corpus_root)
    domains = sorted([d for d in root.iterdir() if d.is_dir()])
    if not domains:
        sys.exit(f"FATAL: no register subdirs under {root}")
    tasks = []  # (register, text)
    for d in domains:
        docs = sorted(d.glob("*.txt"))[: args.per_domain] if args.per_domain else sorted(d.glob("*.txt"))
        for p in docs:
            for c in _chunks(p.read_text(encoding="utf-8", errors="replace")):
                tasks.append((d.name, c))
    print(f"{len(domains)} registers / {len(tasks)} chunks / model {args.model}", flush=True)

    by_domain = defaultdict(list)
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=args.concurrency) as ex:
        for (dom, _txt), triples in zip(tasks, ex.map(lambda x: _llm_call(args.host, args.model, x[1]), tasks)):
            by_domain[dom].extend(triples)
    total = sum(len(v) for v in by_domain.values())
    print(f"extracted {total} triples in {time.time()-t0:.0f}s", flush=True)
    Path(args.out).write_text(json.dumps({"model": args.model, "by_domain": by_domain}), encoding="utf-8")
    print(f"-> {args.out}")
    for dom in domains:
        print(f"  {dom.name}: {len(by_domain[dom.name])} triples")


# ---------------------------------------------------------------- phase 2: map
def _load_ontology(path):
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    families = dict(data["families"])
    return families, dict(data.get("string_to_family", {}))


def _embedder(model_name):
    from sentence_transformers import SentenceTransformer
    st = SentenceTransformer(model_name)

    def embed(texts):
        import numpy as np
        vecs = st.encode(list(texts), normalize_embeddings=True, show_progress_bar=False)
        return np.asarray(vecs, dtype="float32")
    return embed


def mapcov(args):
    import numpy as np
    families, string_to_family = _load_ontology(args.ontology)
    for pack_path in args.pack or []:
        pack = json.loads(Path(pack_path).read_text(encoding="utf-8"))
        for name, meta in pack.get("families", {}).items():
            families.setdefault(name, meta)  # additive: core wins on collision
    embed = _embedder(args.embedding_model)

    data = json.loads(Path(args.edges).read_text(encoding="utf-8"))
    by_domain = data["by_domain"]

    fams = list(families)
    gloss_vecs = embed([families[f]["description"] for f in fams])   # (F, d), normalized

    # --- threshold calibration: known string->family entries SHOULD map to their family
    known = [(s, fam) for s, fam in string_to_family.items() if fam in families]
    if known and args.threshold is None:
        kv = embed([s for s, _ in known])
        fidx = {f: i for i, f in enumerate(fams)}
        true_sims = sorted(float(kv[i] @ gloss_vecs[fidx[fam]]) for i, (_s, fam) in enumerate(known))
        thr = round(true_sims[max(0, len(true_sims) // 20)], 3)
    else:
        thr = args.threshold if args.threshold is not None else 0.541

    # --- distinct proposed relations + freq + which registers
    rel_domains = defaultdict(set); rel_freq = defaultdict(int)
    for dom, triples in by_domain.items():
        for _h, rel, _t in triples:
            r = rel.strip().lower()
            if r:
                rel_domains[r].add(dom); rel_freq[r] += 1
    rels = sorted(rel_domains)
    rv = embed(rels)                                     # (R, d)

    sims = rv @ gloss_vecs.T                             # (R, F) cosine (both normalized)
    nearest = sims.argmax(axis=1); best = sims.max(axis=1)
    covered = best >= thr

    # --- per-register coverage (distinct relations + edge-weighted)
    per_domain = {}
    for dom in by_domain:
        drels = [i for i, r in enumerate(rels) if dom in rel_domains[r]]
        if not drels:
            continue
        dcov = float(np.mean([covered[i] for i in drels]))
        wsum = sum(rel_freq[rels[i]] for i in drels)
        wcov = sum(rel_freq[rels[i]] for i in drels if covered[i]) / wsum if wsum else 0.0
        per_domain[dom] = {"distinct_coverage": round(dcov, 3), "edge_coverage": round(wcov, 3),
                           "distinct_relations": len(drels)}

    # --- cluster the GAP residue (greedy, cosine >= cluster_sim) -> your candidate pack
    gap_idx = [i for i in range(len(rels)) if not covered[i]]
    gap_idx.sort(key=lambda i: -rel_freq[rels[i]])
    clusters = []
    for i in gap_idx:
        placed = False
        for c in clusters:
            if float(rv[i] @ rv[c["centroid"]]) >= args.cluster_sim:
                c["members"].append(rels[i]); c["freq"] += rel_freq[rels[i]]; placed = True; break
        if not placed:
            clusters.append({"members": [rels[i]], "centroid": i, "freq": rel_freq[rels[i]],
                             "near_family": fams[nearest[i]], "near_sim": round(float(best[i]), 3)})
    clusters.sort(key=lambda c: -c["freq"])

    n = len(rels)
    edge_total = sum(rel_freq.values())
    edge_cov = sum(rel_freq[rels[i]] for i in range(n) if covered[i]) / edge_total if edge_total else 0
    report = {
        "threshold": thr,
        "families": len(fams),
        "distinct_relations": n,
        "distinct_coverage": round(float(covered.mean()), 3),
        "edge_coverage": round(edge_cov, 3),
        "gap_distinct": len(gap_idx),
        "gap_clusters": len(clusters),
        "per_domain": per_domain,
        "extension_candidates": [
            {"members": c["members"][:12], "size": len(c["members"]), "edge_freq": c["freq"],
             "nearest_family_below_thr": c.get("near_family"), "nearest_sim": c.get("near_sim")}
            for c in clusters if len(c["members"]) >= 2
        ],
    }
    Path(args.out).write_text(json.dumps(report, indent=1), encoding="utf-8")

    print(f"\n=== VOCAB CLOSURE (threshold {thr}; {len(fams)} families) ===")
    print(f"  distinct relations: {n}   coverage: {report['distinct_coverage']:.1%} distinct / "
          f"{report['edge_coverage']:.1%} edge-weighted")
    print(f"  gaps: {len(gap_idx)} distinct -> "
          f"{len([c for c in clusters if len(c['members']) >= 2])} multi-member clusters")
    print("  per-register distinct coverage:")
    for dom, v in sorted(per_domain.items(), key=lambda x: x[1]["distinct_coverage"]):
        print(f"    {dom:22s} {v['distinct_coverage']:.0%}  ({v['distinct_relations']} rel)")
    print("  top gap clusters (your candidate pack families):")
    for c in [c for c in clusters if len(c["members"]) >= 2][:12]:
        print(f"    [{c['freq']:4d}x] near '{c['near_family']}'({c['near_sim']}): {', '.join(c['members'][:6])}")
    print(f"\n-> {args.out}\nVOCAB_CLOSURE_DONE")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="phase", required=True)
    e = sub.add_parser("extract"); e.set_defaults(fn=extract)
    e.add_argument("--corpus-root", required=True, help="one subdir per register, *.txt inside")
    e.add_argument("--model", default="qwen72b"); e.add_argument("--host", default="http://127.0.0.1:8000")
    e.add_argument("--per-domain", type=int, default=200); e.add_argument("--concurrency", type=int, default=32)
    e.add_argument("--out", default="edges.json")
    m = sub.add_parser("map"); m.set_defaults(fn=mapcov)
    m.add_argument("--edges", default="edges.json"); m.add_argument("--out", default="coverage.json")
    m.add_argument("--ontology", default=str(ONTOLOGY_JSON))
    m.add_argument("--pack", action="append", help="pack JSON(s) to test core+pack coverage")
    m.add_argument("--embedding-model", default="BAAI/bge-large-en-v1.5")
    m.add_argument("--threshold", type=float, default=None)
    m.add_argument("--cluster-sim", type=float, default=0.60)
    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
