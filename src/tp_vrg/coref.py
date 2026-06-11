"""
Linguistically-grounded pronoun resolver for the GLiNER ingestion pipeline.

Resolves third-person singular/plural pronouns to named entity antecedents
using salience ranking + morphological constraints. No LLM calls, no external
dependencies beyond spaCy (already required for GLiNER extraction).

Algorithm:
  1. Parse text with spaCy to find proper nouns and pronouns.
  2. Build an entity salience table: track entities across sentences with
     grammatical-role weighting and recency decay.
  3. Infer entity gender from gendered titles (Mr./Ms.) and pronoun-echo
     (first pronoun following an entity reveals its gender).
  4. For each third-person pronoun, apply constraints (person, number, gender,
     entity type) to filter candidates, then select the highest-salience match.
  5. Apply replacements in reverse character-offset order and return resolved text.

Design boundaries:
  - First-person (I/me/we/us) and second-person (you) pronouns are NOT resolved.
    These require speaker diarization, which is out of scope.
  - Conservative by default: unknown-gender entities match "they"/"it" but not
    "he"/"she". A wrong edge is worse than a missing one.
  - Precision > recall for knowledge graph construction.
  - Pleonastic "it" (expletive dep_=expl: "It is raining", "It seems that...")
    is skipped — it has no referent to resolve to.
  - Reflexives (himself/herself/itself/themselves) follow Binding Theory Principle A:
    they are syntactically bound to the subject of their governing clause. No
    salience ranking is used — the nsubj of the nearest verb is the antecedent.
  - Demonstratives (this/that/these/those) are intentionally NOT resolved. They
    typically reference events or propositions, not discrete named entities, and
    resolving them would introduce more noise than signal in a knowledge graph.
  - Entity-type constraints for he/she: known non-person entity types (ORG, GPE,
    LOC, etc.) are excluded from he/she candidates. Entities with no NER label
    (type="") are allowed through — en_core_web_sm misses many person names.

Usage:
    import spacy
    nlp = spacy.load("en_core_web_sm")
    resolved = resolve_pronouns("Caroline went out. She bought milk.", nlp)
    # → "Caroline went out. Caroline bought milk."
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from enum import Enum, auto
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import spacy

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Types
# ---------------------------------------------------------------------------


class Gender(Enum):
    MASC = auto()    # he/him/his → resolves to this
    FEM = auto()     # she/her/hers → resolves to this
    NEUT = auto()    # it/its, they/them/their → resolves to this
    UNKNOWN = auto() # gender not yet inferred; compatible with they/it only


class Number(Enum):
    SING = auto()
    PLUR = auto()


# ---------------------------------------------------------------------------
# Pronoun constraint table
# ---------------------------------------------------------------------------
# Maps pronoun lemma/surface forms to (person, number, gender_required).
# person=1 or 2 → skip (no resolution).
# gender_required=None means "any gender" (only for they/them in singular-they usage).

_PRONOUN_MAP: dict[str, tuple[int, Number, Gender | None]] = {
    # 3rd-person singular masculine
    "he":   (3, Number.SING, Gender.MASC),
    "him":  (3, Number.SING, Gender.MASC),
    "his":  (3, Number.SING, Gender.MASC),
    # 3rd-person singular feminine
    "she":  (3, Number.SING, Gender.FEM),
    "her":  (3, Number.SING, Gender.FEM),
    "hers": (3, Number.SING, Gender.FEM),
    # 3rd-person singular neuter
    "it":   (3, Number.SING, Gender.NEUT),
    "its":  (3, Number.SING, Gender.NEUT),
    # 3rd-person plural (gender-neutral)
    "they":   (3, Number.PLUR, None),
    "them":   (3, Number.PLUR, None),
    "their":  (3, Number.PLUR, None),
    "theirs": (3, Number.PLUR, None),
    # 1st-person → skip
    "i":    (1, Number.SING, None),
    "me":   (1, Number.SING, None),
    "my":   (1, Number.SING, None),
    "mine": (1, Number.SING, None),
    "we":   (1, Number.PLUR, None),
    "us":   (1, Number.PLUR, None),
    "our":  (1, Number.PLUR, None),
    "ours": (1, Number.PLUR, None),
    # 2nd-person → skip
    "you":   (2, Number.SING, None),
    "your":  (2, Number.SING, None),
    "yours": (2, Number.SING, None),
}

# Gendered honorifics → Gender
_TITLE_GENDER: dict[str, Gender] = {
    "mr": Gender.MASC, "mr.": Gender.MASC,
    "sir": Gender.MASC,
    "ms": Gender.FEM, "ms.": Gender.FEM,
    "mrs": Gender.FEM, "mrs.": Gender.FEM,
    "miss": Gender.FEM,
    "dr": Gender.UNKNOWN, "dr.": Gender.UNKNOWN,  # ambiguous
}

# Salience scores by grammatical role
_SALIENCE_SUBJ = 1.0
_SALIENCE_OBJ  = 0.7
_SALIENCE_OTHER = 0.4
_SALIENCE_DECAY = 0.5  # multiplied each sentence a mention is absent

# spaCy NER types that are explicitly NOT people.
# Entities tagged with these types are excluded from he/she candidates.
# Entities with type="" (NER missed them) are allowed through — en_core_web_sm
# misses many person names, especially non-Western ones.
_NON_PERSON_TYPES: frozenset[str] = frozenset({
    "ORG", "GPE", "LOC", "FAC", "NORP", "PRODUCT",
    "WORK_OF_ART", "LAW", "LANGUAGE", "EVENT",
})

# Third-person reflexive pronouns — resolved via Binding Theory Principle A
# (syntactically bound to the nsubj of their governing clause), not salience ranking.
_REFLEXIVE_PRONOUNS: frozenset[str] = frozenset({
    "himself", "herself", "itself", "themselves", "oneself",
})

# Regex for detecting quoted spans (content only, without the quote characters).
# Handles smart double "…", smart single '…', and straight double "…".
# Straight single quotes ('…') are intentionally excluded — they appear in
# contractions and possessives too frequently to be reliable quote delimiters.
_QUOTE_RE = re.compile(
    r'\u201c([^\u201d]*)\u201d'   # "…" smart double quotes
    r'|\u2018([^\u2019]*)\u2019'  # '…' smart single quotes
    r'|"([^"]*)"',                # "…" straight double quotes
    re.DOTALL,
)

# Turn-boundary detection: matches "{Name}: {content}" at start of line.
# Captures the speaker name (one or more capitalised words) and the colon
# position so we can compute turn content spans.
_TURN_RE = re.compile(
    r'^([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*):\s',
    re.MULTILINE,
)


# ---------------------------------------------------------------------------
# Entity mention tracker
# ---------------------------------------------------------------------------


@dataclass
class EntityMention:
    name: str
    gender: Gender = Gender.UNKNOWN
    number: Number = Number.SING
    last_seen_sent: int = -1
    salience: float = 0.0
    is_proper: bool = False      # True for PROPN chunks; False for common NOUN chunks
    entity_type: str = ""        # spaCy NER label: "PERSON", "ORG", "GPE", "" etc.


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _clean_name(name: str) -> str:
    """Normalise whitespace and strip punctuation at edges."""
    return name.strip().strip("'\".,;:")


def _infer_gender_from_title(name: str) -> Gender | None:
    """Check if the entity name starts with a gendered honorific."""
    parts = name.lower().split()
    if parts and parts[0] in _TITLE_GENDER:
        return _TITLE_GENDER[parts[0]]
    return None


def _get_pronoun_constraints(
    token,
) -> tuple[int, Number, Gender | None] | None:
    """
    Return (person, number, gender_required) for a pronoun token, or None
    if the token is not a resolvable pronoun.

    Handles both POS=PRON and possessive DET (his/her/their) forms.
    """
    if token.pos_ not in ("PRON", "DET"):
        return None
    key = token.text.lower()
    if key not in _PRONOUN_MAP:
        return None
    return _PRONOUN_MAP[key]


def _entity_compatible(mention: EntityMention, number: Number, gender_req: Gender | None) -> bool:
    """
    Check whether an entity mention is compatible with the pronoun's
    number and gender constraints.
    """
    # Number must match
    if mention.number != number:
        # Allow singular "they" (singular-they usage): if number=PLUR but
        # no plural candidate exists, caller falls back to singular.
        # Here we enforce strictly; the fallback is in _resolve_pronoun.
        return False

    # Gender constraint: None means any gender (they/them).
    # For he/she, the entity gender must match (or be UNKNOWN → rejected).
    if gender_req is None:
        return True  # they/them: any gender is fine
    if gender_req == Gender.MASC:
        return mention.gender == Gender.MASC
    if gender_req == Gender.FEM:
        return mention.gender == Gender.FEM
    if gender_req == Gender.NEUT:
        return mention.gender in (Gender.NEUT, Gender.UNKNOWN)
    return False


# ---------------------------------------------------------------------------
# Name variant helpers
# ---------------------------------------------------------------------------


def _find_variant_key(new_key: str, table: dict[str, EntityMention]) -> str | None:
    """
    Check whether `new_key` (a lowercase proper-noun name) is a variant of any
    existing entry in `table`.

    A variant is defined by whole-word substring containment in either direction:
      - new_key is a substring of existing_key  (e.g. "caroline" ⊂ "dr. caroline thompson")
      - existing_key is a substring of new_key  (e.g. "thompson" ⊂ "caroline thompson")

    Uses word-boundary matching so "art" does not merge with "arthur".

    Returns the key of the matching existing entry, or None.
    """
    for existing_key, mention in table.items():
        if not mention.is_proper:
            continue  # only merge PROPN entities
        short, long = (
            (new_key, existing_key)
            if len(new_key) <= len(existing_key)
            else (existing_key, new_key)
        )
        if short == long:
            continue  # exact match — already keyed
        # Require whole-word match to avoid "art" ↔ "arthur"
        if re.search(rf"\b{re.escape(short)}\b", long):
            return existing_key
    return None


# ---------------------------------------------------------------------------
# Quoted speech attribution helpers
# ---------------------------------------------------------------------------


def _find_quote_spans(text: str) -> list[tuple[int, int]]:
    """
    Return a list of (content_start, content_end) character-offset spans for
    each quoted passage found in `text`.

    Only the content inside the outermost quotes is included — the opening and
    closing quote characters themselves are excluded from the span offsets.
    Nested quotes are treated as part of the outer span's content.
    """
    spans: list[tuple[int, int]] = []
    for m in _QUOTE_RE.finditer(text):
        for g in (1, 2, 3):
            if m.group(g) is not None:
                spans.append((m.start(g), m.end(g)))
                break
    return spans


def _find_quote_speakers(
    quote_char_start: int,
    doc,
) -> tuple[str | None, str | None]:
    """
    Identify the speaker and addressee of a quoted passage.

    Strategy: find the last VERB token whose character position precedes
    `quote_char_start`, then scan its dependency children for:
      - nsubj / nsubjpass → speaker ("I" inside the quote refers to this entity)
      - dobj / iobj       → addressee ("you" inside the quote refers to this entity)

    If the nearest verb has no nsubj, walk up to its syntactic head once.

    Returns: (speaker_name, addressee_name) — either or both may be None.
    """
    pre_verbs = [t for t in doc if t.idx < quote_char_start and t.pos_ == "VERB"]
    if not pre_verbs:
        return None, None

    speaker: str | None = None
    addressee: str | None = None

    for verb in reversed(pre_verbs[-5:]):
        for child in verb.children:
            if child.dep_ in ("nsubj", "nsubjpass") and speaker is None:
                name = _clean_name(child.text)
                if name:
                    speaker = name
            elif child.dep_ in ("dobj", "iobj", "pobj") and addressee is None:
                name = _clean_name(child.text)
                if name:
                    addressee = name

        if speaker is not None:
            break  # found a verb with a subject — use it

        # If this verb is embedded, try its syntactic head
        if verb.dep_ != "ROOT" and verb.head.pos_ == "VERB":
            for child in verb.head.children:
                if child.dep_ in ("nsubj", "nsubjpass") and speaker is None:
                    name = _clean_name(child.text)
                    if name:
                        speaker = name
                elif child.dep_ in ("dobj", "iobj", "pobj") and addressee is None:
                    name = _clean_name(child.text)
                    if name:
                        addressee = name
            if speaker is not None:
                break

    return speaker, addressee


def detect_turn_boundaries(text: str) -> list[tuple[int, int, str]]:
    """
    Detect speaker turns in dialogue formatted as ``Name: content``.

    Returns a list of ``(start_char, end_char, speaker_name)`` tuples where
    each span covers the content of the turn (everything after the ``Name: ``
    prefix up to the next turn or end-of-text).

    This is a public helper so that callers (e.g. GLiNERSpacyProvider) can
    detect turns once and pass them into ``resolve_pronouns()`` via the
    ``turn_boundaries`` parameter.
    """
    matches = list(_TURN_RE.finditer(text))
    if not matches:
        return []

    boundaries: list[tuple[int, int, str]] = []
    for i, m in enumerate(matches):
        speaker = m.group(1)
        content_start = m.end()  # right after "Name: "
        content_end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        boundaries.append((content_start, content_end, speaker))
    return boundaries


# ---------------------------------------------------------------------------
# Split-antecedent composite builder
# ---------------------------------------------------------------------------


def _build_composite_entries(
    sent,
    table: dict[str, EntityMention],
    sent_index: int,
) -> None:
    """
    Detect coordinated proper-noun entities in `sent` and create virtual plural
    composite entries for them, enabling "they/them/their" to resolve to the
    joint referent ("Alice and Bob").

    Detection: walk all PROPN tokens; for each one that has a `conj` (conjunct)
    dependency child that is also PROPN, record a pair.

    The composite entry:
      - name: "A and B" (display form for replacement)
      - number: PLUR
      - gender: UNKNOWN (mixed group)
      - salience: max of constituent saliences
      - key: "a and b" (lowercase)

    Only creates composites for pairs of entities already in the salience table
    (so salience and gender info are available). Composites are not merged
    with existing entries — they are always keyed by "a and b".
    """
    for token in sent:
        if token.pos_ != "PROPN":
            continue
        # Look for conjunct PROPN children
        for child in token.children:
            if child.dep_ == "conj" and child.pos_ == "PROPN":
                name_a = _clean_name(token.text)
                name_b = _clean_name(child.text)
                if not name_a or not name_b:
                    continue

                key_a = name_a.lower()
                key_b = name_b.lower()

                # Only build composite if both are in the salience table
                if key_a not in table or key_b not in table:
                    continue

                sal = max(table[key_a].salience, table[key_b].salience)
                composite_name = f"{table[key_a].name} and {table[key_b].name}"
                composite_key = composite_name.lower()

                if composite_key not in table:
                    table[composite_key] = EntityMention(
                        name=composite_name,
                        gender=Gender.UNKNOWN,
                        number=Number.PLUR,
                        last_seen_sent=sent_index,
                        salience=sal,
                        is_proper=True,
                        entity_type="",
                    )
                else:
                    table[composite_key].salience = sal
                    table[composite_key].last_seen_sent = sent_index


# ---------------------------------------------------------------------------
# Salience table builder
# ---------------------------------------------------------------------------


def _build_salience_table(
    doc,
    sent_index: int,
    table: dict[str, EntityMention],
    gender_cache: dict[str, Gender],
) -> None:
    """
    Update `table` with entity mentions found in the spaCy sentence at
    position `sent_index`. Also decays salience for entities not mentioned.

    `gender_cache` accumulates gender inferences for entity names across
    the whole document (pronoun-echo pass).
    """
    sent = list(doc.sents)[sent_index]

    # Decay all existing entities not seen this sentence (applied later)
    mentioned_this_sent: set[str] = set()

    for chunk in sent.noun_chunks:
        # Only consider proper nouns (PROPN head) as named entities
        if chunk.root.pos_ not in ("PROPN", "NOUN"):
            continue
        name = _clean_name(chunk.text)
        if not name:
            continue

        # Determine grammatical role for salience
        dep = chunk.root.dep_
        if dep in ("nsubj", "nsubjpass"):
            sal = _SALIENCE_SUBJ
        elif dep in ("dobj", "attr", "pobj"):
            sal = _SALIENCE_OBJ
        else:
            sal = _SALIENCE_OTHER

        # Determine number (plural noun chunks → PLUR)
        morph = chunk.root.morph
        morph_number = morph.get("Number")
        number = Number.PLUR if morph_number and "Plur" in morph_number else Number.SING

        # Determine gender: title heuristic first, then cache
        gender = _infer_gender_from_title(name)
        if gender is None:
            gender = gender_cache.get(name.lower(), Gender.UNKNOWN)

        is_proper = chunk.root.pos_ == "PROPN"
        entity_type = chunk.root.ent_type_  # "PERSON", "ORG", "GPE", "" etc.

        key = name.lower()

        # Name variant merging: check if this entity is a variant of an existing
        # entry (or vice-versa). E.g. "Caroline" ↔ "Dr. Caroline Thompson".
        # Rules:
        #   - Only merge PROPN-headed chunks (not common nouns like "the team").
        #   - Match on whole-word boundaries to avoid "Art" ↔ "Arthur" false merges.
        #   - Keep the longer name as the display form; use the shorter name as the key
        #     so subsequent "Caroline" references hit the merged entry.
        #   - Gender and entity_type from the richer (titled/longer) form win.
        if is_proper and key not in table:
            merged_key = _find_variant_key(key, table)
            if merged_key is not None:
                existing = table[merged_key]
                # Determine which name is longer (richer display form)
                longer_name = name if len(name) >= len(existing.name) else existing.name
                shorter_key = key if len(key) <= len(merged_key) else merged_key
                # Merge: update existing entry under the shorter key
                existing.name = longer_name
                existing.salience = max(existing.salience, sal)
                existing.last_seen_sent = sent_index
                if gender != Gender.UNKNOWN:
                    existing.gender = gender
                if is_proper:
                    existing.is_proper = True
                if entity_type:
                    existing.entity_type = entity_type
                # Re-key under shorter name if needed
                if shorter_key != merged_key:
                    table[shorter_key] = existing
                    del table[merged_key]
                mentioned_this_sent.add(shorter_key)
                # Also mark the longer key as present (avoids duplicate entries later)
                mentioned_this_sent.add(key)
                continue

        if key in table:
            table[key].salience = sal
            table[key].last_seen_sent = sent_index
            table[key].name = name  # update to latest surface form
            if gender != Gender.UNKNOWN:
                table[key].gender = gender
            if is_proper:
                table[key].is_proper = True  # promote to proper once seen as PROPN
            if entity_type:
                table[key].entity_type = entity_type  # update if now recognized by NER
        else:
            table[key] = EntityMention(
                name=name,
                gender=gender,
                number=number,
                last_seen_sent=sent_index,
                salience=sal,
                is_proper=is_proper,
                entity_type=entity_type,
            )
        mentioned_this_sent.add(key)

    # Decay entities not seen this sentence
    for key in list(table):
        if key not in mentioned_this_sent:
            table[key].salience *= _SALIENCE_DECAY

    # Split antecedents: scan for conj (conjunct) dependencies between entities
    # in this sentence. When two PROPN entities are coordinated ("Alice and Bob"),
    # create a virtual plural composite entry so "they/them/their" can resolve to
    # the joint referent ("Alice and Bob").
    _build_composite_entries(sent, table, sent_index)


# ---------------------------------------------------------------------------
# Pronoun resolution pass
# ---------------------------------------------------------------------------


def _resolve_pronoun(
    token,
    table: dict[str, EntityMention],
    gender_cache: dict[str, Gender],
) -> str | None:
    """
    Find the best antecedent in `table` for `token` (a pronoun).

    Returns the entity's display name, or None if no compatible candidate found.
    """
    constraints = _get_pronoun_constraints(token)
    if constraints is None:
        return None

    person, number, gender_req = constraints
    if person in (1, 2):
        return None  # I/we/you: skip

    # Filter candidates by number + gender
    candidates = [
        m for m in table.values()
        if _entity_compatible(m, number, gender_req)
    ]

    # Soft entity-type filter on strict gender matches: prefer non-person entities
    # excluded (ORG, GPE, etc.) but fall back to all if filtering empties the list.
    # Soft because en_core_web_sm NER is imperfect — it sometimes mislabels person
    # names as ORG/PRODUCT. A gender-confirmed (FEM/MASC) entity should still resolve
    # even if the NER type is wrong.
    if candidates and gender_req in (Gender.FEM, Gender.MASC):
        typed = [m for m in candidates if m.entity_type not in _NON_PERSON_TYPES]
        if typed:
            candidates = typed

    # Singular "they" fallback: if no plural candidates, try singular neuter
    if not candidates and number == Number.PLUR and gender_req is None:
        candidates = [
            m for m in table.values()
            if m.number == Number.SING and m.gender in (Gender.NEUT, Gender.UNKNOWN)
        ]

    # UNKNOWN gender fallback for he/she: in conversational text, speakers always
    # use "I" for self-reference, so their gender is never echo-confirmed.  If no
    # strictly-gendered candidate exists, try UNKNOWN singular proper-noun entities.
    # Soft entity-type filter: prefer non-ORG/non-GPE entities, but if NER mislabeled
    # all candidates (en_core_web_sm frequently tags person names as ORG), fall back
    # to all UNKNOWN proper-noun candidates ranked by salience.
    if not candidates and gender_req in (Gender.FEM, Gender.MASC):
        unknown_proper = [
            m for m in table.values()
            if m.number == number
            and m.gender == Gender.UNKNOWN
            and m.is_proper
        ]
        typed_unknown = [m for m in unknown_proper if m.entity_type not in _NON_PERSON_TYPES]
        candidates = typed_unknown if typed_unknown else unknown_proper

    if not candidates:
        return None

    # Pick highest salience; break ties by recency (last_seen_sent descending)
    best = max(candidates, key=lambda m: (m.salience, m.last_seen_sent))
    return best.name


def _is_in_preverbal_clause(token, sent) -> bool:
    """
    Return True if `token` is inside a pre-root dependent clause.

    Cataphoric pronouns ("Despite his anger, John kept quiet.") appear in
    adverbial/prepositional clauses that precede the sentence's main verb.
    Detection: walk ancestors from token; if any intermediate node has a
    pre-root dependent relation (advcl, prep, mark) whose character position
    is before the sentence root, the token is pre-verbal.
    """
    root = next((t for t in sent if t.dep_ == "ROOT"), None)
    if root is None:
        return False

    ancestor = token.head
    visited: set[int] = set()
    while ancestor.i not in visited and ancestor.dep_ != "ROOT":
        visited.add(ancestor.i)
        if ancestor.dep_ in ("advcl", "prep", "mark") and ancestor.i < root.i:
            return True
        if ancestor.head.i == ancestor.i:
            break
        ancestor = ancestor.head
    return False


def _resolve_cataphora(
    token,
    sent,
    table: dict[str, EntityMention],
    gender_cache: dict[str, Gender],
) -> str | None:
    """
    Forward-look cataphora resolution: scan tokens AFTER the sentence root
    for a PROPN entity in the salience table compatible with the pronoun.

    Used when a pronoun precedes its antecedent within the same sentence
    (cataphoric context). Binding Theory B is intentionally bypassed here —
    the pronoun and antecedent are in different clauses.

    Returns the entity's display name, or None if no match found.
    """
    constraints = _get_pronoun_constraints(token)
    if constraints is None:
        return None
    _, number, gender_req = constraints

    # Scan for PROPN entities that appear AFTER the pronoun in linear order.
    # (The unused root_idx variable has been removed — we scan from token.i onward.)
    # These are the candidates for cataphoric resolution — the antecedent is
    # always to the right of the cataphoric pronoun in the sentence.
    for t in sent:
        if t.i <= token.i or t.pos_ != "PROPN":
            continue
        name = _clean_name(t.text)
        if not name:
            continue
        key = name.lower()
        if key not in table:
            continue
        mention = table[key]
        if _entity_compatible(mention, number, gender_req):
            return mention.name
        # UNKNOWN fallback (same logic as _resolve_pronoun)
        if gender_req in (Gender.FEM, Gender.MASC):
            if (mention.number == number
                    and mention.gender == Gender.UNKNOWN
                    and mention.is_proper
                    and mention.entity_type not in _NON_PERSON_TYPES):
                return mention.name
    return None


def _resolve_reflexive(token, table: dict[str, EntityMention]) -> str | None:
    """
    Resolve a reflexive pronoun to the subject of its governing clause.

    Binding Theory Principle A: a reflexive must be locally bound — it corefers
    with the grammatical subject of the minimal clause containing it.

    Walks the dependency tree upward from the reflexive token to find the nearest
    governing VERB (or ROOT), then returns the nsubj of that verb.

    Returns the entity's display name, or None if the subject cannot be found.
    """
    # Walk up the dependency tree to find the governing verb
    head = token.head
    visited: set[int] = set()
    while head.i not in visited:
        visited.add(head.i)
        if head.dep_ == "ROOT" or head.pos_ == "VERB":
            break
        if head.head.i == head.i:
            break  # reached the true root without finding a verb
        head = head.head

    # Find the nominal subject of this verb
    for child in head.children:
        if child.dep_ in ("nsubj", "nsubjpass"):
            subj_name = _clean_name(child.text)
            if not subj_name:
                continue
            subj_key = subj_name.lower()
            if subj_key in table:
                return table[subj_key].name
            # Return raw text even if not yet in salience table
            # (subject appears before we've built the full table for this sentence)
            return subj_name

    return None


# ---------------------------------------------------------------------------
# Two-pass gender inference
# ---------------------------------------------------------------------------


def _first_pass_gender(doc) -> dict[str, Gender]:
    """
    Scan the document to build a name→gender cache from pronoun-echo:
    when an entity name is followed by a gendered pronoun in the same or
    next sentence, that pronoun reveals the entity's gender.

    Also applies title-based gender inference.

    Returns: {name_lower: Gender}
    """
    cache: dict[str, Gender] = {}
    sents = list(doc.sents)

    # Title-based: scan all proper noun spans
    for token in doc:
        if token.pos_ == "PROPN":
            # Look for preceding title token
            if token.i > 0:
                prev = doc[token.i - 1]
                title_g = _infer_gender_from_title(prev.text)
                if title_g and title_g != Gender.UNKNOWN:
                    # The whole noun chunk starting from prev gets this gender
                    full_name = prev.text + " " + token.text
                    cache[full_name.lower()] = title_g
                    # Also just the name without title
                    cache[token.text.lower()] = title_g

    # Pronoun-echo: for each sentence, find entities → look for pronoun in same/next sent
    for i, sent in enumerate(sents):
        # Collect proper nouns in this sentence
        propn_names = []
        for chunk in sent.noun_chunks:
            if chunk.root.pos_ == "PROPN":
                propn_names.append(_clean_name(chunk.text))

        if not propn_names:
            continue

        # Look for a gendered pronoun in the same sentence or the next
        search_range = list(sent)
        if i + 1 < len(sents):
            search_range += list(sents[i + 1])

        for token in search_range:
            key = token.text.lower()
            if key in ("she", "her", "hers"):
                for name in propn_names:
                    if name.lower() not in cache:
                        cache[name.lower()] = Gender.FEM
                break
            elif key in ("he", "him", "his"):
                for name in propn_names:
                    if name.lower() not in cache:
                        cache[name.lower()] = Gender.MASC
                break
            # "it/its" deliberately excluded: in conversational text, "it" almost
            # always refers to events, topics, or objects — not to the named person
            # whose turn label appears in the same sentence. Assigning NEUT to a
            # person entity here would block all future "she/he" resolution for them.

    return cache


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def resolve_pronouns(
    text: str,
    nlp,
    prior_context: dict[str, EntityMention] | None = None,
    turn_boundaries: list[tuple[int, int, str]] | None = None,
) -> tuple[str, dict[str, EntityMention]]:
    """
    Resolve third-person pronouns in `text` to their named entity antecedents.

    Uses salience-based candidate ranking with morphological constraints.
    First-person (I/me/we/us) and second-person (you/your) pronouns are
    never resolved — they require speaker diarization, which is out of scope.

    Args:
        text:           Raw text to resolve.
        nlp:            A loaded spaCy Language object.
        prior_context:  Optional salience table from a prior chunk/session.
                        When provided, entities from the previous call seed the
                        initial salience table so pronouns at the start of this
                        text can resolve to entities introduced earlier.
        turn_boundaries: List of (start_char, end_char, speaker_name) tuples
                        marking speaker turns within the text. When provided,
                        first-person pronouns (I/me/my) inside a turn are
                        resolved to the turn's speaker name. Use
                        ``detect_turn_boundaries()`` to generate these from
                        ``Name: content`` formatted dialogue.

    Returns:
        (resolved_text, final_salience_table)
        - resolved_text: text with pronouns replaced where resolution is confident
        - final_salience_table: the salience state at the end of this text,
          suitable for passing as `prior_context` to the next call
    """
    if not text or not text.strip():
        return text, {}

    doc = nlp(text)
    sents = list(doc.sents)
    if not sents:
        return text, {}

    # Pass 1: build gender cache from pronoun-echo and titles
    gender_cache = _first_pass_gender(doc)

    # Quoted speech: detect quoted spans and find speaker/addressee for each.
    # Used below to resolve first-person "I/me/my" → speaker and "you/your" →
    # addressee inside the quoted content.
    quote_spans: list[tuple[int, int, str | None, str | None]] = []
    for qs, qe in _find_quote_spans(text):
        speaker, addressee = _find_quote_speakers(qs, doc)
        quote_spans.append((qs, qe, speaker, addressee))

    # Pass 2: process sentence by sentence
    # Seed with prior context if provided (cross-chunk/cross-session carry-over)
    salience_table: dict[str, EntityMention] = dict(prior_context) if prior_context else {}
    replacements: list[tuple[int, int, str]] = []  # (start, end, replacement)

    for sent_idx, sent in enumerate(sents):
        # Update salience table with named entities in this sentence
        _build_salience_table(doc, sent_idx, salience_table, gender_cache)

        # Binding Theory B: within one sentence, a non-reflexive pronoun must be
        # locally FREE — it cannot co-refer with any entity already named in the
        # same clause. We enforce this pragmatically by:
        # 1. Pre-seeding with entities literally named in this sentence (proper nouns).
        #    "Alice praised her" → "Alice" pre-seeded → "her" cannot resolve to "Alice".
        # 2. Once a pronoun resolves to entity X, X is added so subsequent pronouns
        #    in the same sentence don't also resolve to X.
        #    "She congratulated her" → "She"→"Caroline" added → "her" cannot → "Caroline".
        # This prevents self-loop edges (subj=obj=same entity) from zeroing edge counts.
        resolved_in_sentence: set[str] = {
            _clean_name(chunk.text).lower()
            for chunk in sent.noun_chunks
            if chunk.root.pos_ == "PROPN"
        }

        # Find pronouns in this sentence and attempt resolution
        for token in sent:
            if token.pos_ not in ("PRON", "DET"):
                continue

            key = token.text.lower()

            # ----------------------------------------------------------------
            # Reflexive pronouns (Binding Theory Principle A)
            # Resolved syntactically to clause subject — bypass salience table
            # and Binding Theory B (reflexives ARE locally bound by design).
            # ----------------------------------------------------------------
            if key in _REFLEXIVE_PRONOUNS:
                antecedent = _resolve_reflexive(token, salience_table)
                if antecedent is None:
                    continue
                if antecedent.lower() == key:
                    continue
                replacement = antecedent
                if token.is_sent_start and antecedent and antecedent[0].islower():
                    replacement = antecedent[0].upper() + antecedent[1:]
                replacements.append((token.idx, token.idx + len(token.text), replacement))
                logger.debug(
                    "[coref] reflexive '%s' → '%s' (char %d–%d)",
                    token.text, replacement, token.idx, token.idx + len(token.text),
                )
                continue

            # ----------------------------------------------------------------
            # Regular (non-reflexive) pronoun resolution
            # ----------------------------------------------------------------
            constraints = _get_pronoun_constraints(token)
            if constraints is None:
                continue
            person, _, _ = constraints
            if person in (1, 2):
                # Turn-boundary resolution: in "Name: content" dialogue,
                # resolve I/me/my to the speaker of the current turn.
                if key in ("i", "me", "my") and turn_boundaries:
                    for tb_start, tb_end, tb_speaker in turn_boundaries:
                        if tb_start <= token.idx < tb_end:
                            replacement = tb_speaker
                            if token.dep_ == "poss" and not replacement.endswith("'s"):
                                replacement += "'s"
                            if token.is_sent_start and replacement and replacement[0].islower():
                                replacement = replacement[0].upper() + replacement[1:]
                            replacements.append(
                                (token.idx, token.idx + len(token.text), replacement)
                            )
                            logger.debug(
                                "[coref] turn-I '%s' → '%s' (char %d–%d)",
                                token.text, replacement, token.idx,
                                token.idx + len(token.text),
                            )
                            break
                    else:
                        # Fallback: try quoted speech attribution
                        for q_start, q_end, speaker, _addr in quote_spans:
                            if q_start <= token.idx < q_end and speaker is not None:
                                replacement = speaker
                                if token.dep_ == "poss" and not replacement.endswith("'s"):
                                    replacement += "'s"
                                if token.is_sent_start and replacement and replacement[0].islower():
                                    replacement = replacement[0].upper() + replacement[1:]
                                replacements.append(
                                    (token.idx, token.idx + len(token.text), replacement)
                                )
                                logger.debug(
                                    "[coref] quoted-I '%s' → '%s' (char %d–%d)",
                                    token.text, replacement, token.idx,
                                    token.idx + len(token.text),
                                )
                                break
                elif key in ("i", "me", "my"):
                    # No turn boundaries — only quoted speech attribution
                    for q_start, q_end, speaker, _addr in quote_spans:
                        if q_start <= token.idx < q_end and speaker is not None:
                            replacement = speaker
                            if token.dep_ == "poss" and not replacement.endswith("'s"):
                                replacement += "'s"
                            if token.is_sent_start and replacement and replacement[0].islower():
                                replacement = replacement[0].upper() + replacement[1:]
                            replacements.append(
                                (token.idx, token.idx + len(token.text), replacement)
                            )
                            logger.debug(
                                "[coref] quoted-I '%s' → '%s' (char %d–%d)",
                                token.text, replacement, token.idx,
                                token.idx + len(token.text),
                            )
                            break
                elif key in ("you", "your"):
                    for q_start, q_end, _spkr, addressee in quote_spans:
                        if q_start <= token.idx < q_end and addressee is not None:
                            replacement = addressee
                            if token.dep_ == "poss" and not replacement.endswith("'s"):
                                replacement += "'s"
                            if token.is_sent_start and replacement and replacement[0].islower():
                                replacement = replacement[0].upper() + replacement[1:]
                            replacements.append(
                                (token.idx, token.idx + len(token.text), replacement)
                            )
                            logger.debug(
                                "[coref] quoted-you '%s' → '%s' (char %d–%d)",
                                token.text, replacement, token.idx,
                                token.idx + len(token.text),
                            )
                            break
                continue  # I/we/you: skip regular resolution regardless

            # Skip pleonastic (expletive) "it": "It is raining", "It seems that..."
            # These have dep_=expl in spaCy's dependency parse.
            if token.dep_ == "expl":
                continue

            # Try to resolve (backward-looking, salience-based)
            antecedent = _resolve_pronoun(token, salience_table, gender_cache)
            cataphora_used = False

            # Binding Theory B: check before deciding whether to try cataphora.
            # If the backward result is blocked, cataphora may still succeed.
            b_theory_blocked = (
                antecedent is not None
                and antecedent.lower() != token.text.lower()
                and antecedent.lower() in resolved_in_sentence
            )

            if antecedent is None or antecedent.lower() == token.text.lower() or b_theory_blocked:
                # Forward-looking cataphora: if pronoun is in a pre-root clause,
                # the antecedent may appear later in the same sentence.
                # Binding Theory B is NOT applied — the pronoun and antecedent
                # are in different clauses (advcl / prep / mark structure).
                if _is_in_preverbal_clause(token, sent):
                    cataphora_ant = _resolve_cataphora(token, sent, salience_table, gender_cache)
                    if cataphora_ant is not None:
                        antecedent = cataphora_ant
                        cataphora_used = True

            if antecedent is None:
                continue

            # Don't replace a pronoun with itself
            if antecedent.lower() == token.text.lower():
                continue

            if not cataphora_used:
                # Binding Theory B: skip if this entity was already used in this
                # sentence. Prevents subject + object resolving to same entity.
                antecedent_key = antecedent.lower()
                if antecedent_key in resolved_in_sentence:
                    continue
                resolved_in_sentence.add(antecedent_key)

            # Preserve capitalisation if pronoun was sentence-initial
            replacement = antecedent
            if token.is_sent_start and antecedent and antecedent[0].islower():
                replacement = antecedent[0].upper() + antecedent[1:]

            # Possessive pronouns (his/her/their acting as poss det) need "'s"
            # suffix: "his anger" → "John's anger", not "John anger".
            if token.dep_ == "poss" and not replacement.endswith("'s"):
                replacement = replacement + "'s"

            replacements.append((token.idx, token.idx + len(token.text), replacement))
            logger.debug(
                "[coref] '%s' → '%s' (char %d–%d)%s",
                token.text, replacement, token.idx, token.idx + len(token.text),
                " [cataphora]" if cataphora_used else "",
            )

    if not replacements:
        return text, salience_table

    # Apply replacements in reverse order to preserve earlier offsets
    replacements.sort(key=lambda r: r[0], reverse=True)
    result = text
    for start, end, replacement in replacements:
        result = result[:start] + replacement + result[end:]

    return result, salience_table
