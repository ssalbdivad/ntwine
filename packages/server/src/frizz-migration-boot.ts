// Imported by every server and launcher entry right after `@ntwine/shared/legacy-env`, so the Frizz install
// has moved (or been pinned where it is) before any module resolves a path. `ntwine migrate-frizz` runs
// the same migration itself, by hand, and a dry run of it must find the install untouched.
import { bootFrizzMigration } from "./frizz-migration.ts"

if (process.argv[2] !== "migrate-frizz") bootFrizzMigration()
