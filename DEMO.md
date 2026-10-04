# ProxiPrompt demo script

Three minutes for judges, beat by beat. Based on SPEC section 14 plus everything built since. A 60-second cut, a pre-demo checklist, the solo MainCloud recipe with timings, and fallbacks are below.

Tabs used throughout:

- **Asker:** `http://localhost:5173/` (Paul)
- **Responder:** `http://127.0.0.1:5173/` (a teammate, or Paul in the second tab)

The two hosts do not share a login. That is intentional: they are two separate people.

---

## The 3-minute script

### 0:00 - Hook (15 s)

**Show:** asker tab. Already signed in; if asked, say the app opens on a real SpacetimeAuth sign-in (email magic link), with **Use demo session** for instant access.
**Say:** "ProxiPrompt turns nearby humans into sensors. Google can tell you a library exists. It cannot tell you if there is a quiet seat right now. We ask the fewest people who are actually there, and we tell you how sure we are."

### 0:15 - Ask a real question (20 s)

**Do:** pick Shapiro Undergraduate Library. Type "Is Shapiro worth going to if I need somewhere quiet to study?" and press **Ask**.
**Say:** "I never say where I am. Only where the responders are matters."
**Audience sees:** the live timeline: Understanding your question, Checking recent updates.

### 0:35 - ASI:One reads the question (20 s)

**Say:** "ASI:One is the reasoning engine. It turns this into the few conditions worth checking: noise, seating, whether it is worth it. It also reviews the wording first. It rewrites messy questions and refuses bad ones: questions about a named person, a dorm room, or anything that is not observable at a place right now. It never answers from world knowledge."
**Optional live beat:** type "is my ex at the library" and show it refused, then go back to the real question.
**Audience sees:** the timeline line "Asking N people near Shapiro Undergraduate Library".

### 0:55 - Only nearby people are asked (25 s)

**Show:** switch to the responder tab. The prompt pops up.
**Say:** "This tab has a demo location at Shapiro, so it is asked. A teammate placed at the Michigan Union, about 600 m away, is not. Only the GPS reading is simulated; distance, eligibility and push use the real pipeline. The card says 'Quick question about Shapiro', never who asked."
**Do:** pick quick-choice answers (for example noise: Quiet, seats: Some open) and press **Send**.
**Audience sees:** the "Signal sent" thank-you.

### 1:20 - Answer with confidence and provenance (25 s)

**Show:** back to the asker tab.
**Say:** "The answer arrived live. Confidence comes from deterministic scoring in code (freshness, source weight, agreement), not from the LLM. The LLM only writes the sentence and cannot raise the score."
**Audience sees:** recommendation, High / Medium / Low, "N nearby reports, updated Xs ago", expandable sources.
**Optional:** respond from a second location tab or teammate to show confidence rise as reports agree.

### 1:45 - Cache reuse (20 s)

**Do:** in a different account (or the responder tab), ask "Can I find a quiet seat at Shapiro right now?"
**Say:** "Same place, overlapping question, fresh evidence already exists. Nobody is interrupted."
**Audience sees:** the line "Reusing fresh evidence - no one interrupted", and no new prompt on the responder tab.

### 2:05 - Notify me when, and reciprocity (20 s)

**Do:** on the Ask screen press **Notify me when things change**.
**Say:** "A standing watch for up to three hours. The database expires it on its own clock. When a later nearby report shows open seats or quiet, you get told once. And people who answer get answered first: each recent answer adds one more person to your first wave, shown as a 'Priority boost' line on your timeline. Never shown to responders."

### 2:25 - SpacetimeDB runs the clock (15 s)

**Say:** "Every deadline lives in SpacetimeDB. The job deadline, the prompt expiry, the watch expiry and a ten-minute cleanup are scheduled reducers. If our Node worker dies, the database still closes the job and writes 'insufficient fresh evidence'. Rules, privacy views and the state machine are all in the module: 72 guardrail checks."

