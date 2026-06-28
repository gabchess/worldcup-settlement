/**
 * C8 unit tests — StubAssessor only, no network, no key required.
 * C11 operational floor tests added: withTimeout, checkAnomalies.
 *
 * Run: cd agent && npm test
 *
 * Covers:
 *   - detectTrigger: goal, red_card, no-trigger, non-live suppression
 *   - StubAssessor: returns valid AssessmentResult
 *   - logTrace: writes a line to a temp file, parses back
 *   - buildPrompt: contains expected field values
 *   - C11 withTimeout: fires on hung promise, passes through fast promise
 *   - C11 checkAnomalies: trips on no-trade streak, trips on low balance
 */

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { detectTrigger } from "./trigger";
import { StubAssessor, buildPrompt, parseAssessment } from "./assessor";
import { logTrace } from "./logger";
import { MatchState, PositionContext } from "./types";
import {
  withTimeout,
  checkAnomalies,
  NO_TRADE_HALT_CYCLES,
  BALANCE_FLOOR_LAMPORTS,
} from "./loop";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeState(overrides: Partial<MatchState> = {}): MatchState {
  return {
    fixtureId: 1,
    timestamp: 1000,
    isLive: true,
    homeScore: 1,
    awayScore: 0,
    scoreDifferential: 1,
    currentMinute: 60,
    matchPhase: 4,
    homeRedCards: 0,
    awayRedCards: 0,
    redCardDelta: 0,
    prices: [2.0, 3.5, 3.5],
    pct: 107,
    ...overrides,
  };
}

const position: PositionContext = { side: "home", stake: 50, entryOdds: 2.0 };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve(fn())
    .then(() => {
      console.log(`  PASS: ${name}`);
      passed++;
    })
    .catch((err) => {
      console.error(`  FAIL: ${name}`);
      console.error(`        ${err instanceof Error ? err.message : err}`);
      failed++;
    });
}

