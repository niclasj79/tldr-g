"""
TP-VRG: Topology-Preserving Variable-Resolution Graphs
=======================================================

A Level-of-Detail knowledge graph memory system for LLMs.
Maintains a persistent skeleton of edges while storing node data
at three resolution tiers, dynamically assembling context based
on topological proximity to the query.
"""

from tp_vrg.embeddings import (
    EmbeddingProvider,
    MockEmbeddingProvider,
    SentenceTransformerProvider,
)
from tp_vrg.engine import LODGraphMemory
from tp_vrg.governor import TokenGovernor
from tp_vrg.llm_service import (
    AnthropicLLMProvider,
    LLMProvider,
    LLMService,
    MockLLMProvider,
)
from tp_vrg.models import (
    PROFILES,
    EdgeData,
    ExtractionResult,
    LODLevel,
    NodeData,
    ScoredNode,
    SourcePassage,
    TokenProfile,
)
from tp_vrg.normalizer import EntityNormalizer, NormalizationResult, normalize_entity_id
from tp_vrg.scoring import RelevanceScorer
from tp_vrg.search import batch_cosine_top_k, bm25_search, is_rust_available
from tp_vrg.storage import InMemoryBackend, StorageBackend
from tp_vrg.tokens import estimate_tokens

__version__ = "0.3.0"
__all__ = [
    # Core engine
    "LODGraphMemory",
    # Models
    "LODLevel",
    "NodeData",
    "EdgeData",
    "ExtractionResult",
    "TokenProfile",
    "ScoredNode",
    "SourcePassage",
    "PROFILES",
    # Scoring & Governor
    "RelevanceScorer",
    "TokenGovernor",
    "estimate_tokens",
    # Normalizer
    "EntityNormalizer",
    "NormalizationResult",
    "normalize_entity_id",
    # Storage
    "StorageBackend",
    "InMemoryBackend",
    # Embeddings
    "EmbeddingProvider",
    "MockEmbeddingProvider",
    "SentenceTransformerProvider",
    # Search
    "batch_cosine_top_k",
    "bm25_search",
    "is_rust_available",
    # LLM Providers
    "LLMProvider",
    "MockLLMProvider",
    "AnthropicLLMProvider",
    "LLMService",
]
