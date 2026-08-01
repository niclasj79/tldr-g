# Known-technique check

**Fires before:** hand-writing any deterministic component — splitting text, matching strings, ranking, normalizing, classifying, parsing, deduplicating, scoring.

**The tell:** you are about to write the *simple version* with a mental note to improve it later.

**Does not fire for:** genuinely novel work where no established technique applies, or for anything whose behaviour is inherently approximate and model-driven. This is about deterministic components with known solutions.

---

## The failure it prevents

The simple version ships. It works well enough that nobody revisits it. Six months later its shortcomings surface as a quality problem that reads like a hard research question, and the actual answer was a well-known library function available on day one.

The cost is not the rewrite. It is the months of results produced by the weaker version, and the effort spent diagnosing them as something else.

## The check

Four questions, about two minutes:

1. **Name the problem in standard terms.** Not "splitting the text sensibly" — *sentence segmentation*. Not "matching names" — *fuzzy string matching* or *record linkage*. If you cannot name it, that is the first thing to find out, because unnamed problems cannot be searched.
2. **Name the established solution.** For most text and data work it is a library you likely already have. Sentence segmentation, lemmatization, phonetic matching, edit distance, TF-IDF, rank fusion, clustering, hierarchy-aware deduplication — all solved, all packaged, all better tested than what you are about to write.
3. **Is it within reach?** Already a dependency, or a small well-maintained one? Then the good version costs about the same as the simple version.
4. **If it is not in reach, write down why.** "Not adopting X because it pulls a 200 MB dependency for one function" is a decision. Silence is a decision too — a worse one, made by nobody.

## The half that matters most

**Naming the problem correctly is most of the value.** A search for "how to split text into chunks" returns blog posts. A search for "sentence boundary disambiguation" returns thirty years of work and three libraries that do it properly. The gap between those two searches is the gap between the simple version and the right one.

## Keep a log

List each time the simple version shipped first and later had to be redone. Ours has eight entries. The list is more persuasive than the rule, because it is specific and it is yours — and it is what makes the two-minute check feel obviously worth it rather than like ceremony.

---

Part of the [TLDR-G](https://tldr-g.ai) agent-harness starter kit. Apache-2.0.
