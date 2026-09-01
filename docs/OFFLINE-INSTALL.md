# Installing TLDR-G without internet access

TLDR-G runs entirely on your machine. Until now, *installing* it did not: the
app downloaded ~4.6 GB (4.24 GiB) of model weights from Hugging Face on first launch. On a
machine with no egress — an air-gapped network, a regulated enclave, an HPC
compute node — that first launch simply failed.

The **offline model pack** closes that. It is a separate, checksummed artifact
containing exactly the model weights the engine loads, at exactly the revisions
it pins. You move two files instead of one, and nothing reaches the network.

## Which pack you need

The engine needs different models to *build* a graph than to *query* one. The
query path embeds your question and reads the graph; it never runs the entity
extractor or the coreference resolver. So a machine that only answers questions
against a graph built elsewhere needs a third of the weights.

| Pack | Contains | Size | Use it when |
|---|---|---|---|
| **render** | `bge-large-en-v1.5` | **1.25 GiB** (12 files) | the machine only queries an existing graph |
| **full** | + `gliner2-base-v1`, + `lingmess-coref` | **4.24 GiB** (29 files) | the machine ingests documents (the normal desktop install) |

If you are installing the Cockpit to use it end to end, you want **full**.

## Install

**1. Get the pack onto the target machine.**

The **render** pack is a single file on the Releases page. Download and unzip it.

The **full** pack is 4.24 GiB, which exceeds the 2 GiB limit on a single release
asset, so it ships as **three numbered volumes** plus two small files. Download
all five:

```
tldrg-model-pack-full.tar.001     1.77 GiB
tldrg-model-pack-full.tar.002     1.77 GiB
tldrg-model-pack-full.tar.003     0.70 GiB
SPLIT-MANIFEST.json
join_model_pack.py
```

`SPLIT-MANIFEST.json` is not optional. It records the volume **order** and a
digest for each — without it the order is a guess, and a wrong order produces a
corrupt pack rather than an error.

Then rejoin them, which needs only a Python 3 interpreter:

```bash
python join_model_pack.py <folder-with-the-volumes> --out D:\tldr-g-models
```

It checks every volume against the manifest *before* extracting anything, so a
truncated or corrupted download fails in place rather than half-writing 4 GB.
Volumes that are individually intact but assembled in the wrong order are caught
too, by a digest over the whole archive.

Approved removable media is a supported path for all of this; that is much of
the point. Five files instead of one is how regulated IT moves artifacts anyway.

**2. Unpack it** anywhere the account running TLDR-G can read. A drive with
5 GB free is enough for `full`.

```
D:\tldr-g-models\
  MANIFEST.json
  verify_model_pack.py
  hub\
    models--BAAI--bge-large-en-v1.5\...
    models--fastino--gliner2-base-v1\...
    models--biu-nlp--lingmess-coref\...
```

**3. Verify it before you trust it.** The pack ships its own verifier. It needs
only a Python 3 interpreter — no `pip install`, no network, no TLDR-G:

```bash
python D:\tldr-g-models\verify_model_pack.py D:\tldr-g-models
```

`OK - 29 files, 4.2 GB verified.` and exit code 0 means every file matched its
recorded SHA-256. Exit code 1 means a file is missing, altered, truncated, or
that the directory holds a file the manifest does not name. Exit code 2 means
the pack itself is unreadable — usually an incomplete copy rather than a
corrupted one.

**4. Point the engine at it** by setting two environment variables before
launching, then install and run TLDR-G normally:

```bash
setx HF_HOME D:\tldr-g-models
setx HF_HUB_OFFLINE 1
```

`HF_HOME` tells the model loader where to look. `HF_HUB_OFFLINE=1` is the part
worth setting deliberately: it makes any attempt to reach the network **fail
loudly** rather than hang against a blocked route. On an air-gapped machine a
silent hang is indistinguishable from slow model loading, and you will spend the
difference finding out.

