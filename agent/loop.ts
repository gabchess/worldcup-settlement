/**
 * C9.2 — Autonomous trading loop.
 *
 * Wires: C6 fixture data → C7 model → C8 LLM trigger → edge filter →
 * Kelly sizing → open_position on devnet program.
 *
 * KEY SECURITY CONTRACT (mirrors assessor.ts):
 *   - Burner keypair is read from the .md file ONCE at startup, decoded
 *     to a Uint8Array, and held in a variable named `keypair`.
 *   - The raw base58 private key string is NEVER logged, printed, or stored
 *     outside the startup scope.
 *   - `keypair` (the Keypair object) is passed to the Anchor Wallet; the
 *     signing happens inside the SDK, not in userland code.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as anchor from "@anchor-lang/core";
// ponytail: require bs58 at top level — dynamic require inside a function gets
// wrapped by esModuleInterop and loses the named exports.
// Upgrade path: switch to `import bs58 from "bs58"` once the project moves to
// ESM (needs "type":"module" in package.json + tsconfig moduleResolution:bundler).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const bs58 = require("bs58") as { decode: (s: string) => Uint8Array };
import { predictFromMatchState } from "./model";
import { detectTrigger } from "./trigger";
import { logTrace } from "./logger";
import { StubAssessor, RealAssessor } from "./assessor";
import type { MatchState } from "./types";
import { TxLineClient } from "../client/txline-client";
import { normalizeMatchState } from "../client/normalize";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROGRAM_ID = new anchor.web3.PublicKey(
  "FFnQCXKLVLgA4Wn6PjH9mitKpHFqFtKz9HcF6qFRWnmp"
);
const IDL_PATH = path.join(
  __dirname,
  "..",
  "target",
  "idl",
  "worldcup_settlement.json"
);
const WALLET_MD_PATH = path.join(
  os.homedir(),
  "secrets",
  "solana-worldcup-devnet-wallet.md"
);
const RPC_URL = anchor.web3.clusterApiUrl("devnet");

/** Demo match id — new id for C9 part-B re-run (20629 already has a position). */
const MATCH_ID = new anchor.BN(20630);
/** Epoch day placeholder (any u16, program stores it but doesn't constrain). */
const EPOCH_DAY = 100;

/** Kelly tuning */
const EDGE_THRESHOLD = 0.05;
const KELLY_FRACTION = 0.5;
const KELLY_CAP = 0.25; // max f* before fractional Kelly
const BANKROLL_LAMPORTS = 50_000_000; // 0.05 SOL notional bankroll

// ---------------------------------------------------------------------------
// Operational floor — C11
// ---------------------------------------------------------------------------

/** Watchdog: max ms a single loop cycle may take before it is aborted and the
 *  loop continues. 30 s covers any real on-chain RPC call with headroom.
 *  ponytail: global deadline; per-step deadlines only if throughput matters. */
export const CYCLE_WATCHDOG_MS = 30_000;

/** Hard timeout for a single LLM (Opus) assessor call.
 *  On expiry the cycle falls back to HOLD; never hangs the loop. */
export const LLM_TIMEOUT_MS = 20_000;

/** Anomaly: halt after this many consecutive cycles with no trade.
 *  Covers both "bad data feed" and "strategy has no signal" conditions. */
export const NO_TRADE_HALT_CYCLES = 5;

/** Anomaly: halt when wallet balance falls at or below this floor (lamports).
 *  0.01 SOL — enough headroom to always cover rent. */
export const BALANCE_FLOOR_LAMPORTS = 10_000_000;

// ---------------------------------------------------------------------------
// Live mode constants (USE_LIVE=1)
// ---------------------------------------------------------------------------

/** Hard stop after this many live cycles. Prevents unbounded Opus + devnet spend.
 *  First successful open_position also stops the loop (whichever comes first). */
export const MAX_LIVE_CYCLES = 6;

/** Live fixture detection window: StartTime in past + within this many ms. */
const LIVE_WINDOW_MS = 150 * 60 * 1000; // 150 min

/** Path to fresh subscribe txSig written by subscribe-fresh.ts */
const SUBSCRIBE_JSON_PATH = path.join(
  os.homedir(),
  ".arcana",
  "c12-subscribe.json"
);

// ---------------------------------------------------------------------------
// Operational helpers — C11
// ---------------------------------------------------------------------------

/**
 * Race a promise against a timeout. On expiry resolves with `fallback` and
 * logs a structured alert line. Never rejects.
 *
 * ponytail: Promise.race + setTimeout is stdlib — no external dep needed.
 * Upgrade path: replace with AbortSignal.timeout() once Node 18+ is the
 * minimum target (cleaner cancellation, no timer leak risk).
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T,
  label: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const race = Promise.race([
    promise,
    new Promise<T>((resolve) => {
      timer = setTimeout(() => {
        console.error(
          JSON.stringify({
            alert: "TIMEOUT",
            label,
            ms,
            action: "fallback",
            ts: new Date().toISOString(),
          })
        );
        resolve(fallback);
      }, ms);
    }),
  ]);
  // Clear the timer once the real promise wins (prevents handle leak).
  promise.then(() => clearTimeout(timer)).catch(() => clearTimeout(timer));
  return race;
}

/**
 * Check anomaly conditions and return a halt reason or null.
 * Pure function — no side effects — so it is trivially testable.
 *
 * ponytail: two conditions, one function; split only if a third arrives.
 */
