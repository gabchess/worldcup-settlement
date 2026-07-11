# World Cup TxODDS

An autonomous AI agent that bets on a live World Cup match on Solana, settling on-chain using TxODDS oracle data.

**Trading Tools and Agents** | TxODDS x Solana World Cup Hackathon

## Links

| | |
|---|---|
| Live dashboard | https://dashboard-three-kappa-83.vercel.app |
| Repo | https://github.com/gabchess/worldcup-settlement |
| Demo video | https://youtu.be/M1O9fO2TZoA |

---

## Architecture

Four layers that connect live football data to on-chain settlement:

```
TxLINE (TxODDS oracle)  -->  Logistic model  -->  Opus 4.8 LLM  -->  autonomous loop
         |                         |                    |                    |
  fixtures/scores/odds       P(home wins)        trade/hold/exit       open_position
  daily_scores_roots PDA     Brier 0.158         public trace         on-chain tx
```

**Layer 1 -- Settlement contract** (`programs/worldcup-settlement`)
Anchor/Rust program on Solana devnet. Three instructions: `init_market`, `open_position`, `settle_from_proof`. Settles live via a trusted-oracle path (`USE_PLAN_B = true`): a designated oracle authority posts the match outcome directly, no Merkle proof required. A trustless Merkle verifier against the TxODDS on-chain `daily_scores_roots` PDA is implemented and unit-tested in `src/proof/verify.rs`, but is not the active path on the deployed program (see Honesty / Disclosures below). Security hardened: double-settle guard, match_id replay guard, checked arithmetic, settle authority, PDA owner-check.

**Layer 2 -- Prediction model** (`model/`)
Logistic regression with Platt calibration. Outputs P(home wins match) from 4 in-play features: score differential, match phase, red-card delta, and match-phase squared. Trained on StatsBomb Open Data (World Cup 2022 + Euro, 60 matches). Holdout Brier score: 0.158 vs 0.243 baseline (35% better).

**Layer 3 -- LLM trigger** (`agent/assessor.ts`, `agent/trigger.ts`)
Claude Opus 4.8 fires on material events (goal, red card). Writes a public reasoning trace with its trade recommendation and confidence. Hard timeout: 20 s, with a HOLD fallback to keep the loop live.

**Layer 4 -- Autonomous loop** (`agent/loop.ts`)
Edge filter + fractional Kelly sizing (0.5 fraction, 0.25 cap) + on-chain `open_position`. Operational floor: per-cycle watchdog (30 s), LLM timeout, anomaly halt on no-trades or balance floor breach.

---

## TxLINE Integration

TxLINE is the TxODDS live data feed and the settlement proof source.

### Auth flow

```
POST /auth/guest/start
  --> Bearer JWT

POST /api/token/activate
  body: { txSig, walletSignature (base64 Ed25519 over txSig bytes), leagues: [] }
  --> X-Api-Token

Data endpoints use dual headers:
  Authorization: Bearer <jwt>
  X-Api-Token: <apiToken>
```

Note: `leagues: []` is required. `leagues: ["world_cup"]` returns HTTP 500.

### Live data endpoints

- `GET /api/fixtures/snapshot` -- all fixtures
- `GET /api/scores/snapshot?fixtureId=N` -- live scores
- `GET /api/odds/snapshot?fixtureId=N` -- current odds

### Settlement proof

Two settlement paths exist. The deployed program runs Plan-B: a trusted oracle authority calls `settle_from_proof` with the match outcome directly, and the program checks the caller's signature against the configured oracle pubkey. No Merkle proof is read or verified on the live path.

The Merkle path (`verify_proof_against_pda` in `src/proof/verify.rs`) reads the TxODDS `daily_scores_roots` PDA and verifies a Merkle proof (`proof_nodes` + `stat_data`) against the stored root for the epoch day, with `stat_data` encoding match_id (bytes 0-7, little-endian u64) and outcome byte (byte 8: 0=Home, 1=Away, 2=Draw). It is unit-tested but gated off (`USE_PLAN_B = true`) because the proof encoding against live TxODDS data was not confirmed in time.

---

## Honesty / Disclosures

The deployed devnet program settles live via Plan-B: a trusted oracle authority posts the match outcome, and the program checks the caller's signature against a hardcoded pubkey. That is what actually runs when the autonomous loop settles a bet.

