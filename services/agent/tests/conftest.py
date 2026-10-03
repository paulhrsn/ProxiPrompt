import pytest

SHAPIRO = {
    "id": "shapiro-undergraduate-library",
    "name": "Shapiro Undergraduate Library",
    "category": "library",
    "lat": 42.2757,
    "lng": -83.7382,
}


@pytest.fixture(autouse=True)
def _no_llm_key(monkeypatch):
    """Tests are heuristic by default; individual tests opt in to the LLM path by mocking llm."""
    monkeypatch.delenv("ASI_ONE_API_KEY", raising=False)
    monkeypatch.delenv("ORCHESTRATOR_URL", raising=False)


@pytest.fixture
def shapiro():
    return dict(SHAPIRO)
