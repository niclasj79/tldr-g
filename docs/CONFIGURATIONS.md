# Configurations and requirements

TLDR-G runs in two kinds of configuration. Both use the same engine and the same graph, and both return a signed receipt with every result.

- **The raw configuration (the deterministic floor).** The engine ingests your documents, builds the graph and renders the evidence for each question. It uses three small local models and no generative model. Nothing leaves your machine. You, or your own agent over MCP, read the evidence and write the answer.
- **The production configurations (LLM-powered).** The same floor, plus a language model in one or both of the two model slots below. You choose, per slot, between a hosted model (no local LLM, nothing extra to install) and a local one (your data stays on your machine).

**Which one fits.** For personal use, a hosted answer model is the easiest start. Organizations with confidentiality duties keep both slots local, or run the raw configuration, which sends nothing anywhere.

## The raw configuration (the deterministic floor)

| | |
|---|---|
| **What runs** | Entity and relation extraction (GLiNER2), coreference (LingMess, English) and the embedder (bge-large-en-v1.5), all local, all in the installer's model download |
| **Operating system** | Windows 10 or 11, 64-bit. macOS and Linux are fast-follow. |
| **Graphics card** | An NVIDIA GPU with 4 GB of video memory or more is strongly recommended (a GTX 1060 6 GB or better). It also runs on CPU only, with slower ingest and queries. |
| **Memory** | 16 GB of RAM recommended |
| **Disk** | About 12 GB free: the installer is 1.9 GB, it unpacks to about 5 GB, and about 4.6 GB of models download once on first launch (or come from the offline model pack) |
| **Network** | Only for the first model download. None at all with the offline model pack. |

## The production configurations: the model slots

A model slot is a place where a language model can do part of the work. Each slot has its own tiers. The local tiers run through [Ollama](https://ollama.com), which you install separately, and each local model needs video memory of its own on top of the engine's. Before you pick a local answer model, the Cockpit compares its size with the card's free memory and warns you if it will not fit.

### Slot 1: the answer model (writes the answer from the rendered evidence)

Chosen in the Cockpit's answer view: the provider, then the model (every model Ollama has pulled is listed), and for a hosted provider your API key. The same choice is available through the API's `/answer`. Not used by `/query`, by the Cockpit's *Context only* setting, or by an agent over MCP, which writes its own answer.

| Tier | Provider and model | Model memory (about) | Suggested graphics card | Where the evidence goes |
|---|---|---|---|---|
| **Hosted** (no local LLM) | OpenAI (default `gpt-4o-mini`) or OpenRouter (default `openai/gpt-4o-mini`) | None on your machine | As for the raw configuration, plus an internet connection | The rendered evidence for each question goes to that provider |
| **Local, small** | Ollama, `llama3.2` (the default, 3 B parameters) | 2 to 3 GB | 8 GB | Stays on your machine |
| **Local, mid-size** | Ollama, a 7 to 9 B model of your choice | 5 to 7 GB | 12 GB | Stays on your machine |
| **Local, large** | Ollama, a 20 to 30 B model of your choice | 14 to 20 GB | 24 GB | Stays on your machine |

### Slot 2: extraction (reads your documents at ingest)

Set with the environment variable `TPVRG_EXTRACTION_MODE` before the app starts; the Cockpit has no switch for it yet. Changing it changes how the graph is built, so re-ingest your documents afterwards.

| Tier | Mode and default model | Model memory (about) | Suggested graphics card | Where your documents go |
|---|---|---|---|---|
| **Default** (the floor) | `gliner`: GLiNER2, in the installer | None extra | As for the raw configuration | Stay on your machine |
| **Local LLM** | `local`: Ollama, `qwen2.5-coder:7b` | 5 to 6 GB | 12 GB | Stay on your machine |
| **Hosted** (no local LLM) | `api`: Anthropic's API (a Claude model, default `haiku`), with `ANTHROPIC_API_KEY` set | None on your machine | As for the raw configuration, plus an internet connection | The text of each document goes to Anthropic |

Each release is measured on the default extraction. The other two modes are supported but not measured on this release.

## How the numbers were found

A local model's memory is its published 4-bit download size plus room for its context. The suggested card adds the 4 GB the raw configuration recommends, rounded up to a common card size. We have not yet measured each pairing with the engine running beside it, so treat these as a guide, and if the Cockpit warns you, believe the warning: a model that does not fit slows the whole computer rather than just the answer.