export function checkAnomalies(
  consecutiveNoTrades: number,
  walletBalanceLamports: number
): string | null {
  if (consecutiveNoTrades >= NO_TRADE_HALT_CYCLES) {
    return `ANOMALY: no trade for ${consecutiveNoTrades} consecutive cycles (limit=${NO_TRADE_HALT_CYCLES})`;
  }
  if (walletBalanceLamports <= BALANCE_FLOOR_LAMPORTS) {
    return `ANOMALY: wallet balance ${walletBalanceLamports} lamports at or below floor ${BALANCE_FLOOR_LAMPORTS}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Keypair loading — read at startup, never logged
// ---------------------------------------------------------------------------

function loadKeypair(): anchor.web3.Keypair {
  const md = fs.readFileSync(WALLET_MD_PATH, "utf8");
  // Extract base58 key — line: "private key = <base58>"
  const match = md.match(/private key\s*=\s*([A-Za-z1-9][A-Za-z0-9]{43,})/);
  if (!match)
    throw new Error("Could not parse private key from wallet .md file");
  const base58Key = match[1];
  const secretBytes: Uint8Array = bs58.decode(base58Key);
  const kp = anchor.web3.Keypair.fromSecretKey(secretBytes);
  // Security assertion: confirm pubkey matches expected value without logging key
  const expected = "8gbaJEfM5VDs9BpFLgwMTq7s2FkVpEri8ZnPbxn4HPqY";
  if (kp.publicKey.toBase58() !== expected) {
    throw new Error(`Keypair pubkey mismatch — expected ${expected}`);
  }
  return kp;
}

// ---------------------------------------------------------------------------
// Anchor program client
// ---------------------------------------------------------------------------

function buildProgram(keypair: anchor.web3.Keypair): anchor.Program {
  const connection = new anchor.web3.Connection(RPC_URL, "confirmed");
  const wallet = new anchor.Wallet(keypair);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);
  const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf8"));
  return new anchor.Program(idl, provider);
}

// ---------------------------------------------------------------------------
// Market PDA helpers
// ---------------------------------------------------------------------------

async function marketPdaExists(
  program: anchor.Program,
  matchId: anchor.BN
): Promise<boolean> {
  const [marketPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("market"), matchId.toArrayLike(Buffer, "le", 8)],
    PROGRAM_ID
  );
  try {
    const info = await program.provider.connection.getAccountInfo(marketPda);
    return info !== null;
  } catch {
    return false;
  }
}

async function initMarket(
  program: anchor.Program,
  keypair: anchor.web3.Keypair,
  matchId: anchor.BN
): Promise<string> {
  const tx = await (program.methods as any)
    .initMarket(matchId, EPOCH_DAY)
    .accounts({ authority: keypair.publicKey })
    .rpc();
  return tx;
}

async function openPosition(
  program: anchor.Program,
  keypair: anchor.web3.Keypair,
  matchId: anchor.BN,
  stakeLamports: anchor.BN,
  side: "home"
): Promise<string> {
  const [marketPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("market"), matchId.toArrayLike(Buffer, "le", 8)],
    PROGRAM_ID
  );
  const tx = await (program.methods as any)
    .openPosition(stakeLamports, { [side]: {} })
    .accounts({
      market: marketPda,
      bettor: keypair.publicKey,
    })
    .rpc();
  return tx;
}

// ---------------------------------------------------------------------------
// Market probability (de-vigged)
// ---------------------------------------------------------------------------

function marketProb(prices: number[]): number {
  if (prices.length === 0) return 0.5;
  const raws = prices.map((p) => 1 / p);
  const total = raws.reduce((s, r) => s + r, 0);
  // home is index 0 in the fixture/IDL convention
  return raws[0] / total;
}

// ---------------------------------------------------------------------------
// Kelly stake (fractional)
// ---------------------------------------------------------------------------

function kellyStake(
  modelP: number,
  decimalOdds: number
): { stake: number; fStar: number } {
  const b = decimalOdds - 1;
  if (b <= 0) return { stake: 0, fStar: 0 };
  const fStar = (b * modelP - (1 - modelP)) / b;
  const clamped = Math.max(0, Math.min(fStar, KELLY_CAP));
  return {
    stake: Math.floor(BANKROLL_LAMPORTS * KELLY_FRACTION * clamped),
    fStar,
  };
}

// ---------------------------------------------------------------------------
// Live mode: credential loading (path-only, never logged)
// ---------------------------------------------------------------------------

/**
 * Read the wallet private key (base58) from the secrets .md file at call time.
 * The raw value is returned only to the immediate caller (liveAuth); never stored
 * in a persistent variable or logged.
 */
function readPrivKeyB58(): string {
  const md = fs.readFileSync(WALLET_MD_PATH, "utf8");
  const m = md.match(/private key\s*=\s*([A-Za-z1-9][A-Za-z0-9]{43,})/);
  if (!m) throw new Error("Could not parse private key from wallet .md file");
  return m[1];
}

/**
 * Read the fresh subscribe txSig from ~/.arcana/c12-subscribe.json.
 */
function readSubscribeTxSig(): string {
  const raw = fs.readFileSync(SUBSCRIBE_JSON_PATH, "utf8");
  const parsed = JSON.parse(raw) as { txSig: string };
  if (!parsed.txSig) throw new Error("c12-subscribe.json missing txSig field");
  return parsed.txSig;
}

// Internal type for the raw TxLINE fixture list entry (live schema)
interface LiveFixtureEntry {
  FixtureId: number;
  Participant1: string;
  Participant2: string;
  StartTime: number; // unix ms
  Competition: string;
}

/**
 * Pick the live in-progress World Cup fixture: StartTime in the past, within
 * LIVE_WINDOW_MS. Prefers most-recently-started. Falls back to most recent
 * past fixture when no live match is found (for testing outside match windows).
 */
function pickLiveFixture(
  fixtures: LiveFixtureEntry[],
  nowMs: number
): { fixture: LiveFixtureEntry; isActuallyLive: boolean } {
  const live = fixtures.filter(
    (f) => f.StartTime <= nowMs && nowMs - f.StartTime < LIVE_WINDOW_MS
  );
  if (live.length > 0) {
    const fixture = live.reduce((a, b) => (a.StartTime > b.StartTime ? a : b));
    return { fixture, isActuallyLive: true };
  }
  // No live match — use most recently started (graceful fallback)
  const past = fixtures.filter((f) => f.StartTime <= nowMs);
  if (past.length === 0)
    throw new Error("No past fixtures found in TxLINE snapshot");
  const fixture = past.reduce((a, b) => (a.StartTime > b.StartTime ? a : b));
  return { fixture, isActuallyLive: false };
}

// ---------------------------------------------------------------------------
// Live mode: main loop
// ---------------------------------------------------------------------------

/**
 * runLiveLoop — bounded live trading loop.
 *
 * Safety contract:
 *   - Stops after first successful open_position OR MAX_LIVE_CYCLES, whichever first.
 *   - Opus (RealAssessor) called ONLY on material events (goal / red card).
 *   - All C11 watchdog/timeout/anomaly floor checks remain active.
 *   - Never logs the private key or API key value.
 *   - Appends cycle + Opus trace to agent/traces.jsonl (and stdout).
 */
async function runLiveLoop(
  program: anchor.Program,
  keypair: anchor.web3.Keypair,
  connection: anchor.web3.Connection
): Promise<void> {
  console.log("\n=== LIVE MODE (USE_LIVE=1) ===");
  console.log(`MAX_LIVE_CYCLES=${MAX_LIVE_CYCLES}, stop-on-first-bet=true`);
  console.log("Authenticating against TxLINE...");

  // Auth once at startup — apiToken is reused for all polls (not single-use)
  const liveClient = new TxLineClient({ useFixture: false });
  const txSig = readSubscribeTxSig();
  const privKeyB58 = readPrivKeyB58(); // read at call time, held only in this scope
  await liveClient.liveAuth(txSig, privKeyB58);
  // privKeyB58 goes out of scope after liveAuth returns; GC eligible immediately
  console.log("Auth complete (jwt + apiToken cached in client).");

  // Discover live fixture
  console.log("Fetching fixtures snapshot...");
  const rawFixtures =
    (await liveClient.rawFixturesSnapshot()) as LiveFixtureEntry[];
  const nowMs = Date.now();
  const { fixture, isActuallyLive } = pickLiveFixture(rawFixtures, nowMs);
  const fixtureId = fixture.FixtureId;
  console.log(
    `Target fixture: ${fixture.Participant1} vs ${fixture.Participant2}` +
      ` (FixtureId=${fixtureId}, live=${isActuallyLive})`
  );
  if (!isActuallyLive) {
    console.warn(
      "WARNING: No in-progress match found. Using most recent past fixture for structure test."
    );
  }

  // Ensure market PDA exists for this fixture's match ID
  const liveMatchId = new anchor.BN(fixtureId);
  const pdaExists = await marketPdaExists(program, liveMatchId);
  if (!pdaExists) {
    console.log(`Initialising market PDA for FixtureId=${fixtureId}...`);
    const initTx = await initMarket(program, keypair, liveMatchId);
    console.log(`init_market tx: ${initTx}`);
  } else {
    console.log("Market PDA already exists.");
  }

  const assessor = new RealAssessor(); // Opus 4.8 — key read at call time

  let prevState: MatchState | null = null;
  let positionOpened = false;
  let positionStakeLamports = 0;
  let consecutiveNoTrades = 0;
  let anomalyHalt = false;

  for (
    let cycle = 0;
    cycle < MAX_LIVE_CYCLES && !anomalyHalt && !positionOpened;
    cycle++
  ) {
    console.log(`\n--- Live cycle ${cycle + 1}/${MAX_LIVE_CYCLES} ---`);

    // lastState is written by the IIFE so prevState can be updated after.
    // ponytail: mutable ref beats returning a tuple; only one caller.
    let lastState: MatchState | null = null;

    const cycleResult = await withTimeout<CycleLog | null>(
      (async (): Promise<CycleLog | null> => {
        // Fetch live scores + odds for target fixture
        const [rawScores, rawOdds] = await Promise.all([
          liveClient.scoresSnapshot(fixtureId),
          liveClient.oddsSnapshot(fixtureId),
        ]);

        // rawScores from live endpoint is an array; find the matching entry
        // ponytail: single-pass search; if array is short (1-2 entries) this is fine
        let scoresEntry: unknown = rawScores;
        if (Array.isArray(rawScores)) {
          // Find by FixtureId, fallback to first entry
          const found = (rawScores as Array<{ FixtureId?: number }>).find(
            (e) => e.FixtureId === fixtureId
          );
          scoresEntry = found ?? rawScores[0] ?? {};
        }

        const state = normalizeMatchState(
          fixtureId,
          scoresEntry as import("../client/types").ScoresSnapshot,
          rawOdds
        );
        lastState = state; // expose to outer scope for prevState tracking

        console.log(
          `  scores: ${state.homeScore ?? "?"}–${state.awayScore ?? "?"} ` +
            `minute=${state.currentMinute ?? "?"}' ` +
            `isLive=${state.isLive} ` +
            `prices=[${state.prices.join(", ")}]`
        );

        if (!state.isLive) {
          console.log("  Not live (InRunning=false) — skip.");
          return {
            cycle,
            fixtureId,
            modelP: 0,
            marketP: 0,
            edge: 0,
            decision: "skip-not-live",
          };
        }

        const modelP = predictFromMatchState(
          state.scoreDifferential ?? 0,
          state.matchPhase ?? 1,
          state.redCardDelta ?? 0
        );
        const mktP = marketProb(state.prices);
        const edge = modelP - mktP;

        console.log(
          `  model_P=${modelP.toFixed(4)} market_P=${mktP.toFixed(4)} ` +
            `edge=${edge.toFixed(4)} threshold=${EDGE_THRESHOLD}`
        );

        // Material event check → Opus assessment (event-gated, sparse)
        if (prevState) {
          const trigger = detectTrigger(prevState, state);
          if (trigger) {
            console.log(`  MATERIAL EVENT: ${trigger.type} — calling Opus...`);
            const position: import("./types").PositionContext = {
              side: positionOpened ? ("home" as const) : ("none" as const),
              stake: positionOpened ? positionStakeLamports : 0,
              entryOdds: positionOpened ? state.prices[0] : null,
            };

            const HOLD_FALLBACK = {
              assessment: "LLM call timed out — defaulting to hold.",
              suggestedAction: "hold" as const,
              reasoningTrace: "Timeout; no action taken.",
            };
            const assessment = await withTimeout(
              assessor.assess(trigger, modelP, position),
              LLM_TIMEOUT_MS,
              HOLD_FALLBACK,
              `live-assessor cycle=${cycle}`
            );

            // Log Opus trace to traces.jsonl (and stdout via logTrace)
            logTrace(trigger, modelP, position, assessment, "real");
            console.log(`  Opus assessment: ${assessment.assessment}`);
            console.log(`  Suggested action: ${assessment.suggestedAction}`);
            console.log(`  Reasoning trace: ${assessment.reasoningTrace}`);

            if (
              positionOpened &&
              (assessment.suggestedAction === "exit" ||
                assessment.suggestedAction === "decrease")
            ) {
              return {
                cycle,
                fixtureId,
                modelP,
                marketP: mktP,
                edge,
                decision: "skip-assessor",
                assessorAction: assessment.suggestedAction,
              };
            }
          }
        }

        // Edge filter + Kelly sizing + open_position
        if (edge > EDGE_THRESHOLD && !positionOpened) {
          const homeOdds = state.prices[0];
          const { stake: stakeLamports, fStar } = kellyStake(modelP, homeOdds);

          if (stakeLamports <= 0) {
            console.log("  Kelly stake = 0 (negative EV) — skip.");
            return {
              cycle,
              fixtureId,
              modelP,
              marketP: mktP,
              edge,
              decision: "skip-no-edge",
            };
          }

          console.log(
            `  EDGE > threshold! stake=${stakeLamports} lamports ` +
              `(${(stakeLamports / 1e9).toFixed(6)} SOL) ` +
              `f*=${fStar.toFixed(4)}`
          );
          console.log(
            `  Calling open_position(stake=${stakeLamports}, side=home) on devnet...`
          );

          try {
            const txSigBet = await openPosition(
              program,
              keypair,
              liveMatchId,
              new anchor.BN(stakeLamports),
              "home"
            );
            positionOpened = true;
            positionStakeLamports = stakeLamports;
            console.log(`  OPEN_POSITION TX: ${txSigBet}`);

            // --- Opus bet-decision narrative (non-blocking) ---
            // Ask the assessor WHY this trade was taken. Runs AFTER the bet
            // lands so a failure here can NEVER affect the position or loop.
            // Uses type="edge" so the narrative describes the real reason:
            // model-vs-market probability gap, not a fictional goal/card.
            const formulaTrace = `Edge=${edge.toFixed(4)}, f*=${fStar.toFixed(
              4
            )}, model_P=${modelP.toFixed(4)}`;
            let betNarrative = formulaTrace; // fallback if Opus fails/times out
            try {
              const betEvent = {
                type: "edge" as const,
                fixtureId,
                fromState: prevState ?? state,
                toState: state,
                edge, // model-vs-market gap; impliedP = modelP - edge
              };
              const betPosition = {
                side: "home" as const,
                stake: stakeLamports,
                entryOdds: homeOdds,
              };
              const betAssessment = await withTimeout(
                assessor.assess(betEvent, modelP, betPosition),
                LLM_TIMEOUT_MS,
                null,
                `bet-narrative cycle=${cycle}`
              );
              if (betAssessment !== null) {
                betNarrative = betAssessment.reasoningTrace;
                console.log(`  Opus bet narrative: ${betNarrative}`);
              }
            } catch (narrativeErr) {
              console.error(
                `  bet-narrative Opus call failed: ${
                  narrativeErr instanceof Error
                    ? narrativeErr.message
                    : narrativeErr
                } — using formula fallback`
              );
            }

            // Log the bet cycle to traces.jsonl so Garry has the tx
            logTrace(
              {
                type: "edge", // truthful: bet triggered by model-vs-market edge
                fixtureId,
                fromState: prevState ?? state,
                toState: state,
                edge,
              },
              modelP,
              { side: "home", stake: stakeLamports, entryOdds: homeOdds },
              {
                assessment: `Bet placed. stake=${stakeLamports} lamports, tx=${txSigBet}`,
                suggestedAction: "hold",
                reasoningTrace: betNarrative,
              },
              "real"
            );
            return {
              cycle,
              fixtureId,
              modelP,
              marketP: mktP,
              edge,
              decision: "bet",
              stakeLamports,
              txSig: txSigBet,
            };
          } catch (err) {
            console.error(
              `  open_position FAILED: ${
                err instanceof Error ? err.message : err
              }`
            );
            return {
              cycle,
              fixtureId,
              modelP,
              marketP: mktP,
              edge,
              decision: "bet-failed",
              stakeLamports,
            };
          }
        } else if (positionOpened) {
          console.log("  Position already open — monitoring.");
          return {
            cycle,
            fixtureId,
            modelP,
            marketP: mktP,
            edge,
            decision: "skip-position-open",
          };
        } else {
          console.log(`  No bet: edge ${edge.toFixed(4)} ≤ threshold`);
          return {
            cycle,
            fixtureId,
            modelP,
            marketP: mktP,
            edge,
            decision: "skip-no-edge",
          };
        }
      })(),
      CYCLE_WATCHDOG_MS,
      null,
      `live-cycle-watchdog cycle=${cycle}`
    );

    if (cycleResult === null) {
      console.error(`  Watchdog fired on cycle ${cycle} — continuing.`);
      if (isActuallyLive) consecutiveNoTrades++;
    } else {
      // Advance prevState so detectTrigger can compare consecutive snapshots.
      // Only update when we successfully fetched a state (lastState set by IIFE).
      if (lastState !== null) prevState = lastState;
      if (cycleResult.decision === "bet") {
        consecutiveNoTrades = 0;
      } else if (isActuallyLive) {
        consecutiveNoTrades++;
      }
    }

    // Balance floor check (C11)
    let walletBalanceLamports = 0;
    try {
      walletBalanceLamports = await connection.getBalance(keypair.publicKey);
    } catch {
      console.error(
        JSON.stringify({
          alert: "BALANCE_READ_ERROR",
          cycle,
          ts: new Date().toISOString(),
        })
      );
    }

    const anomaly = checkAnomalies(consecutiveNoTrades, walletBalanceLamports);
    if (anomaly) {
      console.error(
        JSON.stringify({
          alert: "ANOMALY_HALT",
          reason: anomaly,
          cycle,
          ts: new Date().toISOString(),
        })
      );
      anomalyHalt = true;
    }

    // Brief poll interval between live cycles (avoid hammering the API)
    if (!positionOpened && !anomalyHalt && cycle + 1 < MAX_LIVE_CYCLES) {
      await new Promise((r) => setTimeout(r, 5_000)); // 5s between polls
    }
  }

  const stopReason = positionOpened
    ? "first bet placed"
    : anomalyHalt
    ? "anomaly halt"
    : `MAX_LIVE_CYCLES (${MAX_LIVE_CYCLES}) reached`;
  console.log(`\n=== LIVE LOOP COMPLETE — stopped: ${stopReason} ===`);
  console.log(`Traces written to agent/traces.jsonl`);
}

