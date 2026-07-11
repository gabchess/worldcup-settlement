use crate::constants::MARKET_SEED;
use crate::errors::WorldCupError;
use crate::market::{Market, Side};
use crate::position::Position;
use anchor_lang::prelude::*;

/// Pays out a resolved market's pooled lamports to a bettor: proportionally if
/// they backed the winning side, or a full refund of their own stake in the
/// empty-winning-pool edge case (see below).
///
/// Ported from `worldcup-pari-market`'s `claim_payout` (algorithm + guard shape,
/// PRD S193 Implementation Decision #1). Two adaptations from the donor:
/// a 3-way `Side` enum (Home/Away/Draw) here vs. pari-market's `bool`, and a
/// direct native-lamport balance transfer here vs. pari-market's SPL CPI (the
/// market PDA is program-owned, so an outbound `system_program::transfer`
/// CPI — which requires a System-owned source — is not available; see
/// Implementation Decision #3).
///
/// ── Payout math ──────────────────────────────────────────────────────────
/// `payout = position.stake_lamports * total_pool / winning_pool`, where
/// `total_pool = home_pool + away_pool + draw_pool` and `winning_pool` is
/// whichever pool matches `market.outcome`. Computed in a u128 intermediate
/// (the u64 * u64 numerator can overflow u64 well before either pool reaches
/// u64::MAX), floor division, then checked-cast back to u64.
///
/// ── Dust policy (deliberate design, inherited from the donor) ───────────
/// Floor division means `sum(all payouts) <= total_pool`, almost always
/// strictly less: the remainder from every floor-divided claim ("dust") stays
/// in the market PDA permanently. No last-claimer sweep, no redistribution —
/// unclaimed dust sitting in the vault forever is a strictly safer failure
/// mode than a conservation violation.
///
/// ── Empty-winning-pool refund (edge case, user story 4) ──────────────────
/// If `market.outcome` lands on a side nobody staked on (winning_pool == 0),
/// there is no legitimate winner to construct a proportional payout for.
/// Every position — regardless of `position.side` — may claim back exactly
/// `position.stake_lamports` (a refund, not a "win"). The `ClaimPayout`
/// Accounts struct's winner-only constraint is OR'd with this refund
/// condition, so the account-validation layer itself distinguishes "ordinary
/// losing position, winning pool has money in it, nothing to claim"
/// (rejected with LosingPosition) from "winning pool is empty, everyone
/// refunds" (allowed through to this body, which then branches on the same
/// condition to pick refund vs. proportional-payout math).
///
/// ── Rent-exemption guard (Implementation Decision #3) ────────────────────
/// The market PDA is the vault; a payout that would drain it below its own
/// rent-exempt minimum must fail closed (checked_sub, not saturating_sub),
/// matching the existing checked-arithmetic discipline (council-4c) already
/// used in open_position.
///
/// ── Reentrancy hygiene ───────────────────────────────────────────────────
/// `position.claimed = true` is set BEFORE the lamport transfer. Solana
/// instructions are atomic (a later failure in the same instruction reverts
/// the whole transaction, including this write), so this is cheap discipline
/// rather than closing a real reentrancy hole — but it is the right shape to
/// default to.
///
/// Verifier (PRD S193 Test Seams): after claim_payout, position.claimed ==
/// true, the bettor's lamport balance increases by exactly the proportional
/// share (or refund), and the market PDA's balance decreases by the same
/// amount. A second claim_payout on the same position fails with
/// AlreadyClaimed; a call on an ordinary losing-side position (winning pool
/// non-empty) fails with LosingPosition; a call before settle_from_proof has
/// run fails with MarketNotResolved.
pub fn claim_payout(ctx: Context<ClaimPayout>) -> Result<()> {
    let market = &ctx.accounts.market;
    let position = &ctx.accounts.position;

    // Belt-and-suspenders: the ClaimPayout account constraint on `market`
    // already rejects an unsettled market before reaching this body (matches
    // the existing require!-after-constraint pattern in settle_from_proof).
    let winning_side = market
        .outcome
        .clone()
        .ok_or(WorldCupError::MarketNotResolved)?;
    let winning_pool: u64 = match winning_side {
        Side::Home => market.home_pool,
        Side::Away => market.away_pool,
        Side::Draw => market.draw_pool,
    };
    let total_pool: u64 = market
        .home_pool
        .checked_add(market.away_pool)
        .and_then(|sum| sum.checked_add(market.draw_pool))
        .ok_or(WorldCupError::ArithmeticOverflow)?;

    let payout: u64 = if winning_pool == 0 {
        // Empty-winning-pool refund: nobody backed the resolved outcome, so
        // every position — any side — gets exactly its own stake back. The
        // Accounts struct's constraint already gated entry here to only this
        // refund case OR a genuine winner (see doc comment above).
        position.stake_lamports
    } else {
        // Proportional payout: u128 intermediate (stake * total_pool can
        // exceed u64::MAX even when each individual value fits u64), floor
        // division (the dust policy above), checked cast back to u64.
        let numerator: u128 = (position.stake_lamports as u128)
            .checked_mul(total_pool as u128)
            .ok_or(WorldCupError::ArithmeticOverflow)?;
        let payout_u128: u128 = numerator / (winning_pool as u128); // winning_pool != 0, checked above
        u64::try_from(payout_u128).map_err(|_| WorldCupError::ArithmeticOverflow)?
    };

    // Rent-exemption guard: fail closed if this payout would drain the market
    // PDA below its own rent-exempt minimum (checked_sub, matching the
    // existing checked-arithmetic discipline).
    let rent_exempt_minimum = Rent::get()?.minimum_balance(Market::SIZE);
    let market_lamports_before = ctx.accounts.market.to_account_info().lamports();
    let market_lamports_after = market_lamports_before
        .checked_sub(payout)
        .ok_or(WorldCupError::ArithmeticOverflow)?;
    require!(
        market_lamports_after >= rent_exempt_minimum,
        WorldCupError::VaultBelowRentExemption
    );

    // Reentrancy hygiene: mark claimed before moving lamports (see doc comment above).
    ctx.accounts.position.claimed = true;

    // Direct lamport-balance transfer: the market PDA is program-owned
    // (`#[account]`), so an outbound transfer FROM it cannot go through
    // system_program::transfer (that CPI requires a System-owned source).
    // This is the standard pattern for disbursing from a program-owned PDA
    // that is also the vault (Implementation Decision #3).
    **ctx.accounts.market.to_account_info().lamports.borrow_mut() = market_lamports_after;
    let bettor_lamports_after = ctx
        .accounts
        .bettor
        .to_account_info()
        .lamports()
        .checked_add(payout)
        .ok_or(WorldCupError::ArithmeticOverflow)?;
    **ctx.accounts.bettor.to_account_info().lamports.borrow_mut() = bettor_lamports_after;

    Ok(())
}

