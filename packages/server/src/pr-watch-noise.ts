import { isBotGithubActor, type GithubReviewActivity } from "./github-review.ts"

// The exclusion list for registered PR watchers: which new reviews and comments must NOT wake a worker.
//
// MEASURED, not guessed. 2026-08-26, over 1,028 public Pullfrog-customer PRs (205 repos, 8,979 wake-
// eligible items — every `review` + issue-level `comment` node the poller can see). 80% of that
// activity is bot-authored, and the maintainer's complaint (2026-08-28: "the watcher keeps on waking
// up agents with bullshit … comments from things like Vercel and from Linear that are just not really
// high signal") is about a SUBSET of it. Edits were ruled out first: the poller keys on the immutable
// node id and never asks for `lastEditedAt`, so every bump is a genuinely new item — Vercel edits its
// deploy table in place, which wakes once per PR, not once per deployment. The corpus and the script
// that re-derives every figure here live in `.ntwine/pr-watch-noise/` (gitignored, 17MB).
//
// The rule is DELIBERATELY not "mute all bots" — that filter was tried and reverted (see
// `isBotGithubActor`): Pullfrog, CodeRabbit, Copilot, Cursor, Codex, cubic, Greptile and Qodo all post
// real review from a Bot actor. So three tiers, each narrower than the last, and a human item is never
// muted by any of them. Together they drop 1,940 of the 8,979 items (21.6%), with 0 human items.
//
// ONE clean-bill rule is deliberately ABSENT: Pullfrog's own `✅ No new issues found.` re-review (~280
// items in the corpus, the single biggest lever left). A clean verdict on the worker's own PR is
// arguably the answer it was waiting for, so it stays live; the maintainer chose that on 2026-08-28.

/** Tier 1 — the actor never carries review substance: deploy previews, coverage badges, changeset
 *  notices, issue linkbacks, package previews, greeters. Logins are the GRAPHQL form, with NO `[bot]`
 *  suffix — REST adds it, GraphQL does not, and a list written as `vercel[bot]` matches nothing
 *  (`isNoisePrActivity` strips a suffix defensively, but keep the list in this form).
 *  `socket-security` and `codspeed-hq` are NOT here on purpose: their `[!WARNING]` dependency alerts
 *  and "degrade performance by 12%" reports are review, so they get a body rule below instead. */
const MUTE_ACTORS = new Set([
  // deploy / preview
  "vercel", "netlify", "cloudflare-workers-and-pages", "render", "railway-app", "supabase",
  "surge-sh", "bolt-new-by-stackblitz", "mintlify", "pkg-pr-new", "argos-ci", "chromatic", "percy",
  // release / changelog
  "changeset-bot",
  // coverage + static-analysis dashboards that mirror a check the watcher already reports
  "codecov", "coveralls-official", "sonarqubecloud", "codacy-production", "deepsource-io",
  // issue trackers / linkbacks
  "linear-code", "linear", "height-app",
  // greeters, taggers, self-announcers
  "gitginie", "pr-insights-tagger", "devin-ai-integration", "codesherlock-ai", "precogs-ai",
  // misc infra
  "sentry-io", "gitguardian", "graphite-app", "cypress", "snyk-bot",
])

/** Tier 2 — the actor posts BOTH signal and noise, and marks the noise itself with an HTML comment.
 *  Matched against the START of the raw body, so a substantive review that merely mentions one of
 *  these is untouched. (This is why the poller fetches `body`, not `bodyText`: `bodyText` strips
 *  every marker below and leaves the whole tier silently inert.) */