### 2:40 - ASI:One chat (20 s)

**Show:** Posts tab (Live Pulse) for a few seconds, then ASI:One chat (asi1.ai) with the agent.
**Say:** "People can post proactive updates; they become evidence that expires quickly. And you do not need our app at all: our uAgent is on Agentverse with the Chat Protocol."
**Do:** in ASI:One chat, address the agent and send these three messages in order:

1. `hi` - reply is the capability intro: "Hi, I'm ProxiPrompt. I tell you what a place is like right now (crowds, noise, seating, lines, wait times) using reports from people physically nearby, never guesses." plus three example questions and 'Say "list places" to see everywhere I cover.'
2. `list places` - reply: "I cover these places around Ann Arbor:" then places grouped by category (Libraries, Student unions, Academic, Gyms, Dining halls, Restaurants, Outdoors, Transit, Stadiums).
3. `Is Shapiro busy right now?` - a real query. With neighbors running, the answer arrives in about 10 to 15 s (see timings below) as: a headline, then `Recommendation: Worth going now.` (or `Maybe, check the details first.` / `Probably skip it for now.`), `Confidence: High` (or Medium / Low), `Based on N recent nearby reports (newest just now)`, and the closer "Answers come from people physically near the place, not from guesses."

**Audience sees:** a real query appear in the asker app, then the formatted answer in chat. If a question takes longer than about 45 s the agent first says "Still working on it" and posts the answer as "Update on your earlier question:". A message with no known place gets guidance and "list places"; a refused question gets a refusal, not a guess.

### 3:00 - Close

**Say:** "Nearby humans as sensors, with honest uncertainty. Built on SpacetimeDB, ASI:One and Fetch.ai."

---

## 60-second version

1. (0:00) One line pitch (10 s): "Nearby humans as queryable sensors with honest uncertainty."
2. (0:10) Ask the Shapiro question on the asker tab (10 s).
3. (0:20) Switch to the responder tab, answer the prompt (15 s). Say: "Only people near the place are asked."
4. (0:35) Back to the asker: answer, confidence, report count (10 s).
5. (0:45) Say: "SpacetimeDB holds the rules, privacy views and the clocks. ASI:One plans, reviews and writes. You can also ask it from ASI:One chat." (15 s)

---

## Pre-demo checklist

Do this 30 minutes before.

1. Stack (pick one, from the repo root):
   - Local: `pnpm dev` (SpacetimeDB :3000, agent :8001, orchestrator :8080, web :5173).
   - Hosted database: `STDB_TARGET=maincloud pnpm dev` (uses `proxiprompt-mhacks` on MainCloud; no local SpacetimeDB; refuses a database without our worker token).
2. Confirm health: `curl -s localhost:8001/health` shows `llm_configured:true`.
3. Open two tabs: `http://localhost:5173/` (asker) and `http://127.0.0.1:5173/` (responder). Sign in each. The app opens on a real SpacetimeAuth sign-in (enter an email, follow the magic link; needs `VITE_SPACETIMEAUTH_CLIENT_ID` in `apps/web/.env`) with a **Use demo session** button below it for instant access, a labeled browser-only identity. Use **Use demo session** for rehearsal and the live demo unless you want to show real sign-in. Without a client ID the button reads **Explore the demo**. Pick a username.
4. Responder tab: You tab, Location, choose Shapiro Undergraduate Library (shown as "Demo location, simulated"). Demo locations stay valid for 6 hours in demo mode.
5. Optional far responder: a third profile with the Michigan Union demo location, to prove it is not asked.
6. Notifications: on laptop, You tab, **Enable phone notifications**, allow the browser permission. On iPhone: HTTPS ngrok URL, Share, Add to Home Screen, open from the icon, then enable. Physical iPhone push is untested (see PROGRESS), so do not rely on it live; the in-app prompt pop-up is the dependable path.
7. Clean slate: You tab, Developer tools, **Wipe activity** (localhost only), so old evidence does not skew the demo.
8. Dry run the full Shapiro question once, then wipe again. Remember that wiping removes the cached evidence the cache-reuse beat needs; the first question of the demo creates it.
9. `DEMO_MODE=1` is the default in `pnpm dev`: first wave 10 people, expansion after 10 s, job deadline 30 s.
10. Keep the Agentverse profile and ASI:One chat open in other tabs: https://agentverse.ai/agents/details/agent1q2n246t50502rk048qful37rqmf3sv9yna6z9gsdlynr3lqrcmzhj7p3ncs/profile

