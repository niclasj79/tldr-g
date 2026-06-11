"""Multi-resolution descent helpers."""

from tp_vrg.multi_res.centroid_query import Candidate, cosine_top_k
from tp_vrg.multi_res.descent_algorithm import GraphScope, PassageScope, macro_retrieve
from tp_vrg.multi_res.descent_step import descent_step
from tp_vrg.multi_res.entry_seed import seed_entry_level
from tp_vrg.multi_res.errors import StaleSubstrateError

__all__ = [
    "Candidate",
    "GraphScope",
    "PassageScope",
    "StaleSubstrateError",
    "cosine_top_k",
    "descent_step",
    "macro_retrieve",
    "seed_entry_level",
]
