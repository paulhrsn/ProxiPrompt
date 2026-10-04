import httpx
import pytest

from proxiprompt_agent import bridge, chat, llm
from proxiprompt_agent.places import CATALOG

NO_DASH = ("—", "–")


@pytest.fixture
def orch(monkeypatch):
    """Orchestrator configured; records every orchestrated call so tests can assert none was made."""
    calls = []

    async def fake_run(text, sender, url):
        calls.append(text)
        return "orchestrated", None

    monkeypatch.setenv("ORCHESTRATOR_URL", "http://orc")
    monkeypatch.setattr(bridge, "run_orchestrated", fake_run)
    return calls


@pytest.mark.parametrize("text", ["hi", "Hello!", "hey there", "good morning", "yo", "help", "what can you do?",
                                  "who are you", "how does this work", "", "   ", "?", "@agent1qabc", "thanks"])
async def test_greeting_help_and_empty_get_capability_reply_without_a_query(orch, text):
    reply, pending = await bridge.handle_chat_text(text, "s")
    assert orch == [] and pending is None
    assert "ProxiPrompt" in reply
    assert reply.count("?") >= 3  # three example questions
    names = [p.name for p in CATALOG]
    assert sum(1 for line in reply.splitlines() if any(n in line for n in names)) >= 2
    assert not any(d in reply for d in NO_DASH)


@pytest.mark.parametrize("text", ["what places do you know", "list places", "Which places can I ask about?",
                                  "where can i ask about", "what locations do you cover"])
async def test_list_places_returns_whole_catalog(orch, text):
    reply, pending = await bridge.handle_chat_text(text, "s")
    assert orch == [] and pending is None
    for p in CATALOG:
        assert p.name in reply
    assert "Libraries" in reply and "Gyms" in reply
    assert not any(d in reply for d in NO_DASH)


@pytest.mark.parametrize("text", ["is the moon busy", "how's the line at Starbucks on Main"])
async def test_unresolvable_place_names_known_places_without_a_query(orch, text):
    reply, pending = await bridge.handle_chat_text(text, "s")
    assert orch == [] and pending is None
    assert "Shapiro Undergraduate Library" in reply and "Michigan Union" in reply
    assert "list places" in reply.lower()
    assert "went wrong" not in reply.lower()


async def test_unresolvable_place_without_orchestrator_also_replies_helpfully():
    reply, pending = await bridge.handle_chat_text("is the moon busy", "s")
    assert pending is None and "Shapiro Undergraduate Library" in reply and "isn't connected" not in reply


async def test_place_question_with_greeting_word_still_goes_to_orchestrator(orch):
    reply, _ = await bridge.handle_chat_text("hi, is Shapiro busy?", "s")
    assert orch == ["hi, is Shapiro busy?"] and reply == "orchestrated"


async def test_mention_stripped_then_greeting(orch):
    reply, _ = await bridge.handle_chat_text("@agent1qabc hello", "s")
    assert orch == [] and "ProxiPrompt" in reply


async def test_refusal_without_place_is_polite_and_makes_no_query(orch):
    reply, pending = await bridge.handle_chat_text("is my ex at the library", "s")
    assert orch == [] and pending is None
    assert "can't" in reply.lower()


async def test_llm_classifies_unsure_chitchat_when_key_set(orch, monkeypatch):
    monkeypatch.setenv("ASI_ONE_API_KEY", "k")
    seen = {}

    async def fake_json(system, user, schema_hint=""):
        seen["user"] = user
        return {"kind": "chitchat"}

    monkeypatch.setattr(llm, "complete_json", fake_json)
    reply, _ = await bridge.handle_chat_text("tell me a joke about robots", "s")
    assert seen["user"] == "tell me a joke about robots"
    assert orch == [] and "ProxiPrompt" in reply and reply.count("?") >= 3


async def test_llm_place_question_verdict_gives_no_place_reply(orch, monkeypatch):
    monkeypatch.setenv("ASI_ONE_API_KEY", "k")

    async def fake_json(system, user, schema_hint=""):
        return {"kind": "place_question", "answer": "it is busy"}

    monkeypatch.setattr(llm, "complete_json", fake_json)
    reply, _ = await bridge.handle_chat_text("is the moon busy", "s")
    assert "it is busy" not in reply and "Shapiro Undergraduate Library" in reply


