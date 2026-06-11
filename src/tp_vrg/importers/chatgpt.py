"""Parser for OpenAI ChatGPT ``conversations.json`` export files.

Pure-function module — no engine dependency. Reusable by the API server,
cockpit, CLI tools, or tests.

Usage::

    from tp_vrg.importers.chatgpt import parse_conversations

    conversations = parse_conversations(raw_bytes)
    for conv in conversations:
        await engine.ingest(
            conv.session_text,
            source=f"chatgpt/{conv.title[:80]}",
            event_timestamp=conv.create_time,
        )
"""

from __future__ import annotations

import json
from dataclasses import dataclass


@dataclass(slots=True)
class Turn:
    """A single user or assistant message."""

    role: str  # "user" or "assistant"
    text: str
    create_time: float | None


@dataclass(slots=True)
class ParsedConversation:
    """A parsed ChatGPT conversation ready for ingestion."""

    title: str
    session_text: str
    create_time: float  # Unix timestamp — becomes event_timestamp
    conversation_id: str
    turn_count: int


def parse_conversations(
    raw_json: bytes | str,
    *,
    min_turns: int = 2,
) -> list[ParsedConversation]:
    """Parse a ChatGPT ``conversations.json`` export.

    Args:
        raw_json: The raw JSON content (bytes or string).
        min_turns: Minimum number of valid user/assistant turns to include
            a conversation.  Conversations with fewer turns are skipped.

    Returns:
        List of parsed conversations, ordered by create_time ascending.
    """
    if isinstance(raw_json, bytes):
        raw_json = raw_json.decode("utf-8")
    data = json.loads(raw_json)
    if not isinstance(data, list):
        raise ValueError("Expected a JSON array of conversations at top level")

    results: list[ParsedConversation] = []
    for conv in data:
        parsed = _parse_single(conv, min_turns=min_turns)
        if parsed is not None:
            results.append(parsed)

    # Sort by create_time so ingestion order matches chronological order
    results.sort(key=lambda c: c.create_time)
    return results


def _parse_single(
    conv: dict,
    *,
    min_turns: int,
) -> ParsedConversation | None:
    """Parse a single conversation dict.  Returns None if it should be skipped."""
    mapping = conv.get("mapping")
    if not mapping or not isinstance(mapping, dict):
        return None

    current_node = conv.get("current_node")
    if not current_node:
        return None

    # Walk tree from current_node backwards to root
    turns = _walk_tree(mapping, current_node)
    if len(turns) < min_turns:
        return None

    title = (conv.get("title") or "").strip() or "Untitled conversation"
    create_time = conv.get("create_time") or 0.0
    conversation_id = conv.get("conversation_id", "")

    session_text = _format_session(turns, title)

    return ParsedConversation(
        title=title,
        session_text=session_text,
        create_time=float(create_time),
        conversation_id=conversation_id,
        turn_count=len(turns),
    )


def _walk_tree(mapping: dict, current_node: str) -> list[Turn]:
    """Walk from ``current_node`` backwards via parent pointers to reconstruct
    the canonical (non-branched) conversation sequence.

    Returns turns in chronological order (root → leaf).
    """
    turns: list[Turn] = []
    node_id: str | None = current_node

    # Safety: limit iterations to prevent infinite loops on malformed data
    max_depth = len(mapping) + 1
    visited: set[str] = set()

    while node_id and max_depth > 0:
        if node_id in visited:
            break  # cycle detected
        visited.add(node_id)
        max_depth -= 1

        node = mapping.get(node_id)
        if node is None:
            break

        msg = node.get("message")
        if msg is not None:
            turn = _extract_turn(msg)
            if turn is not None:
                turns.append(turn)

        node_id = node.get("parent")

    # We walked leaf → root, so reverse to get chronological order
    turns.reverse()
    return turns


def _extract_turn(msg: dict) -> Turn | None:
    """Extract a Turn from a message dict, or None if it should be skipped."""
    author = msg.get("author", {})
    role = author.get("role", "")

    # Only keep user and assistant messages
    if role not in ("user", "assistant"):
        return None

    content = msg.get("content", {})

    # Skip non-text content types (code execution results, browsing, etc.)
    content_type = content.get("content_type", "")
    if content_type and content_type != "text":
        return None

    parts = content.get("parts", [])
    # Parts can contain dicts (multimodal content) — only keep strings
    text = "\n".join(p for p in parts if isinstance(p, str) and p.strip())
    if not text.strip():
        return None

    create_time = msg.get("create_time")

    return Turn(role=role, text=text, create_time=create_time)


def _format_session(turns: list[Turn], title: str) -> str:
    """Format turns into the ingestion session format.

    Output::

        # My Conversation Title

        [User]: First message text

        [Assistant]: Response text

        [User]: Follow-up...
    """
    lines: list[str] = []
    if title and title != "Untitled conversation":
        lines.append(f"# {title}")
        lines.append("")

    for turn in turns:
        prefix = "[User]" if turn.role == "user" else "[Assistant]"
        lines.append(f"{prefix}: {turn.text}")
        lines.append("")

    return "\n".join(lines).rstrip()
