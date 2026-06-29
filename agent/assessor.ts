/**
 * C8 LLM assessor — real (Opus 4.8) + stub implementations.
 *
 * KEY SECURITY CONTRACT:
 *   - The API key is read from ~/secrets/anthropic-api-key.txt AT CALL TIME.
 *   - It is NEVER printed, logged, stored in a variable that outlives the
 *     single SDK call, or returned in any structure.
 *   - The key file path is the only thing that appears in source.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  AssessmentResult,
  LLMAssessor,
  PositionContext,
  SuggestedAction,
  TriggerEvent,
} from "./types";

// ---------------------------------------------------------------------------
// Prompt builder (shared, testable without a key)
// ---------------------------------------------------------------------------

export function buildPrompt(
  event: TriggerEvent,
  modelProbability: number,
  position: PositionContext,
): string {
  const { type, fixtureId, fromState, toState } = event;
  const scoreFrom = `${fromState.homeScore ?? "?"}–${
    fromState.awayScore ?? "?"
  }`;
  const scoreTo = `${toState.homeScore ?? "?"}–${toState.awayScore ?? "?"}`;
  const minute = toState.currentMinute ?? "?";
  const redFrom = fromState.redCardDelta ?? "?";
  const redTo = toState.redCardDelta ?? "?";

  const edgeVal = event.edge ?? 0;
  const impliedP = modelProbability - edgeVal;
  const eventBlock =
    type === "edge"
      ? `EVENT: EDGE OPPORTUNITY — model P(win) ${(
          modelProbability * 100
        ).toFixed(1)}% vs market-implied ${(impliedP * 100).toFixed(
          1,
        )}% (edge ${edgeVal.toFixed(
          4,
        )}). No new match event; the agent found a mispriced line.`
      : `EVENT: ${type === "goal" ? "GOAL" : "RED CARD"}
Score: ${scoreFrom} → ${scoreTo}
Red card delta (home−away): ${redFrom} → ${redTo}`;

  return `You are an in-play football trading assistant. A material event just occurred.

${eventBlock}
Fixture ID: ${fixtureId}
Match minute: ${minute}'
Match phase (1–7): ${toState.matchPhase ?? "unknown"}
Odds (home/draw/away): [${toState.prices.map((p) => (p >= 100 ? p / 1000 : p)).join(", ")}]
Market overround: ${toState.pct ?? "unknown"}%

CURRENT POSITION:
Side: ${position.side}
Stake: ${position.stake} units
Entry odds: ${position.entryOdds ?? "none"}

MODEL PROBABILITY (P(home wins match)): ${(modelProbability * 100).toFixed(1)}%

${
  type === "edge"
    ? "Explain why this trade is +EV based on the model-vs-market probability gap. Do NOT mention goals or cards unless the match state reflects one."
    : "Assess whether this event materially changes the position."
}
Provide:
1. A brief assessment (2–3 sentences) of how this event affects the trade thesis.
2. A suggested action: hold | increase | decrease | exit
3. A concise reasoning trace (the logic chain, max 4 sentences) that serves as a public trust signal.

Respond in this exact JSON format:
{
  "assessment": "...",
  "suggestedAction": "hold|increase|decrease|exit",
  "reasoningTrace": "..."
}`;
}

// ---------------------------------------------------------------------------
// parseAssessment — exported pure function, never throws (fail-safe for loop)
// ---------------------------------------------------------------------------

const VALID_ACTIONS: SuggestedAction[] = [
  "hold",
  "increase",
  "decrease",
  "exit",
];

const PARSE_FAIL_SAFE: AssessmentResult = {
  assessment: "LLM response could not be parsed.",
  suggestedAction: "hold",
  reasoningTrace: "LLM response unparseable; defaulting to hold (no action).",
};

export function parseAssessment(raw: string): AssessmentResult {
  // Extract the first JSON object from raw text, tolerating prose preambles
  // and markdown fences (e.g. "Here is the JSON:\n```json\n{...}\n```").
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return PARSE_FAIL_SAFE;

  let parsed: {
    assessment: string;
    suggestedAction: string;
    reasoningTrace: string;
  };
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return PARSE_FAIL_SAFE;
  }

  const action = parsed.suggestedAction as SuggestedAction;
  if (!VALID_ACTIONS.includes(action)) return PARSE_FAIL_SAFE;

  return {
    assessment: parsed.assessment,
    suggestedAction: action,
    reasoningTrace: parsed.reasoningTrace,
  };
}

// ---------------------------------------------------------------------------
// Real assessor — calls Opus 4.8, reads key at call time
// ---------------------------------------------------------------------------

export class RealAssessor implements LLMAssessor {
  private readonly keyPath: string;

  constructor(keyPath?: string) {
    this.keyPath =
      keyPath ?? path.join(os.homedir(), "secrets", "anthropic-api-key.txt");
  }

  async assess(
    event: TriggerEvent,
    modelProbability: number,
    position: PositionContext,
  ): Promise<AssessmentResult> {
    // Read key at call time — never stored outside this function scope.
    const apiKey = fs.readFileSync(this.keyPath, "utf8").trim();

    // Dynamic import keeps the SDK out of stub-only paths.
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey });

    const prompt = buildPrompt(event, modelProbability, position);

    const message = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    });

    // Extract text content from the response.
    const raw = message.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("");

    return parseAssessment(raw);
  }
}

// ---------------------------------------------------------------------------
// Stub assessor — deterministic, no network, no key
// ---------------------------------------------------------------------------

export class StubAssessor implements LLMAssessor {
  async assess(
    event: TriggerEvent,
    modelProbability: number,
    _position: PositionContext,
  ): Promise<AssessmentResult> {
    const scoreDiff = event.toState.scoreDifferential ?? 0;

    // Simple heuristic for the stub: if model P is high and we're behind, exit.
    const suggestedAction: SuggestedAction =
      modelProbability > 0.6 && scoreDiff < 0 ? "exit" : "hold";

    if (event.type === "edge") {
      const edgeVal = event.edge ?? 0;
      const impliedP = modelProbability - edgeVal;
      const assessment = `Edge opportunity: model P(win) ${(
        modelProbability * 100
      ).toFixed(1)}% vs market-implied ${(impliedP * 100).toFixed(
        1,
      )}% (edge ${edgeVal.toFixed(4)}). No match event occurred.`;
      const reasoningTrace = `Model probability ${(
        modelProbability * 100
      ).toFixed(1)}% exceeds market-implied ${(impliedP * 100).toFixed(
        1,
      )}% by ${(edgeVal * 100).toFixed(
        2,
      )}pp. This mispricing is the trade trigger — not a goal or card. ${suggestedAction} recommended given current position.`;
      return { assessment, suggestedAction, reasoningTrace };
    }

    const isGoal = event.type === "goal";
    const assessment = isGoal
      ? `Goal changed score differential to ${scoreDiff}. Model P=${(
          modelProbability * 100
        ).toFixed(1)}%. Assessing position impact.`
      : `Red card shifts balance. Red card delta now ${
          event.toState.redCardDelta
        }. Model P=${(modelProbability * 100).toFixed(1)}%.`;

    const reasoningTrace = isGoal
      ? `Event: goal. Score differential moved to ${scoreDiff}. Model probability ${(
          modelProbability * 100
        ).toFixed(
          1,
        )}% suggests ${suggestedAction} is appropriate given current market prices.`
      : `Event: red_card. Red card delta ${
          event.toState.redCardDelta
        } increases home disadvantage. Model probability ${(
          modelProbability * 100
        ).toFixed(1)}% informs ${suggestedAction} recommendation.`;

    return { assessment, suggestedAction, reasoningTrace };
  }
}