// ---------------------------------------------------------------------------
// Synthetic state sequence for 3+ unattended cycles
//
// The base fixture has Argentina 2-1 France, 73', home red=0, away red=1.
// We build 5 states that include:
//   - cycle 0 → 1: pre-live state (isLive=false, no edge)
//   - cycle 1 → 2: live, edge present → BET
//   - cycle 2 → 3: goal (scoreDiff changes) → material event → LLM assess
//   - cycle 3 → 4: red card changes → material event → LLM assess
// This satisfies: 3+ cycles, ≥1 edge→bet, ≥1 material event.
// ---------------------------------------------------------------------------

function buildStateSequence(): MatchState[] {
  const base = {
    fixtureId: 20630,
    prices: [1.45, 4.2, 7.5],
    pct: 107.2,
    rawOdds: null,
    rawScores: null,
  };

  const now = Date.now();

  return [
    // Cycle 0: pre-live snapshot (no bet — isLive=false)
    {
      ...base,
      timestamp: now,
      isLive: false,
      homeScore: 2,
      awayScore: 1,
      scoreDifferential: 1,
      currentMinute: 73,
      matchPhase: 5,
      homeRedCards: 0,
      awayRedCards: 1,
      redCardDelta: -1,
    },
    // Cycle 1: match goes live — market backs away heavily, home mispriced.
    // model_P(scoreDiff=1, phase=5, redDelta=-1) ≈ 0.346;
    // market_P(home) = (1/4.20) / (1/4.20 + 1/3.10 + 1/1.85) ≈ 0.175 → edge ≈ +0.17 → BET
    {
      ...base,
      timestamp: now + 5000,
      isLive: true,
      homeScore: 2,
      awayScore: 1,
      scoreDifferential: 1,
      currentMinute: 74,
      matchPhase: 5,
      homeRedCards: 0,
      awayRedCards: 1,
      redCardDelta: -1,
      prices: [4.2, 3.1, 1.85], // home heavily mispriced — model sees +edge
      pct: 110.1,
    },
    // Cycle 2: odds tighten slightly — position already open, no new bet
    {
      ...base,
      timestamp: now + 10000,
      isLive: true,
      homeScore: 2,
      awayScore: 1,
      scoreDifferential: 1,
      currentMinute: 75,
      matchPhase: 5,
      homeRedCards: 0,
      awayRedCards: 1,
      redCardDelta: -1,
      prices: [3.8, 3.2, 1.9], // still positive edge but position already open
      pct: 108.5,
    },
    // Cycle 3: GOAL — away scores, score diff changes → material event
    {
      ...base,
      timestamp: now + 15000,
      isLive: true,
      homeScore: 2,
      awayScore: 2,
      scoreDifferential: 0,
      currentMinute: 78,
      matchPhase: 5,
      homeRedCards: 0,
      awayRedCards: 1,
      redCardDelta: -1,
      prices: [2.1, 3.2, 3.5], // equaliser → odds flip
      pct: 108.0,
    },
    // Cycle 4: RED CARD — home gets one → redCardDelta changes → material event
    {
      ...base,
      timestamp: now + 20000,
      isLive: true,
      homeScore: 2,
      awayScore: 2,
      scoreDifferential: 0,
      currentMinute: 82,
      matchPhase: 6,
      homeRedCards: 1,
      awayRedCards: 1,
      redCardDelta: 0,
      prices: [2.8, 3.1, 2.6], // red card shifts market to away
      pct: 107.5,
    },
  ] as MatchState[];
}