Skip `TPVRG_FIRST_RUN_FETCH` — with the pack in place there is nothing to fetch.

## What the pack does and does not guarantee

**It pins bytes.** Every file carries a SHA-256 in `MANIFEST.json`, and the
model revisions come from the engine's own `REQUIRED_MODELS`, so the weights on
the target machine are the weights the release was built and tested against. Two
machines installing a month apart get identical models.

**It does not stop a stale local cache from winning — but the engine now says
so.** If the target machine already has a `~/.cache/huggingface` holding a
*different* revision of one of these models and `HF_HOME` is not set, the
engine will resolve that instead. Since 2026-08-29 that is no longer silent: at
startup the engine checks which revision the cache would actually serve against
the pinned one, logs a mismatch as an unmissable error naming both shas, and
reports it on `/health` under `model_revision_pins` (`status`: `ok` /
`mismatch` / `unverifiable`). Set `HF_HOME` explicitly; do not rely on the pack
being the only cache present. The residual gap: the graph *recipe* still
records the model name, not its bytes, so two graphs built either side of a
mismatch remain structurally divergent — the check makes the divergence
visible, it does not make the graphs comparable.

**`TPVRG_STRICT_MODEL_PIN=1`** turns that detection into a refusal: the engine
does not start unless the cache *provably* serves every pinned revision. A
mismatch refuses, and so does an unverifiable cache (one with no `refs/main`
record) — a regulated install must be able to prove the pin, not merely fail to
disprove it. Set it on regulated installs and in CI alongside `HF_HOME` and
`HF_HUB_OFFLINE`; leave it unset on ordinary desktops, where a cache predating
the pins would otherwise refuse to start over models that work. A pack
installed per this document verifies cleanly: the pack writes `refs/main` at
the pinned sha, which is exactly what the check reads.

**It does not carry the spaCy pipeline.** `en_core_web_sm` is bundled inside the
Windows installer by the PyInstaller build, so the installer path is covered. If
you are running from source offline you need it separately:

```bash
pip install --no-index en_core_web_sm-3.8.0-py3-none-any.whl
```

**It does not carry an answer model.** TLDR-G's deterministic core needs no LLM
— it renders the context and you read it. For generated answers, point the
Cockpit at a local Ollama instance; nothing in this pack is required for that
and nothing in it talks to a cloud provider.

## Licences

The pack redistributes model weights authored by others, unmodified, at the
revisions named in `MANIFEST.json`. Every pack carries a `LICENSES.md` listing
each model's licence, copyright holder, source, and the exact revision included.
As of the 2026-08-28 build:

| Model | Licence |
|---|---|
| `BAAI/bge-large-en-v1.5` | MIT (FlagEmbedding) |
| `fastino/gliner2-base-v1` | Apache-2.0 |
| `biu-nlp/lingmess-coref` | MIT |

All three permit redistribution. If you pass a pack onward, pass `LICENSES.md`
with it — that is what both licence families require, and it is why the file is
inside the pack rather than in a repository you would have to go and find.

## Verifying the offline claim yourself

The engine should never touch the network once the pack is in place. On a
machine that has internet, you can prove that rather than take it on trust:

```bash
set HF_HOME=D:\tldr-g-models
set HF_HUB_OFFLINE=1
set TRANSFORMERS_OFFLINE=1
```

With those set, any code path that tries to reach Hugging Face raises
immediately instead of succeeding quietly. If the Cockpit ingests a document
and answers a question with all three set, it did so without the network. That
is the same check the release runs before shipping a pack, and it is the check
that caught a pack which resolved every model correctly and could not load one
of them.

## Building a pack yourself

From a repo checkout on a machine that *has* egress, with the models already
fetched into its Hugging Face cache:

```bash
python tools/build_model_pack.py --profile full --out C:\tmp\tldrg-pack-full
```

The builder refuses to substitute a revision. If the pinned revision is not in
the source cache it stops and names both the revision it wanted and the ones it
found, rather than building a correct-looking pack around the wrong weights.
