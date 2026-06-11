"""Command-line interface for TP-VRG demo and utilities."""

from __future__ import annotations

import argparse
import asyncio
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

from tp_vrg.data_dir import get_graph_db_path
from tp_vrg.engine import LODGraphMemory
from tp_vrg.models import CHUNK_MAX_CHARS, PROFILES
from tp_vrg.tokens import estimate_tokens


async def run_demo() -> None:
    """End-to-end demonstration of the LOD Graph Memory system."""
    print()
    print("=" * 70)
    print("  TP-VRG: Topology-Preserving Variable-Resolution Graphs")
    print("  Prototype Demo")
    print("=" * 70)

    mem = LODGraphMemory()

    raw = (
        "OpenAI, led by Sam Altman, developed GPT-4. Anthropic was founded "
        "by Dario Amodei, who previously worked at OpenAI. Both companies "
        "focus on AI Safety. Sam Altman formerly led Y Combinator."
    )

    print(f'\n  Ingesting memory:\n  "{raw[:80]}..."\n')
    result = await mem.add_memory(raw)
    print(f"  Extracted {len(result.nodes)} nodes, {len(result.edges)} edges\n")

    queries = [
        "Tell me about Sam Altman and OpenAI",
        "What is Y Combinator?",
        "Explain AI Safety",
    ]

    for i, query in enumerate(queries, 1):
        print(f"\n{'=' * 70}")
        print(f'QUERY {i}: "{query}"')
        print("=" * 70)
        ctx = await mem.get_context(query)
        print(ctx)
        mem.render_map(query)

    print(f"\n{mem.stats()}\n")


async def _query_graph(graph_file: str, query_text: str) -> None:
    """Load a saved graph and run a query against it."""
    mem = LODGraphMemory()
    mem.load(graph_file)
    print(f"Loaded graph: {mem.stats()}")

    ctx = await mem.get_context(query_text)
    print(ctx)
    mem.render_map(query_text)


async def _run_metrics(
    graph_file: str, query_text: str, profile_name: str
) -> None:
    """Load a graph, render context with a profile, and show token metrics."""
    mem = LODGraphMemory(use_semantic_scoring=True)
    mem.load(graph_file)
    print(f"Loaded graph: {mem.stats()}")
    print(f"Profile: {profile_name} (max {PROFILES[profile_name].max_tokens:,} tokens)")
    print()

    # Calculate raw context size (all nodes at LOD_0)
    all_nodes = mem._storage.get_all_nodes()
    raw_tokens = sum(estimate_tokens(n.lod_0) for n in all_nodes.values())

    # Calculate rendered context size
    rendered = await mem.render_context(query_text, profile=profile_name)
    rendered_tokens = estimate_tokens(rendered)

    # Estimate cost savings (using Claude Opus pricing: $15/MTok input)
    cost_raw = raw_tokens * 15.0 / 1_000_000
    cost_rendered = rendered_tokens * 15.0 / 1_000_000
    savings = cost_raw - cost_rendered

    print("=" * 50)
    print("  TP-VRG CONTEXT METRICS")
    print("=" * 50)
    print(f"  Raw Context:        {raw_tokens:>8,} tokens")
    print(f"  TP-VRG Rendered:    {rendered_tokens:>8,} tokens")
    if raw_tokens > 0:
        reduction = (1 - rendered_tokens / raw_tokens) * 100
        print(f"  Reduction:          {reduction:>7.1f}%")
    print(f"  Estimated Savings on Opus: ${savings:.4f}")
    print("=" * 50)


