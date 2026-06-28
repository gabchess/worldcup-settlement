# Hackathon Submission

## Links

| | |
|---|---|
| Live dashboard | https://dashboard-three-kappa-83.vercel.app |
| Repo | https://github.com/gabchess/worldcup-settlement |
| Demo video | [DEMO_VIDEO_URL -- paste at C13] |
| Submission URL | [SUBMISSION_URL -- paste at C15] |

---

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

**Live autonomous bet (open_position):** [`3YznzQ4S...`](https://explorer.solana.com/tx/3YznzQ4S3RNZudfDLt2f6BDe7NvA3tSCharWtKkDrjiieWcB1cy8gbERFzdDyvfsgXfGbc6KdUoLCRTNnouN5dxL?cluster=devnet)

**Market init for that bet:** [`2tU4aShf...`](https://explorer.solana.com/tx/2tU4aShfwjhikuzTSBV1C2883VEF2awDKsmnjsjCmCsntgxj6UvfSn22biM2ePwWcW1BvuefWNnWc3c9ZxEFYCyv?cluster=devnet)

The autonomous loop authenticated to TxLINE, read a live in-running match, found a model edge, sized the stake with fractional Kelly, and opened the position on devnet with no human input. Both transactions are Finalized.

---

## Live-Data Evidence

- Authenticated against TxLINE devnet and fetched live World Cup fixtures
- Read a live in-running match (Congo DR vs Uzbekistan) and an earlier live match (England vs Panama)
- Retrieved in-play score fields from the live feed: Goals, YellowCards, RedCards, Clock (minutes)
- Retrieved odds with the InRunning flag set
- Opened a real on-chain position from live in-running data (the open_position transaction above)
- Confirmed the on-chain `daily_scores_roots` Merkle root for the current epoch on devnet, which is the settlement proof source

---

## Team

Solo submission.

---

## Dashboard

https://dashboard-three-kappa-83.vercel.app

Shows: last agent action, open positions, live P&L, latest Opus 4.8 reasoning trace.
