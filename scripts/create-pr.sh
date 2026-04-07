#!/usr/bin/env bash
# Usage: ./scripts/create-pr.sh "PR title" "Summary of what changed"
# Creates a feature branch from current changes, pushes, opens a PR,
# then spawns an OG subagent to review and approve it.

set -euo pipefail

TITLE="${1:-"chore: sprint microsite update"}"
BODY="${2:-"Automated sprint sync"}"
REPO="dagim-agentic-solutions/norton-reimagined-sprint"

# Generate a branch name from the title
BRANCH="sprint/$(echo "$TITLE" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | sed 's/^-//' | sed 's/-$//' | cut -c1-60)-$(date +%s)"

echo "🌿 Creating branch: $BRANCH"
git checkout -b "$BRANCH"
git push origin "$BRANCH"

echo "📬 Opening PR..."
PR_URL=$(gh pr create \
  --repo "$REPO" \
  --title "$TITLE" \
  --body "$BODY" \
  --base main \
  --head "$BRANCH")

echo "✅ PR created: $PR_URL"
PR_NUMBER=$(echo "$PR_URL" | grep -oE '[0-9]+$')

# Return to main
git checkout main

echo "PR_NUMBER=$PR_NUMBER"
echo "PR_URL=$PR_URL"
echo "BRANCH=$BRANCH"
