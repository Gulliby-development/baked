#!/usr/bin/env bash
set -euo pipefail

# baked Bundle Script
# Creates a self-contained distributable with all native dependencies.
# Usage: ./scripts/bundle.sh [arch] [platform]
#   arch:     arm64 (default), x64, or x64-baseline (no AVX — for older CPUs)
#   platform: darwin (default) or linux

ARCH="${1:-arm64}"
PLATFORM="${2:-darwin}"

# x64-baseline: same native deps as x64, but Bun binary targets SSE2-only (no AVX).
# Needed for pre-Sandy Bridge CPUs (Westmere, Nehalem, Core 2, etc.).
BASE_ARCH="${ARCH}"
[[ "$ARCH" == "x64-baseline" ]] && BASE_ARCH="x64"

VERSION="$(bun -e "console.log(require('./package.json').version)")"
BUNDLE_NAME="baked-${VERSION}-${PLATFORM}-${ARCH}"
STAGE_DIR="dist/bundle/${BUNDLE_NAME}"
DEPS_DIR="${STAGE_DIR}/deps"

RG_VERSION="14.1.1"
FD_VERSION="10.2.0"
# runtime via `baked addon install <name>`.

# ── Platform / arch matrix ──
if [[ "$PLATFORM" == "darwin" ]]; then
  if [[ "$ARCH" == "arm64" ]]; then
    RG_TRIPLET="aarch64-apple-darwin"
    FD_TRIPLET="aarch64-apple-darwin"
    BUN_TARGET="bun-darwin-aarch64"
  elif [[ "$ARCH" == "x64" ]]; then
    RG_TRIPLET="x86_64-apple-darwin"
    FD_TRIPLET="x86_64-apple-darwin"
    BUN_TARGET="bun-darwin-x64"
  else
    echo "Unknown arch: ${ARCH} (use arm64 or x64)"
    exit 1
  fi
elif [[ "$PLATFORM" == "linux" ]]; then
  if [[ "$ARCH" == "arm64" ]]; then
    RG_TRIPLET="aarch64-unknown-linux-gnu"
    FD_TRIPLET="aarch64-unknown-linux-gnu"
    BUN_TARGET="bun-linux-aarch64"
  elif [[ "$BASE_ARCH" == "x64" ]]; then
    RG_TRIPLET="x86_64-unknown-linux-musl"
    FD_TRIPLET="x86_64-unknown-linux-musl"
    if [[ "$ARCH" == "x64-baseline" ]]; then
        BUN_TARGET="bun-linux-x64-baseline"
    else
        BUN_TARGET="bun-linux-x64"
    fi
    else
    echo "Unknown arch: ${ARCH} (use arm64, x64, or x64-baseline)"
    exit 1
  fi
else
  echo "Unknown platform: ${PLATFORM} (use darwin or linux)"
  exit 1
fi

echo "==> Bundling baked ${VERSION} for ${PLATFORM}/${ARCH}"

rm -rf "${STAGE_DIR}"
mkdir -p "${DEPS_DIR}"

# ── 1. Compile baked ──
echo "==> Compiling binary..."
bun scripts/build.ts --compile --outfile="${STAGE_DIR}/baked" --target="${BUN_TARGET}"
echo "    ✓ baked binary"

# ── 2. Download native dependencies ──
download() {
  local url="$1" dest="$2" label="$3"
  if [[ -f "$dest" ]]; then
    echo "    ✓ ${label} (cached)"
    return
  fi
  echo "    ↓ ${label}..."
  curl -fSL --retry 3 "$url" -o "$dest"
}

CACHE_DIR="dist/bundle/.cache"
mkdir -p "$CACHE_DIR"


# ripgrep
RG_ASSET="ripgrep-${RG_VERSION}-${RG_TRIPLET}.tar.gz"
RG_URL="https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/${RG_ASSET}"
download "$RG_URL" "${CACHE_DIR}/rg-${PLATFORM}-${BASE_ARCH}.tar.gz" "ripgrep ${RG_VERSION}"
mkdir -p "${DEPS_DIR}/rg-tmp"
tar xzf "${CACHE_DIR}/rg-${PLATFORM}-${BASE_ARCH}.tar.gz" -C "${DEPS_DIR}/rg-tmp" --strip-components=1
cp "${DEPS_DIR}/rg-tmp/rg" "${DEPS_DIR}/rg"
rm -rf "${DEPS_DIR}/rg-tmp"

