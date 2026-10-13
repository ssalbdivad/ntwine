// This product was Frizz until 2026-10-13, and the browser kept its settings under `frizz…` keys
// (theme, last view, drafts, collapsed groups). The origin did not change, so the values are still
// here: copy each one to its `ntwine…` name once, before anything reads it. A value already saved
// under the new name always wins, and the old keys are left where they are.
export function adoptFrizzStorage(): void {
  for (const area of [globalThis.localStorage, globalThis.sessionStorage]) {
    try {
      for (let i = 0; i < area.length; i++) {
        const key = area.key(i)
        if (!key?.startsWith("frizz")) continue
        const renamed = `ntwine${key.slice("frizz".length)}`
        if (area.getItem(renamed) === null) area.setItem(renamed, area.getItem(key) ?? "")
      }
    } catch {
      // Storage disabled or full: the settings simply start fresh.
    }
  }
}

// Runs on import: main.tsx imports this first, ahead of every module that reads a setting at load.
adoptFrizzStorage()
