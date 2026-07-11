//! Shared test scaffolding for worldcup-settlement's integration tests
//! (tests/claim_payout.rs, tests/settlement.rs). Extracted per the ponytail
//! comment that lived in settlement.rs ("extract only if tests multiply past
//! 10+") -- combined test count crossed 16 once claim_payout.rs landed.
//! Mirrors worldcup-pari-market's `tests/common/mod.rs` pattern (a shared
//! `mod common;` test-support module included by each integration test file).
use litesvm::LiteSVM;
use solana_clock::Clock;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use solana_transaction::Transaction;

pub const SYSTEM_PROGRAM_ID: Pubkey = Pubkey::from_str_const("11111111111111111111111111111111");

// ── Test oracle keypair (test-oracle feature, baked in by build.rs) ────────
// Ed25519 secret = [1u8; 32] → pubkey AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9
// Must match PLAN_B_ORACLE_AUTHORITY in constants.rs when compiled with `test-oracle`.
pub const TEST_ORACLE_SECRET: [u8; 32] = [1u8; 32];

/// A lock_ts far enough in the future (year 2286) that open_position always
/// succeeds without needing a clock warp, for tests that exercise unrelated
/// behavior and don't care about the betting-lock feature (T1c) itself.
///
/// Each `tests/*.rs` file compiles as its own crate and includes this module
/// separately; `settlement.rs` uses this constant but `claim_payout.rs` does
/// not, so the claim_payout crate compilation flags it as dead code. #[allow]
/// is correct here (used-elsewhere-in-workspace, not unused-in-truth).
#[allow(dead_code)]
pub const FAR_FUTURE_LOCK_TS: u64 = 9_999_999_999;

pub fn oracle_keypair() -> Keypair {
    Keypair::new_from_array(TEST_ORACLE_SECRET)
}

pub fn program_id() -> Pubkey {
    worldcup_settlement::ID
}

pub fn market_pda(match_id: u64) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[
            worldcup_settlement::constants::MARKET_SEED,
            &match_id.to_le_bytes(),
        ],
        &program_id(),
    )
}

pub fn position_pda(market: &Pubkey, bettor: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[b"position", market.as_ref(), bettor.as_ref()],
        &program_id(),
    )
}

/// Build an SVM with the program loaded. The .so is produced by build.rs
/// (cargo-build-sbf --features test-oracle) ahead of every `cargo test`.
pub fn svm() -> LiteSVM {
    let mut svm = LiteSVM::new();
    // CARGO_MANIFEST_DIR = programs/worldcup-settlement/; workspace root is two levels up.
    let manifest_dir = std::env!("CARGO_MANIFEST_DIR");
    let so = format!("{manifest_dir}/../../target/deploy/worldcup_settlement.so");
    svm.add_program_from_file(program_id(), &so)
        .unwrap_or_else(|e| panic!("failed to load {so}: {e}"));
    svm
}

/// Warps litesvm's Clock sysvar to `unix_timestamp`, for exercising the
/// betting-lock boundary (T1c: open_position rejects at/after market.lock_ts,
/// settle_from_proof rejects before it). Mirrors worldcup-pari-market's
/// `set_clock_timestamp` test helper (tests/pari_market.rs).
pub fn set_clock_timestamp(svm: &mut LiteSVM, unix_timestamp: i64) {
    let mut clock = svm.get_sysvar::<Clock>();
    clock.unix_timestamp = unix_timestamp;
    svm.set_sysvar::<Clock>(&clock);
}

pub fn send(
    svm: &mut LiteSVM,
    payer: &Keypair,
    signers: &[&Keypair],
    instruction: Instruction,
) -> litesvm::types::TransactionResult {
    let bh = svm.latest_blockhash();
    let msg = Message::new(&[instruction], Some(&payer.pubkey()));
    let tx = Transaction::new(signers, msg, bh);
    svm.send_transaction(tx)
}
