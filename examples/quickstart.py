"""TLDR-G public quickstart — the trust story in ~20 lines. No engine, no key.

Signs a sample render trace, verifies it offline, then tampers one byte and
shows verification fail. This is the offline, server-free integrity check
anyone holding a TLDR-G export can run.

The render trace below is a stand-in: the real one is produced by the engine,
but its SHAPE is the public contract in docs/contracts/render-trace-v1.md, and
the verification is identical.
"""

from tp_vrg.attestation import sign_envelope, verify_envelope


def main() -> None:
    payload = {
        "answer_id": "demo-1",
        "answer": "OpenAI and Anthropic are connected through Dario Amodei.",
        "citations": [
            {"segment_id": "s1", "snippet": "Dario Amodei previously worked at OpenAI."}
        ],
    }

    envelope = sign_envelope(payload, "render_trace")
    print("signed by:           ", envelope["key_id"])

    verdict = verify_envelope(envelope)
    print("verify (untampered): ", verdict["valid"], "-", verdict["reason"])
    assert verdict["valid"], "a freshly signed envelope must verify"

    # Tamper one word of the payload after signing.
    envelope["payload"]["answer"] = envelope["payload"]["answer"].replace("Dario", "Sam")
    tampered = verify_envelope(envelope)
    print("verify (tampered):   ", tampered["valid"], "-", tampered["reason"])
    assert not tampered["valid"], "tampering must be detected"

    print("\nOK — integrity is verifiable offline, and tampering is detected.")


if __name__ == "__main__":
    main()
