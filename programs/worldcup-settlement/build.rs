// build.rs — rebuilds the BPF .so with `test-oracle` feature baked in.
//
// Why this exists: integration tests (tests/settlement.rs) use litesvm to load
// a pre-compiled .so from target/deploy/. The Plan-B authority check inside
// that .so must match TEST_ORACLE_SECRET (ed25519 [1u8;32], pubkey AKnL4NNf…).
// That pubkey is only compiled in when the `test-oracle` feature is active.
//
// Guard: when cargo-build-sbf compiles this crate for the SBF target it ALSO
// runs build.rs. Without a guard that creates infinite recursion. We detect the
// SBF target via the TARGET env var and skip the sbf rebuild in that context.
//
// Devnet note: the deployed program at FFnQCXKL… was produced by `anchor build`
// (WITHOUT test-oracle), so its PLAN_B_ORACLE_AUTHORITY remains the real devnet
// burner key (8gbaJEfM…). This build.rs only affects the test .so — no redeploy
// is needed or implied.
//
// ponytail: unconditional rebuild on any src change; add a content-hash cache
// if build times become painful.

use std::process::Command;

fn main() {
    // Re-run only when source or Cargo.toml change.
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rerun-if-changed=Cargo.toml");

    // Guard: when cargo-build-sbf compiles us for the SBF/BPF target it also
    // runs this build.rs. Skip the sbf rebuild in that context to avoid
    // infinite recursion.
    let target = std::env::var("TARGET").unwrap_or_default();
    if target.contains("sbpf") || target.contains("bpf") || target.contains("solana") {
        // Running inside the SBF compilation — nothing to do.
        return;
    }

    // Locate cargo-build-sbf.
    let sbf = which_cargo_build_sbf();

    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR")
        .expect("CARGO_MANIFEST_DIR must be set by Cargo");

    let status = Command::new(&sbf)
        .args(["--features", "test-oracle"])
        .current_dir(&manifest_dir)
        .status()
        .unwrap_or_else(|e| panic!("failed to run {sbf}: {e}"));

    if !status.success() {
        panic!("cargo-build-sbf --features test-oracle failed (exit {:?})", status.code());
    }
}

/// Returns the path to cargo-build-sbf, checking common locations.
fn which_cargo_build_sbf() -> String {
    let candidates = [
        "cargo-build-sbf".to_string(),
        format!(
            "{}/.local/share/solana/install/active_release/bin/cargo-build-sbf",
            std::env::var("HOME").unwrap_or_default()
        ),
    ];

    for candidate in &candidates {
        if Command::new(candidate).arg("--version").output().is_ok() {
            return candidate.clone();
        }
    }

    panic!(
        "cargo-build-sbf not found. Install the Solana toolchain: \
         https://docs.solana.com/cli/install-solana-cli-tools"
    );
}
