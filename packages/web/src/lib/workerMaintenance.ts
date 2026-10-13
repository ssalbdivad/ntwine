import type { ThreadView } from "@ntwine/shared"

// The live-process MAINTENANCE verb — Restart worker — as the thread menu offers it. It was an icon in
// the drawer header's action strip (2026-08-26 to 2026-09-29), and before that in the lifecycle footer;
// the maintainer moved it into the drawer's ⋯ menu on 2026-09-29, because it is reached for rarely and
// held permanent space beside the two doors that are used on nearly every thread (fullscreen and open
// terminal). Reload plugins sat beside it until upstream 288f5687: the server reloads a worker's
// plugins on its own now.
//
// It is OFFERED only where it can actually work — a menu item that throws is worse than an absent one.

/** Restart worker replaces the live `claude` process, keeping the conversation (lib/restartWorker.ts).
 *  DEV BUILDS ONLY, and the gate is the launcher's runtime answer (lib/devBuild.ts), never
 *  `import.meta.env.DEV`, which is false in the production bundle ntwine-dev actually serves. Claude only:
 *  a codex turn lives in the app-server and an ACP session in its agent's own child. Live process only:
 *  Retry already covers an exited thread. */
export function offersRestartWorker(thread: ThreadView, devBuild: boolean): boolean {
  if (!devBuild) return false
  if (thread.kind !== "session" || thread.foreign) return false
  if (thread.backend === "codex" || thread.backend === "acp") return false
  return thread.runtime !== "exited"
}
