use anchor_lang::prelude::*;
use crate::constants::PLAN_B_ORACLE_AUTHORITY;
use crate::errors::WorldCupError;
use crate::market::Market;
use crate::proof::verify;

/// PLAN-B: trusted-oracle settle. Admin key posts result.
/// Not trustless. Replaces Model-2 until token/activate HTTP 500 is resolved.
/// Remove before any mainnet consideration.
///
/// The authority signer must match PLAN_B_ORACLE_AUTHORITY from constants.
/// stat_data encoding for Plan-B: [outcome_byte] where 0=Home, 1=Away, 2=Draw.
///
/// TODO(C4): define and document the stat_data encoding contract
/// TODO(C5): delete this file and route all settlement through verify::verify_proof_against_pda
pub fn settle_plan_b(
    market: &mut Market,
    authority: &Signer,
    stat_data: &[u8],
) -> Result<()> {
    // Authority guard: only the designated devnet oracle may call this path.
    require_keys_eq!(
        authority.key(),
        PLAN_B_ORACLE_AUTHORITY,
        WorldCupError::UnauthorizedOracle
    );

    // Decode outcome from stat_data using the shared encoding:
    // bytes 0..8 = match_id (u64 LE, ignored in Plan-B —
    //   no replay guard: the oracle-key check is the trust boundary; the Anchor PDA
    //   constraint on the accounts list binds which market settles; replay protection
    //   is the oracle's operational responsibility).
    // byte 8 = outcome (0=Home, 1=Away, 2=Draw).
    // This matches the Model-2 stat_data layout so callers use a single encoding.
    // TODO(C6): confirm encoding against live TxODDS stat_data schema.
    let side = verify::decode_outcome(stat_data).ok_or(WorldCupError::ProofVerificationFailed)?;

    // council-4b: outcome AND settled written in the SAME call, never split.
    market.outcome = Some(side);
    market.settled = true; // council-4b: double-settle guard
    Ok(())
}
