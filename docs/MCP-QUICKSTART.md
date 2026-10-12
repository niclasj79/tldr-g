# Give your agent an auditable memory — in five minutes

TLDR-G ships an MCP server, `tldr-g-mcp`, so any MCP client (Claude Desktop, Cursor, Cline, or your own) can use a local knowledge graph as a tool. Everything runs on your machine: no API key, no account, no data leaving the box.

The part worth your attention is the last tool in the list. Your agent can hand back a **signed receipt** for an answer, and anyone can check that receipt offline — including with [`verify.html`](../verify.html), which needs no install at all.

---

## 1. Install the engine

Download the installer from the [Releases](../../releases) page or [tldr-g.ai](https://tldr-g.ai), and run it. That gives you two executables:

- `TLDR-G-Cockpit.exe` — the desktop app
- `tldr-g-mcp.exe` — the MCP server your agent talks to

**Requirements:** Windows 10/11 (64-bit). An NVIDIA GPU with ≥4 GB VRAM is strongly recommended; CPU-only works but ingest and query are roughly 20–50× slower. Budget ~11 GB of free disk (1.9 GB installer, ~5 GB unpacked, ~4.2 GB of models downloaded once on first launch). On a machine with no internet, use the offline model pack from Releases instead. *macOS and Linux are fast-follow.*

> Run the Cockpit once before wiring up MCP. First launch downloads the models, and it's easier to watch that finish in a window than to wonder why your agent's first tool call is slow.

## 2. Point your client at it

**Claude Desktop** — edit `claude_desktop_config.json`:

- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "tldr-g": {
      "command": "C:\\Program Files\\TLDR-G\\tldr-g-mcp.exe"
    }
  }
}
```

Adjust the path if you installed elsewhere. Restart the client — the tools appear under the MCP icon.

**Cursor / Cline / others:** the same shape. The server speaks MCP over stdio, so any client that can launch a command works; it needs no port, no URL, and no token.

## 3. Check it works

Ask your agent:

> Use the tldr-g tools to check the engine's health, then tell me how many nodes are in the graph.

It should call `tp_vrg_health` and report back. An empty graph is the expected answer before you ingest anything.

## 4. The five-minute loop

```
You:  Ingest this into tldr-g: "The Halland contract was signed on 12 March 2024
      by IngridÖberg. It supersedes the 2019 framework agreement."

      (agent calls tp_vrg_ingest)

You:  Now ask tldr-g who signed the Halland contract, and export a signed receipt
      for the answer.

      (agent calls tp_vrg_query, then tp_vrg_export_trace)
```

You now have a JSON receipt. Open [`verify.html`](../verify.html) in any browser — offline, no install — and drop the file in. Change one character of the answer text and drop it in again: it fails. That is the whole trust story, and your agent produced it.

---

## The tools

| Tool | What it does |
|---|---|
| `tp_vrg_ingest` | Add text to the graph (`text`, optional `source`, optional `event_timestamp`) |
| `tp_vrg_query` | Render query-specific context under a token budget (`question`, optional `token_budget` — see the note below) |
| `tp_vrg_explain` | Show the provenance behind an answer (`answer_id`) |
| `tp_vrg_export_trace` | Export the answer + citations as a **signed** receipt (`answer_id`, `sign`) |
| `tp_vrg_question_bank` | Questions the current graph implies — useful for agent self-orientation |
| `tp_vrg_extract_source` / `tp_vrg_extract_asset` / `tp_vrg_extract_community` | Export a portable subgraph (the GDPR Art-20 shape) |
| `tp_vrg_delete_source` / `tp_vrg_delete_asset` | Cascading deletion (the erasure path) |
| `tp_vrg_move_source` / `tp_vrg_move_asset` | Re-file content between communities |
| `tp_vrg_metrics` / `tp_vrg_health` | Engine state |
| `tp_vrg_janitor` | Maintenance tasks (backbone rebuild, merges) |
| `tp_vrg_clear` / `tp_vrg_reset_stats` | Destructive — both require `confirm: true` |

### `tp_vrg_query`'s token budget

`token_budget` now defaults to nothing rather than to a literal 10000, so the
tool can tell "no budget was named" apart from "the caller asked for exactly
10000". On a plain install this is invisible: an omitted budget still resolves
to 10000. The distinction only matters when a measurement profile with its own
frozen ceiling is active, and in that case an omitted budget defers to the
active profile's ceiling instead of always receiving a flat 10000 — which
brings `tp_vrg_query` into agreement with how `/query` already behaved.

### What `tp_vrg_query` says about how it chose

A `tp_vrg_query` result carries `render_plan.summary`: a few short sentences
on what was considered for the question, what was used, what was left out and
why, and which documents the used passages came from (named, not linked). Show
`summary.lines` to a person as they are, in order. The same account is split
into `considered`, `used`, `left_out` and `sources` for code; `sources` is
`null` when a result did not report them, which is not the same as none. The
key is additive: every other key in `render_plan` keeps its shape. When a
request kept no record, the summary's first line says so. A query against an
empty knowledge graph, or one that fails, returns no `render_plan` at all, so
check for the key before you read it.

### `tp_vrg_query` is not a search tool

This is the one thing worth understanding before you build against it. It does not return "the top-k chunks." It **renders** a view of the graph for that question, choosing a level of detail per region under the token budget you gave it — verbatim where the question is specific, summarised where it only needs context, omitted where it is irrelevant.

Practically, for an agent author:

- **Pass a real `token_budget`.** It is the control surface, and a hard limit: the context never exceeds it. What does not fit is left out, and the response's `render_plan` names what was left out and why. Vary the budget and compare the render plans to see what a tighter budget gives up.
- **Ingest at the grain you'll ask at.** The graph connects across documents, so several small related ingests generally beat one large blob.
- **Reach for `tp_vrg_export_trace` whenever the answer matters.** It is the difference between an agent that asserts and an agent that can be checked.

## Destructive tools, and being honest about the current posture

`tp_vrg_clear`, `tp_vrg_delete_source`, `tp_vrg_delete_asset`, and the janitor's mutating tasks change or remove data. `clear` and `reset_stats` require an explicit `confirm: true`.

**Know what this is today:** the server is designed for a single operator on their own machine, and it trusts its client. An agent that can be steered by untrusted input — a web page, an email, a document it was asked to summarise — is an agent that can be steered into calling a destructive tool. That is the standard prompt-injection surface for any MCP tool with side effects, and TLDR-G is no exception.

Until server-side capability gating ships, treat the destructive tools as you would `rm`: only expose them to agents processing input you trust, and keep a backup of the graph file if it holds anything you care about. A hardening track — localhost-only defaults, token auth, a read/admin capability split, and destructive operations off by default — is in progress.

If you are building something where that matters, we would like to hear about it: **`niclas@tldr-g.ai`**.

---

## Where to go next

- [`verify.html`](../verify.html) — verify a receipt with no install, offline
- [`docs/contracts/render-trace-v1.md`](contracts/render-trace-v1.md) — the receipt format your agent is producing
- [`docs/contracts/portable-artifact-v1.md`](contracts/portable-artifact-v1.md) — the subgraph export format
- [`docs/contracts/third-party-verify-walkthrough.md`](contracts/third-party-verify-walkthrough.md) — verifying as a third party who trusts nobody
- [`examples/quickstart.py`](../examples/quickstart.py) — sign, verify, tamper, in ~20 lines with no engine at all