const MUTE_PREFIXES = [
  // coderabbit: the walkthrough comment, command acks, skip/limit banners. Its FINDINGS ride a
  // separate review node, which stays live. 387 of coderabbit's 840 corpus items.
  "<!-- This is an auto-generated comment: summarize by coderabbit.ai -->",
  "<!-- This is an auto-generated reply by CodeRabbit -->",
  "<!-- This is an auto-generated comment: skip review by coderabbit.ai -->",
  "<!-- This is an auto-generated comment: rate limited by coderabbit.ai -->",
  "[vc]: #", // vercel deployment table
  "<!-- linear-linkback -->",
  "<!-- indent-pr-review-banner -->",
  "<!-- greptile-status -->",
  "<!-- __CODSPEED_PERFORMANCE_REPORT_COMMENT__ -->",
  "<!-- mintlify-preview-comment",
  "<!-- vitehub-babysitter-status -->",
  "<!-- react-doctor:summary -->",
  "<!-- bundle-analysis -->",
  // pullfrog's own run chrome: seeded BEFORE the run, says nothing, and its substance arrives as EDITS
  // to the same node — which can never wake a watcher.
  "New pull request. Leaping into action...",
  "New issue. Leaping into action...",
]

/** Tier 3 — a reviewer that reviewed and found nothing, or could not review at all (trial ended,
 *  quota hit, reviews paused, insufficient balance, rate-limited: 512 corpus items whose entire
 *  content is a billing notice about somebody else's subscription). Anchored at the FIRST LINE of
 *  the body with HTML comments and blockquote markers stripped — never a substring match: a naive
 *  `/rate limit/i` over the whole body hit 72 substantive CodeRabbit reviews and 33 Pullfrog ones. */
const MUTE_LEADS = [
  // clean bills of health (Pullfrog's own is deliberately absent — see the header)
  /^codex review: didn't find any/i, // chatgpt-codex-connector
  /^\*\*no issues found\*\*/i, // cubic-dev-ai
  /^\*\*all reported issues/i, // cubic-dev-ai
  /^#+ kody review complete/i,
  /^#+ code review completed!/i,
  /^#+ up to standards/i, // codacy
  /^#+ \[!\[quality gate passed/i, // sonarqube
  /^#+ codesherlock review insight\s+\*\*no issues found/i,
  /^✅ precogs scan complete/i,
  /^\*\*react doctor\*\* .*found (no new issues|\*\*0 new issues)/i,
  /^#+ 📦 bundle size analysis\s+no bundle changes/i,
  /^\*\*review the following changes in direct dependencies\.\*\*/i, // socket-security all-clear
  /^#+ merging this (pull request|pr) will \*\*not alter performance\*\*/i, // codspeed all-clear
  /^#+ pull request overview\s+copilot reviewed \d+ out of \d+ changed files in this pull request and generated 0 comments/i,
  // could-not-review: quota, trial, balance, rate limit, path filter, size cap
  /^copilot (was unable to|encountered an error)/i,
  /^your trial has ended/i,
  /^insufficient balance to process/i,
  /^🤖 review skipped/i,
  /^#+ qodo reviews are paused/i,
  /^you have reached your codex usage limits/i,
  /^sorry,? .*(review budget|unable to review)/i,
  /^pr author is not in the allowed authors list/i,
  /^too many files changed for review/i,
  // stale bots
  /^this pull request is now \*\*(stale|closed)\*\*/i,
  /^@\S+ thank you for your contribution/i,
]

const leadOf = (body: string): string =>
  body.replace(/^\s*(<!--[\s\S]*?-->\s*)*/, "").replace(/^\s*>\s?/gm, "").trim()

/** True when this review or comment must not wake a worker. A human item is NEVER noise, and neither
 *  is a bot review with an EMPTY body: that shape means the substance is inline (measured, 3/3
 *  empty-body Pullfrog reviews carry inline comments; Cursor Bugbot posts the same way). */
export function isNoisePrActivity(a: Pick<GithubReviewActivity, "actor" | "actorType" | "body">): boolean {
  if (!isBotGithubActor(a)) return false
  if (MUTE_ACTORS.has(a.actor.toLowerCase().replace(/\[bot\]$/, ""))) return true
  const body = a.body ?? ""
  if (!body.trim()) return false
  if (MUTE_PREFIXES.some((p) => body.trimStart().startsWith(p))) return true
  return MUTE_LEADS.some((r) => r.test(leadOf(body)))
}
