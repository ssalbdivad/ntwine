#!/usr/bin/env bash
# Publish one package directory to npm: `npm publish` through OIDC trusted publishing, which
# attaches provenance on its own.
#
# Until 2026-09-30 this was npm-stage-publish.sh and ran `npm stage publish`, so every version
# waited for a maintainer's 2FA approval. release.yml's header says why that was dropped.
#
# Idempotent, because a run that dies after the publish is finished by re-running it. A version the
# registry already serves is skipped. A version npm has accepted but still holds in its automated
# review is not served yet, so a re-run publishes it again and npm refuses — pullfrog saw `E409
# Cannot publish over previously staged version` on exactly that re-run — and that refusal is
# success here: npm-wait-served.sh, which follows every publish in release.yml, still gates on the
# registry actually serving the version. The wording is matched loosely; anything else stays fatal.
#
# E403 is checked FIRST, is always fatal, and names the fix. `E403 OIDC permission denied for this
# action` is what npm returns when the trusted publisher's allowed actions do not include a direct
# `npm publish` — which is exactly the state a stage-only publisher left from 2026-09-22 is in.
set -euo pipefail
dir="${1:?usage: npm-publish.sh <package-dir> [npm flags...]}"
shift
name="$(node -p "require(require('node:path').resolve('$dir', 'package.json')).name")"
version="$(node -p "require(require('node:path').resolve('$dir', 'package.json')).version")"

# The registry URL, not `npm view`: see npm-wait-served.sh.
if curl -sf "https://registry.npmjs.org/$name/$version" > /dev/null; then
  echo "✓ $name@$version is already published — skipping"
  exit 0
fi

# Never past a version npm still holds in review: see npm-refuse-overtake.sh.
bash "$(dirname "${BASH_SOURCE[0]}")/npm-refuse-overtake.sh" "$name" "$version"

echo "→ publishing $name@$version"
out="$(mktemp)"
if npm publish "$dir" "$@" >"$out" 2>&1; then
  cat "$out"
  rm -f "$out"
  exit 0
fi
cat "$out"
if grep -q 'E403' "$out"; then
  rm -f "$out"
  echo "::error::npm refused to publish $name@$version (E403). If the log says OIDC permission denied, the trusted publisher for $name on npmjs.com does not allow a direct \`npm publish\` from release.yml. Allow npm publish there, then re-run this job."
  exit 1
fi
if grep -qiE 'already (been )?staged|staged version|E409|EPUBLISHCONFLICT|previously published' "$out"; then
  echo "✓ $name@$version is already in npm's review or published — the wait decides the rest"
  rm -f "$out"
  exit 0
fi
rm -f "$out"
echo "::error::publishing $name@$version failed"
exit 1