# fd
FD_ASSET="fd-v${FD_VERSION}-${FD_TRIPLET}.tar.gz"
FD_URL="https://github.com/sharkdp/fd/releases/download/v${FD_VERSION}/${FD_ASSET}"
download "$FD_URL" "${CACHE_DIR}/fd-${PLATFORM}-${BASE_ARCH}.tar.gz" "fd ${FD_VERSION}"
mkdir -p "${DEPS_DIR}/fd-tmp"
tar xzf "${CACHE_DIR}/fd-${PLATFORM}-${BASE_ARCH}.tar.gz" -C "${DEPS_DIR}/fd-tmp" --strip-components=1
cp "${DEPS_DIR}/fd-tmp/fd" "${DEPS_DIR}/fd"
rm -rf "${DEPS_DIR}/fd-tmp"



chmod +x "${DEPS_DIR}/rg" "${DEPS_DIR}/fd"

# Native addons — can't be embedded in compiled binaries
echo "    Bundling native addons..."
NATIVE_DIR="${DEPS_DIR}/native/${PLATFORM}-${BASE_ARCH}"
mkdir -p "${NATIVE_DIR}"
if [[ "$PLATFORM" == "darwin" ]]; then
  NATIVE_PLATFORM="darwin"
else
  NATIVE_PLATFORM="linux"
fi
# OpenTUI native lib. `bun install` only installs the host's platform
# package, so a cross-bundle (darwin on Linux, arm64 on x64) fetches the
# matching tarball from the npm registry into the download cache.
if [[ "$PLATFORM" == "darwin" ]]; then
  OPENTUI_LIB_NAME="libopentui.dylib"
else
  OPENTUI_LIB_NAME="libopentui.so"
fi
OPENTUI_PKG="core-${NATIVE_PLATFORM}-${BASE_ARCH}"
OPENTUI_LIB="node_modules/@opentui/${OPENTUI_PKG}/${OPENTUI_LIB_NAME}"
if [[ ! -f "$OPENTUI_LIB" ]]; then
  OPENTUI_VERSION="$(bun -e "console.log(require('./node_modules/@opentui/core/package.json').version)")"
  OPENTUI_TGZ="${CACHE_DIR}/opentui-${OPENTUI_PKG}-${OPENTUI_VERSION}.tgz"
  download "https://registry.npmjs.org/@opentui/${OPENTUI_PKG}/-/${OPENTUI_PKG}-${OPENTUI_VERSION}.tgz" \
    "$OPENTUI_TGZ" "@opentui/${OPENTUI_PKG} ${OPENTUI_VERSION}"
  OPENTUI_TMP="${CACHE_DIR}/opentui-${OPENTUI_PKG}-${OPENTUI_VERSION}"
  rm -rf "$OPENTUI_TMP"
  mkdir -p "$OPENTUI_TMP"
  tar xzf "$OPENTUI_TGZ" -C "$OPENTUI_TMP" --strip-components=1
  OPENTUI_LIB="${OPENTUI_TMP}/${OPENTUI_LIB_NAME}"
fi
if [[ -f "$OPENTUI_LIB" ]]; then
  cp "$OPENTUI_LIB" "${NATIVE_DIR}/"
  echo "    ✓ $(basename "$OPENTUI_LIB")"
else
  echo "    ✘ OpenTUI native lib not found: ${OPENTUI_LIB}"
  exit 1
fi

# Worker scripts — pre-bundled for compiled binary.
# Use --outdir + --entry-naming because Bun may emit multiple chunks for
# the intelligence worker (code-splitting via dynamic imports of ts-morph,
# tree-sitter, etc.). --outfile only accepts a single output file.
#
# --external is scoped to binary assets only (.node, .wasm, .scm). The TUI
# packages (@opentui/core, tree-sitter-wasms) used to be
# externalised too as a workaround for 2.18.x where io.worker.ts pulled the
# entire TUI tree via summarize.ts → provider-options.ts → src/index.tsx;
# leftover require("@opentui/core") calls then crashed at worker startup with
# "Worker has been terminated". The proper fix lives in the source — worker
# handlers now import from leaf modules only (convo-text.ts, model-id.ts).
# scripts/build.ts enforces this with a leak canary on the dist/ workers.
# Tree-sitter wasm grammars are still resolved at runtime from ~/.baked/wasm.
echo "    Bundling worker scripts..."
mkdir -p "${DEPS_DIR}/workers"
WORKER_EXTERNALS=(
  --external "*.node"
  --external "*.wasm"
  --external "*.scm"
)
bun build src/core/workers/intelligence.worker.ts \
  --outdir "${DEPS_DIR}/workers" \
  --entry-naming "[name].[ext]" \
  --target=bun \
  "${WORKER_EXTERNALS[@]}"
