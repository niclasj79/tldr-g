# FAQ

## How do I ingest a whole folder or repo?

In the Cockpit, drop a folder onto the Ingest Files panel, or click **Select folder…**. Subfolders are walked automatically; `.git`, `node_modules`, `.venv`, `__pycache__`, and other dot-prefixed directories are skipped.

Watching a folder for new files is not available in the packaged app yet. For now, drop the folder again after changes.

## What about code files?

Not supported today. The ingestible types are `.txt`, `.md`, `.markdown`, `.text`, `.pdf`, `.docx` — the same list the Cockpit's file picker and folder walk both filter against.

## GPU vs CPU?

The engine picks up an available NVIDIA GPU automatically. An NVIDIA GPU with at least 4 GB VRAM is strongly recommended — ingest and query both run, but substantially slower, on CPU only.

## Can I connect a database like Postgres?

No. TLDR-G ingests documents, not database connections — there's no Postgres or other external-database integration in the engine.

## Where is my graph stored?

By default, `~/.tp_vrg/internal/graph.db` (a local SQLite file). Set the `TP_VRG_HOME` environment variable to use a different data directory instead — everything under it moves with it.

## How do I use it from Claude Desktop or Cursor?

`tp-vrg-mcp` is an MCP server any agent client can call as a tool. See [docs/MCP-QUICKSTART.md](MCP-QUICKSTART.md) for the five-minute wiring guide.

## How do I do an offline install?

See [docs/OFFLINE-INSTALL.md](OFFLINE-INSTALL.md) — the offline model pack lets an air-gapped or regulated machine install without reaching a third party.

## How do I clear the graph?

In the Cockpit, the **Clear Graph** button (in the danger zone of the Ingest panel) wipes the active graph. It's an admin-only action — a read-capability token can't reach it.

## How do I verify a receipt?

Open [verify.html](../verify.html) in any browser and drop a receipt on it. No install, no network — it works offline from a `file://` URL. The `tp-vrg-verify` CLI does the same three checks (payload hash, key-id binding, Ed25519 signature) for anyone who already has a terminal open.