#[derive(Accounts)]
pub struct ClaimPayout<'info> {
    #[account(
        mut,
        seeds = [MARKET_SEED, &market.match_id.to_le_bytes()],
        bump = market.bump,
        constraint = market.settled @ WorldCupError::MarketNotResolved,
    )]
    pub market: Account<'info, Market>,

    #[account(
        mut,
        seeds = [b"position", market.key().as_ref(), bettor.key().as_ref()],
        bump = position.bump,
        has_one = market,
        has_one = bettor,
        constraint = !position.claimed @ WorldCupError::AlreadyClaimed,
        // Winner-only claim, OR'd with the empty-winning-pool refund path (user
        // story 4): a position may claim if (a) its side matches the resolved
        // outcome (ordinary winner), or (b) the pool matching the resolved
        // outcome is empty (nobody backed the winner — every position, any
        // side, refunds its own stake; see claim_payout's doc comment for the
        // full rationale). Fails cheap, before any CU is spent on payout math
        // (user story 10) — also the seam that rejects cross-market
        // substitution together with the has_one constraints above (user
        // story 11).
        constraint = (
            Some(position.side.clone()) == market.outcome
            || (market.outcome == Some(Side::Home) && market.home_pool == 0)
            || (market.outcome == Some(Side::Away) && market.away_pool == 0)
            || (market.outcome == Some(Side::Draw) && market.draw_pool == 0)
        ) @ WorldCupError::LosingPosition,
    )]
    pub position: Account<'info, Position>,

    #[account(mut)]
    pub bettor: Signer<'info>,
}
