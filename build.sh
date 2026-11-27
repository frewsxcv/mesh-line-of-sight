#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
PATH="$(dirname "$(rustup which --toolchain stable rustc)"):$PATH" cargo build --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/los.wasm web/los.wasm
ls -lh web/los.wasm
