# worldcup-settlement

An autonomous AI agent that trades a live World Cup match on Solana, settling on-chain using TxODDS oracle data.

**Track 2 -- Prediction Markets and Settlement** | TxODDS x Solana World Cup Hackathon

## Links

| | |
|---|---|
| Live dashboard | https://dashboard-three-kappa-83.vercel.app |
| Repo | https://github.com/gabchess/worldcup-settlement |
| Demo video | [DEMO_VIDEO_URL -- paste at C13] |

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
Anchor/Rust program on Solana devnet. Three instructions: `init_market`, `open_position`, `settle_from_proof`. Verifies a Merkle proof against the TxODDS on-chain `daily_scores_roots` PDA. Includes a Plan-B trusted-oracle fallback (`USE_PLAN_B` flag). Security hardened: double-settle guard, match_id replay guard, checked arithmetic, settle authority, PDA owner-check.

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

Settlement reads the TxODDS `daily_scores_roots` PDA on Solana devnet. The program verifies a Merkle proof (`proof_nodes` + `stat_data`) against the stored root for the epoch day. `stat_data` encodes match_id (bytes 0-7, little-endian u64) and outcome byte (byte 8: 0=Home, 1=Away, 2=Draw).

---

## Deployed Program

**Program ID:** `FFnQCXKLVLgA4Wn6PjH9mitKpHFqFtKz9HcF6qFRWnmp`

Network: Solana devnet. This is not the TxODDS oracle program.

```bash
solana program show FFnQCXKLVLgA4Wn6PjH9mitKpHFqFtKz9HcF6qFRWnmp --url devnet
```

**Live dashboard:** https://dashboard-three-kappa-83.vercel.app

The dashboard shows last agent action, open positions, live P&L, and the latest Opus reasoning trace.

---

## Repo Layout

```
programs/worldcup-settlement/   Anchor/Rust settlement contract
  src/                          Instructions, market, position, proof, constants
  tests/settlement.rs           7 integration tests (litesvm, no validator)

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
cargo build-bpf

# Run tests (in-process, no validator required).
# build.rs compiles the test-oracle build automatically, so no flags are needed.
cargo test
```

15 tests (8 unit + 7 integration), all green, cover: market init, position opens, double-settle guard, match_id replay guard, settle authority, Merkle proof verification, and Plan-B oracle path.

### Prediction model

```bash
cd model
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt

# Train (downloads StatsBomb Open Data)
../.venv/bin/python train.py

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

**Track:** Track 2 -- Prediction Markets and Settlement

**Program ID:** `FFnQCXKLVLgA4Wn6PjH9mitKpHFqFtKz9HcF6qFRWnmp`

**Live dashboard:** https://dashboard-three-kappa-83.vercel.app
