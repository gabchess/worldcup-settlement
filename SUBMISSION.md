# Hackathon Submission

## Track

**Track 2 -- Prediction Markets and Settlement**
TxODDS x Solana World Cup Hackathon

---

## What Was Built

An autonomous AI agent that trades a live World Cup match on Solana from end to end: subscribes to TxLINE for live fixture data, runs an in-play logistic model to produce a win probability, fires Claude Opus 4.8 on material events (goals, red cards) for a trade decision, and calls `open_position` on a deployed Anchor settlement contract.

The settlement contract verifies match outcomes using a Merkle proof against the TxODDS on-chain `daily_scores_roots` PDA. A Plan-B trusted-oracle path is available for devnet testing when Merkle proofs are not yet committed.

The full pipeline -- oracle data in, on-chain position out -- runs autonomously with no human in the loop.

---

## TxLINE Usage

The agent authenticates against TxLINE devnet using the guest JWT flow:

1. `POST /auth/guest/start` returns a Bearer JWT
2. `POST /api/token/activate` with `{ txSig, walletSignature, leagues: [] }` returns an `X-Api-Token`
3. All data endpoints use both headers: `Authorization: Bearer <jwt>` and `X-Api-Token: <token>`

Live data consumed:
- `/api/fixtures/snapshot` -- World Cup fixture list
- `/api/scores/snapshot?fixtureId=N` -- in-play scores (goals, red cards, clock)
- `/api/odds/snapshot?fixtureId=N` -- current market odds

Settlement proof source:
- TxODDS `daily_scores_roots` PDA on Solana devnet -- the contract Merkle-verifies the outcome against the stored daily root

---

## On-Chain Proof

**Deployed program (devnet):** `FFnQCXKLVLgA4Wn6PjH9mitKpHFqFtKz9HcF6qFRWnmp`

```bash
solana program show FFnQCXKLVLgA4Wn6PjH9mitKpHFqFtKz9HcF6qFRWnmp --url devnet
```

**Live init_market transaction:** `3w5bTL2qr...` (placed from live TxLINE fixture data for England vs Panama)

This transaction was initiated by the autonomous loop from a real TxLINE fixture snapshot, confirming the full auth-to-on-chain path works on devnet.

---

## Live-Data Evidence

- Authenticated against TxLINE devnet and fetched live World Cup fixtures
- Captured scores and odds for England vs Panama (FixtureId from live snapshot)
- Retrieved in-play score fields: Goals, YellowCards, RedCards, Clock (minutes)
- Retrieved odds with InRunning flag set
- Placed a real `init_market` on-chain transaction from live fixture data
- The full capture artifact is at `~/.arcana/c12-live-capture.json`

---

## Demo Video

TBD

---

## Team

Solo submission.

---

## Dashboard

https://dashboard-three-kappa-83.vercel.app

Shows: last agent action, open positions, live P&L, latest Opus 4.8 reasoning trace.
