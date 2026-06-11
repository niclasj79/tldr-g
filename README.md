# TP-VRG

TP-VRG is a local-first knowledge rendering engine. It turns source material into a graph, then renders query-specific context at the right level of detail under a token budget.

It is not a RAG wrapper and not a hosted memory SaaS. Retrieval fetches chunks. TP-VRG renders context from topology, resolution, provenance, and budget constraints.

![TP-VRG launch architecture](docs/diagrams/launch-architecture-tiny.png)

## What You Can Do

- Ingest notes, documents, chats, or repo text into a local graph.
- Query the graph through Python, CLI, HTTP, MCP, or the desktop Cockpit.
- Render source-grounded context for an agent or LLM.
- Inspect citations, provenance, and signed extracts.
- Experiment with optional Water mode, where an LLM can help with query expansion, reranking, and extraction enrichment while the deterministic pipeline remains the fallback.

## Quickstart

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -e .
python examples/quickstart.py
```

On macOS/Linux, activate with `source .venv/bin/activate`.

For the public smoke tests, install the dev extra and run:

```bash
pip install -e ".[dev]"
python -m pytest tests/test_public_smoke.py tests/test_water.py tests/test_component_registry.py tests/adapters/test_contracts.py tests/adapters/test_registry.py -q
```

## Minimal Python Example

```python
import asyncio
from tp_vrg import LODGraphMemory

async def main():
    mem = LODGraphMemory()
    await mem.ingest(
        "OpenAI, led by Sam Altman, developed GPT-4. "
        "Anthropic was founded by Dario Amodei, who previously worked at OpenAI. "
        "Both companies focus on AI safety."
    )
    context = await mem.render_context("How are OpenAI and Anthropic connected?", profile="chat")
    print(context)

asyncio.run(main())
```

## Main Surfaces

- `tp-vrg`: CLI demo and utilities.
- `tp-vrg-mcp`: MCP server for agent clients.
- `tp-vrg-api`: HTTP API for local apps and tools.
- `tp-vrg-cockpit`: local desktop Cockpit.
- `tools/provenance_audit.py`: verifies that cited text exists in the source material.

## Open Boundary

This launch repo exposes the runnable local ingest-to-render pipeline and proof contracts: sources to passages/assets, graph/rungs, render selector, rendered answer, provenance, and trace.

Production tuning, advanced Janitor optimization, enterprise operations, and production federation tooling remain internal for now.

## Status

Private launch candidate. Do not publish until `PUBLICATION_CHECKLIST.md` is green.
