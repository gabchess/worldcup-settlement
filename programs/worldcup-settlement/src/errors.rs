use anchor_lang::prelude::*;

#[error_code]
pub enum WorldCupError {
    // Settlement guards (council 4b)
    #[msg("Market is already settled")]
    AlreadySettled,

    // Replay / identity guard (council 4b)
    #[msg("Proof match_id does not match the market match_id")]
    MatchIdMismatch,

    // Zero-stake guard (open_position: stake_lamports must be > 0)
    #[msg("Stake amount must be greater than zero")]
    ZeroStake,

    // Arithmetic overflow guard (council 4c)
    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,

    // Merkle proof errors (TODO C5 -- verify_proof_against_pda logic)
    #[msg("Merkle proof verification failed")]
    ProofVerificationFailed,

    // Plan-B guard
    #[msg("Caller is not the Plan-B oracle authority")]
    UnauthorizedOracle,

    // TxODDS program identity guard
    #[msg("txodds_program key does not match TXODDS_PROGRAM_ID")]
    InvalidTxOddsProgram,

    // Root account owner guard (council 4a — PDA squatting defense)
    #[msg("daily_batch_roots_pda is not owned by the TxODDS program")]
    InvalidRootAccountOwner,

    // claim_payout guards (C9, ported from pari-market's ClaimPayout constraints)
    #[msg("Market has not been resolved yet")]
    MarketNotResolved,

    #[msg("Position has already been claimed")]
    AlreadyClaimed,

    #[msg("Position is on the losing side")]
    LosingPosition,

    // Rent-exemption guard (Implementation Decision #3) -- distinct from
    // ArithmeticOverflow: this failure is "payout would drain the vault
    // below its own rent-exempt minimum," not an overflow.
    #[msg("Payout would drain the vault below its rent-exempt minimum")]
    VaultBelowRentExemption,

    // Betting-lock guards (PRD S193 Amendment 1, ticket T1c)
    #[msg("Betting is closed: the market's lock_ts has been reached")]
    BettingClosed,

    #[msg("Market cannot be settled before its lock_ts has elapsed")]
    MarketNotYetLocked,

    // Guards the lock_ts u64->i64 cast: a value above i64::MAX would wrap
    // negative and silently defeat the betting-lock guards (Kent review, S193).
    #[msg("lock_ts exceeds the maximum valid unix timestamp (i64::MAX)")]
    InvalidLockTs,
}
