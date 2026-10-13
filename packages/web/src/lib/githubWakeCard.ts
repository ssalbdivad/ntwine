// Presentation helpers for the GitHub wake card. The PARSING lives in @ntwine/shared beside the
// scheduler's formatter (so the two can't drift); this is only about how the parsed shape reads.

// The compact age the divider's tail used to take from here (`wakeItemAge`) is `compactAge` in
// activityTime.ts since 2026-08-29: every hairline carries one now, not only this one.

// The wake divider's label as ONE PLAIN STRING. One item reads as the WHOLE event in a sentence — the
// kind and who filed it, "New comment from @pullfrog[bot]" (maintainer 2026-07-31) — so the divider
// needs no row beneath it, which is what lets a single-item wake collapse onto one hairline. Several
// items read as a count, because naming three kinds in one line is worse than counting them and
// listing them underneath.
//
// The divider itself renders these as NODES, not from this string, because the login has to escape the
// petite-caps treatment the label wears. This is the accessible/plain-text spelling of the same
// sentence — the `aria-label` a divider takes when it has no link to be reached through — so the two
// must stay in step. The caller appends " on owner/repo#N".
export function wakeCardTitle(count: number, label: string, actor?: string): string {
  if (count !== 1) return `${count} new items`
  return actor ? `New ${label} from @${actor}` : `New ${label}`
}
