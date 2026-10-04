# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

A person who wants to know what a specific place is like right now, before they go. A second person who is actually near that place and can answer in a few taps. At the hackathon demo, both roles are teammates on separate browser sessions.

## Product Purpose

ProxiPrompt turns a natural question about a place into a current recommendation. It checks recent reports first, asks the fewest useful nearby people only when that evidence is thin, and returns an answer with confidence and where it came from. Success is a live ask, a prompt on the responder's current screen, and an answer that updates without a refresh.

## Positioning

Nearby people are sensors. The agent decides what to ask, who is close enough, and when cached evidence is enough. It does not answer from general knowledge.

## Operating Context

Mobile web, installed to the home screen when possible. One app serves both roles. Demo location is an explicit override on the You screen; distance, selection, and delivery still use the real pipeline. Local demo: asker at localhost, responder at 127.0.0.1, started with `pnpm dev`.

## Capabilities and Constraints

Ask a place-specific question. Resolve the place from a curated Ann Arbor catalog. Show a compact activity timeline and a High / Medium / Low answer. Prompt selected responders with a card on any screen, with quick choices, an optional note, Send, and Not now. Live Pulse lists place updates, anonymous by default, with comments. Exact coordinates stay private. Prompt answers are not a public thread. Web Push needs keys that are not configured yet, so the in-app card is the delivery that must work.

## Brand Commitments

The name is ProxiPrompt. Do not present it as a nightlife app or a generic social network.

## Evidence on Hand

Curated campus places (Shapiro Undergraduate Library, Michigan Union, Intramural Sports Building, and the rest of the catalog). No customer quotes, usage numbers, or press.

## Product Principles

Ask about a place, not about a person. Interrupt the fewest people who can actually see it. Say when evidence is thin. Keep answering on the screen the responder is already using. Label simulated location as simulated.
