#!/usr/bin/env bash
# Wait until the npm registry serves <name>@<version>, or fail at $RELEASE_DEADLINE (epoch seconds).
#
# A direct publish is not the end of it: npm holds a new version in automated review, and the
# version does not exist on the registry until that finishes — 6m 40s for ntwine 0.13.5
# (2026-09-14); pullfrog measured 3.5, ~54 and 236 minutes. None of those is an upper bound, so
# release.yml sets the deadline as late as its six-hour job cap allows, and an expiry here means
# something is wrong, not merely slow.
#
# It reads the registry URL directly rather than through `npm view`, which revalidates a cached
# packument and can report a live version as missing for minutes (pullfrog, diagnosing its 0.1.66
# and 0.1.72 releases).
set -euo pipefail
name="${1:?usage: npm-wait-served.sh <name> <version>}"
version="${2:?usage: npm-wait-served.sh <name> <version>}"
deadline="${RELEASE_DEADLINE:?RELEASE_DEADLINE (epoch seconds) must be set}"
url="https://registry.npmjs.org/$name/$version"
start="$(date +%s)"

until curl -sf "$url" > /dev/null; do
  now="$(date +%s)"
  if [ "$now" -ge "$deadline" ]; then
    echo "::error::npm still does not serve $name@$version after $(( (now - start) / 60 )) minutes. See the publish step's log for why, then re-run this job: a served version is skipped, and the run resumes from the first one npm does not serve."
    exit 1
  fi
  echo "… npm does not serve $name@$version yet (in review) — $(date -u +%H:%M:%SZ)"
  sleep 60
done
echo "✓ npm serves $name@$version"
