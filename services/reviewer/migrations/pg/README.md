# Reviewer Postgres migrations

## `0000_certain_sabra.sql`'s `CREATE EXTENSION IF NOT EXISTS pgcrypto` is not required

`gen_random_uuid()` has been built into Postgres core since **PG13** — it does not require the
`pgcrypto` extension on any Postgres version this project supports (Minsky floors at PG16;
production and CI both run `pgvector/pgvector:pg16`). No other migration in this directory creates
`pgcrypto`, and none needs to.

The `CREATE EXTENSION IF NOT EXISTS pgcrypto;` at `0000_certain_sabra.sql:3` exists because a
reviewer raised the pre-PG13 version of this claim on **PR #849 (mt#1306)**, and the migration was
hand-augmented to accommodate it. The accommodation is harmless — `IF NOT EXISTS` makes it a no-op
on any database where the extension is already absent and unneeded — but it is not evidence the
extension is required. `bootstrap/full-schema.sql` and every later migration in this service call
`gen_random_uuid()` directly, with no extension, and pass on pg16.

**This line is being left in place deliberately, not by oversight.** `0000_certain_sabra.sql` is an
applied migration; drizzle records its sha256 at apply time, and editing an applied migration's
content — including deleting this line — changes that hash and makes the migrator treat the file as
unapplied, re-running it against a database where the table it creates already exists (see
mem#532 and the mt#2268 immutable-migration guard, which blocks exactly this edit). The correct fix
is to stop the false premise from propagating, not to touch the artifact it produced.

**Do not cite this file as evidence that pgcrypto is required.** A later reviewer or agent reading
this migration in isolation may reach the same false conclusion the mt#1306 review did — that is
the failure this README exists to prevent (mt#4691).
