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
}
