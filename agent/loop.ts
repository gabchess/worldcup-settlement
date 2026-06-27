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
// eslint-disable-next-line @typescript-eslint/no-var-requires
const bs58 = require("bs58") as { decode: (s: string) => Uint8Array };
import { predictFromMatchState } from "./model";
import { detectTrigger } from "./trigger";
import { logTrace } from "./logger";
import { StubAssessor } from "./assessor";
import type { MatchState } from "./types";

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
// Operational helpers — C11
// ---------------------------------------------------------------------------

/**
 * Race a promise against a timeout. On expiry resolves with `fallback` and
 * logs a structured alert line. Never rejects.
 *
 * ponytail: Promise.race + setTimeout is stdlib — no external dep needed.
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
  const assessor = new StubAssessor();
  // ponytail: stub for dev; swap to new RealAssessor() for ≤2 real Opus calls

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