bun build src/core/workers/io.worker.ts \
  --outdir "${DEPS_DIR}/workers" \
  --entry-naming "[name].[ext]" \
  --target=bun \
  "${WORKER_EXTERNALS[@]}"
bun build src/core/workers/workflow.worker.ts \
  --outdir "${DEPS_DIR}/workers" \
  --entry-naming "[name].[ext]" \
  --target=bun \
  "${WORKER_EXTERNALS[@]}"

# Worker bundle leak canary — mirrors scripts/build.ts. The io worker must
# stay TUI-free. The intelligence worker may use shiki/tree-sitter but never
# the TUI. Failure here means a handler import chain re-poisoned the bundle
# (see src/core/llm/model-id.ts + src/core/compaction/convo-text.ts).
echo "    Verifying worker bundles are TUI-free..."
LEAKS=""
for needle in "src/index.tsx" "@opentui/core" "src/components/" "react/cjs/react.development"; do
  if grep -q "$needle" "${DEPS_DIR}/workers/io.worker.js"; then
    LEAKS="${LEAKS} io.worker.js→${needle}"
  fi
done
for needle in "src/index.tsx" "@opentui/core" "src/components/"; do
  if grep -q "$needle" "${DEPS_DIR}/workers/intelligence.worker.js"; then
    LEAKS="${LEAKS} intelligence.worker.js→${needle}"
  fi
done
if [[ -n "$LEAKS" ]]; then
  echo "✗ worker bundle TUI leak detected:${LEAKS}" >&2
  echo "  worker handlers must only import leaf modules — see scripts/build.ts canary." >&2
  exit 1
fi

