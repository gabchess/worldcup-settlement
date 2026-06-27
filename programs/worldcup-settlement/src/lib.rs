use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod instructions;
pub mod market;
pub mod position;
pub mod proof;

use instructions::*;
use proof::ProofNode;

declare_id!("FFnQCXKLVLgA4Wn6PjH9mitKpHFqFtKz9HcF6qFRWnmp");

#[program]
pub mod worldcup_settlement {
    use super::*;

    /// Creates a Market PDA keyed on match_id.
    pub fn init_market(ctx: Context<InitMarket>, match_id: u64, epoch_day: u16) -> Result<()> {
        instructions::init_market::init_market(ctx, match_id, epoch_day)
    }

    /// Records a single bet on an open market.
    pub fn open_position(
        ctx: Context<OpenPosition>,
        stake_lamports: u64,
        side: market::Side,
    ) -> Result<()> {
        instructions::open_position::open_position(ctx, stake_lamports, side)
    }

    /// Verifies a Merkle proof and settles the market outcome.
    /// epoch_day is derived from market.epoch_day (stored at init_market) — no param.
    pub fn settle_from_proof(
        ctx: Context<SettleFromProof>,
        proof_nodes: Vec<ProofNode>,
        stat_data: Vec<u8>,
    ) -> Result<()> {
        instructions::settle_from_proof::settle_from_proof(ctx, proof_nodes, stat_data)
    }
}
