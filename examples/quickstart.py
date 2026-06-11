import asyncio

from tp_vrg import LODGraphMemory


async def main() -> None:
    mem = LODGraphMemory()
    await mem.ingest(
        "OpenAI, led by Sam Altman, developed GPT-4. "
        "Anthropic was founded by Dario Amodei, who previously worked at OpenAI. "
        "Both companies focus on AI safety. Sam Altman formerly led Y Combinator.",
        source="quickstart-demo",
    )
    context = await mem.render_context("How are OpenAI and Anthropic connected?", profile="chat")
    print(context)


if __name__ == "__main__":
    asyncio.run(main())