def _run_migrate(source: str, out: str | None, force: bool) -> None:
    """Migrate a JSON graph to SQLite format."""
    source_path = Path(source).expanduser().resolve()
    ext = source_path.suffix.lower()

    if ext == ".db":
        print(f"Error: '{source_path}' is already a SQLite database.", file=sys.stderr)
        sys.exit(1)
    elif ext == ".h5":
        print(
            "Error: HDF5 migration is no longer supported. "
            "Use an older tp-vrg release to migrate .h5 → .json first, "
            "then migrate .json → .db with this version.",
            file=sys.stderr,
        )
        sys.exit(1)
    elif ext != ".json":
        print(f"Error: unknown format '{ext}'. Supported: .json", file=sys.stderr)
        sys.exit(1)

    if out is not None:
        target_path = Path(out).expanduser().resolve()
    else:
        target_path = source_path.with_suffix(".db")

    if target_path.exists() and not force:
        print(
            f"Error: target '{target_path}' already exists. Use --force to overwrite.",
            file=sys.stderr,
        )
        sys.exit(1)

    from tp_vrg.storage import InMemoryBackend
    src = InMemoryBackend()
    src.load(source_path)
    passages = list(src._passages.values())

    # Remove stale target if --force
    if target_path.exists():
        target_path.unlink()

    # SQL-I1: derive the target's embedding_dim from the source's existing
    # embeddings (not from a default) so that a 1024-dim InMemoryBackend
    # migrates into a 1024-dim SQLiteBackend. Falls back to the default
    # if the source has no embeddings yet (fresh JSON graphs with nodes
    # but no vectors).
    _src_nodes = src.get_all_nodes()
    _src_dim = None
    for _n in _src_nodes.values():
        if _n.embedding is not None and len(_n.embedding) > 0:
            _src_dim = len(_n.embedding)
            break
    from tp_vrg.storage_sqlite import SQLiteBackend
    dst = SQLiteBackend(target_path, embedding_dim=_src_dim)
    if _src_dim is not None:
        print(f"  Embedding dim: {_src_dim} (auto-detected from source)")

    # Migrate nodes
    all_nodes = src.get_all_nodes()
    for node in all_nodes.values():
        dst.upsert_node(node)
    print(f"  Nodes:    {len(all_nodes)}")

    # Migrate edges
    all_edges = src.get_all_edges()
    from tp_vrg.models import EdgeData
    for src_id, tgt_id, data in all_edges:
        dst.upsert_edge(EdgeData(
            source=src_id,
            target=tgt_id,
            relation=data.get("relation", "related"),
            weight=data.get("weight", 1.0),
        ))
    print(f"  Edges:    {len(all_edges)}")

    # Migrate passages
    for p in passages:
        dst.upsert_passage(p)
    print(f"  Passages: {len(passages)}")

    dst.save(target_path)
    dst.close()
    print(f"Migration complete: {target_path} — {len(all_nodes)} nodes, {len(all_edges)} edges, {len(passages)} passages")


def _run_inspect(path: str) -> None:
    """Print a formatted health report for a SQLite graph database."""
    db_path = Path(path).expanduser().resolve()

    if not db_path.exists():
        print(f"No graph found at {db_path}. Run tp-vrg-mcp to create one.")
        sys.exit(0)

    try:
        from tp_vrg.storage_sqlite import SQLiteBackend
    except ImportError as exc:
        print(f"sqlite-vec not installed — run: pip install sqlite-vec\n({exc})", file=sys.stderr)
        sys.exit(1)

    backend = None
    try:
        backend = SQLiteBackend(db_path)
        result = backend.health_check()
    finally:
        if backend is not None:
            backend.close()

    status_icon = "✅ OK" if result["status"] == "ok" else "⚠️  DEGRADED"
    fts5_icon = "✅ in sync" if result["fts5_in_sync"] else f"❌ desync: {result['fts5_rows']} rows vs {result['node_count']} nodes"
    integrity_icon = "✅ ok" if result["integrity"] == "ok" else f"❌ {result['integrity']}"

    print(f"TP-VRG Graph Health — {db_path}")
    print("─" * 33)
    print(f"Status:       {status_icon}")
    print(f"Nodes:        {result['node_count']}")
    print(f"Edges:        {result['edge_count']}")
    print(f"Passages:     {result['passage_count']}")
    print("─" * 33)
    print(f"Embeddings:   {result['vec0_rows']} / {result['node_count']} nodes have embeddings")
    print(f"FTS5:         {fts5_icon}")
    print(f"Integrity:    {integrity_icon}")
    print(f"Components:   {result['connected_components']}")
    print(f"Orphaned:     {result['orphaned_edges']} edges")

    if result["issues"]:
        print("─" * 33)
        print("Issues:")
        for issue in result["issues"]:
            print(f"  - {issue}")


