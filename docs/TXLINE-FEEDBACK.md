# TxLINE API Feedback: Devnet Integration Notes

These are notes from building a World Cup settlement system on devnet during the hackathon. The API works well once you know the right call shapes. Each item below is a place where I lost time and a suggested doc fix that would save the next builder that time.

---

## 1. `leagues` must be an empty array on SL=1 devnet

The `token/activate` endpoint accepts a `leagues` parameter. Sending `leagues: ["world_cup"]` returns HTTP 500 ("Could not issue custom API token due to an internal error"). The working call is `leagues: []`.

**Suggested doc addition:** note that `leagues` is empty on SL=1 devnet and that populated values apply to higher service levels or mainnet.

---

## 2. `walletSignature` message format is `txSig::jwt` (two colons)

The Ed25519 signature must be over the exact string formed by concatenating the onchain subscribe transaction signature, two colons, and the guest JWT: `txSig::jwt`. The order matters: obtain the guest JWT first, then sign. Signing `txSig` alone returns HTTP 403 ("Wallet signature verification failed or payload was tampered with").

**Suggested doc addition:** show the exact concatenation pattern (`txSig + "::" + guestJwt`) and specify that the JWT must already exist before signing.

---

## 3. Data endpoints require both `Authorization` and `X-Api-Token` headers

Authenticated data requests need two headers simultaneously: `Authorization: Bearer <jwt>` and `X-Api-Token: <apiToken>`. Sending only one returns a 401 or 403. Easy to miss when reading the auth flow.

**Suggested doc addition:** a minimal working request example showing both headers together.

---

## 4. `token/activate` response is `text/plain`, not JSON

The endpoint returns the raw API token string (format: `txoracle_api_<hex>`) as plain text, not a JSON object. Calling `.json()` on the response throws. Calling `.text()` works.

**Suggested doc addition:** specify the `Content-Type: text/plain` response and show `.text()` as the correct parser.

---

## 5. Subscribe transaction signatures are single-use

Each call to `token/activate` consumes the onchain subscribe transaction. Re-activating with the same transaction signature returns HTTP 403 ("This transaction has already been used to activate a subscription"). A fresh onchain subscribe is required for each activation. The subscription itself remains valid for roughly four weeks.

**Suggested doc addition:** a note that `txSig` values are one-time-use for activation, separate from subscription validity.

---

## 6. Merkle proof endpoint vs. onchain settlement root

`GET /api/odds/validation?messageId=...&ts=...` returns HTTP 404 for live in-running odds message IDs on devnet. The verifiable settlement source is the `daily_scores_roots` PDA written by the oracle program, which was confirmed present on devnet for the current epoch.

**Suggested doc addition:** clarify which settlement verification path is canonical for onchain use cases. If the Merkle proof endpoint is mainnet-only or epoch-gated, a note to that effect would help integrators pick the right path without trial and error.

---

## 7. SL=12 is mainnet-only; devnet pricingMatrix has SL=1 and SL=2

A Discord note mentioned SL=12 as a working service level. On devnet the pricingMatrix only returns SL=1 and SL=2. SL=12 appears to be mainnet. This sent me down a path trying to activate with SL=12 before checking the pricingMatrix response directly.

**Suggested doc addition:** a table or note showing which service levels are available per environment (devnet vs. mainnet).

---

Thanks for building this. The authentication model is clean once the pieces click, and the onchain settlement root as the canonical truth source is a good design. These notes are all from a solved state, so hopefully they translate directly into doc improvements.
