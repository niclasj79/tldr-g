"""
Temporal extraction and normalization for TP-VRG.

Two subsystems:

1. **F14 Temporal Extraction** (ingestion-time + janitor retroactive):
   Extracts years from LOD_0 text → passage temporal ranges + TEMPORAL_ANCHOR
   node creation. Powers temporal retrieval, scoring, and rendering.

2. **Relative Date Normalization** (render-time, Liquid LOD Phase B):
   Converts relative temporal expressions ("last year", etc.) to concrete dates
   using session date embedded in LOD_0 text. Applied at render time only.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta

import dateparser
from dateparser.search import search_dates


# ---------------------------------------------------------------------------
# F14 — Temporal Extraction (ingestion-time + janitor)
# ---------------------------------------------------------------------------

# dateparser-backed year extraction is deterministic via RELATIVE_BASE.
_YEAR_MIN = 1000
_YEAR_MAX = 2099
_DATEPARSER_SETTINGS = {
    "PREFER_DAY_OF_MONTH": "first",
    "PREFER_MONTH_OF_YEAR": "first",
    "RELATIVE_BASE": datetime(2000, 1, 1),
}


@dataclass
class TemporalExtraction:
    """Result of temporal extraction from a text passage."""

    temporal_min: int | None  # earliest year found (e.g. 1944)
    temporal_max: int | None  # latest year found
    anchor_years: list[int] = field(default_factory=list)  # unique years, sorted
    sentence_years: dict[int, list[int]] = field(
        default_factory=dict
    )  # sentence_index → [years in that sentence]


# SOTA: Temporal event extraction — inspired by Chronos (arXiv:2603.16862, Sen et al., 2026)
# Chronos uses structured event tuples with dual calendar system for 95.6% LongMemEval.
# Our adaptation: spaCy DATE entity extraction + regex year patterns for broader
# temporal coverage. Catches "January 25, 2026", "Q3 2025", "fiscal year 2026"
# that the regex-only approach misses. Full event tuple system is a future steal.

# Patterns for temporal expressions that dateparser does not model directly.
_QUARTER_PATTERN = re.compile(r"\bQ([1-4])\s*((?:20|1[0-9])[0-9]{2})\b", re.IGNORECASE)
_FISCAL_YEAR_PATTERN = re.compile(r"\bfiscal\s+year\s+((?:20|1[0-9])[0-9]{2})\b", re.IGNORECASE)
_DECADE_PATTERN = re.compile(r"\b(?:(early|mid|late)\s+)?((?:19|20)[0-9]0)s\b", re.IGNORECASE)
_NUMERIC_TOKEN_PATTERN = re.compile(r"(?<!\d)\d{4}(?!\d)")


def _valid_year(year: int) -> bool:
    return _YEAR_MIN <= year <= _YEAR_MAX


def _add_parsed_year(years: set[int], text: str) -> None:
    parsed = dateparser.parse(text, settings=_DATEPARSER_SETTINGS)
    if parsed is not None and _valid_year(parsed.year):
        years.add(parsed.year)


def extract_years(text: str) -> list[int]:
    """Extract temporal anchor years with dateparser plus phrase semantics.

    ``dateparser.search.search_dates`` covers ordinary date strings and
    standalone years. Small deterministic phrase adapters preserve quarter,
    fiscal-year, and qualified-decade semantics that dateparser does not
    expose as year anchors directly.
    """
    years: set[int] = set()

    for m in _QUARTER_PATTERN.finditer(text):
        _add_parsed_year(years, m.group(2))

    for m in _FISCAL_YEAR_PATTERN.finditer(text):
        _add_parsed_year(years, m.group(1))

    for m in _DECADE_PATTERN.finditer(text):
        qualifier = (m.group(1) or "").lower()
        base_year = int(m.group(2))
        if qualifier == "early":
            years.update(y for y in range(base_year, base_year + 5) if _valid_year(y))
        elif qualifier == "mid":
            years.update(y for y in range(base_year + 3, base_year + 7) if _valid_year(y))
        elif qualifier == "late":
            years.update(y for y in range(base_year + 5, base_year + 10) if _valid_year(y))
        elif _valid_year(base_year):
            years.add(base_year)

    for m in _NUMERIC_TOKEN_PATTERN.finditer(text):
        _add_parsed_year(years, m.group(0))

    matches = search_dates(text, settings=_DATEPARSER_SETTINGS, languages=["en"]) or []
    for matched_text, parsed in matches:
        if not any(ch.isdigit() for ch in matched_text):
            continue
        if _DECADE_PATTERN.search(matched_text):
            continue
        if _valid_year(parsed.year):
            years.add(parsed.year)

    return sorted(years)


def _extract_years_extended(text: str) -> list[int]:
    """Backward-compatible wrapper for dateparser-backed year extraction."""
    return extract_years(text)

def extract_temporal(
    text: str, sentences: list[str] | None = None
) -> TemporalExtraction:
    """Extract temporal information from text.

    Uses extended patterns (Chronos-inspired) to catch temporal expressions
    beyond simple 4-digit years: quarters, fiscal years, decades, full dates.

    Args:
        text: Raw text (LOD_0).
        sentences: Pre-split sentences. If None, splits internally.

    Returns:
        TemporalExtraction with passage-level min/max and per-sentence year mapping.
    """
    from .compression import split_sentences

    if sentences is None:
        sentences = split_sentences(text)

    all_years: list[int] = []
    sentence_years: dict[int, list[int]] = {}

    for i, sent in enumerate(sentences):
        years = _extract_years_extended(sent)
        if years:
            sentence_years[i] = years
            all_years.extend(years)

    unique_years = sorted(set(all_years))

    return TemporalExtraction(
        temporal_min=min(unique_years) if unique_years else None,
        temporal_max=max(unique_years) if unique_years else None,
        anchor_years=unique_years,
        sentence_years=sentence_years,
    )


def extract_temporal_spacy(doc: object) -> list[int]:
    """Extract additional years from spaCy DATE entities not caught by regex.

    Args:
        doc: A spaCy Doc object.

    Returns:
        List of year integers found in DATE/TIME entities.
    """
    extra_years: list[int] = []
    for ent in doc.ents:  # type: ignore[attr-defined]
        if ent.label_ in ("DATE", "TIME"):
            extra_years.extend(extract_years(ent.text))
    return extra_years


def make_temporal_anchor_id(year: int) -> str:
    """Create entity_id for a TEMPORAL_ANCHOR node.

    Convention: ``t_YYYY`` — the ``t_`` prefix avoids collision with
    content-hash entity IDs and passage IDs (``p_``/``ps_``).
    """
    return f"t_{year}"


# ---------------------------------------------------------------------------
# Relative Date Normalization (render-time, Liquid LOD Phase B)
# ---------------------------------------------------------------------------


# Regex to extract session date from LOD_0 prefix
_SESSION_DATE_RE = re.compile(
    r"\[Session date:\s*(\d{4}-\d{2}-\d{2})",
    re.IGNORECASE,
)

# Month name lookup (1-indexed: _MONTH_NAMES[1] == "January")
_MONTH_NAMES = [
    "", "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
]


def _extract_session_date(text: str) -> date | None:
    """Extract the session date from a [Session date: YYYY-MM-DD ...] prefix."""
    m = _SESSION_DATE_RE.search(text)
    if not m:
        return None
    try:
        return date.fromisoformat(m.group(1))
    except ValueError:
        return None


# Open-ended relative spans resolved against the session anchor via dateparser.
# The fixed-phrase substitutions in normalize_relative_dates cover the common
# closed set; this catches the numeric long tail ("N units ago", "in N units")
# that dominates conversational memory (LoCoMo category_2). The `(?!\s*\()` guard
# prevents re-annotating spans the fixed-phrase pass already annotated, and the
# patterns are specific to relative phrases so absolute dates already in the text
# are never touched.
#
# NOTE: bare weekday-relative phrases ("last Friday", "next Monday") are NOT
# handled here — dateparser.parse returns None for them — and resolving them
# would need deterministic calendar arithmetic with genuine "this/last/next"
# ambiguity. Deferred as a follow-on (filed in the resolver's backlog item).
_REL_NUM = r"(?:\d{1,3}|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)"
_REL_UNIT = r"(?:year|month|week|day|hour)s?"
_REL_SPAN_PATTERN = re.compile(
    r"\b(?:"
    rf"{_REL_NUM}\s+{_REL_UNIT}\s+ago"
    rf"|in\s+{_REL_NUM}\s+{_REL_UNIT}"
    r")\b(?!\s*\()",
    re.IGNORECASE,
)


# Master on/off for the render-time relative-date resolver. Default OFF as of
# 2026-06-09 (founder decision): the full-156Q LoCoMo category_2 A/B
# ([[docs/diagnostics/2026-06-09-overnight-cat2-cat3-analysis.md]]) found the
# resolver (even in its best "anchored" mode) ties resolver-OFF on lenient
# (paired net 0) and is marginally worse on strict (net −2) — i.e. it earns no
# net lift on its target category, so per "earn-your-default" it does not run
# by default. cat2 is already a strength (~81% lenient) without it. Set
# TPVRG_RELATIVE_DATE_RESOLVER=1 (or true/on/yes) to opt the resolver back in
# (e.g. for a future query class); when on, the "anchored" mode below is the
# recommended/escape-hatch form (strictly better than the legacy "absolute").
_RELATIVE_DATE_RESOLVER_ENABLED = (
    os.environ.get("TPVRG_RELATIVE_DATE_RESOLVER", "false").strip().lower()
    in {"1", "true", "on", "yes"}
)

# Resolver output FORMAT mode. Default "absolute" = current behavior, byte-identical:
# week-grained spans annotate with the resolved absolute date ("last week (week of
# 2023-06-02)"). Mode "anchored" expresses week-grained resolutions RELATIVE to the
# session anchor ("last week (the week before 2023-06-09)"). The 2026-06-07 LoCoMo
# category_2 A/B ([[docs/diagnostics/2026-06-07-relative-date-resolver-ab-cat2.md]])
# found the gold answers + judge reward the anchored phrasing ("the week before
# 9 June 2023"); the absolute "week of <date>" form cost ~9.5pp strict by over-
# resolving into a specific week that mismatched the gold's relative framing. Set
# TPVRG_RELATIVE_DATE_RESOLVER_MODE=anchored to A/B the alternative. Year / month /
# day (yesterday/today/tomorrow) annotations are identical across modes — they
# matched gold in both arms; only week-grained resolution is re-phrased.
_RELATIVE_DATE_RESOLVER_MODE = (
    os.environ.get("TPVRG_RELATIVE_DATE_RESOLVER_MODE", "absolute").strip().lower()
)


def normalize_relative_dates(text: str) -> str:
    """
    Replace relative temporal expressions with concrete dates.

    Reads session date from the ``[Session date: YYYY-MM-DD]`` prefix in text.
    If no session date is found, returns text unchanged.

    Substitution rules (case-insensitive, word-boundary anchored):
      "last year"    → "last year (YYYY-1)"
      "next year"    → "next year (YYYY+1)"
      "this year"    → "this year (YYYY)"
      "last month"   → "last month (MonthName YYYY)"
      "next month"   → "next month (MonthName YYYY)"
      "this month"   → "this month (MonthName YYYY)"
      "yesterday"    → "yesterday (YYYY-MM-DD)"
      "today"        → "today (YYYY-MM-DD)"
      "tomorrow"     → "tomorrow (YYYY-MM-DD)"
      "last week"    → "last week (week of YYYY-MM-DD)"

    Uses lambda replacements to preserve the original case of the matched
    phrase (e.g. "LAST YEAR" stays "LAST YEAR (2021)", not "last year (2021)").

    Negative lookahead ``(?!\\s*\\()`` prevents double-annotation when called
    on already-normalized text.
    """
    if not text:
        return text
    if not _RELATIVE_DATE_RESOLVER_ENABLED:
        return text

    session_date = _extract_session_date(text)
    if session_date is None:
        return text

    result = text

    year = session_date.year
    month = session_date.month

    # ── Year expressions ──────────────────────────────────────────────────
    result = re.sub(
        r"\blast year\b(?!\s*\()",
        lambda m: f"{m.group(0)} ({year - 1})",
        result,
        flags=re.IGNORECASE,
    )
    result = re.sub(
        r"\bnext year\b(?!\s*\()",
        lambda m: f"{m.group(0)} ({year + 1})",
        result,
        flags=re.IGNORECASE,
    )
    result = re.sub(
        r"\bthis year\b(?!\s*\()",
        lambda m: f"{m.group(0)} ({year})",
        result,
        flags=re.IGNORECASE,
    )

    # ── Month expressions ─────────────────────────────────────────────────
    last_month_idx = ((month - 2) % 12) + 1   # Jan→Dec, Feb→Jan, etc.
    next_month_idx = (month % 12) + 1          # Dec→Jan, Nov→Dec, etc.

    # Compute the year for last/next month (handles Jan→prev Dec, Dec→next Jan)
    last_month_year = year if last_month_idx < month else year - 1
    next_month_year = year if next_month_idx > month else year + 1

    result = re.sub(
        r"\blast month\b(?!\s*\()",
        lambda m: f"{m.group(0)} ({_MONTH_NAMES[last_month_idx]} {last_month_year})",
        result,
        flags=re.IGNORECASE,
    )
    result = re.sub(
        r"\bnext month\b(?!\s*\()",
        lambda m: f"{m.group(0)} ({_MONTH_NAMES[next_month_idx]} {next_month_year})",
        result,
        flags=re.IGNORECASE,
    )
    result = re.sub(
        r"\bthis month\b(?!\s*\()",
        lambda m: f"{m.group(0)} ({_MONTH_NAMES[month]} {year})",
        result,
        flags=re.IGNORECASE,
    )

    # ── Day expressions ───────────────────────────────────────────────────
    yesterday = session_date - timedelta(days=1)
    tomorrow = session_date + timedelta(days=1)
    last_week = session_date - timedelta(days=7)

    result = re.sub(
        r"\byesterday\b(?!\s*\()",
        lambda m: f"{m.group(0)} ({yesterday.isoformat()})",
        result,
        flags=re.IGNORECASE,
    )
    result = re.sub(
        r"\btoday\b(?!\s*\()",
        lambda m: f"{m.group(0)} ({session_date.isoformat()})",
        result,
        flags=re.IGNORECASE,
    )
    result = re.sub(
        r"\btomorrow\b(?!\s*\()",
        lambda m: f"{m.group(0)} ({tomorrow.isoformat()})",
        result,
        flags=re.IGNORECASE,
    )
    # Week-grained resolution: "absolute" → "(week of <last_week>)" (default,
    # byte-identical); "anchored" → "(the week before <session>)" to match the
    # LoCoMo gold/judge-preferred phrasing (see _RELATIVE_DATE_RESOLVER_MODE note).
    if _RELATIVE_DATE_RESOLVER_MODE == "anchored":
        _last_week_annot = f"the week before {session_date.isoformat()}"
    else:
        _last_week_annot = f"week of {last_week.isoformat()}"
    result = re.sub(
        r"\blast week\b(?!\s*\()",
        lambda m: f"{m.group(0)} ({_last_week_annot})",
        result,
        flags=re.IGNORECASE,
    )

    # ── Open-ended relative spans (dateparser-resolved against the anchor) ──
    # SOTA: dateparser does the date arithmetic for arbitrary "N units ago" /
    # "in N units" / "last <weekday>" spans; the regex only detects the trigger.
    base_dt = datetime(session_date.year, session_date.month, session_date.day)

    def _annotate_rel_span(m: re.Match) -> str:
        phrase = m.group(0)
        parsed = dateparser.parse(
            phrase,
            settings={"RELATIVE_BASE": base_dt, "PREFER_DATES_FROM": "past"},
        )
        if parsed is None:
            return phrase
        return f"{phrase} ({parsed.date().isoformat()})"

    result = _REL_SPAN_PATTERN.sub(_annotate_rel_span, result)

    return result
