#!/usr/bin/env bash
set -euo pipefail

# Cut a BAKED release in two steps, because main takes changes only through the merge queue.
#
# Usage:
#   scripts/release.sh <patch|minor|major> [--dry-run|--skip-checks]
#   scripts/release.sh tag
#
# Step 1 (patch|minor|major), from an up-to-date main:
#   runs lint, typecheck and tests (skip with --skip-checks), bumps the version in
#   package.json and apps/desktop/package.json on a feature/release-X-Y-Z branch, commits
#   "Release X.Y.Z", pushes the branch and, when the GitHub CLI is installed, opens the pull
#   request and adds it to the merge queue.
# Step 2 (tag), after that pull request merged:
#   tags the merged main commit vX.Y.Z (the version in package.json) and pushes the tag.
#
# The tag starts .github/workflows/release.yml, which builds every archive and
# publishes the GitHub release with notes generated from merged pull requests.

BUMP="${1:-}"
FLAG="${2:-}"

if [[ ! "$BUMP" =~ ^(patch|minor|major|tag)$ ]]; then
  echo "Usage: scripts/release.sh <patch|minor|major> [--dry-run|--skip-checks]"
  echo "       scripts/release.sh tag"
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

git fetch --quiet --tags origin main
if [[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]]; then
  echo "Local main differs from origin/main. Pull first."
  exit 1
fi

CURRENT=$(bun -e "console.log(require('./package.json').version)")

if [[ "$BUMP" == "tag" ]]; then
  TAG="v${CURRENT}"
  if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
    echo "Tag $TAG already exists. Run step 1 first: scripts/release.sh <patch|minor|major>."
    exit 1
  fi
  git tag -a "$TAG" -m "BAKED ${CURRENT}"
  git push origin "$TAG"
  echo "Pushed ${TAG}. The Release workflow builds the archives and publishes the release."
  exit 0
fi

IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"
case "$BUMP" in
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  patch) PATCH=$((PATCH + 1)) ;;
esac
VERSION="${MAJOR}.${MINOR}.${PATCH}"
TAG="v${VERSION}"
RELEASE_BRANCH="feature/release-${VERSION//./-}"

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "Tag $TAG already exists."
  exit 1
fi

echo "Release: ${CURRENT} -> ${VERSION} (${BUMP}), branch ${RELEASE_BRANCH}, tag ${TAG}"

if [[ "$FLAG" == "--dry-run" ]]; then
  echo "[dry-run] Pull requests merged since the last tag:"
  LAST=$(git describe --tags --abbrev=0 2>/dev/null || true)
  git log --oneline ${LAST:+"$LAST"..HEAD}
  exit 0
fi

if [[ "$FLAG" != "--skip-checks" ]]; then
  bun run lint
  bun run typecheck
  bun test
fi

git switch -c "$RELEASE_BRANCH"
for manifest in package.json apps/desktop/package.json; do
  [[ -f "$manifest" ]] || continue
  bun -e "
const fs = require('node:fs');
const text = fs.readFileSync('${manifest}', 'utf8');
fs.writeFileSync('${manifest}', text.replace(/\"version\": \"[^\"]+\"/, '\"version\": \"${VERSION}\"'));
"
  git add "$manifest"
done
git commit -m "Release ${VERSION}"
git push -u origin "$RELEASE_BRANCH"

if command -v gh >/dev/null 2>&1; then
  gh pr create --base main --head "$RELEASE_BRANCH" --title "Release ${VERSION}" \
    --body "Bumps the version to ${VERSION}. After this merges, run \`scripts/release.sh tag\` on main to push ${TAG}."
  gh pr merge "$RELEASE_BRANCH" --merge --auto
  echo "Opened the release pull request and added it to the merge queue."
else
  echo "Open a pull request from ${RELEASE_BRANCH} to main and add it to the merge queue."
fi
git switch main
echo "After it merges: git pull, then scripts/release.sh tag (or bun run release:tag)."