def _run_status(path: str) -> None:
    """Print a graph status summary with backbone freshness and storage info."""
    db_path = Path(path).expanduser().resolve()

    if not db_path.exists():
        print(f"No graph found at {db_path}. Run tp-vrg-mcp to create one.")
        sys.exit(0)

    try:
        from tp_vrg.storage_sqlite import SQLiteBackend
    except ImportError as exc:
        print(f"sqlite-vec not installed — run: pip install sqlite-vec\n({exc})", file=sys.stderr)
        sys.exit(1)

    backend = None
    try:
        backend = SQLiteBackend(db_path)
        result = backend.health_check()

        conn = getattr(backend, "_conn", None)

        # Backbone freshness
        backbone_count = 0
        if conn is not None:
            try:
                backbone_count = conn.execute(
                    "SELECT COUNT(*) FROM backbone"
                ).fetchone()[0]
            except sqlite3.OperationalError:
                backbone_count = 0  # table doesn't exist yet

        # Unrefined and oversized node counts
        unrefined = 0
        oversized = 0
        if conn is not None:
            try:
                unrefined = conn.execute(
                    "SELECT COUNT(*) FROM nodes WHERE is_chunk=1 AND refined=0"
                ).fetchone()[0]
                oversized = conn.execute(
                    f"SELECT COUNT(*) FROM nodes WHERE length(lod_0) > {CHUNK_MAX_CHARS} AND is_chunk=0"
                ).fetchone()[0]
            except sqlite3.OperationalError:
                pass

        size_mb = db_path.stat().st_size / (1024 * 1024)

    finally:
        if backend is not None:
            backend.close()

    backbone_str = f"cached ({backbone_count} nodes)" if backbone_count > 0 else "not cached"

    print(f"TP-VRG Graph Status — {db_path}")
    print("─" * 50)
    print(f"Nodes:        {result['node_count']}")
    print(f"Edges:        {result['edge_count']}")
    print(f"Passages:     {result['passage_count']}")
    print("─" * 50)
    print(f"Backbone:     {backbone_str}")
    print(f"Unrefined:    {unrefined} nodes")
    print(f"Oversized:    {oversized} nodes")
    print("─" * 50)
    print(f"Storage:      {size_mb:.1f} MB")


def _run_backup(source: str, destination: str | None) -> None:
    """Create a WAL-safe backup of the graph using VACUUM INTO."""
    src_path = Path(source).expanduser().resolve()
    if not src_path.exists():
        print(f"Error: graph not found at {src_path}", file=sys.stderr)
        sys.exit(1)

    if destination is None:
        timestamp = datetime.now().strftime("%Y-%m-%d-%H-%M-%S")
        dest_path = src_path.parent / f"graph.db.backup-{timestamp}"
    else:
        dest_path = Path(destination).expanduser().resolve()

    if dest_path.exists():
        print(f"Error: destination already exists: {dest_path}", file=sys.stderr)
        print("Move or remove it first, or specify a different destination.", file=sys.stderr)
        sys.exit(1)

    print(f"Backing up {src_path}")
    print(f"        -> {dest_path} ...")
    try:
        conn = sqlite3.connect(str(src_path))
        conn.execute("VACUUM INTO ?", [str(dest_path)])
        conn.close()
    except Exception as exc:
        print(f"Backup failed: {exc}", file=sys.stderr)
        sys.exit(1)

    size_mb = dest_path.stat().st_size / (1024 * 1024)
    print(f"Backup complete: {dest_path}  ({size_mb:.1f} MB)")


def _run_verify(envelope_file: str) -> None:
    """Verify a signed attestation envelope offline; exit 0 valid / 1 invalid.

    The third-party half of the IV-2 Q1 federation artifact: anyone
    holding an exported (signed) PortableArtifact or render trace can
    check its integrity without access to the producing graph. Identity
    trust additionally requires matching key_id against the signer's
    did:web document (GET /attestation/identity on the producing engine).
    """
    import json as _json

    from tp_vrg.attestation import verify_envelope

    path = Path(envelope_file)
    if not path.exists():
        print(f"  ERROR: no such file: {path}")
        sys.exit(2)
    try:
        envelope = _json.loads(path.read_text(encoding="utf-8"))
    except _json.JSONDecodeError as exc:
        print(f"  ERROR: not valid JSON: {exc}")
        sys.exit(2)

    verdict = verify_envelope(envelope)
    status = "VALID" if verdict["valid"] else "INVALID"
    print(f"\n  Attestation: {status}")
    print(f"  Reason:       {verdict['reason']}")
    print(f"  Payload type: {verdict.get('payload_type')}")
    print(f"  Payload hash: {verdict.get('payload_hash')}")
    print(f"  Signed by:    {verdict.get('signed_by')}")
    print(f"  Key id:       {verdict.get('key_id')}")
    print(f"  Signed at:    {verdict.get('signed_at')}\n")
    if verdict["valid"]:
        print(
            "  NOTE: integrity verified. Identity trust requires matching the\n"
            "  key id against the signer's did:web document.\n"
        )
    sys.exit(0 if verdict["valid"] else 1)


