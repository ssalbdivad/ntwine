// Imported by every server and launcher entry right after `@ntwine/shared/legacy-env`, so the Frizz install
// has moved (or been pinned where it is) before any module resolves a path.
import { bootFrizzMigration } from "./frizz-migration.ts"

// Only a launch that SERVES moves anything. A command that reads, signals or builds and exits — usage,
// `top`, `--status`, an artifact verb — must never rewrite the machine as a side effect (2026-10-13: a
// test's `index.js --help` under the real HOME migrated the live install). `--sandbox` serves a fresh
// board under a throwaway HOME it swaps in later, so the real one it starts under is not its to move.
// `migrate-frizz` runs the migration itself, and its dry run must find the install untouched.
const NON_SERVING_COMMANDS = new Set(["migrate-frizz", "top", "build", "promote", "restart"])
const NON_SERVING_FLAGS = ["--help", "-h", "--stop", "--status", "--link", "--sessions", "--sign-out", "--sandbox", "--_ntwine-print-launcher"]

const args = process.argv.slice(2)
const serves = !NON_SERVING_COMMANDS.has(args[0] ?? "") &&
  !args.some((arg) => NON_SERVING_FLAGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`)))
if (serves) bootFrizzMigration()
