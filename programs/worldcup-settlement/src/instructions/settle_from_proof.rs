use anchor_lang::prelude::*;
use crate::constants::{MARKET_SEED, TXODDS_PROGRAM_ID, USE_PLAN_B};
use crate::errors::WorldCupError;
use crate::market::Market;
use crate::proof::{ProofNode, plan_b, verify};

/// Verifies that stat_data is included in the TxODDS daily batch root via Merkle proof,
/// then marks market.settled = true and records the outcome.
///
/// PRIMARY PATH (Model-2): PDA-Merkle via daily_batch_roots PDA (USE_PLAN_B = false).
/// FALLBACK (Plan-B): trusted-oracle settle when USE_PLAN_B = true (devnet default).
///
/// Double-settle guard: the `constraint = !market.settled` on the Market account
/// causes Anchor to reject the transaction before reaching instruction body.
///
/// council-4d: Model-2 is trustless Merkle (primary). Plan-B is the documented
/// PoC shortcut behind USE_PLAN_B; NOT trustless. Replace at C6 once live
/// TxODDS data confirms the proof encoding.
pub fn settle_from_proof(
    ctx: Context<SettleFromProof>,
    proof_nodes: Vec<ProofNode>,
    stat_data: Vec<u8>,
) -> Result<()> {
    let market = &mut ctx.accounts.market;

    // council-4b: double-settle guard enforced by account constraint (AlreadySettled).
    // The require here is a belt-and-suspenders for direct unit test paths that bypass
    // Anchor's constraint check (e.g. set_account pokes in tests).
    require!(!market.settled, WorldCupError::AlreadySettled);

    if USE_PLAN_B {
        // PLAN-B: trusted-oracle settle. Admin key posts result.
        // Plan-B = a trusted oracle posts the result, NO Merkle verification.
        // PoC shortcut, NOT trustless; replaced by Model-2 once live data
        // confirms the proof encoding (C6).
        plan_b::settle_plan_b(market, &ctx.accounts.authority, &stat_data)?;
    } else {
        // PRIMARY: Model-2 PDA-Merkle path (USE_PLAN_B = false).

        // council-4d: in-body TXODDS_PROGRAM_ID guard (belt-and-suspenders with
        // account constraint on txodds_program above).
        require_keys_eq!(
            ctx.accounts.txodds_program.key(),
            TXODDS_PROGRAM_ID,
            WorldCupError::InvalidTxOddsProgram
        );

        // Derive and verify the daily_batch_roots PDA for this market's epoch_day.
        // epoch_day is stored at init_market — avoids param-vs-state mismatch bypass.
        let (expected_pda, _) =
            verify::derive_daily_batch_roots_pda(market.epoch_day, &TXODDS_PROGRAM_ID);
        require_keys_eq!(
            ctx.accounts.daily_batch_roots_pda.key(),
            expected_pda,
            WorldCupError::ProofVerificationFailed
        );

        // Full Merkle walk: leaf = sha256(stat_data), walk proof_nodes, compare root
        // stored in the daily_batch_roots PDA account data.
        verify::verify_proof_against_pda(
            &stat_data,
            &proof_nodes,
            ctx.accounts.daily_batch_roots_pda.as_ref(),
        )?;

        // Decode match_id from stat_data and enforce replay guard.
        // Encoding: bytes 0..8 = match_id as u64 LE. TODO(C6): confirm against live TxODDS.
        let decoded_match_id =
            verify::decode_match_id(&stat_data).ok_or(WorldCupError::ProofVerificationFailed)?;
        require!(decoded_match_id == market.match_id, WorldCupError::MatchIdMismatch);

        // Decode outcome from stat_data.
        // Encoding: byte 8 = 0=Home, 1=Away, 2=Draw. TODO(C6): confirm against live TxODDS.
        let decoded_side =
            verify::decode_outcome(&stat_data).ok_or(WorldCupError::ProofVerificationFailed)?;

        // council-4b: both outcome and settled flag written atomically in the SAME instruction.
        market.outcome = Some(decoded_side);
        market.settled = true;
    }

    Ok(())
}

#[derive(Accounts)]
pub struct SettleFromProof<'info> {
    #[account(
        mut,
        seeds = [MARKET_SEED, &market.match_id.to_le_bytes()],
        bump = market.bump,
        // council-4b: market must not already be settled
        constraint = !market.settled @ WorldCupError::AlreadySettled,
    )]
    pub market: Account<'info, Market>,

    /// TxODDS-owned daily_batch_roots PDA (read-only in Model-2 path).
    /// CHECK: We derive and compare the expected PDA address in the instruction body.
    #[account()]
    pub daily_batch_roots_pda: UncheckedAccount<'info>,

    /// TxODDS program (for potential CPI to validate_odds in C6).
    /// CHECK: constraint below enforces key == TXODDS_PROGRAM_ID at account deserialization.
    #[account(constraint = txodds_program.key() == crate::constants::TXODDS_PROGRAM_ID @ WorldCupError::InvalidTxOddsProgram)]
    pub txodds_program: UncheckedAccount<'info>,

    /// Settle authority.
    /// Model-2: any signer (Merkle proof is the auth mechanism, not the key).
    /// Plan-B: must match PLAN_B_ORACLE_AUTHORITY (enforced in plan_b::settle_plan_b).
    pub authority: Signer<'info>,
}
