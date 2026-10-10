#!/usr/bin/env bash
set -euo pipefail

# Cut a BAKED release.
# Usage: scripts/release.sh <patch|minor|major> [--dry-run|--skip-checks]
#
# 1. Runs lint, typecheck, locale validation and tests (skip with --skip-checks).
# 2. Bumps the version in package.json.
# 3. Commits "Release X.Y.Z", tags vX.Y.Z and pushes main and the tag.
#
# The tag starts .github/workflows/release.yml, which builds every archive and
# publishes the GitHub release with notes generated from merged pull requests.

BUMP="${1:-}"
FLAG="${2:-}"

if [[ ! "$BUMP" =~ ^(patch|minor|major)$ ]]; then
  echo "Usage: scripts/release.sh <patch|minor|major> [--dry-run|--skip-checks]"
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is dirty. Commit or stash changes first."
  exit 1
fi

BRANCH=$(git branch --show-current)
if [[ "$BRANCH" != "main" ]]; then
  echo "Must be on main (currently on: $BRANCH)"
  exit 1
fi

git fetch --quiet origin main
if [[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]]; then
  echo "Local main differs from origin/main. Pull or push first."
  exit 1
fi

CURRENT=$(bun -e "console.log(require('./package.json').version)")
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"
case "$BUMP" in
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  patch) PATCH=$((PATCH + 1)) ;;
esac
VERSION="${MAJOR}.${MINOR}.${PATCH}"
TAG="v${VERSION}"

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "Tag $TAG already exists."
  exit 1
fi

echo "Release: ${CURRENT} -> ${VERSION} (${BUMP}), tag ${TAG}"

if [[ "$FLAG" == "--dry-run" ]]; then
  echo "[dry-run] Pull requests merged since the last tag:"
  LAST=$(git describe --tags --abbrev=0 2>/dev/null || true)
  git log --oneline ${LAST:+"$LAST"..HEAD}
  exit 0
fi

if [[ "$FLAG" != "--skip-checks" ]]; then
  bun run lint
  bun run typecheck
  bun scripts/validate-locales.ts
  bun test
fi

bun -e "
const fs = require('node:fs');
const text = fs.readFileSync('package.json', 'utf8');
fs.writeFileSync('package.json', text.replace(/\"version\": \"[^\"]+\"/, '\"version\": \"${VERSION}\"'));
"
git add package.json
git commit -m "Release ${VERSION}"
git tag -a "$TAG" -m "BAKED ${VERSION}"
git push origin main
git push origin "$TAG"

echo "Pushed ${TAG}. The Release workflow builds the archives and publishes the release."