## Solo demo: simulated neighbors on MainCloud

Tested recipe (W7 rehearsal, 8 neighbors, scripted asker). Two terminals from the repo root:

```bash
# terminal 1: orchestrator, agent and web app against the hosted database
STDB_TARGET=maincloud pnpm dev

# terminal 2: eight bot residents
pnpm demo:neighbors --uri wss://maincloud.spacetimedb.com --db proxiprompt-mhacks --count 8
```

Do not pass `--seed-posts`: seeded Live Pulse posts make repeat questions answer from cache, so you would not see answers arrive live. Ask at Shapiro, Duderstadt or the Michigan Union, then a reworded repeat to show reuse.

The bots are ordinary user accounts (public client reducers only, never the worker identity) with usernames ending `_sim`, and they answer after a random 3 to 12 s. Say so: "These are simulated neighbors; real people use the same path." Answers still go through the real pipeline (location, eligibility, one response per prompt). A judge may ask, so be plain that they are simulated.

### Expected timings on MainCloud (measured in rehearsal)

| Step | Typical time | What to say while you wait |
|---|---|---|
| First prompt reaches a neighbor | about 3 to 5 s | "ASI:One is turning this into the few conditions worth checking." |
| Live answer (prompt, bot delay, synthesis) | about 10 to 15 s | "Real people near the place are being asked; the confidence comes from code, not the model." |
| Cache reuse (reworded repeat) | about 6 to 8 s, no new prompt | "Fresh evidence already exists, so nobody is interrupted." One 23 to 25 s outlier happened on a busy shared agent. |
| Refusal | instant (about 0.14 s) | Nothing to cover; it is the point. |

Reducer round trips to MainCloud were 0.1 to 0.3 s, so the pauses are the LLM calls and the bot delay, not the network. Ask the next question's setup out loud during the pause instead of staring at the timeline.

---

## What to say if something breaks

| What breaks | What to do and say |
|---|---|
| Nobody answers the prompt | "A deadline fires in the database. With no fresh evidence it says insufficient fresh evidence, and it will not guess." This is the honest-uncertainty beat. Then answer from the responder tab and show the late answer upgrade the result ("Updated answer"). |
| Prompt does not appear on responder tab | Check the demo location is set to the asked place and the tab is signed in as a different user than the asker. Refresh once. Fall back to the simulated neighbors (`pnpm demo:neighbors`, see the solo section). |
| Push notification does not arrive | "Push is wired with Web Push and VAPID, and we tested it on laptop; physical iPhone is not yet tested." Show the in-app prompt pop-up instead. |
| ASI:One (LLM) slow or down | The agent falls back to a deterministic heuristic planner and marks it `planner: heuristic`. Say so: "That is the offline fallback, never presented as the AI." |
| MainCloud unreachable | Stop, run `pnpm dev` for the local database. Same product. |
| ASI:One chat times out | The agent replies "Still working on it" and sends the answer as a follow-up when ready. Show the answer in the app instead. |
| Browser shows "Failed to verify token" | Reload. The app drops a rejected saved token and starts a fresh session. |
| Port in use | `pnpm stop`, then `pnpm dev`. |
| Answer says Low or insufficient | That is the product working. "We show Low rather than pretend." Add one more nearby answer to raise it. |