async def test_llm_failure_falls_back_to_deterministic_reply(orch, monkeypatch):
    monkeypatch.setenv("ASI_ONE_API_KEY", "k")

    async def boom(*a, **k):
        raise llm.LLMError("down")

    monkeypatch.setattr(llm, "complete_json", boom)
    reply, _ = await bridge.handle_chat_text("tell me a joke about robots", "s")
    assert "Shapiro Undergraduate Library" in reply and orch == []


async def test_llm_not_called_without_key(orch, monkeypatch):
    async def boom(*a, **k):
        raise AssertionError("llm must not be called")

    monkeypatch.setattr(llm, "complete_json", boom)
    await bridge.handle_chat_text("tell me a joke about robots", "s")


async def test_llm_not_called_for_clear_cases(orch, monkeypatch):
    monkeypatch.setenv("ASI_ONE_API_KEY", "k")

    async def boom(*a, **k):
        raise AssertionError("llm must not be called")

    monkeypatch.setattr(llm, "complete_json", boom)
    await bridge.handle_chat_text("hi", "s")
    await bridge.handle_chat_text("list places", "s")
    await bridge.handle_chat_text("is Shapiro busy", "s")


# ---- answer formatting ----

def test_answered_format_has_headline_confidence_reports_freshness_and_note():
    out = bridge.format_result({"status": "answered", "headline": "Shapiro is moderately busy.",
                                "recommendation": "Try the second floor.", "confidence": {"level": "High"},
                                "sources": "2 recent nearby reports", "freshest_age_s": 240})
    lines = out.splitlines()
    assert lines[0] == "Shapiro is moderately busy."
    assert "Recommendation: Try the second floor." in lines
    assert "Confidence: High" in lines
    assert "Based on 2 recent nearby reports (newest 4 min ago)" in lines
    assert "Answers come from people physically near the place" in lines[-1]
    assert not any(d in out for d in NO_DASH)


def test_answered_format_without_optional_fields_omits_them():
    out = bridge.format_result({"status": "answered", "headline": "Quiet.", "confidence": "Medium", "source_count": 1})
    assert "Recommendation" not in out and "newest" not in out
    assert "Based on 1 recent nearby report" in out and "reports" not in out.replace("nearby reports", "")
    assert "Confidence: Medium" in out


def test_insufficient_is_plain_and_does_not_guess():
    out = bridge.format_result({"status": "insufficient"})
    assert "Not enough fresh evidence" in out
    assert "won't guess" in out
    assert "Answers come from people" not in out


def test_refusal_keeps_orchestrator_message_and_default_is_one_sentence_rule():
    assert bridge.format_result({"status": "refused", "message": "ProxiPrompt won't track people."}) == "ProxiPrompt won't track people."
    assert "only reports current conditions at a place" in bridge.format_result({"status": "refused"})


def test_age_text():
    assert chat.age_text(20) == "just now"
    assert chat.age_text(240) == "4 min ago"
    assert chat.age_text(7300) == "2 h ago"


async def test_late_follow_up_is_labelled_and_short():
    def handler(request):
        return httpx.Response(200, json={"status": "answered", "headline": "Seats opened up.", "confidence": "High", "source_count": 2})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
        text = await bridge.poll_until_done("http://orc", "abc", total_s=2, interval_s=0.01, client=c, late=True)
    assert text.startswith("Update on your earlier question:\nSeats opened up.")
    assert "Confidence: High" in text


async def test_progress_message_is_short_and_promises_follow_up():
    def handler(request):
        return httpx.Response(200, json={"id": "abc"} if request.method == "POST" else {"status": "collecting", "progress": "Asking 2 people near Shapiro"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
        reply, pending = await bridge.run_orchestrated("Is Shapiro busy?", "s", "http://orc", total_s=0.05, interval_s=0.01, client=c)
    assert pending == "abc" and "Asking 2 people near Shapiro" in reply and len(reply.splitlines()) <= 2
    assert not any(d in reply for d in NO_DASH)


def test_format_result_from_a_realistic_orchestrator_poll_payload():
    payload = {"id": "asi-abc", "queryId": "7", "status": "answered", "progress": "Answer ready",
               "headline": "Shapiro is moderately busy.", "confidence": "High",
               "sources": "2 recent nearby reports", "recommendation": "go", "freshest_age_s": 240}
    out = bridge.format_result(payload)
    assert "Recommendation: Worth going now." in out
    assert "Based on 2 recent nearby reports (newest 4 min ago)" in out
