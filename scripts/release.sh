#!/usr/bin/env bash
set -euo pipefail

# Cut a BAKED release in two steps, because main takes changes only through the merge queue.
# Usage:
#   scripts/release.sh <patch|minor|major> [--dry-run|--skip-checks]
#   scripts/release.sh tag
#
# Step 1 (<patch|minor|major>), from an up-to-date main:
#   runs lint, typecheck and tests (skip with --skip-checks), bumps the version in
#   package.json and apps/desktop/package.json on a feature/release-X-Y-Z branch,
#   commits "Release X.Y.Z", pushes the branch and, when the GitHub CLI is installed,
#   opens a pull request and adds it to the merge queue.
# Step 2 (tag), once that pull request is merged and main is pulled:
#   tags the merged commit vX.Y.Z from package.json and pushes the tag.
#
# The tag starts .github/workflows/release.yml, which builds every archive and
# publishes the GitHub release with notes generated from merged pull requests.

MODE="${1:-}"
FLAG="${2:-}"

usage() {
  echo "Usage: scripts/release.sh <patch|minor|major> [--dry-run|--skip-checks]"
  echo "       scripts/release.sh tag"
  exit 1
}

if [[ ! "$MODE" =~ ^(patch|minor|major|tag)$ ]]; then
  usage
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
  echo "Local main differs from origin/main. Pull first."
  exit 1
fi

CURRENT=$(bun -e "console.log(require('./package.json').version)")

if [[ "$MODE" == "tag" ]]; then
  TAG="v${CURRENT}"
  git fetch --quiet --tags origin
  if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
    echo "Tag $TAG already exists. Merge a release pull request first (scripts/release.sh <patch|minor|major>)."
    exit 1
  fi
  git tag -a "$TAG" -m "BAKED ${CURRENT}"
  git push origin "$TAG"
  echo "Pushed ${TAG} on $(git rev-parse --short HEAD). The Release workflow builds the archives and publishes the release."
  exit 0
fi

IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"
case "$MODE" in
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  patch) PATCH=$((PATCH + 1)) ;;
esac
VERSION="${MAJOR}.${MINOR}.${PATCH}"
TAG="v${VERSION}"
RELEASE_BRANCH="feature/release-${MAJOR}-${MINOR}-${PATCH}"

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "Tag $TAG already exists."
  exit 1
fi

echo "Release: ${CURRENT} -> ${VERSION} (${MODE}), branch ${RELEASE_BRANCH}, tag ${TAG}"

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
bun -e "
const fs = require('node:fs');
for (const file of ['package.json', 'apps/desktop/package.json']) {
  const text = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, text.replace(/\"version\": \"[^\"]+\"/, '\"version\": \"${VERSION}\"'));
}
"
git add package.json apps/desktop/package.json
git commit -m "Release ${VERSION}"
git push -u origin "$RELEASE_BRANCH"

if command -v gh >/dev/null 2>&1 &&
  gh pr create --base main --head "$RELEASE_BRANCH" --title "Release ${VERSION}" \
    --body "Bumps the version to ${VERSION}. After the merge, run \`scripts/release.sh tag\` on an up-to-date main to tag ${TAG}."; then
  gh pr merge "$RELEASE_BRANCH" --merge --auto || echo "Add the pull request to the merge queue."
else
  echo "Pushed ${RELEASE_BRANCH}. Open a pull request to main and add it to the merge queue."
fi
echo "After it merges: git switch main && git pull && scripts/release.sh tag"
