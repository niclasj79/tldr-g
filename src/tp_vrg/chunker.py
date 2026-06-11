"""Semantic text chunking for Atomic LOD0."""

import os
import re


def get_token_count(text: str) -> int:
    """Estimate token count using tiktoken (cl100k_base)."""
    try:
        import tiktoken
        encoding = tiktoken.get_encoding("cl100k_base")
        return len(encoding.encode(text))
    except Exception:
        return len(text) // 4  # rough fallback: ~4 chars/token


class DeterministicChunker:
    """
    Chunks text by semantic boundaries: headers → paragraphs → sentences.

    Respects both semantic boundaries (headers, paragraph breaks) and token limits.
    Does NOT call any LLM — fully deterministic.

    Target: ~384 tokens per chunk — aligned to bge-large-en-v1.5 (512-token max seq length).
    Hard max: 480 tokens — guarantees zero truncation in passage embeddings.
    Minimum: 80 tokens (avoids micro-chunks that waste extraction calls)

    Splitting order:
    0. Tables (markdown) — extract as single chunks (never split)
    1. Markdown headers (# ## ### etc.) — preserve semantic sections
    2. Paragraphs (double newlines)
    3. Sentences (period/exclamation/question boundaries)
    """

    # Chunk sizes aligned to bge-large-en-v1.5 max_seq_length (512 tokens).
    # TARGET at 75% of 512 leaves headroom for the contextual embedding prefix
    # ("From: {source}", ~10-30 tokens) and tiktoken-vs-model tokenizer variance.
    # MAX must be < 512 to guarantee zero truncation in passage embeddings.
    # See: 2026-04-06 discovery that all prior benchmarks ran with silently
    # truncated embeddings (old TARGET=500, MAX=1000 exceeded the 512-token window).
    TARGET_TOKENS = int(os.environ.get("TPVRG_CHUNK_TARGET_TOKENS", "384"))
    MAX_TOKENS    = 480  # Hard ceiling below 512 — never truncate a passage embedding
    MIN_TOKENS    = 80   # Proportional minimum (was 100 at TARGET=500)

    # Markdown table: 2+ consecutive lines starting and ending with |
    _MD_TABLE_RE = re.compile(
        r"((?:^[ \t]*\|.+\|[ \t]*\n){2,})",
        re.MULTILINE,
    )
    # Separator row confirms it's a real table (|---|, |:---:|, etc.)
    _MD_TABLE_SEP_RE = re.compile(r"^\|[\s:]*-+", re.MULTILINE)

    @classmethod
    def _extract_tables(cls, text: str) -> tuple[str, list[str]]:
        """Detect and extract markdown table blocks from text.

        Returns (text_with_tables_removed, list_of_table_blocks).
        Tables are preserved as single chunks to maintain row/column
        structure — they should never be split across chunk boundaries.

        Detection: consecutive lines starting and ending with ``|`` (pipe),
        with at least one separator row containing dashes (``|---|``).
        """
        tables: list[str] = []
        replacements: list[tuple[str, str]] = []

        for match in cls._MD_TABLE_RE.finditer(text):
            block = match.group(1).strip()
            # Must contain a separator row to be a real table
            if cls._MD_TABLE_SEP_RE.search(block):
                placeholder = f"\x00TABLE{len(tables)}\x00"
                replacements.append((match.group(1), placeholder))
                tables.append(block)

        text_without = text
        for original, placeholder in replacements:
            text_without = text_without.replace(original, placeholder)

        return text_without, tables

    @classmethod
    def _split_by_headers(cls, text: str) -> list[tuple[str, str]]:
        """
        Split text on markdown headers (# ## ###), returning (section_name, section_text) pairs.

        Returns: List of (header_or_empty, content) tuples, where:
          - header_or_empty: The header line (if found) or empty string
          - content: All text until the next header
        """
        # Match markdown headers: # (h1), ## (h2), ### (h3), etc.
        # Split on these while preserving the header text
        header_pattern = r"^(#{1,6})\s+(.+)$"

        lines = text.split("\n")
        sections = []
        current_header = ""
        current_content = []

        for line in lines:
            match = re.match(header_pattern, line)
            if match:
                # Found a new header
                if current_content:
                    sections.append((current_header, "\n".join(current_content).strip()))
                    current_content = []
                current_header = line  # Keep full header line
            else:
                current_content.append(line)

        # Don't forget the last section
        if current_content:
            sections.append((current_header, "\n".join(current_content).strip()))

        return sections

    @classmethod
    def _apply_overlap(cls, chunks: list[str], n: int) -> list[str]:
        """Prepend the last *n* sentences of chunk K to chunk K+1 (Layer 1).

        Gives the extractor cross-boundary context so relationships spanning
        chunk boundaries are visible to extraction. Entity and edge dedup is
        handled by the normalizer + upsert PRIMARY KEY.
        """
        result = [chunks[0]]  # first chunk unchanged
        for k in range(1, len(chunks)):
            prev_sents = re.split(r"(?<=[.!?])\s+", chunks[k - 1])
            overlap = prev_sents[-n:] if len(prev_sents) >= n else prev_sents
            result.append(" ".join(overlap) + "\n\n" + chunks[k])
        return result

    @classmethod
    def chunk(cls, text: str, overlap_sentences: int = 2) -> list[str]:
        """
        Chunk text respecting headers, then paragraphs, then sentences.

        Args:
            text: The document to chunk.
            overlap_sentences: Number of trailing sentences from chunk K to
                prepend to chunk K+1 (Layer 1 overlap windows). Default 2.
                Set to 0 to disable overlap.

        Returns a list of chunk strings, each under the target token limit.
        """
        chunks: list[str] = []

        # Phase 0: Extract tables — they become their own chunks (never split)
        text_for_chunking, table_blocks = cls._extract_tables(text)

        # First, split by headers to preserve semantic boundaries
        header_sections = cls._split_by_headers(text_for_chunking)

        if not header_sections or (len(header_sections) == 1 and not header_sections[0][0]):
            # No headers found, use simple paragraph-based chunking
            paragraphs = [p.strip() for p in text_for_chunking.split("\n\n") if p.strip()]
        else:
            # Process each header section and chunk by paragraphs/sentences
            # Rebuild paragraphs from sections while preserving headers
            all_parts = []
            for header, content in header_sections:
                if header:
                    all_parts.append(header)
                paragraphs = [p.strip() for p in content.split("\n\n") if p.strip()]
                all_parts.extend(paragraphs)
            paragraphs = all_parts

        # Now apply paragraph + sentence-level chunking with token limits
        current: list[str] = []
        current_tokens = 0

        for para in paragraphs:
            para_tokens = get_token_count(para)

            # Single paragraph/header bigger than hard max → split by sentences
            if para_tokens > cls.MAX_TOKENS:
                if current and current_tokens >= cls.MIN_TOKENS:
                    chunks.append("\n\n".join(current))
                    current, current_tokens = [], 0

                sent_chunk: list[str] = []
                sent_tokens = 0
                # Split on sentence boundaries: . ! ? followed by space
                for sent in re.split(r"(?<=[.!?])\s+", para):
                    st = get_token_count(sent)
                    if sent_tokens + st > cls.MAX_TOKENS and sent_chunk:
                        chunks.append(" ".join(sent_chunk))
                        sent_chunk, sent_tokens = [sent], st
                    else:
                        sent_chunk.append(sent)
                        sent_tokens += st
                if sent_chunk:
                    chunks.append(" ".join(sent_chunk))

            # Would exceed target → flush current chunk first
            elif current_tokens + para_tokens > cls.TARGET_TOKENS and current:
                chunks.append("\n\n".join(current))
                current, current_tokens = [para], para_tokens

            else:
                current.append(para)
                current_tokens += para_tokens

        if current and current_tokens >= cls.MIN_TOKENS:
            chunks.append("\n\n".join(current))

        # Layer 1: overlap windows — prepend trailing sentences from chunk K
        # to chunk K+1 so the extractor sees cross-boundary context.
        # Applied only to text chunks; table chunks are appended after.
        if overlap_sentences > 0 and len(chunks) > 1:
            chunks = cls._apply_overlap(chunks, overlap_sentences)

        # Append table chunks — preserved as single units (no overlap)
        chunks.extend(table_blocks)

        return chunks