# Tree-sitter WASM runtime + grammars + OpenTUI syntax assets
echo "    Bundling tree-sitter assets..."
mkdir -p "${DEPS_DIR}/wasm"
# tree-sitter.wasm is web-tree-sitter 0.25.10, which OpenTUI's syntax highlighting pins;
# web-tree-sitter.wasm is 0.27 (the web-tree-sitter-engine alias) for the code intelligence backend.
cp node_modules/web-tree-sitter/tree-sitter.wasm "${DEPS_DIR}/wasm/"
cp node_modules/web-tree-sitter-engine/web-tree-sitter.wasm "${DEPS_DIR}/wasm/"
cp node_modules/tree-sitter-wasms/out/*.wasm "${DEPS_DIR}/wasm/"
cp -r node_modules/@opentui/core/assets "${DEPS_DIR}/opentui-assets"
# Pre-bundle the worker with all deps (web-tree-sitter) into a single file
bun build node_modules/@opentui/core/parser.worker.js --outdir "${DEPS_DIR}/opentui-assets" --target=bun --asset-naming="[name].[ext]"
# No post-build patching: since OpenTUI 0.5 the main thread resolves
# tree-sitter.wasm and passes its path to the worker in the INIT message, and
# the worker is plain ESM where Bun provides `require`. The 0.4.x patches that
# rewrote require() to __require() now crash the worker (no __require shim).
if grep -q '__require(' "${DEPS_DIR}/opentui-assets/parser.worker.js" \
  && ! grep -q '__require =' "${DEPS_DIR}/opentui-assets/parser.worker.js"; then
  echo "    ✘ parser.worker.js calls __require() without defining it"
  exit 1
fi


# ── 3. Create install script ──
cat > "${STAGE_DIR}/install.sh" << 'INSTALL_EOF'
#!/usr/bin/env bash
# Re-exec under bash if invoked via sh/dash (dash lacks pipefail)
if [ -z "${BASH_VERSION:-}" ]; then
  exec bash "$0" "$@"
fi
set -euo pipefail

BAKED_DIR="${HOME}/.baked"
BIN_DIR="${BAKED_DIR}/bin"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
QUIET="${BAKED_QUIET:-}"

# --quiet flag for non-interactive installs (Homebrew, CI)
for arg in "$@"; do
  [[ "$arg" == "--quiet" ]] && QUIET=1
done

P='\033[38;2;155;48;255m'
R='\033[38;2;255;0;64m'
D='\033[2m'
M='\033[38;2;85;85;85m'
G='\033[38;2;74;167;74m'
W='\033[38;2;170;170;170m'
Y='\033[38;2;230;180;60m'
B='\033[1m'
RST='\033[0m'
SPINNER=("⠋" "⠙" "⠹" "⠸" "⠼" "⠴" "⠦" "⠧" "⠇" "⠏")

spin() {
  local msg="$1" pid="$2" i=0
  if [[ -n "$QUIET" ]]; then
    wait "$pid" 2>/dev/null
    echo "  ✓ $msg"
    return
  fi
  while kill -0 "$pid" 2>/dev/null; do
    printf "\r  ${P}${SPINNER[$((i % 10))]}${RST} ${M}%s${RST}  " "$msg"
    i=$((i + 1))
    sleep 0.08
  done
  wait "$pid" 2>/dev/null
  printf "\r  ${G}✓${RST} ${W}%s${RST}  \n" "$msg"
}

step() {
  if [[ -n "$QUIET" ]]; then echo "  ✓ $1"; else printf "  ${G}✓${RST} ${W}%s${RST}\n" "$1"; fi
}
dim() {
  if [[ -n "$QUIET" ]]; then echo "  $1"; else printf "  ${M}%s${RST}\n" "$1"; fi
}

if [[ -z "$QUIET" ]]; then
  clear
  printf "\033[?25l"
  sleep 0.1

  printf "\n"
  printf "  ${P}${B}░${RST}\n"
  sleep 0.04
  printf "\033[1A\r  ${P}${B}▒${RST}\n"
  sleep 0.04
  printf "\033[1A\r  ${P}${B}▓${RST}\n"
  sleep 0.04
  printf "\033[1A\r  ${P}${B}◆${RST}\n"
  sleep 0.08

  printf "  ${D}${P}~∿~${RST}\n"

  WORDMARK_1="┌─┐┌─┐┬ ┬┬  ┌─┐┌─┐┬─┐┌─┐┌─┐"
  WORDMARK_2="└─┐│ ││ ││  ├┤ │ │├┬┘│ ┬├┤ "
  WORDMARK_3="└─┘└─┘└─┘┴─┘└  └─┘┴└─└─┘└─┘"

  GLITCH="░▒▓█▄▀▐▌┤├┼─│┌┐└┘"
  garble() {
    local text="$1" out="" i ch
    for ((i=0; i<${#text}; i++)); do
      ch="${text:$i:1}"
      if [[ "$ch" == " " ]]; then out+=" "; else out+="${GLITCH:$((RANDOM % ${#GLITCH})):1}"; fi
    done
    printf "%s" "$out"
  }

  printf "\n"
  printf "  ${M}$(garble "$WORDMARK_1")${RST}\n"
  sleep 0.02
  printf "\033[1A\r  ${P}${B}${WORDMARK_1}${RST}\n"
  printf "  ${M}$(garble "$WORDMARK_2")${RST}\n"
  sleep 0.02
  printf "\033[1A\r  ${P}${B}${WORDMARK_2}${RST}\n"
  printf "  ${M}$(garble "$WORDMARK_3")${RST}\n"
  sleep 0.02
  printf "\033[1A\r  ${P}${B}${WORDMARK_3}${RST}\n"

  printf "\n"
  printf "  ${M}── ${D}Graph-Powered Code Intelligence${RST}${M} ──${RST}\n"

  printf "\n\n"
  printf "  ${M}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RST}\n"
  printf "  ${P}${B}INSTALLING${RST}  ${M}→ ~/.baked/${RST}\n"
  printf "  ${M}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RST}\n"
  printf "\n"
else
  echo "Installing baked to ~/.baked/ ..."
fi

# Clean previous install (preserve config + sessions)
if [[ -d "$BAKED_DIR" ]]; then
  rm -rf "${BAKED_DIR}/bin" "${BAKED_DIR}/installs" "${BAKED_DIR}/wasm" "${BAKED_DIR}/workers" "${BAKED_DIR}/native" "${BAKED_DIR}/opentui-assets" 2>/dev/null
  dim "Cleaned previous install (config & sessions preserved)"
fi

mkdir -p "$BIN_DIR"

if [[ -n "$QUIET" ]]; then
  # Synchronous install — no background jobs (Homebrew kills orphaned bg processes)
  cp "${SCRIPT_DIR}/baked" "${BIN_DIR}/baked" && chmod +x "${BIN_DIR}/baked" && ln -sf "${BIN_DIR}/baked" "${BIN_DIR}/sf"
  step "Building the bake binary"

  for bin in rg fd; do
    cp "${SCRIPT_DIR}/deps/${bin}" "${BIN_DIR}/${bin}"
    chmod +x "${BIN_DIR}/${bin}"
  done
  step "Sharpening the search blades"

  mkdir -p "${BAKED_DIR}/wasm" "${BAKED_DIR}/workers"
  cp "${SCRIPT_DIR}/deps/wasm/"*.wasm "${BAKED_DIR}/wasm/"
  cp "${SCRIPT_DIR}/deps/workers/"*.js "${BAKED_DIR}/workers/"
  if [[ -d "${SCRIPT_DIR}/deps/native" ]]; then
    cp -r "${SCRIPT_DIR}/deps/native" "${BAKED_DIR}/native"
  fi
  rm -rf "${BAKED_DIR}/opentui-assets"
  cp -r "${SCRIPT_DIR}/deps/opentui-assets" "${BAKED_DIR}/opentui-assets"
  step "Inscribing the tree-sitter runes"


  if [[ "$(uname)" == "Darwin" ]]; then
    xattr -cr "${BAKED_DIR}" 2>/dev/null || true
    step "Warding off Gatekeeper curses"
  fi
else
  # Interactive install — background jobs with spinners
  (cp "${SCRIPT_DIR}/baked" "${BIN_DIR}/baked" && chmod +x "${BIN_DIR}/baked" && ln -sf "${BIN_DIR}/baked" "${BIN_DIR}/sf") &
  spin "Building the bake binary" $!

  (for bin in rg fd; do
    cp "${SCRIPT_DIR}/deps/${bin}" "${BIN_DIR}/${bin}"
    chmod +x "${BIN_DIR}/${bin}"
  done) &
  spin "Sharpening the search blades" $!

  (mkdir -p "${BAKED_DIR}/wasm" "${BAKED_DIR}/workers"
  cp "${SCRIPT_DIR}/deps/wasm/"*.wasm "${BAKED_DIR}/wasm/"
  cp "${SCRIPT_DIR}/deps/workers/"*.js "${BAKED_DIR}/workers/"
  if [[ -d "${SCRIPT_DIR}/deps/native" ]]; then
    cp -r "${SCRIPT_DIR}/deps/native" "${BAKED_DIR}/native"
  fi
  rm -rf "${BAKED_DIR}/opentui-assets"
  cp -r "${SCRIPT_DIR}/deps/opentui-assets" "${BAKED_DIR}/opentui-assets"
) &
  spin "Inscribing the tree-sitter runes" $!


  if [[ "$(uname)" == "Darwin" ]]; then
    (xattr -cr "${BAKED_DIR}" 2>/dev/null || true) &
    spin "Warding off Gatekeeper curses" $!
  fi
fi

# ── Verify critical runtime artifacts (issue #66) ────────────────────
# Detect platform-arch for native lib triplet (matches process.platform/arch in JS).
case "$(uname -s)" in
  Darwin) NATIVE_PLATFORM="darwin"; LIB_EXT="dylib" ;;
  Linux)  NATIVE_PLATFORM="linux";  LIB_EXT="so"    ;;
  *)      NATIVE_PLATFORM="$(uname -s | tr '[:upper:]' '[:lower:]')"; LIB_EXT="so" ;;
esac
case "$(uname -m)" in
  x86_64|amd64) NATIVE_ARCH="x64" ;;
  aarch64|arm64) NATIVE_ARCH="arm64" ;;
  *)             NATIVE_ARCH="$(uname -m)" ;;
esac
NATIVE_TRIPLET="${NATIVE_PLATFORM}-${NATIVE_ARCH}"
NATIVE_LIB="${BAKED_DIR}/native/${NATIVE_TRIPLET}/libopentui.${LIB_EXT}"

REQUIRED_FILES=(
  "${BIN_DIR}/baked"
  "${BAKED_DIR}/wasm/tree-sitter.wasm"
  "${BAKED_DIR}/wasm/web-tree-sitter.wasm"

  "${NATIVE_LIB}"
)
MISSING=()
for f in "${REQUIRED_FILES[@]}"; do
  [[ -f "$f" ]] || MISSING+=("$f")
done
if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo "" >&2
  echo "ERROR: baked install incomplete — missing files:" >&2
  for f in "${MISSING[@]}"; do echo "  - $f" >&2; done
  echo "" >&2
  echo "  source: ${SCRIPT_DIR}" >&2
  echo "  triplet: ${NATIVE_TRIPLET}" >&2
  if [[ ! -d "${SCRIPT_DIR}/deps/native/${NATIVE_TRIPLET}" ]]; then
    echo "  cause: bundled tarball does not contain native libs for ${NATIVE_TRIPLET}" >&2
    echo "         this build was packaged for a different platform." >&2
  else
    echo "  cause: copy from ${SCRIPT_DIR}/deps/ failed (permissions / disk full / sandbox)" >&2
  fi
  echo "" >&2
  echo "  fix: re-download the matching release tarball from" >&2
  echo "       https://github.com/Gulliby-development/baked/releases" >&2
  echo "       or run: brew reinstall baked" >&2
  echo "" >&2
  exit 1
fi
step "Verified runtime artifacts"

# Skip shell RC modification in quiet mode (Homebrew manages PATH via symlinks)
if [[ -z "$QUIET" ]]; then
  # Detect shell RC file based on user's actual shell
  SHELL_RC=""
  USER_SHELL="$(basename "${SHELL:-/bin/bash}")"
  case "$USER_SHELL" in
    zsh)  SHELL_RC="${HOME}/.zshrc" ;;
    bash)
      # macOS uses .bash_profile for login shells, Linux uses .bashrc
      if [[ -f "${HOME}/.bashrc" ]]; then
        SHELL_RC="${HOME}/.bashrc"
      elif [[ -f "${HOME}/.bash_profile" ]]; then
        SHELL_RC="${HOME}/.bash_profile"
      else
        SHELL_RC="${HOME}/.bashrc"
      fi
      ;;
    fish) SHELL_RC="${HOME}/.config/fish/config.fish" ;;
    ksh)  SHELL_RC="${HOME}/.kshrc" ;;
    *)
      # Fallback: check common files
      for rc in "${HOME}/.zshrc" "${HOME}/.bashrc" "${HOME}/.bash_profile" "${HOME}/.profile"; do
        if [[ -f "$rc" ]]; then SHELL_RC="$rc"; break; fi
      done
      ;;
  esac

  if [[ -n "$SHELL_RC" ]]; then
    if ! grep -q '.baked/bin' "$SHELL_RC" 2>/dev/null; then
      mkdir -p "$(dirname "$SHELL_RC")"
      echo '' >> "$SHELL_RC"
      echo '# baked' >> "$SHELL_RC"
      if [[ "$USER_SHELL" == "fish" ]]; then
        echo 'set -gx PATH $HOME/.baked/bin $PATH' >> "$SHELL_RC"
      else
        echo 'export PATH="$HOME/.baked/bin:$PATH"' >> "$SHELL_RC"
      fi
      step "Added to PATH in $(basename "$SHELL_RC")"
    else
      step "PATH already configured"
    fi
  else
    dim "Could not detect shell config — add ~/.baked/bin to your PATH manually"
  fi

  printf "\n"
  printf "  ${M}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RST}\n"
  printf "  ${G}${B}◆ INSTALLED${RST}\n"
  printf "  ${M}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RST}\n"
  printf "\n"
  printf "  ${W}Commands:${RST}  ${P}baked${RST}  ${M}or${RST}  ${P}sf${RST}\n"
  printf "  ${W}Location:${RST}  ${M}~/.baked/bin/${RST}\n"
  printf "\n"
  printf "\n"
  printf "  ${Y}→${RST} ${W}Run${RST} ${P}source ${SHELL_RC:-~/.zshrc}${RST} ${W}then${RST} ${P}baked${RST}\n"
  printf "\n"
  printf "\033[?25h"
else
  echo "Done. baked installed to ~/.baked/"
fi
INSTALL_EOF
chmod +x "${STAGE_DIR}/install.sh"

# ── 4. Create uninstall script ──
cat > "${STAGE_DIR}/uninstall.sh" << 'UNINSTALL_EOF'
#!/usr/bin/env bash
# Re-exec under bash if invoked via sh/dash (dash lacks pipefail)
if [ -z "${BASH_VERSION:-}" ]; then
  exec bash "$0" "$@"
fi
set -euo pipefail

BAKED_DIR="${HOME}/.baked"

P='\033[38;2;155;48;255m'
R='\033[38;2;255;0;64m'
D='\033[2m'
M='\033[38;2;85;85;85m'
G='\033[38;2;74;167;74m'
W='\033[38;2;170;170;170m'
B='\033[1m'
RST='\033[0m'
SPINNER=("⠋" "⠙" "⠹" "⠸" "⠼" "⠴" "⠦" "⠧" "⠇" "⠏")

spin() {
  local msg="$1" pid="$2" i=0
  while kill -0 "$pid" 2>/dev/null; do
    printf "\r  ${R}${SPINNER[$((i % 10))]}${RST} ${M}%s${RST}  " "$msg"
    i=$((i + 1))
    sleep 0.08
  done
  wait "$pid" 2>/dev/null
  printf "\r  ${G}✓${RST} ${W}%s${RST}  \n" "$msg"
}

clear
printf "\033[?25l"
printf "\n"
printf "  ${P}${B}◆${RST}\n"
printf "  ${D}${P}∿·∿${RST}\n"
printf "\n"
printf "  ${M}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RST}\n"
printf "  ${R}${B}UNINSTALLING${RST}  ${M}← ~/.baked/${RST}\n"
printf "  ${M}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RST}\n"
printf "\n"

if [[ -d "$BAKED_DIR" ]]; then
  (rm -rf "${BAKED_DIR}/bin") &
  spin "Cooling the oven" $!

  (rm -rf "${BAKED_DIR}/installs") &
  spin "Removing tool installs" $!

  (rm -rf "${BAKED_DIR}/wasm" "${BAKED_DIR}/workers" "${BAKED_DIR}/native" "${BAKED_DIR}/opentui-assets") &
  spin "Dissolving the runes" $!

  (rm -rf "${BAKED_DIR}/sessions" "${BAKED_DIR}/memories") &
  spin "Erasing the memories" $!

  (rm -f "${BAKED_DIR}/config.json"
  rmdir "$BAKED_DIR" 2>/dev/null || rm -rf "$BAKED_DIR") &
  spin "Scattering the ashes" $!

  (rm -rf "${HOME}/.local/share/baked" "${HOME}/.local/state/baked" "${HOME}/.cache/baked" "${HOME}/.config/baked") &
  spin "Purging the spirit realm" $!
else
  printf "  ${M}Nothing to remove at ${BAKED_DIR}${RST}\n"
fi

for rc in "${HOME}/.zshrc" "${HOME}/.bashrc" "${HOME}/.bash_profile" "${HOME}/.profile" "${HOME}/.kshrc" "${HOME}/.config/fish/config.fish"; do
  if [[ -f "$rc" ]] && grep -q '.baked/bin' "$rc" 2>/dev/null; then
    sed -i.bak '/# baked/d' "$rc"
    sed -i.bak '/\.baked\/bin/d' "$rc"
    rm -f "${rc}.bak"
    printf "  ${G}✓${RST} ${W}Removed PATH from $(basename "$rc")${RST}\n"
  fi
done

printf "\n"
printf "  ${M}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RST}\n"
printf "  ${R}${B}◆ UNINSTALLED${RST}\n"
printf "  ${M}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RST}\n"
printf "\n"
printf "  ${W}Restart your terminal or run:${RST}\n"
printf "    ${P}source ~/.zshrc${RST}\n"
printf "\n"
printf "\033[?25h"
UNINSTALL_EOF
chmod +x "${STAGE_DIR}/uninstall.sh"

# ── 5. Create tarball ──
echo "==> Creating tarball..."
cd dist/bundle
tar czf "${BUNDLE_NAME}.tar.gz" "${BUNDLE_NAME}/"
cd ../..

SIZE=$(du -sh "dist/bundle/${BUNDLE_NAME}.tar.gz" | cut -f1)
echo ""
echo "==> Done! dist/bundle/${BUNDLE_NAME}.tar.gz (${SIZE})"
echo "    Install:"
echo "    tar xzf ${BUNDLE_NAME}.tar.gz && cd ${BUNDLE_NAME} && ./install.sh"