async function run(): Promise<void> {
  console.log("Running C8 stub tests...\n");

  // --- detectTrigger ---

  await test("detectTrigger: goal fires when scoreDifferential changes", () => {
    const prev = makeState({ scoreDifferential: 1 });
    const next = makeState({ scoreDifferential: 2, homeScore: 2 });
    const ev = detectTrigger(prev, next);
    assert.ok(ev, "should return a TriggerEvent");
    assert.strictEqual(ev!.type, "goal");
  });

  await test("detectTrigger: red_card fires when redCardDelta changes", () => {
    const prev = makeState({ redCardDelta: 0 });
    const next = makeState({ redCardDelta: -1, awayRedCards: 1 });
    const ev = detectTrigger(prev, next);
    assert.ok(ev, "should return a TriggerEvent");
    assert.strictEqual(ev!.type, "red_card");
  });

  await test("detectTrigger: returns null when nothing changed", () => {
    const state = makeState();
    assert.strictEqual(
      detectTrigger(state, { ...state, timestamp: 2000 }),
      null
    );
  });

  await test("detectTrigger: suppressed when isLive=false", () => {
    const prev = makeState({ scoreDifferential: 1 });
    const next = makeState({ scoreDifferential: 2, isLive: false });
    assert.strictEqual(detectTrigger(prev, next), null);
  });

  await test("detectTrigger: suppressed when scoreDifferential is null (DEFERRED)", () => {
    const prev = makeState({ scoreDifferential: null });
    const next = makeState({ scoreDifferential: null });
    assert.strictEqual(detectTrigger(prev, next), null);
  });

  // --- StubAssessor ---

  await test("StubAssessor: returns valid AssessmentResult for goal", async () => {
    const prev = makeState({ scoreDifferential: 1 });
    const next = makeState({ scoreDifferential: 2 });
    const ev = detectTrigger(prev, next)!;
    const result = await new StubAssessor().assess(ev, 0.5, position);
    assert.ok(result.assessment.length > 0);
    assert.ok(
      ["hold", "increase", "decrease", "exit"].includes(result.suggestedAction)
    );
    assert.ok(result.reasoningTrace.length > 0);
  });

  await test("StubAssessor: suggests exit when P>0.6 and behind", async () => {
    const prev = makeState({ scoreDifferential: -1 });
    const next = makeState({
      scoreDifferential: -2,
      homeScore: 0,
      awayScore: 2,
    });
    const ev = detectTrigger(prev, next)!;
    const result = await new StubAssessor().assess(ev, 0.8, position);
    assert.strictEqual(result.suggestedAction, "exit");
  });

  // --- logTrace ---

  await test("logTrace: writes valid JSON line to file", async () => {
    const tmpFile = path.join(os.tmpdir(), `c8-test-${Date.now()}.jsonl`);
    const prev = makeState({ scoreDifferential: 1 });
    const next = makeState({ scoreDifferential: 2 });
    const ev = detectTrigger(prev, next)!;
    const result = await new StubAssessor().assess(ev, 0.5, position);
    const record = logTrace(ev, 0.5, position, result, "stub", tmpFile);
    const line = fs.readFileSync(tmpFile, "utf8").trim();
    const parsed = JSON.parse(line);
    assert.strictEqual(parsed.eventType, "goal");
    assert.strictEqual(parsed.impl, "stub");
    assert.strictEqual(parsed.fixtureId, 1);
    assert.ok(parsed.reasoningTrace.length > 0);
    assert.deepStrictEqual(record, parsed);
    fs.unlinkSync(tmpFile);
  });

  // --- buildPrompt ---

  await test("buildPrompt: contains event type and model probability", () => {
    const prev = makeState({ scoreDifferential: 1 });
    const next = makeState({ scoreDifferential: 2 });
    const ev = detectTrigger(prev, next)!;
    const prompt = buildPrompt(ev, 0.72, position);
    assert.ok(prompt.includes("GOAL"), "should mention GOAL");
    assert.ok(prompt.includes("72.0%"), "should include model probability");
    assert.ok(
      prompt.includes("claude-opus-4-8") === false,
      "should not mention model name"
    );
  });

  // --- parseAssessment ---

  await test("parseAssessment: clean JSON string parses correctly", () => {
    const raw = JSON.stringify({
      assessment: "Good trade.",
      suggestedAction: "hold",
      reasoningTrace: "P is flat.",
    });
    const result = parseAssessment(raw);
    assert.strictEqual(result.suggestedAction, "hold");
    assert.strictEqual(result.assessment, "Good trade.");
  });

  await test("parseAssessment: fenced JSON parses correctly", () => {
    const raw =
      "```json\n" +
      JSON.stringify({
        assessment: "Exit advised.",
        suggestedAction: "exit",
        reasoningTrace: "Score gap widened.",
      }) +
      "\n```";
    const result = parseAssessment(raw);
    assert.strictEqual(result.suggestedAction, "exit");
  });

  await test("parseAssessment: prose-then-fenced JSON parses correctly", () => {
    const raw =
      "Here is the JSON:\n```json\n" +
      JSON.stringify({
        assessment: "Increase stake.",
        suggestedAction: "increase",
        reasoningTrace: "Model P high.",
      }) +
      "\n```";
    const result = parseAssessment(raw);
    assert.strictEqual(result.suggestedAction, "increase");
  });

  await test("parseAssessment: total garbage returns hold default without throwing", () => {
    const result = parseAssessment("sorry, I cannot provide JSON right now");
    assert.strictEqual(result.suggestedAction, "hold");
    assert.ok(result.reasoningTrace.includes("unparseable"));
  });

  // --- C11: withTimeout ---

  await test("withTimeout: resolves with real value when promise completes before deadline", async () => {
    const result = await withTimeout(
      Promise.resolve(42),
      1000,
      -1,
      "fast-promise"
    );
    assert.strictEqual(result, 42);
  });

  await test("withTimeout: resolves with fallback when promise never settles (simulated hang)", async () => {
    // A promise that never resolves — simulates a hung LLM or RPC call.
    const hung = new Promise<string>(() => {
      /* intentionally never resolves */
    });
    const result = await withTimeout(hung, 50, "FALLBACK", "hung-llm");
    assert.strictEqual(
      result,
      "FALLBACK",
      "should resolve with fallback after timeout"
    );
  });

  await test("withTimeout: logs a structured TIMEOUT alert to stderr on expiry", async () => {
    const lines: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => lines.push(String(args[0]));
    try {
      await withTimeout(
        new Promise<number>(() => {
          /* never */
        }),
        50,
        0,
        "test-label"
      );
    } finally {
      console.error = orig;
    }
    assert.ok(lines.length > 0, "expected at least one stderr line");
    const parsed = JSON.parse(lines[0]);
    assert.strictEqual(parsed.alert, "TIMEOUT");
    assert.strictEqual(parsed.label, "test-label");
    assert.strictEqual(parsed.ms, 50);
  });

  // --- C11: checkAnomalies ---

  await test("checkAnomalies: returns null when both conditions are healthy", () => {
    const result = checkAnomalies(0, BALANCE_FLOOR_LAMPORTS + 1);
    assert.strictEqual(result, null);
  });

  await test("checkAnomalies: trips on no-trade streak at NO_TRADE_HALT_CYCLES", () => {
    const result = checkAnomalies(
      NO_TRADE_HALT_CYCLES,
      BALANCE_FLOOR_LAMPORTS + 1
    );
    assert.ok(result !== null, "should return a halt reason");
    assert.ok(
      result!.includes("ANOMALY"),
      `expected ANOMALY prefix, got: ${result}`
    );
    assert.ok(
      result!.includes("no trade"),
      `expected 'no trade' in message, got: ${result}`
    );
  });

  await test("checkAnomalies: trips on balance at or below floor", () => {
    const result = checkAnomalies(0, BALANCE_FLOOR_LAMPORTS);
    assert.ok(result !== null, "should return a halt reason");
    assert.ok(
      result!.includes("ANOMALY"),
      `expected ANOMALY prefix, got: ${result}`
    );
    assert.ok(
      result!.includes("balance"),
      `expected 'balance' in message, got: ${result}`
    );
  });

  await test("checkAnomalies: no-trade streak below threshold returns null", () => {
    const result = checkAnomalies(
      NO_TRADE_HALT_CYCLES - 1,
      BALANCE_FLOOR_LAMPORTS + 1
    );
    assert.strictEqual(result, null);
  });

  // --- C11 watchdog null-branch (integration-style) ---
  // When a cycle times out, withTimeout resolves null. The loop contract:
  //   - prevState is NOT advanced (the timed-out state is skipped)
  //   - consecutiveNoTrades increments (if state.isLive)
  // This test exercises those invariants without running the full loop.

  await test("watchdog null-branch: cycleResult===null does not advance prevState", async () => {
    // Simulate a live cycle that times out (withTimeout returns null).
    const cycleState = makeState({ isLive: true });
    let prevState: MatchState | null = null;
    let consecutiveNoTrades = 0;

    // Run withTimeout with a hung promise and a 50 ms deadline → resolves null.
    const hung = new Promise<null>(() => {
      /* never */
    });
    const cycleResult = await withTimeout<null>(
      hung,
      50,
      null,
      "watchdog-test"
    );

    // Mirror the loop's null-branch logic:
    if (cycleResult === null) {
      if (cycleState.isLive) consecutiveNoTrades++;
      // prevState intentionally NOT updated
    } else {
      prevState = cycleState;
    }

    assert.strictEqual(
      prevState,
      null,
      "prevState must NOT be advanced on watchdog timeout"
    );
    assert.strictEqual(
      consecutiveNoTrades,
      1,
      "consecutiveNoTrades must increment on live timeout"
    );
  });

  await test("watchdog null-branch: pre-live timeout does NOT increment consecutiveNoTrades", async () => {
    const cycleState = makeState({ isLive: false });
    let consecutiveNoTrades = 0;

    const hung = new Promise<null>(() => {
      /* never */
    });
    const cycleResult = await withTimeout<null>(
      hung,
      50,
      null,
      "watchdog-prelive"
    );

    if (cycleResult === null) {
      if (cycleState.isLive) consecutiveNoTrades++;
    }

    assert.strictEqual(
      consecutiveNoTrades,
      0,
      "pre-live watchdog timeout must not count toward no-trade halt"
    );
  });

  // --- Bet-path Opus narrative (stub) ---
  // Verifies: after a successful bet, the assessor.assess() call fires and its
  // reasoningTrace replaces the formula string in the logged trace.

  await test("bet-path: StubAssessor returns edge-language narrative for edge event", async () => {
    const state = makeState({ scoreDifferential: 1, currentMinute: 60 });
    const betEvent = {
      type: "edge" as const,
      fixtureId: 1,
      fromState: state,
      toState: state,
      edge: 0.351, // model_P(0.419) - market_implied(0.068) — real demo numbers
    };
    const betPosition: PositionContext = {
      side: "home",
      stake: 50_000,
      entryOdds: 2.0,
    };
    const result = await new StubAssessor().assess(
      betEvent,
      0.419,
      betPosition
    );
    // The stub must describe the REAL reason: model-vs-market edge, not a goal.
    assert.ok(
      result.reasoningTrace.length > 0,
      "reasoningTrace must be non-empty"
    );
    assert.ok(
      !result.reasoningTrace.startsWith("Edge="),
      `reasoningTrace should be narrative, not formula string; got: ${result.reasoningTrace}`
    );
    // Must reference the model-vs-market gap (edge-language), not a goal.
    const traceHasEdgeLanguage =
      result.reasoningTrace.includes("market-implied") ||
      result.reasoningTrace.includes("edge") ||
      result.reasoningTrace.includes("mispricing");
    assert.ok(
      traceHasEdgeLanguage,
      `reasoningTrace must reference model-vs-market edge; got: ${result.reasoningTrace}`
    );
    assert.ok(
      !result.reasoningTrace.includes("Event: goal") &&
        !result.reasoningTrace.includes("score differential moved"),
      `edge narrative must NOT claim a goal occurred; got: ${result.reasoningTrace}`
    );
    // Confirm it would be written correctly via logTrace.
    const tmpFile = path.join(
      os.tmpdir(),
      `c8-bet-narrative-test-${Date.now()}.jsonl`
    );
    const record = logTrace(
      betEvent,
      0.55,
      betPosition,
      result,
      "stub",
      tmpFile
    );
    const line = fs.readFileSync(tmpFile, "utf8").trim();
    const parsed = JSON.parse(line);
    assert.strictEqual(
      parsed.reasoningTrace,
      result.reasoningTrace,
      "logTrace must persist the narrative"
    );
    assert.ok(parsed.reasoningTrace.length > 0);
    fs.unlinkSync(tmpFile);
  });

  // Summary
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