def _run_identity(domain: str, out: str) -> None:
    """Generate the did:web identity document (IV-2 Q2 key distribution).

    The counterpart of `tp-vrg verify`: verify proves INTEGRITY offline;
    serving this document at https://<domain>/.well-known/did.json lets a
    counterparty bind the envelope's key_id to an identity they trust.
    """
    import json as _json

    from tp_vrg.attestation import build_did_web_document, key_fingerprint, load_or_create_signing_key

    doc = build_did_web_document(domain)
    out_path = Path(out)
    out_path.write_text(_json.dumps(doc, indent=2) + "\n", encoding="utf-8")
    fingerprint = key_fingerprint(load_or_create_signing_key().public_key())
    print(f"\n  did:web identity document written: {out_path}")
    print(f"  Key id:  {fingerprint}")
    print(f"  Serve it at:  https://{domain}/.well-known/did.json")
    print(
        "  Counterparties then verify envelopes offline with `tp-vrg verify`\n"
        "  and match the envelope key_id against this document.\n"
    )


def main() -> None:
    """CLI entry point."""
    parser = argparse.ArgumentParser(
        prog="tp-vrg",
        description="TP-VRG: Topology-Preserving Variable-Resolution Graphs for LLM memory",
    )
    subparsers = parser.add_subparsers(dest="command")

    subparsers.add_parser("demo", help="Run the prototype demo")

    query_parser = subparsers.add_parser("query", help="Query a saved graph")
    query_parser.add_argument("graph_file", help="Path to a saved graph JSON file")
    query_parser.add_argument("query_text", help="The query to run")

    metrics_parser = subparsers.add_parser(
        "metrics", help="Show token savings metrics for a query"
    )
    metrics_parser.add_argument("graph_file", help="Path to a saved graph JSON file")
    metrics_parser.add_argument("query_text", help="The query to run")
    metrics_parser.add_argument(
        "--profile",
        default="research",
        choices=list(PROFILES.keys()),
        help="Token budget profile (default: research)",
    )

    migrate_parser = subparsers.add_parser(
        "migrate", help="Migrate an HDF5 or JSON graph to SQLite format"
    )
    migrate_parser.add_argument("source", help="Path to source graph (.h5 or .json)")
    migrate_parser.add_argument(
        "--out", default=None, help="Target .db path (default: <source>.db in same dir)"
    )
    migrate_parser.add_argument(
        "--force", action="store_true", help="Overwrite existing target"
    )

    inspect_parser = subparsers.add_parser(
        "inspect", help="Show health diagnostics for a SQLite graph database"
    )
    inspect_parser.add_argument(
        "--path",
        default=str(get_graph_db_path()),
        help="Path to .db file (default: ~/.tp_vrg/internal/graph.db)",
    )

    status_parser = subparsers.add_parser(
        "status", help="Show graph status (nodes, backbone freshness, storage)"
    )
    status_parser.add_argument(
        "--path",
        default=str(get_graph_db_path()),
        help="Path to .db file (default: ~/.tp_vrg/internal/graph.db)",
    )

    backup_parser = subparsers.add_parser(
        "backup", help="Create a timestamped backup copy of the graph (VACUUM INTO)"
    )
    backup_parser.add_argument(
        "destination",
        nargs="?",
        default=None,
        help="Destination path (default: timestamped file next to source)",
    )
    backup_parser.add_argument(
        "--path",
        default=str(get_graph_db_path()),
        help="Source graph path (default: ~/.tp_vrg/internal/graph.db)",
    )

    verify_parser = subparsers.add_parser(
        "verify",
        help="Verify a signed attestation envelope (PortableArtifact or render trace)",
    )
    verify_parser.add_argument(
        "envelope_file", help="Path to a signed-envelope JSON file"
    )

    identity_parser = subparsers.add_parser(
        "identity",
        help="Generate the did:web identity document publishing the signing key",
    )
    identity_parser.add_argument(
        "--domain", required=True,
        help="The domain that will serve the document (e.g. example.com)",
    )
    identity_parser.add_argument(
        "--out", default="did.json",
        help="Output path (default: ./did.json). Serve at "
             "https://<domain>/.well-known/did.json",
    )

    args = parser.parse_args()

    if args.command == "demo":
        asyncio.run(run_demo())
    elif args.command == "query":
        asyncio.run(_query_graph(args.graph_file, args.query_text))
    elif args.command == "metrics":
        asyncio.run(_run_metrics(args.graph_file, args.query_text, args.profile))
    elif args.command == "migrate":
        _run_migrate(args.source, args.out, args.force)
    elif args.command == "inspect":
        _run_inspect(args.path)
    elif args.command == "status":
        _run_status(args.path)
    elif args.command == "backup":
        _run_backup(args.path, args.destination)
    elif args.command == "verify":
        _run_verify(args.envelope_file)
    elif args.command == "identity":
        _run_identity(args.domain, args.out)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
