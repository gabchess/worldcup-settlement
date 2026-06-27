use anchor_lang::prelude::*;
use crate::market::Side;

/// On-chain record of a single bettor's position in a market.
///
/// PDA seeds: [b"position", market.key(), bettor.key()]
#[account]
pub struct Position {
    /// Parent Market PDA.
    pub market: Pubkey,
    /// Who placed the bet.
    pub bettor: Pubkey,
    /// Lamports wagered. All mutations use checked_add / checked_sub (council 4c).
    pub stake_lamports: u64,
    /// Which side the bettor is on.
    pub side: Side,
    /// Payout guard -- prevents double-claim at C9 (Kelly loop dispatch).
    /// Not a council C3 requirement but needed at C9; adding now avoids a state migration.
    pub claimed: bool,
    /// PDA bump, stored to avoid re-derivation.
    pub bump: u8,
}

impl Position {
    // discriminator(8) + market(32) + bettor(32) + stake_lamports(8) + side(1) + claimed(1) + bump(1) = 83; pad to 96
    pub const SIZE: usize = 8 + 32 + 32 + 8 + 1 + 1 + 1 + 13; // 96 bytes total
}