// ---------------------------------------------------------------------------
// Cycle log
// ---------------------------------------------------------------------------

interface CycleLog {
  cycle: number;
  fixtureId: number;
  modelP: number;
  marketP: number;
  edge: number;
  decision:
    | "bet"
    | "bet-failed"
    | "skip-no-edge"
    | "skip-position-open"
    | "skip-not-live"
    | "skip-assessor"
    | "watchdog-timeout"; // C11: cycle exceeded CYCLE_WATCHDOG_MS
  stakeLamports?: number;
  txSig?: string;
  assessorAction?: string;
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=== C9.2 Autonomous Trading Loop ===");
  console.log(`RPC: ${RPC_URL}`);
  console.log(`Program: ${PROGRAM_ID.toBase58()}`);
  console.log("Loading keypair (in-memory, not logged)...");

  const keypair = loadKeypair();
  console.log(`Wallet pubkey: ${keypair.publicKey.toBase58()}`);

  const program = buildProgram(keypair);

  // ---------------------------------------------------------------------------
  // LIVE MODE — gated behind USE_LIVE=1
  // Spends real Opus credits + devnet SOL. Garry main-thread executes under
  // Gabe's GABE_GATE approval. DO NOT run without explicit authorisation.
  // ---------------------------------------------------------------------------
  if (process.env["USE_LIVE"] === "1") {
    const connection = program.provider.connection;
    await runLiveLoop(program, keypair, connection);
    return;
  }

