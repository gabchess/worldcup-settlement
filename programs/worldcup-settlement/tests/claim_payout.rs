/// Integration tests for worldcup-settlement's claim_payout instruction (C9).
///
/// Uses litesvm (in-process SVM) — same seam as tests/settlement.rs, no local
/// validator, no devnet. The compiled .so is loaded from
/// target/deploy/worldcup_settlement.so (build.rs rebuilds it with
/// `--features test-oracle` on every `cargo test`, so PLAN_B_ORACLE_AUTHORITY
/// matches TEST_ORACLE_SECRET below — see build.rs and tests/settlement.rs).
///
/// Ported from worldcup-pari-market's tests/claim_payout.rs (structure and
/// the conservation-fuzz pattern), adapted for: 3-way Side (Home/Away/Draw)
/// instead of bool, and native-lamport balance assertions (the market PDA is
/// the vault) instead of SPL token-account balances. A dedicated `relayer`
/// keypair pays transaction fees for every claim send so a bettor's lamport
/// balance delta reflects the program's payout exactly, uncontaminated by fee
/// deduction (pari-market's donor tests get this for free because payouts
/// move in SPL tokens, a separate balance from the SOL that pays fees).
///
/// 9 tests total: the 8 required by PRD S193 Test Seams, plus one additional
/// coverage test for the native-lamport rent-exemption guard (Implementation
/// Decision #3), which has no equivalent in the donor's SPL-based vault.
mod common;

