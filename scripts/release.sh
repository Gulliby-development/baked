#!/usr/bin/env bash
set -euo pipefail

# baked Release Script
# Usage: ./scripts/release.sh <patch|minor|major> [--dry-run|--skip-checks]
#
# 1. Runs lint + typecheck + test (skip with --skip-checks)
# 2. Bumps version in package.json
# 3. Generates CHANGELOG.md via git-cliff
# 4. Commits, tags, pushes
# 5. Creates GitHub release with changelog
#
# Prerequisites: git-cliff (brew install git-cliff), gh (GitHub CLI)

BUMP="${1:-}"
DRY_RUN="${2:-}"

if [[ -z "$BUMP" ]] || [[ ! "$BUMP" =~ ^(patch|minor|major)$ ]]; then
  echo "Usage: ./scripts/release.sh <patch|minor|major> [--dry-run]"
  exit 1
fi

# Check tools
command -v git-cliff >/dev/null 2>&1 || { echo "Install git-cliff: brew install git-cliff"; exit 1; }
command -v gh >/dev/null 2>&1 || { echo "Install gh: brew install gh"; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "Install jq: brew install jq"; exit 1; }

# Ensure clean working tree
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is dirty. Commit or stash changes first."
  exit 1
fi

# Ensure on main
BRANCH=$(git branch --show-current)
if [[ "$BRANCH" != "main" ]]; then
  echo "Must be on main branch (currently on: $BRANCH)"
  exit 1
fi

# Pre-flight — catch lint/typecheck/test failures BEFORE tagging.
# CI runs these too, but a failed CI on a published tag means a broken
# Homebrew formula or npm tarball before the npm-publish job can veto it.
# --skip-checks is an escape hatch for emergency releases.
if [[ "$DRY_RUN" != "--skip-checks" && "$DRY_RUN" != "--dry-run" ]]; then
  echo "  Pre-flight: lint, typecheck, test..."
  bun run lint
  bun run typecheck
  bun test
  echo "  Pre-flight OK"
  echo ""
fi

# Current version
CURRENT=$(jq -r .version package.json)
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"

case "$BUMP" in
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  patch) PATCH=$((PATCH + 1)) ;;
esac

VERSION="${MAJOR}.${MINOR}.${PATCH}"
TAG="v${VERSION}"

echo ""
echo "  Release: ${CURRENT} → ${VERSION} (${BUMP})"
echo "  Tag:     ${TAG}"
echo ""

if [[ "$DRY_RUN" == "--dry-run" ]]; then
  echo "  [dry-run] Would generate changelog:"
  git-cliff --tag "$TAG" --unreleased --strip header
  echo ""
  echo "  [dry-run] No changes made."
  exit 0
fi

# Bump version in package.json
TMPFILE=$(mktemp)
jq ".version = \"${VERSION}\"" package.json > "$TMPFILE" && mv "$TMPFILE" package.json

# Generate release notes for this version (for GH release body)
RELEASE_NOTES=$(git-cliff --tag "$TAG" --unreleased --strip header)

# Prepend new version to CHANGELOG.md (preserve existing v1.0.0 and earlier)
git-cliff --tag "$TAG" --unreleased --prepend CHANGELOG.md

# Commit and tag
git add package.json CHANGELOG.md
git commit -m "chore(release): ${VERSION}"
git tag -a "$TAG" -m "Release ${VERSION}"

echo ""
echo "  Pushing to origin..."
git push origin main
git push origin "$TAG"

echo ""
echo "  Creating GitHub release..."
gh release create "$TAG" \
  --title "baked ${VERSION}" \
  --notes "$RELEASE_NOTES"

echo ""
echo "  Done! Release ${VERSION} created."
echo "  GitHub Actions will now build binaries and update Homebrew."
echo ""
