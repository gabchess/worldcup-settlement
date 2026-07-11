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
    /// Cumulative stake_lamports wagered on Side::Home. Incremented by
    /// open_position (checked_add). Lets claim_payout compute winning_pool /
    /// total_pool for the proportional-payout formula without an expensive
    /// linear scan over every Position account for the market (PRD S193
    /// Implementation Decision #2).
    pub home_pool: u64,
    /// Cumulative stake_lamports wagered on Side::Away.
    pub away_pool: u64,
    /// Cumulative stake_lamports wagered on Side::Draw.
    pub draw_pool: u64,
    /// Unix timestamp closing the betting window. Set once at init_market
    /// from an explicit instruction argument (no derivation, no hardcoding —
    /// PRD S193 Amendment 1 story 19). Enforced as a closed-interval guard in
    /// open_position (rejects at unix_timestamp == lock_ts, not just after —
    /// PRD Amendment 1 story 17, kills the same-clock-tick lock-race window)
    /// and as a settle-vs-lock ordering guard in settle_from_proof (rejects
    /// settlement before unix_timestamp >= lock_ts).
    pub lock_ts: u64,
}

impl Market {
    // discriminator(8) + match_id(8) + epoch_day(2) + authority(32) + settled(1)
    // + outcome(1 tag + 1 variant = 2, use 2) + bump(1) + home_pool(8)
    // + away_pool(8) + draw_pool(8) + lock_ts(8) = 86; pad to 96
    pub const SIZE: usize = 8 + 8 + 2 + 32 + 1 + 2 + 1 + 8 + 8 + 8 + 8 + 10; // 96 bytes total
}