use anchor_lang::{AnchorDeserialize, AnchorSerialize, InstructionData};
use litesvm::LiteSVM;
use solana_account::Account;
use solana_instruction::{error::InstructionError, AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use solana_transaction::TransactionError;
use worldcup_settlement::{self, instruction as ix};

use worldcup_settlement::market::Side;

use common::{
    market_pda, oracle_keypair, position_pda, program_id, send, set_clock_timestamp, svm,
    SYSTEM_PROGRAM_ID,
};

/// Every test in this file opens all its positions (before lock_ts elapses),
/// then settles (at/after lock_ts). lock_ts = 1 is the smallest value that
/// keeps litesvm's default-frozen Clock (unix_timestamp == 0) strictly
/// before lock for every open_position call; `settle_plan_b` below warps the
/// clock forward to this exact value before settling (PRD S193 Amendment 1 /
/// ticket T1c).
const CLAIM_TEST_LOCK_TS: u64 = 1;

fn side_byte(side: &Side) -> u8 {
    match side {
        Side::Home => 0,
        Side::Away => 1,
        Side::Draw => 2,
    }
}

/// Build a stat_data buffer that encodes match_id (u64 LE at bytes 0..8) and
/// outcome byte (at byte 8: 0=Home, 1=Away, 2=Draw). Same encoding tests/settlement.rs uses.
fn stat_data_for(match_id: u64, outcome_byte: u8) -> Vec<u8> {
    let mut buf = vec![0u8; 9];
    buf[..8].copy_from_slice(&match_id.to_le_bytes());
    buf[8] = outcome_byte;
    buf
}

fn custom_err(code: u32) -> TransactionError {
    TransactionError::InstructionError(0, InstructionError::Custom(code))
}

fn lamports(svm: &LiteSVM, pubkey: &Pubkey) -> u64 {
    svm.get_account(pubkey).expect("account not found").lamports
}

fn read_market(svm: &LiteSVM, market: &Pubkey) -> worldcup_settlement::market::Market {
    let raw = svm.get_account(market).expect("market account not found");
    AnchorDeserialize::deserialize(&mut &raw.data[8..]).expect("deserialize market")
}

fn read_position(svm: &LiteSVM, position: &Pubkey) -> worldcup_settlement::position::Position {
    let raw = svm
        .get_account(position)
        .expect("position account not found");
    AnchorDeserialize::deserialize(&mut &raw.data[8..]).expect("deserialize position")
}

/// Deserialize -> mutate -> re-serialize a Position account's `stake_lamports`
/// field. Layout-proof (field-level mutation, not a byte-offset poke) —
/// mirrors pari-market's force_resolve helper and settlement.rs's own
/// documented preference for this pattern over raw offset pokes.
fn force_position_stake(svm: &mut LiteSVM, position: &Pubkey, new_stake: u64) {
    let raw = svm.get_account(position).expect("position account");
    let owner = raw.owner;
    let mut pos: worldcup_settlement::position::Position =
        AnchorDeserialize::deserialize(&mut &raw.data[8..]).expect("deserialize position");
    pos.stake_lamports = new_stake;
    let mut data = raw.data[..8].to_vec();
    AnchorSerialize::serialize(&pos, &mut data).expect("serialize position");
    svm.set_account(
        *position,
        Account {
            lamports: raw.lamports,
            data,
            owner,
            executable: false,
            rent_epoch: raw.rent_epoch,
        },
    )
    .unwrap();
}

/// Deserialize -> mutate -> re-serialize a Position account's `market` field
/// (cross-market substitution attack simulation — see
/// test_claim_payout_cross_market_substitution_rejected).
fn force_position_market(svm: &mut LiteSVM, position: &Pubkey, new_market: Pubkey) {
    let raw = svm.get_account(position).expect("position account");
    let owner = raw.owner;
    let mut pos: worldcup_settlement::position::Position =
        AnchorDeserialize::deserialize(&mut &raw.data[8..]).expect("deserialize position");
    pos.market = new_market;
    let mut data = raw.data[..8].to_vec();
    AnchorSerialize::serialize(&pos, &mut data).expect("serialize position");
    svm.set_account(
        *position,
        Account {
            lamports: raw.lamports,
            data,
            owner,
            executable: false,
            rent_epoch: raw.rent_epoch,
        },
    )
    .unwrap();
}

struct MarketSetup {
    market: Pubkey,
}

fn setup_market(svm: &mut LiteSVM, match_id: u64) -> MarketSetup {
    let authority = Keypair::new();
    svm.airdrop(&authority.pubkey(), 10_000_000_000).unwrap();
    let epoch_day: u16 = 1;
    let (market, _) = market_pda(match_id);
    let accounts = vec![
        AccountMeta::new(market, false),
        AccountMeta::new(authority.pubkey(), true),
        AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
    ];
    let data = ix::InitMarket {
        match_id,
        epoch_day,
        lock_ts: CLAIM_TEST_LOCK_TS,
    }
    .data();
    send(
        svm,
        &authority,
        &[&authority],
        Instruction {
            program_id: program_id(),
            accounts,
            data,
        },
    )
    .expect("init_market failed");
    MarketSetup { market }
}

fn open_position(
    svm: &mut LiteSVM,
    market: &Pubkey,
    bettor: &Keypair,
    stake: u64,
    side: Side,
) -> Pubkey {
    let (position, _) = position_pda(market, &bettor.pubkey());
    let accounts = vec![
        AccountMeta::new(*market, false),
        AccountMeta::new(position, false),
        AccountMeta::new(bettor.pubkey(), true),
        AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
    ];
    let data = ix::OpenPosition {
        stake_lamports: stake,
        side,
    }
    .data();
    svm.expire_blockhash();
    send(
        svm,
        bettor,
        &[bettor],
        Instruction {
            program_id: program_id(),
            accounts,
            data,
        },
    )
    .expect("open_position failed");
    position
}

/// Settles `market` via the Plan-B path with the given outcome side.
/// `match_id` must match the market's own match_id (encoded into stat_data).
fn settle_plan_b(svm: &mut LiteSVM, market: &Pubkey, match_id: u64, outcome: &Side) {
    // Warp the clock to exactly CLAIM_TEST_LOCK_TS: settle_from_proof's
    // guard is unix_timestamp >= lock_ts, so this is the earliest tick at
    // which settlement is allowed (T1c). Every open_position call in this
    // file's tests happens before this warp, at the default t == 0.
    set_clock_timestamp(svm, CLAIM_TEST_LOCK_TS as i64);

    let oracle = oracle_keypair();
    svm.airdrop(&oracle.pubkey(), 10_000_000_000).unwrap();
    let txodds = worldcup_settlement::constants::TXODDS_PROGRAM_ID;
    let accounts = vec![
        AccountMeta::new(*market, false),
        AccountMeta::new_readonly(txodds, false), // daily_batch_roots_pda (unused in Plan-B)
        AccountMeta::new_readonly(txodds, false), // txodds_program
        AccountMeta::new(oracle.pubkey(), true),
    ];
    let data = ix::SettleFromProof {
        proof_nodes: vec![],
        stat_data: stat_data_for(match_id, side_byte(outcome)),
    }
    .data();
    svm.expire_blockhash();
    send(
        svm,
        &oracle,
        &[&oracle],
        Instruction {
            program_id: program_id(),
            accounts,
            data,
        },
    )
    .expect("settle_from_proof (Plan-B) failed");
}

fn claim_ix(market: &Pubkey, position: &Pubkey, bettor: &Pubkey) -> Instruction {
    let accounts = vec![
        AccountMeta::new(*market, false),
        AccountMeta::new(*position, false),
        AccountMeta::new(*bettor, true),
    ];
    Instruction {
        program_id: program_id(),
        accounts,
        data: ix::ClaimPayout {}.data(),
    }
}

/// Sends a claim_payout instruction with a dedicated fee-paying relayer, so
/// `bettor`'s lamport balance delta reflects the payout exactly (uncontaminated
/// by the transaction fee).
fn claim(
    svm: &mut LiteSVM,
    relayer: &Keypair,
    market: &Pubkey,
    position: &Pubkey,
    bettor: &Keypair,
) -> litesvm::types::TransactionResult {
    svm.expire_blockhash();
    send(
        svm,
        relayer,
        &[relayer, bettor],
        claim_ix(market, position, &bettor.pubkey()),
    )
}

fn funded_keypair(svm: &mut LiteSVM, lamports: u64) -> Keypair {
    let kp = Keypair::new();
    svm.airdrop(&kp.pubkey(), lamports).unwrap();
    kp
}

// ── Test 1: proportional payout happy path ──────────────────────────────────
// Home pool: 300_000 (bettor A). Away pool: 100_000 (bettor B). Outcome: Home wins.
// total_pool = 400_000, winning_pool = 300_000. A's payout = 300_000 * 400_000 / 300_000 = 400_000.

#[test]
fn test_claim_payout_proportional_happy_path() {
    let mut svm = svm();
    let setup = setup_market(&mut svm, 5001);
    let relayer = funded_keypair(&mut svm, 10_000_000_000);

    let bettor_a = funded_keypair(&mut svm, 10_000_000_000);
    let bettor_b = funded_keypair(&mut svm, 10_000_000_000);
    let position_a = open_position(&mut svm, &setup.market, &bettor_a, 300_000, Side::Home);
    open_position(&mut svm, &setup.market, &bettor_b, 100_000, Side::Away);

    settle_plan_b(&mut svm, &setup.market, 5001, &Side::Home);

    let market_before = lamports(&svm, &setup.market);
    let bettor_before = lamports(&svm, &bettor_a.pubkey());

    claim(&mut svm, &relayer, &setup.market, &position_a, &bettor_a)
        .expect("winner claim should succeed");

    let market_after = lamports(&svm, &setup.market);
    let bettor_after = lamports(&svm, &bettor_a.pubkey());

    assert_eq!(
        bettor_after - bettor_before,
        400_000,
        "winner's payout must be exactly total_pool (sole winner takes all)"
    );
    assert_eq!(
        market_before - market_after,
        400_000,
        "market PDA must pay out exactly the same amount it credited the bettor"
    );

    let pos = read_position(&svm, &position_a);
    assert!(pos.claimed, "position.claimed must be true after claim");
}

// ── Test 2: losing position rejected (winner-only constraint) ──────────────

#[test]
fn test_claim_payout_losing_position_rejected() {
    let mut svm = svm();
    let setup = setup_market(&mut svm, 5002);
    let relayer = funded_keypair(&mut svm, 10_000_000_000);

    let bettor_a = funded_keypair(&mut svm, 10_000_000_000);
    let bettor_b = funded_keypair(&mut svm, 10_000_000_000);
    open_position(&mut svm, &setup.market, &bettor_a, 300_000, Side::Home);
    let position_b = open_position(&mut svm, &setup.market, &bettor_b, 100_000, Side::Away);

    settle_plan_b(&mut svm, &setup.market, 5002, &Side::Home); // Home wins, B (Away) loses

    let err = claim(&mut svm, &relayer, &setup.market, &position_b, &bettor_b)
        .expect_err("losing-side claim (winning pool non-empty) must be rejected");
    assert_eq!(err.err, custom_err(6010), "expected LosingPosition (6010)");
}

// ── Test 3: double-claim rejected ───────────────────────────────────────────

#[test]
fn test_claim_payout_double_claim_rejected() {
    let mut svm = svm();
    let setup = setup_market(&mut svm, 5003);
    let relayer = funded_keypair(&mut svm, 10_000_000_000);

    let bettor_a = funded_keypair(&mut svm, 10_000_000_000);
    let position_a = open_position(&mut svm, &setup.market, &bettor_a, 100_000, Side::Home);
    settle_plan_b(&mut svm, &setup.market, 5003, &Side::Home);

    claim(&mut svm, &relayer, &setup.market, &position_a, &bettor_a)
        .expect("first claim should succeed");

    let err = claim(&mut svm, &relayer, &setup.market, &position_a, &bettor_a)
        .expect_err("second claim on the same position must be rejected");
    assert_eq!(err.err, custom_err(6009), "expected AlreadyClaimed (6009)");
}

// ── Test 4: empty-winning-pool refund ───────────────────────────────────────
// Only Away-side deposits exist. Outcome resolves Home (winning_pool = home_pool = 0).
// The Away-side depositor must be refunded exactly their stake, not stuck.

#[test]
fn test_claim_payout_empty_winning_pool_refund() {
    let mut svm = svm();
    let setup = setup_market(&mut svm, 5004);
    let relayer = funded_keypair(&mut svm, 10_000_000_000);

    let bettor_a = funded_keypair(&mut svm, 10_000_000_000);
    let position_a = open_position(&mut svm, &setup.market, &bettor_a, 250_000, Side::Away);

    let market_state = read_market(&svm, &setup.market);
    assert_eq!(
        market_state.home_pool, 0,
        "sanity: home_pool must be 0 (nobody bet Home)"
    );

    settle_plan_b(&mut svm, &setup.market, 5004, &Side::Home); // Home wins, but home_pool == 0

    let market_before = lamports(&svm, &setup.market);
    let bettor_before = lamports(&svm, &bettor_a.pubkey());

    claim(&mut svm, &relayer, &setup.market, &position_a, &bettor_a)
        .expect("empty-winning-pool refund must succeed for the Away-side depositor");

    let market_after = lamports(&svm, &setup.market);
    let bettor_after = lamports(&svm, &bettor_a.pubkey());

    assert_eq!(
        bettor_after - bettor_before,
        250_000,
        "refund must equal exactly the original stake, not a proportional share"
    );
    assert_eq!(
        market_before - market_after,
        250_000,
        "market PDA must pay out exactly the refund amount"
    );
}

// ── Test 5: claim before settle_from_proof rejected ─────────────────────────

#[test]
fn test_claim_payout_before_resolve_rejected() {
    let mut svm = svm();
    let setup = setup_market(&mut svm, 5005);
    let relayer = funded_keypair(&mut svm, 10_000_000_000);

    let bettor_a = funded_keypair(&mut svm, 10_000_000_000);
    let position_a = open_position(&mut svm, &setup.market, &bettor_a, 100_000, Side::Home);
    // Note: settle_from_proof is never called — market.settled stays false.

    let err = claim(&mut svm, &relayer, &setup.market, &position_a, &bettor_a)
        .expect_err("claim before settle_from_proof must be rejected");
    assert_eq!(
        err.err,
        custom_err(6008),
        "expected MarketNotResolved (6008)"
    );
}

// ── Test 6: dust-stake zero-payout succeeds (user story 13) ─────────────────
// Under pari-mutuel math, winning_pool <= total_pool always, so a position
// reached via the genuine-winner branch always has payout >= its own stake >=
// 1 (the ZeroStake guard in open_position prevents a real 0-stake position
// from ever existing). To exercise the "0-lamport payout, no panic/underflow"
// edge from user story 13, this test forges position.stake_lamports = 0 after
// the position is legitimately opened and the market settled — simulating the
// "adversarial small-stake input" the story names, since 0 itself is
// unreachable via the normal open_position path.

#[test]
fn test_claim_payout_dust_stake_zero_payout_succeeds() {
    let mut svm = svm();
    let setup = setup_market(&mut svm, 5006);
    let relayer = funded_keypair(&mut svm, 10_000_000_000);

    let bettor_a = funded_keypair(&mut svm, 10_000_000_000);
    let position_a = open_position(&mut svm, &setup.market, &bettor_a, 100, Side::Home);
    settle_plan_b(&mut svm, &setup.market, 5006, &Side::Home);

    force_position_stake(&mut svm, &position_a, 0);

    let market_before = lamports(&svm, &setup.market);
    let bettor_before = lamports(&svm, &bettor_a.pubkey());

    claim(&mut svm, &relayer, &setup.market, &position_a, &bettor_a)
        .expect("0-lamport payout must succeed without panicking or underflowing");

    let market_after = lamports(&svm, &setup.market);
    let bettor_after = lamports(&svm, &bettor_a.pubkey());

    assert_eq!(
        bettor_after, bettor_before,
        "0-stake position must yield exactly 0 payout"
    );
    assert_eq!(
        market_after, market_before,
        "market PDA balance must be unchanged by a 0-lamport payout"
    );

    let pos = read_position(&svm, &position_a);
    assert!(
        pos.claimed,
        "claimed must still be set true even for a 0-lamport payout"
    );
}

// ── Additional test: rent-exemption guard rejected ──────────────────────────
// Not one of the PRD's 8 named required cases, but directly exercises the
// rent-exemption guard added in claim_payout's body (Implementation Decision
// #3). Conservation (proven in the fuzz test below) guarantees the market
// PDA's balance can never legitimately drop below its own rent-exempt
// minimum through real claims, so this guard is unreachable via normal flow
// — the same reason test_claim_payout_dust_stake_zero_payout_succeeds needs
// to force an account state directly. Here the market's lamport balance is
// forced down (deserialize -> mutate -> re-serialize the lamports field, data
// untouched) to a value that can cover the payout but would leave the market
// below rent-exemption, proving the guard fails closed instead of silently
// draining the vault or panicking.

#[test]
fn test_claim_payout_rent_exemption_guard_rejected() {
    let mut svm = svm();
    let setup = setup_market(&mut svm, 5009);
    let rent_baseline = lamports(&svm, &setup.market);
    let relayer = funded_keypair(&mut svm, 10_000_000_000);

    let bettor_a = funded_keypair(&mut svm, 10_000_000_000);
    let stake = 10u64;
    let position_a = open_position(&mut svm, &setup.market, &bettor_a, stake, Side::Home);
    settle_plan_b(&mut svm, &setup.market, 5009, &Side::Home);

    // Force the market PDA's lamport balance down to half its rent-exempt
    // baseline: comfortably enough to cover the (tiny) payout without
    // underflowing, but the post-payout remainder still lands below
    // rent_baseline, which is exactly the condition the guard must reject.
    let raw = svm.get_account(&setup.market).expect("market account");
    svm.set_account(
        setup.market,
        Account {
            lamports: rent_baseline / 2,
            data: raw.data.clone(),
            owner: raw.owner,
            executable: false,
            rent_epoch: raw.rent_epoch,
        },
    )
    .unwrap();

    let err = claim(&mut svm, &relayer, &setup.market, &position_a, &bettor_a)
        .expect_err("a claim that would drain the market below rent-exemption must be rejected");
    assert_eq!(
        err.err,
        custom_err(6011),
        "expected VaultBelowRentExemption (6011) from the rent-exemption guard"
    );
}

// ── Test 7: cross-market substitution rejected (has_one constraints) ───────
// A position legitimately opened under market A has its `market` field forged
// to point at market B's real pubkey (same technique as force_resolve-style
// helpers elsewhere in this suite: deserialize -> mutate -> re-serialize).
// The position's PDA address is unchanged (still derived under market A), so
// the seeds constraint on `position` still passes when market A is supplied
// — but `has_one = market` on the Accounts struct must catch the mismatch
// between the forged position.market (B) and the supplied market account (A).

#[test]
fn test_claim_payout_cross_market_substitution_rejected() {
    let mut svm = svm();
    let setup_a = setup_market(&mut svm, 5007);
    let setup_b = setup_market(&mut svm, 5008);
    let relayer = funded_keypair(&mut svm, 10_000_000_000);

    let bettor_a = funded_keypair(&mut svm, 10_000_000_000);
    let position_a = open_position(&mut svm, &setup_a.market, &bettor_a, 100_000, Side::Home);
    settle_plan_b(&mut svm, &setup_a.market, 5007, &Side::Home); // would otherwise be a legitimate winning claim

    force_position_market(&mut svm, &position_a, setup_b.market);

    let err = claim(&mut svm, &relayer, &setup_a.market, &position_a, &bettor_a)
        .expect_err("position substituted to a different market must be rejected");
    // Anchor's built-in ConstraintHasOne (anchor-lang-error 1.1.2) = 2001.
    assert_eq!(
        err.err,
        custom_err(2001),
        "expected ConstraintHasOne (2001)"
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 8: CONSERVATION FUZZ (the T1 verifier's non-negotiable property test)
// ═══════════════════════════════════════════════════════════════════════════
//
// Property-style test over adversarial stake sets, ported from pari-market's
// test_claim_payout_conservation_fuzz. Deterministic seeding (no wall-clock
// randomness) — every case is a hardcoded list, reproducible on every run.
// For each case: build the market, open all positions, settle, claim every
// eligible position in sequence, then assert:
//   (a) sum(all payouts) <= total_staked
//   (b) market PDA lamports == rent_baseline + total_staked - sum(payouts)
//       (no phantom lamports; rent_baseline offsets the market account's own
//       rent-exempt balance from init_market, which pari-market's SPL vault
//       does not carry since token accounts are a separate balance from SOL)
//   (c) every winner's payout >= their proportional floor computed
//       independently (redundant cross-check of the CONTRACT, not a
//       re-implementation the test blindly trusts)

struct FuzzStake {
    side: Side,
    amount: u64,
}

struct FuzzCase {
    name: &'static str,
    stakes: Vec<FuzzStake>,
    outcome: Side,
}

fn fuzz_cases() -> Vec<FuzzCase> {
    vec![
        FuzzCase {
            name: "1-unit stakes, many claimers",
            stakes: vec![
                FuzzStake {
                    side: Side::Home,
                    amount: 1,
                },
                FuzzStake {
                    side: Side::Home,
                    amount: 1,
                },
                FuzzStake {
                    side: Side::Away,
                    amount: 1,
                },
                FuzzStake {
                    side: Side::Away,
                    amount: 1,
                },
                FuzzStake {
                    side: Side::Home,
                    amount: 1,
                },
            ],
            outcome: Side::Home,
        },
        FuzzCase {
            name: "heavily lopsided: 1 vs a large Away pool",
            stakes: vec![
                FuzzStake {
                    side: Side::Home,
                    amount: 1,
                },
                FuzzStake {
                    side: Side::Away,
                    amount: 5_000_000_000,
                },
            ],
            outcome: Side::Home, // the 1-unit Home staker takes the whole pool
        },
        FuzzCase {
            name: "dust-generating: amounts that do not divide evenly, all 3 sides",
            stakes: vec![
                FuzzStake {
                    side: Side::Home,
                    amount: 7,
                },
                FuzzStake {
                    side: Side::Home,
                    amount: 11,
                },
                FuzzStake {
                    side: Side::Away,
                    amount: 13,
                },
                FuzzStake {
                    side: Side::Away,
                    amount: 17,
                },
                FuzzStake {
                    side: Side::Draw,
                    amount: 19,
                },
            ],
            outcome: Side::Home,
        },
        FuzzCase {
            name: "many claimers in sequence, mixed amounts, Draw wins",
            stakes: vec![
                FuzzStake {
                    side: Side::Home,
                    amount: 100_000,
                },
                FuzzStake {
                    side: Side::Home,
                    amount: 250_000,
                },
                FuzzStake {
                    side: Side::Away,
                    amount: 400_000,
                },
                FuzzStake {
                    side: Side::Away,
                    amount: 150_000,
                },
                FuzzStake {
                    side: Side::Draw,
                    amount: 333_333,
                },
                FuzzStake {
                    side: Side::Draw,
                    amount: 999_999,
                },
                FuzzStake {
                    side: Side::Draw,
                    amount: 1,
                },
            ],
            outcome: Side::Draw,
        },
        FuzzCase {
            name: "empty-winning-pool refund case (fuzz-covered)",
            stakes: vec![
                FuzzStake {
                    side: Side::Away,
                    amount: 50_000,
                },
                FuzzStake {
                    side: Side::Away,
                    amount: 75_000,
                },
                FuzzStake {
                    side: Side::Draw,
                    amount: 1,
                },
            ],
            outcome: Side::Home, // Home wins but home_pool == 0 -> everyone refunds
        },
    ]
}

#[test]
fn test_claim_payout_conservation_fuzz() {
    for (case_idx, case) in fuzz_cases().into_iter().enumerate() {
        let mut svm = svm();
        // Deterministic match_id per case: 6000 + case_idx (offset clear of
        // this file's other tests' match_ids 5001-5008).
        let match_id = 6000 + case_idx as u64;
        let setup = setup_market(&mut svm, match_id);
        let relayer = funded_keypair(&mut svm, 20_000_000_000_000);

        let rent_baseline = lamports(&svm, &setup.market);

        struct Staker {
            keypair: Keypair,
            position: Pubkey,
            amount: u64,
            side: Side,
        }

        let mut stakers: Vec<Staker> = Vec::new();
        let mut total_staked: u128 = 0;

        for (stake_idx, stake) in case.stakes.iter().enumerate() {
            let mut seed = [0u8; 32];
            seed[0] = case_idx as u8;
            seed[1] = stake_idx as u8;
            seed[2] = 0xAB; // distinguish from other fixed-seed keypairs in the suite
            let bettor = Keypair::new_from_array(seed);
            svm.airdrop(&bettor.pubkey(), 20_000_000_000_000).unwrap(); // enough for the lopsided case's large amount + rent

            let position = open_position(
                &mut svm,
                &setup.market,
                &bettor,
                stake.amount,
                stake.side.clone(),
            );
            total_staked += stake.amount as u128;

            stakers.push(Staker {
                keypair: bettor,
                position,
                amount: stake.amount,
                side: stake.side.clone(),
            });
        }

        settle_plan_b(&mut svm, &setup.market, match_id, &case.outcome);

        let market_before_claims = read_market(&svm, &setup.market);
        // Match on a reference: `case.outcome` is read again later in this loop
        // (per-staker `s.side == case.outcome`), and Side is not Copy.
        let winning_pool: u64 = match &case.outcome {
            Side::Home => market_before_claims.home_pool,
            Side::Away => market_before_claims.away_pool,
            Side::Draw => market_before_claims.draw_pool,
        };
        let total_pool: u64 = market_before_claims.home_pool
            + market_before_claims.away_pool
            + market_before_claims.draw_pool;

        let mut sum_payouts: u128 = 0;

        for s in &stakers {
            let is_winner_side = s.side == case.outcome;
            let eligible = is_winner_side || winning_pool == 0;
            if !eligible {
                let err = claim(&mut svm, &relayer, &setup.market, &s.position, &s.keypair)
                    .expect_err(&format!(
                        "[{}] losing position must be rejected, not silently paid",
                        case.name
                    ));
                assert_eq!(
                    err.err,
                    custom_err(6010),
                    "[{}] expected LosingPosition (6010)",
                    case.name
                );
                continue;
            }

            let before = lamports(&svm, &s.keypair.pubkey());
            claim(&mut svm, &relayer, &setup.market, &s.position, &s.keypair)
                .unwrap_or_else(|e| panic!("[{}] eligible claim failed: {e:?}", case.name));
            let after = lamports(&svm, &s.keypair.pubkey());
            let payout = after - before;

            let expected_floor: u128 = if winning_pool == 0 {
                s.amount as u128 // refund case: exact stake back
            } else {
                (s.amount as u128 * total_pool as u128) / (winning_pool as u128)
            };
            assert_eq!(
                payout as u128, expected_floor,
                "[{}] payout must equal the exact floor-divided share (no over/under-payment) for stake amount {}",
                case.name, s.amount
            );

            sum_payouts += payout as u128;
        }

        // (a) conservation: never pay out more than was staked.
        assert!(
            sum_payouts <= total_staked,
            "[{}] CONSERVATION VIOLATION: sum_payouts {} > total_staked {}",
            case.name,
            sum_payouts,
            total_staked
        );

        // (b) no phantom lamports: market balance must equal exactly what's left
        // (rent_baseline offsets the market account's own rent-exempt balance,
        // which is not part of staked funds).
        let market_balance = lamports(&svm, &setup.market) as u128;
        assert_eq!(
            market_balance,
            rent_baseline as u128 + total_staked - sum_payouts,
            "[{}] market balance {} != rent_baseline {} + total_staked {} - sum_payouts {} (phantom lamports or a leak)",
            case.name, market_balance, rent_baseline, total_staked, sum_payouts
        );
    }
}
