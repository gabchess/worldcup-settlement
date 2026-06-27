/**
 * Native TS inference for the C2 match-outcome model (LogisticRegression +
 * CalibratedClassifierCV, method="sigmoid", cv=3).
 *
 * Target: P(home wins the match) — retargeted from P(goal in 15 min) at C9 gate
 * (Kent+Dayo unanimous) for model↔market↔settlement coherence.
 *
 * Composition (mirrors sklearn exactly):
 *   For each of the 3 cv folds:
 *     decision = X · coef + intercept          (LR decision function)
 *     fold_p   = 1 / (1 + exp(a * decision + b)) (Platt sigmoid)
 *   final_p = mean(fold_p0, fold_p1, fold_p2)
 *
 * Features (in order): [score_differential, match_phase, red_card_delta, match_phase^2]
 * Source: model/model.json (exported from the fitted model.joblib).
 */

import * as fs from "fs";
import * as path from "path";

interface Fold {
  lr_coef: number[];
  lr_intercept: number;
  platt_a: number;
  platt_b: number;
}

interface ModelParams {
  feature_order: string[];
  folds: Fold[];
}

// Load once at module init; fail fast if file is missing.
const MODEL_JSON_PATH = path.join(__dirname, "..", "model", "model.json");
const _params: ModelParams = JSON.parse(
  fs.readFileSync(MODEL_JSON_PATH, "utf8")
);

function dot(a: number[], b: number[]): number {
  return a.reduce((sum, ai, i) => sum + ai * b[i], 0);
}

/**
 * Predict P(home wins the match) for a given feature vector.
 *
 * @param features  [score_differential, match_phase, red_card_delta, match_phase^2]
 *                  (same order as model.json feature_order)
 * @returns calibrated probability in [0, 1]
 */
export function predictHomeWinProb(features: number[]): number {
  let sum = 0;
  for (const fold of _params.folds) {
    const decision = dot(fold.lr_coef, features) + fold.lr_intercept;
    const foldP = 1 / (1 + Math.exp(fold.platt_a * decision + fold.platt_b));
    sum += foldP;
  }
  return sum / _params.folds.length;
}

/**
 * Convenience wrapper: returns P(home wins the match) from named match-state fields.
 * Matches MatchState in types.ts. This is the value the loop consumes as home-win prob.
 */
export function predictFromMatchState(
  scoreDifferential: number,
  matchPhase: number,
  redCardDelta: number
): number {
  return predictHomeWinProb([
    scoreDifferential,
    matchPhase,
    redCardDelta,
    matchPhase ** 2,
  ]);
}
