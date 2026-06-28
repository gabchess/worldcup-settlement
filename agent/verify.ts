/**
 * C8 verifier — fires ONE real Opus 4.8 call and logs the reasoning trace.
 *
 * Run: cd agent && npm run verify
 *
 * What it does:
 *   1. Builds a synthetic goal-event MatchState transition (Argentina 2-1 France
 *      → 3-1 France at 73', mirroring the C6 fixture data).
 *   2. detectTrigger fires → TriggerEvent{type:"goal"}.
 *   3. RealAssessor.assess() makes ONE Opus 4.8 call.
 *   4. logTrace() appends the trace to agent/traces.jsonl.
 *   5. Prints the logged trace to stdout.
 *
 * KEY SECURITY: the API key is read inside RealAssessor.assess(), never here.
 */

import * as path from "path";
import { detectTrigger } from "./trigger";
import { RealAssessor } from "./assessor";
import { logTrace } from "./logger";
import { MatchState, PositionContext } from "./types";

// ---------------------------------------------------------------------------
// Synthetic MatchState pair — goal event: scoreDiff 1 → 2
// ---------------------------------------------------------------------------

const BASE: Omit<MatchState, "homeScore" | "awayScore" | "scoreDifferential"> =
  {
    fixtureId: 20629,
    timestamp: 1750002680000,
    isLive: true,
    currentMinute: 73,
    matchPhase: 4,
    homeRedCards: 0,
    awayRedCards: 1,
    redCardDelta: -1,
    prices: [1.45, 4.2, 7.5],
    pct: 107.2,
  };

const prevState: MatchState = {
  ...BASE,
  homeScore: 2,
  awayScore: 1,
  scoreDifferential: 1, // home leads by 1
};

const nextState: MatchState = {
  ...BASE,
  timestamp: BASE.timestamp + 60_000,
  homeScore: 3,
  awayScore: 1,
  scoreDifferential: 2, // home now leads by 2 — GOAL
};

// ---------------------------------------------------------------------------
// Position context (passed param; C9 wires the real position)
// ---------------------------------------------------------------------------

const position: PositionContext = {
  side: "home",
  stake: 100,
  entryOdds: 1.8,
};

// Model probability is a passed-in param (C9 wires Python model output).
const modelProbability = 0.72; // P(home wins match)

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const TRACES_PATH = path.join(__dirname, "traces.jsonl");

async function main(): Promise<void> {
  console.log("C8 verifier starting...\n");

  // Step 1: trigger detection
  const event = detectTrigger(prevState, nextState);
  if (!event) {
    console.error(
      "ERROR: detectTrigger returned null — no material event detected."
    );
    process.exit(1);
  }
  console.log(`Trigger detected: ${event.type} on fixture ${event.fixtureId}`);

  // Step 2: real Opus call
  console.log("Calling Opus 4.8 (claude-opus-4-8)...");
  const assessor = new RealAssessor();
  const result = await assessor.assess(event, modelProbability, position);
  console.log("Opus call succeeded.");

  // Step 3: log trace
  const record = logTrace(
    event,
    modelProbability,
    position,
    result,
    "real",
    TRACES_PATH
  );
  console.log(`\nTrace logged to: ${TRACES_PATH}`);
  console.log("\n=== LOGGED TRACE ===");
  console.log(JSON.stringify(record, null, 2));
  console.log("===================");
  console.log(
    "\nVERIFIER_OK: trigger fired, real Opus call succeeded, trace logged."
  );
}

main().catch((err) => {
  console.error("Verifier failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
