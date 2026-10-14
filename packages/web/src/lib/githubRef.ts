// `owner/repo#N` → the PR's own URL. Shared by every card that carries a GitHub reference: the wake
// card's title-row ref (a burst's items normally have their own permalinks, but the ref must stay
// clickable when GitHub returned none) and the awaiting card's `prs:` refs, which have no other
// link to offer at all. Null when the ref isn't the expected shape, in which case the card renders it
// as plain text rather than a broken link.
//
// The `/pull/N` path is the default and GitHub redirects it to `/issues/N` when the number is an issue,
// so a mistyped kind still lands the human on the right page. A caller that KNOWS it holds an issue
// (a `subject: "issue"` watch row) says so and gets the direct path.
export function githubRefUrl(ref: string, kind: "pull" | "issue" = "pull"): string | null {
  const m = /^([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.-]*)#(\d+)$/.exec(ref.trim())
  return m ? `https://github.com/${m[1]}/${m[2]}/${kind === "issue" ? "issues" : "pull"}/${m[3]}` : null
}
