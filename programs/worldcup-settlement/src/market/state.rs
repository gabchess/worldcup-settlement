use anchor_lang::prelude::*;

/// Which side of the match a position can be on.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug)]
pub enum Side {
    Home,
    Away,
    Draw,
}

/// On-chain record of a single World Cup match market.
///
/// PDA seeds: [b"market", match_id.to_le_bytes()]
#[account]
pub struct Market {
    /// TxODDS fixture ID; used as the PDA seed key.
    pub match_id: u64,
    /// Daily batch roots epoch day for this match (LE-encoded, matches TxODDS).
    /// Stored so settle_from_proof can derive the daily_batch_roots PDA without re-passing epoch_day.
    pub epoch_day: u16,
    /// The signer who called init_market; becomes settle authority pending C5 decision.
    pub authority: Pubkey,
    /// council-4b: double-settle guard. Flips to true in the SAME instruction that records outcome.
    pub settled: bool,
    /// None until settled; Some(side) after successful settle_from_proof.
    pub outcome: Option<Side>,
    /// PDA bump, stored to avoid re-derivation on every CPI.
    pub bump: u8,
}

impl Market {
    // discriminator(8) + match_id(8) + epoch_day(2) + authority(32) + settled(1)
    // + outcome(1 tag + 1 variant = 2, use 2) + bump(1) = 54; pad to 64
    pub const SIZE: usize = 8 + 8 + 2 + 32 + 1 + 2 + 1 + 10; // 64 bytes total
}
