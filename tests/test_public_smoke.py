import pytest

from tp_vrg import LODGraphMemory


@pytest.mark.asyncio
async def test_public_quickstart_ingest_and_render_smoke() -> None:
    mem = LODGraphMemory()
    result = await mem.ingest(
        "OpenAI, led by Sam Altman, developed GPT-4. "
        "Anthropic was founded by Dario Amodei, who previously worked at OpenAI.",
        source="public-smoke",
    )
    assert result.nodes

    context = await mem.render_context("How are OpenAI and Anthropic connected?", profile="chat")
    assert context.strip()
    assert "OpenAI" in context or "Anthropic" in context