  // ---------------------------------------------------------------------------
  // STUB MODE (default) — synthetic state sequence, no network, no Opus calls
  // ---------------------------------------------------------------------------
  const assessor = new StubAssessor();

  // --- SETUP: init_market (skip if PDA already exists) ---
  console.log(`\nChecking market PDA for match_id=${MATCH_ID.toString()}...`);
  const exists = await marketPdaExists(program, MATCH_ID);
  if (exists) {
    console.log("Market PDA already exists — skipping init_market.");
  } else {
    console.log("Calling init_market...");
    const initTx = await initMarket(program, keypair, MATCH_ID);
    console.log(`init_market tx: ${initTx}`);
  }

  // --- SYNTHETIC STATE SEQUENCE ---
  const states = buildStateSequence();
  let prevState: MatchState | null = null;

  // Position tracking (one position opened per loop run for demo)
  let positionOpened = false;
  let positionStakeLamports = 0;
  const cycleLogs: CycleLog[] = [];

  // C11: anomaly counters
  let consecutiveNoTrades = 0;
  // C12: live balance read from devnet at point of use (credentials: keypair
  // already loaded above, never re-logged). Balance is re-read each cycle so
  // the floor check reflects reality, not a stale startup snapshot.
  // ponytail: single connection.getBalance call per cycle; per-step granularity
  // only if sub-cycle balance drain becomes a concern.
  const connection = program.provider.connection;

