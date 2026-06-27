/**
 * C8 trace logger.
 *
 * Appends one TraceRecord per LLM assessment to traces.jsonl.
 * Each line is valid JSON — the file is the public trust artifact.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  AssessmentResult,
  PositionContext,
  TraceRecord,
  TriggerEvent,
} from "./types";

// ponytail: env var wins; fallback to ~/.worldcup-settlement/traces.jsonl (stable across ts-node/tsc)
const DEFAULT_PATH =
  process.env.WORLDCUP_TRACES_PATH ??
  path.join(os.homedir(), ".worldcup-settlement", "traces.jsonl");

export function logTrace(
  event: TriggerEvent,
  modelProbability: number,
  position: PositionContext,
  result: AssessmentResult,
  impl: "real" | "stub",
  tracesPath: string = DEFAULT_PATH,
): TraceRecord {
  const record: TraceRecord = {
    timestamp: new Date().toISOString(),
    fixtureId: event.fixtureId,
    eventType: event.type,
    modelProbability,
    position,
    assessment: result.assessment,
    suggestedAction: result.suggestedAction,
    reasoningTrace: result.reasoningTrace,
    impl,
  };

  fs.mkdirSync(path.dirname(tracesPath), { recursive: true });
  fs.appendFileSync(tracesPath, JSON.stringify(record) + "\n", "utf8");
  return record;
}