The trustless path is real code, not a placeholder. `verify_merkle_proof` and `verify_proof_against_pda` in `src/proof/verify.rs` walk a Merkle proof against the TxODDS `daily_scores_roots` PDA and are covered by unit tests: valid proof, tampered node rejected, wrong leaf rejected, PDA owner-check. It is switched off on the deployed program (`USE_PLAN_B = true` in `src/constants.rs`) because the exact hash function and leaf encoding TxODDS uses in production were not confirmed against live data in time for the hackathon window (tracked as C6 in the code comments).

Flip `USE_PLAN_B` to `false` once that encoding is confirmed and `settle_from_proof` runs trustlessly, no changes needed to the calling agent.

All P&L shown on the dashboard is a mark-to-model estimate, not settled winnings: a devnet proof of concept, not a claim of realized returns.

---

## Deployed Program

**Program ID:** `FFnQCXKLVLgA4Wn6PjH9mitKpHFqFtKz9HcF6qFRWnmp`

Network: Solana devnet. This is not the TxODDS oracle program.

```bash
solana program show FFnQCXKLVLgA4Wn6PjH9mitKpHFqFtKz9HcF6qFRWnmp --url devnet
```

The live dashboard (linked above) shows last agent action, open positions, live P&L, and the latest Opus 4.8 reasoning trace.

---

## Repo Layout

```
programs/worldcup-settlement/   Anchor/Rust settlement contract
  src/                          Instructions, market, position, proof, constants
  tests/settlement.rs           11 integration tests (litesvm, no validator)
  tests/claim_payout.rs         9 integration tests (litesvm, no validator)

client/                         TxLINE TypeScript client
  txline-client.ts              Auth, fixtures, scores, odds, Merkle proof
  live-capture.ts               C12 live match capture script
  subscribe-fresh.ts            Subscription bootstrapper
  normalize.ts                  Match-state normalizer

model/                          Python prediction model
  train.py                      LogisticRegression + Platt calibration, StatsBomb data
  predict_sample.py             Verifier + predict() function
  model.joblib                  Fitted model
  model.json                    JSON export for TS bridge
  metrics.json                  Holdout metrics

agent/                          Autonomous trading loop (TypeScript)
  loop.ts                       Main autonomous loop
  assessor.ts                   Opus 4.8 LLM assessor (real + stub)
  trigger.ts                    Material event detection (goal, red card)
  model.ts                      TS bridge to model.json
  logger.ts                     Trace writer (traces.jsonl)
  types.ts                      Shared types

dashboard/                      Next.js status dashboard
  src/app/page.tsx              Main page: positions, P&L, reasoning trace
```

---

## Build and Test

### Settlement contract

```bash
# Build
anchor build

# Run tests (in-process, no validator required).
# build.rs compiles the test-oracle build automatically, so no flags are needed.
cargo test
```

29 tests (8 lib unit + 9 claim_payout integration + 12 settlement integration), all green, cover: market init, lock_ts bounds validation, position opens, betting-lock timing guards, double-settle guard, match_id replay guard, settle authority, Merkle proof verification (valid proof, tampered node rejected, wrong leaf rejected, PDA owner-check), Plan-B oracle path, proportional payout math, conservation of funds, double-claim rejection, and empty-winning-pool refund.

### Prerequisites

The agent reads `~/secrets/solana-worldcup-devnet-wallet.md` at startup before mode-branching. Ensure this file exists on the target machine.

### Prediction model

```bash
cd model
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt

# Train (downloads StatsBomb Open Data)
.venv/bin/python train.py

# Verify predictions
python predict_sample.py
```

Expected: holdout Brier < 0.24, directional sanity passes.

### TxLINE client

```bash
cd client
npm install

# Live capture (requires devnet wallet in ~/secrets/)
npx ts-node live-capture.ts
```

### Autonomous agent

```bash
cd agent
npm install

# Fixture mode (offline, uses fixture.json)
npx ts-node loop.ts

# Live mode
USE_LIVE=1 npx ts-node loop.ts
```

### Dashboard

```bash
cd dashboard
npm install
npm run build
npm run dev
```

---

## Submission

**Track:** Trading Tools and Agents

**Program ID:** `FFnQCXKLVLgA4Wn6PjH9mitKpHFqFtKz9HcF6qFRWnmp`

**Live dashboard:** https://dashboard-three-kappa-83.vercel.app
