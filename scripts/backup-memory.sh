#!/bin/bash
# Hourly snapshot of EVE's memory into its own local git repo (memory/.git).
#
# This script can ADD and COMMIT. That is all it can do. There is deliberately
# no checkout, reset, clean, rm, push or branch command anywhere in it, so no
# scheduled run can ever destroy a memory — the worst it can do is record one.
set -euo pipefail

REPO="$HOME/TRILLION/memory"

cd "$REPO" || { echo "$(date '+%F %T') no memory directory at $REPO" >&2; exit 1; }
[ -d .git ] || { echo "$(date '+%F %T') no git repo in $REPO — run git init first" >&2; exit 1; }

# Mid-operation means a human is in the middle of something. Committing on top
# of that would tangle it; refuse and let them finish.
for marker in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD BISECT_LOG rebase-merge rebase-apply; do
  [ -e ".git/$marker" ] && { echo "$(date '+%F %T') refusing: repo is mid-operation (.git/$marker)" >&2; exit 1; }
done
git rev-parse --verify HEAD >/dev/null 2>&1 || { echo "$(date '+%F %T') refusing: no commits yet" >&2; exit 1; }

git add -A
changed=$(git diff --cached --name-only | wc -l | tr -d ' ')

if [ "$changed" -eq 0 ]; then
  echo "$(date '+%F %T') no changes"
  exit 0
fi

git commit -q -m "memory snapshot $(date '+%F %T') — $changed file(s) changed"
echo "$(date '+%F %T') committed $changed file(s): $(git rev-parse --short HEAD)"