  console.log(`\nRunning ${states.length} cycles (zero manual input)...\n`);

  let anomalyHalt = false;

  for (let cycle = 0; cycle < states.length && !anomalyHalt; cycle++) {
    const state = states[cycle];

    // C11 WATCHDOG: wrap the entire async cycle body. On timeout the cycle logs
    // "watchdog-timeout", prevState is NOT advanced (keeps prior state), and the
    // loop continues to the next cycle.
    const cycleResult = await withTimeout<CycleLog | null>(
      (async (): Promise<CycleLog | null> => {
        console.log(
          `--- Cycle ${cycle} --- fixture=${state.fixtureId} minute=${state.currentMinute}' phase=${state.matchPhase} isLive=${state.isLive}`
        );
        console.log(
          `  scores: ${state.homeScore}-${state.awayScore} (diff=${
            state.scoreDifferential
          })  redDelta=${state.redCardDelta}  prices=[${state.prices.join(
            ", "
          )}]`
        );

        if (!state.isLive) {
          console.log("  Not live — skip.");
          return {
            cycle,
            fixtureId: state.fixtureId,
            modelP: 0,
            marketP: 0,
            edge: 0,
            decision: "skip-not-live",
          };
        }

        // C7: model probability
        const modelP = predictFromMatchState(
          state.scoreDifferential ?? 0,
          state.matchPhase ?? 1,
          state.redCardDelta ?? 0
        );

        // Market implied prob (de-vigged home)
        const mktP = marketProb(state.prices);
        const edge = modelP - mktP;

        console.log(
          `  model_P=${modelP.toFixed(4)}  market_P=${mktP.toFixed(
            4
          )}  edge=${edge.toFixed(4)}  threshold=${EDGE_THRESHOLD}`
        );

        // C8: detect material event and assess
        if (prevState) {
          const trigger = detectTrigger(prevState, state);
          if (trigger) {
            console.log(`  MATERIAL EVENT: ${trigger.type}`);
            const position = {
              side: positionOpened ? ("home" as const) : ("none" as const),
              stake: positionOpened ? positionStakeLamports : 0,
              entryOdds: positionOpened ? state.prices[0] : null,
            };

            // C11 LLM TIMEOUT: hard cap on assessor call; fail-safe to HOLD
            const HOLD_FALLBACK = {
              assessment: "LLM call timed out — defaulting to hold.",
              suggestedAction: "hold" as const,
              reasoningTrace: "Timeout; no action taken.",
            };
            const assessment = await withTimeout(
              assessor.assess(trigger, modelP, position),
              LLM_TIMEOUT_MS,
              HOLD_FALLBACK,
              `assessor cycle=${cycle}`
            );

            logTrace(trigger, modelP, position, assessment, "stub");
            console.log(`  LLM assessment: ${assessment.assessment}`);
            console.log(`  Suggested action: ${assessment.suggestedAction}`);
            console.log(`  Reasoning trace: ${assessment.reasoningTrace}`);

            if (
              positionOpened &&
              (assessment.suggestedAction === "exit" ||
                assessment.suggestedAction === "decrease")
            ) {
              console.log(
                "  Assessor says exit/decrease — will not open new position this cycle."
              );
              return {
                cycle,
                fixtureId: state.fixtureId,
                modelP,
                marketP: mktP,
                edge,
                decision: "skip-assessor",
                assessorAction: assessment.suggestedAction,
              };
            }
          }
        }

        // Edge filter + Kelly bet
        if (edge > EDGE_THRESHOLD && !positionOpened) {
          const homeOdds = state.prices[0];
          const { stake: stakeLamports, fStar } = kellyStake(modelP, homeOdds);

          if (stakeLamports <= 0) {
            console.log("  Kelly stake = 0 (negative EV) — skip.");
            return {
              cycle,
              fixtureId: state.fixtureId,
              modelP,
              marketP: mktP,
              edge,
              decision: "skip-no-edge",
            };
          }

          console.log(
            `  EDGE > threshold! stake=${stakeLamports} lamports (${(
              stakeLamports / 1e9
            ).toFixed(6)} SOL)`
          );
          console.log(
            `  Kelly params: b=${(homeOdds - 1).toFixed(3)} f*=${fStar.toFixed(
              4
            )} fraction=${KELLY_FRACTION} cap=${KELLY_CAP}`
          );
          console.log(
            `  Calling open_position(stake=${stakeLamports}, side=home)...`
          );

          try {
            const txSig = await openPosition(
              program,
              keypair,
              MATCH_ID,
              new anchor.BN(stakeLamports),
              "home"
            );
            positionOpened = true;
            positionStakeLamports = stakeLamports;
            console.log(`  OPEN_POSITION TX: ${txSig}`);
            return {
              cycle,
              fixtureId: state.fixtureId,
              modelP,
              marketP: mktP,
              edge,
              decision: "bet",
              stakeLamports,
              txSig,
            };
          } catch (err) {
            console.error(
              `  open_position FAILED: ${
                err instanceof Error ? err.message : err
              }`
            );
            return {
              cycle,
              fixtureId: state.fixtureId,
              modelP,
              marketP: mktP,
              edge,
              decision: "bet-failed",
              stakeLamports,
            };
          }
        } else if (positionOpened) {
          console.log("  No bet: position already open");
          return {
            cycle,
            fixtureId: state.fixtureId,
            modelP,
            marketP: mktP,
            edge,
            decision: "skip-position-open",
          };
        } else {
          console.log(`  No bet: edge ${edge.toFixed(4)} ≤ threshold`);
          return {
            cycle,
            fixtureId: state.fixtureId,
            modelP,
            marketP: mktP,
            edge,
            decision: "skip-no-edge",
          };
        }
      })(),
      CYCLE_WATCHDOG_MS,
      null, // null = watchdog fired
      `cycle-watchdog cycle=${cycle}`
    );

    if (cycleResult === null) {
      // Watchdog fired — log, do NOT advance prevState, continue loop
      cycleLogs.push({
        cycle,
        fixtureId: state.fixtureId,
        modelP: 0,
        marketP: 0,
        edge: 0,
        decision: "watchdog-timeout",
      });
      // Only count live cycles toward no-trade halt; pre-match waits are
      // expected and should not trigger the anomaly threshold.
      if (state.isLive) consecutiveNoTrades++;
    } else {
      cycleLogs.push(cycleResult);
      prevState = state;

      // C11 ANOMALY: track consecutive no-trades (live cycles only).
      // Pre-match "skip-not-live" cycles are expected; counting them would
      // false-halt the loop when a feed delays the live flag.
      if (cycleResult.decision === "bet") {
        consecutiveNoTrades = 0;
      } else if (state.isLive) {
        consecutiveNoTrades++;
      }
    }

    // C12: read actual devnet wallet balance at point of use (lamports).
    // On RPC error fall back to 0 so the floor check is conservative (halts
    // rather than silently assumes plenty of funds).
    let walletBalanceLamports = 0;
    try {
      walletBalanceLamports = await connection.getBalance(keypair.publicKey);
    } catch {
      console.error(
        JSON.stringify({
          alert: "BALANCE_READ_ERROR",
          cycle,
          ts: new Date().toISOString(),
        })
      );
    }

    // C11 ANOMALY CHECK: halt on no-trade streak or low balance
    const anomaly = checkAnomalies(consecutiveNoTrades, walletBalanceLamports);
    if (anomaly) {
      console.error(
        JSON.stringify({
          alert: "ANOMALY_HALT",
          reason: anomaly,
          cycle,
          consecutiveNoTrades,
          walletBalanceLamports,
          ts: new Date().toISOString(),
        })
      );
      anomalyHalt = true;
    }
  }

