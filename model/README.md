# C2 Match-Outcome Model

Logistic regression + Platt calibration. Outputs P(home wins the match) from 4 features.

Retargeted from P(goal in 15 min) at C9 gate (Kent+Dayo unanimous) for model↔market↔settlement
coherence: the bet is on the match WINNER, so the model must predict the same event.

## Features (C2 spec)

| Feature | Description |
|---|---|
| `score_differential` | home_goals - away_goals at minute T |
| `match_phase` | Ordinal bucket 1-7 (15-min intervals) |
| `red_card_delta` | home_reds - away_reds |
| `match_phase_sq` | match_phase^2 (captures non-linear time effect) |

## Setup

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
```

## Train

```bash
cd model && ../.venv/bin/python train.py
# Pulls 60 World Cup + Euro matches from StatsBomb Open Data via statsbombpy
# Saves model.joblib + model.json + metrics.json
```

## Predict

```python
from predict_sample import predict
p = predict({"score_differential": 2, "match_phase": 6, "red_card_delta": 0})
# returns float in [0, 1] — P(home wins match)
```

## Verify

```bash
python model/predict_sample.py
```

Expected output: P(home wins match) for 3 sample states + Brier better than baseline.

## Performance

- Dataset: StatsBomb Open Data, World Cup 2022 + Euro (60 matches, 5400 rows)
- Home-win base rate: ~42%
- Holdout Brier: ~0.158 vs baseline ~0.243
- Directional sanity: leading +2 at phase 6 → P ≈ 0.91; trailing -2 at phase 6 → P ≈ 0.009

## Files

| File | Purpose |
|---|---|
| `train.py` | Data pull, feature engineering, fit, export JSON, save metrics |
| `predict_sample.py` | Verifier + `predict()` function |
| `model.joblib` | Fitted CalibratedClassifierCV |
| `model.json` | JSON export for TS bridge (agent/model.ts) |
| `metrics.json` | Holdout metrics + directional sanity |
| `requirements.txt` | Python deps |
