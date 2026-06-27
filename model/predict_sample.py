"""
Verifier: load saved model, print P(home wins match) for sample match-states.
Also reports holdout Brier score if metrics.json exists.

Usage: python model/predict_sample.py
"""

import json
import os
import sys

import numpy as np
import joblib

MODEL_PATH = os.path.join(os.path.dirname(__file__), "model.joblib")
METRICS_PATH = os.path.join(os.path.dirname(__file__), "metrics.json")


def predict(match_state: dict) -> float:
    """
    Return P(home wins the match) for a given in-game match state.

    match_state keys:
        score_differential (int): home_goals - away_goals at minute T
        match_phase (int 1-7): phase bucket per C2 spec
        red_card_delta (int): home_reds - away_reds
    """
    if not os.path.exists(MODEL_PATH):
        raise FileNotFoundError(f"Model not found at {MODEL_PATH}. Run train.py first.")

    model = joblib.load(MODEL_PATH)

    phase = match_state["match_phase"]
    X = np.array([[
        match_state["score_differential"],
        phase,
        match_state["red_card_delta"],
        phase ** 2,
    ]])

    proba = model.predict_proba(X)[0, 1]
    return float(proba)


if __name__ == "__main__":
    samples = [
        # (description, score_diff, phase, red_delta)
        ("tied game, mid-match (phase 4)", 0, 4, 0),
        ("home leads +2, late (phase 6)", 2, 6, 0),
        ("home trails -2, late (phase 6)", -2, 6, 0),
    ]

    try:
        model = joblib.load(MODEL_PATH)
    except FileNotFoundError:
        print(f"ERROR: Model not found at {MODEL_PATH}. Run train.py first.", file=sys.stderr)
        sys.exit(1)

    print("P(home wins match) samples:")
    for desc, score_diff, phase, red_delta in samples:
        X = np.array([[score_diff, phase, red_delta, phase ** 2]])
        p = float(model.predict_proba(X)[0, 1])
        print(f"  {desc}: {p:.4f}")

    if os.path.exists(METRICS_PATH):
        with open(METRICS_PATH) as f:
            m = json.load(f)
        print(f"\nTarget: {m.get('target', 'P(home wins match)')}")
        print(f"Holdout Brier: {m['brier_score']:.4f}  (baseline: {m['brier_baseline']:.4f})")
        print(f"Home-win base rate: {m['base_rate']:.3f}")
        print(f"Train rows: {m['train_rows']}  |  Test rows: {m['test_rows']}  |  Matches: {m.get('matches', '?')}")
        if "directional_sanity" in m:
            ds = m["directional_sanity"]
            print(f"\nDirectional sanity:")
            print(f"  leading +2 late:  {ds['leading_late_phase6_diff+2']:.4f} (want > 0.70)")
            print(f"  trailing -2 late: {ds['trailing_late_phase6_diff-2']:.4f} (want < 0.30)")
            print(f"  OK: {ds['directional_ok']}")
    else:
        print("\n(metrics.json not found — run train.py to generate)")
