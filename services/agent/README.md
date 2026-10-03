# ProxiPrompt: real-time local conditions from nearby humans

**ProxiPrompt turns nearby humans into queryable, uncertainty-aware sensors.** Ask about a specific place's *current* conditions. The agent works out what you actually need to know, checks fresh evidence, asks the fewest useful people physically near that place only if it has to, and returns an answer with a confidence level and provenance.

It never answers from model world-knowledge. With no fresh evidence the answer is an explicit **"insufficient fresh evidence"**.

## What you can ask

- "Is Shapiro Library busy right now?"
- "Is Shapiro worth going to if I need somewhere quiet to study?"
- "How long is the line at the Michigan Union?"
- "Are there any free treadmills at the CCRB?"
- "Is there parking near Michigan Stadium?"
- "Is South Quad Dining open and is there a wait?"

## Capabilities

- **Plan:** turns a question into the few conditions worth checking (noise, seating, crowd, wait time, line length, equipment, parking, open status, atmosphere, "is it worth it") and a short, neutral micro-survey for people near the place.
- **Synthesize:** composes a one-sentence answer plus caveats from a bundle of fresh nearby reports. It never invents evidence or raises the computed confidence. Subjective opinions are labeled as opinions.
- **Summarize posts:** condenses community posts into one sentence and structured claims that expire quickly.
- **Privacy by design:** the requester is never identified to the people who are asked, and responders' identities and coordinates are never exposed. Questions about private individuals, homes, dorm rooms, patients or surveillance are refused.

Keywords: local conditions, crowd, wait time, seating, campus, real-time, human sensors, line length, noise level, availability, University of Michigan, Ann Arbor.

## Talking to the agent

Use the Chat Protocol (ASI:One, or the Agentverse "Chat with Agent" button). Name a place and what you want to know. Answers come back with a headline, a High / Medium / Low confidence, and a sources line such as "2 recent nearby reports". Collecting live answers from nearby people can take up to a minute or two; if it isn't ready the agent says so and you can ask again.

## Interfaces

| Interface | Used by | Notes |
|---|---|---|
| Chat Protocol (`chat_protocol_spec`, manifest published, mailbox) | ASI:One / Agentverse users | Replies, then ends the session |
| `POST /plan`, `POST /synthesize`, `POST /summarize_post`, `GET /health` | ProxiPrompt orchestrator | JSON over HTTP, see `SPEC.md` §9 |

Planner behavior: when `ASI_ONE_API_KEY` is set, ASI:One (OpenAI-compatible, `https://api.asi1.ai/v1`, model `asi1` by default) does the planning and writing; every output is validated and clamped (dimension vocabulary, TTL bounds, radius 50–500 m, 1–5 responders, 1–3 survey controls). With no key, or if the model output is invalid, a deterministic heuristic planner is used and responses carry `"planner": "heuristic"`.

---

## Run locally

Requires [uv](https://docs.astral.sh/uv/). Python 3.12 is pinned in `.python-version` (uv downloads it if needed).

```bash
cd services/agent
cp .env.example .env        # fill in values; names only are committed
uv sync
uv run pytest               # unit + REST integration tests
set -a; source .env; set +a # export env vars (or use your process manager)
uv run python -m proxiprompt_agent.agent
```

If your machine has a slow `pyenv`, run uv with `UV_PYTHON_PREFERENCE=only-managed`.

Environment (names only; see `.env.example`):

| Variable | Purpose |
|---|---|
| `ASI_ONE_API_KEY`, `ASI_ONE_MODEL` | LLM; unset key ⇒ heuristic planner |
| `AGENT_SEED` | Secret, stable. Determines the agent address |
| `AGENT_PORT` | Default `8001` |
| `AGENT_MAILBOX` | `1` to connect through the Agentverse mailbox |
| `AGENT_ENDPOINT` | Public HTTPS `/submit` URL if not using a mailbox |
| `AGENT_HANDLE` | Optional Agentverse handle (e.g. `proxiprompt`) |
| `ORCHESTRATOR_URL` | Base URL of the orchestrator for the Chat Protocol bridge. Unset ⇒ chat replies with the plan only |

Quick check:

```bash
curl -s localhost:8001/health
curl -s -X POST localhost:8001/plan -H 'content-type: application/json' -d '{
  "query_id":"q1","text":"Is Shapiro worth going to if I need somewhere quiet to study?",
  "place":{"id":"shapiro-undergraduate-library","name":"Shapiro Undergraduate Library","category":"library","lat":42.2757,"lng":-83.7382},
  "now_iso":"2026-10-03T19:00:00Z","recent_evidence":[]}'
```

## Register on Agentverse (mailbox) and make it discoverable in ASI:One

1. Create an ASI:One API key at <https://asi1.ai/dashboard/api-keys> and put it in `ASI_ONE_API_KEY`.
2. Pick a long random `AGENT_SEED` and keep it stable. Set `AGENT_MAILBOX=1` and (optionally) `AGENT_HANDLE=proxiprompt`.
3. Start the agent. The log prints `Agent inspector available at https://agentverse.ai/inspect/?uri=...&address=agent1...`. Open that link.
4. Click **Connect → Mailbox → Finish**. Sign in to Agentverse if asked. The agent now shows under *Local Agents* with a mailbox.
5. In Agentverse, open the agent profile and verify the README (this file) and the keywords are shown. Add the keywords above if missing, and set the handle `@proxiprompt`.
6. Click **Evaluate Registration** and make sure all checks pass (Chat Protocol manifest published, README present, agent active). Keep the process running while evaluating.
7. In ASI:One (<https://asi1.ai>), enable **Agents** and ask: "Ask @proxiprompt: is Shapiro Library busy right now?" (or search the agent by name/handle and open a chat).
8. For the hackathon deployment, run this service on Railway with a public HTTPS URL, set the same `AGENT_SEED`, and keep `AGENT_MAILBOX=1`. The orchestrator reaches it over `AGENT_URL`.
