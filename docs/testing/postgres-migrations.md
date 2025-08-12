### PostgreSQL migrations for SessionDB

This project uses Drizzle migrations for the PostgreSQL SessionDB backend.

- Migrations are generated from `src/domain/storage/schemas/session-schema.ts`.
- PostgreSQL migration files live under `src/domain/storage/migrations/pg`.
- At runtime, migrations are applied by `PostgresStorage.initialize()` using `drizzle-orm/postgres-js/migrator`.

#### Generate migrations (PostgreSQL)

```bash
bunx drizzle-kit generate --config ./drizzle.pg.config.ts
```

This will emit SQL and metadata under `src/domain/storage/migrations/pg`.

#### Runtime application

`src/domain/storage/backends/postgres-storage.ts` executes migrations at initialization:

```12:21:src/domain/storage/backends/postgres-storage.ts
  private async runMigrations(): Promise<void> {
    try {
      await migrate(this.drizzle, { migrationsFolder: "./src/domain/storage/migrations/pg" });
    } catch (error) {
      log.debug("Migration attempt failed:", error);
    }
  }
```

Ensure `sessiondb.postgres.connectionString` is configured in your config for runtime usage.