  // --- Summary ---
  console.log("\n=== CYCLE DECISION LOG ===");
  console.log(
    "cycle | modelP  | marketP | edge    | decision         | stake (lamports) | txSig"
  );
  for (const log of cycleLogs) {
    const stake = log.stakeLamports ? log.stakeLamports.toString() : "-";
    const tx = log.txSig ? log.txSig.slice(0, 20) + "..." : "-";
    const assess = log.assessorAction
      ? ` [assessor:${log.assessorAction}]`
      : "";
    console.log(
      `  ${String(log.cycle).padStart(2)} | ${log.modelP.toFixed(
        4
      )} | ${log.marketP.toFixed(4)} | ${log.edge.toFixed(
        4
      )} | ${log.decision.padEnd(16)}${assess} | ${stake.padStart(16)} | ${tx}`
    );
  }

  // Find the open_position tx for the verifier
  const betLog = cycleLogs.find((l) => l.txSig);
  if (betLog?.txSig) {
    console.log(`\n=== VERIFIER ===`);
    console.log(`open_position txSig: ${betLog.txSig}`);
    console.log(`Run: solana confirm -v ${betLog.txSig} --url devnet`);
  } else {
    console.log(
      "\nNo open_position tx dispatched this run (edge below threshold on all live cycles)."
    );
  }

  console.log("\nBurner key: held in memory only, never logged. ✓");
  console.log("Assessor: stub (no real Opus calls). ✓");
  console.log(`Cycles completed: ${states.length}. ✓`);
}

main().catch((err) => {
  console.error("Loop error:", err);
  process.exit(1);
});
