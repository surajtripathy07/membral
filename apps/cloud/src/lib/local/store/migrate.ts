// Applies supabase/migrations/*.sql to the embedded store, in order, each in its own transaction, recording them in
// supabase_migrations.schema_migrations in the same shape `membral local up` writes (packages/cli migrationVersion():
// version = file name up to the first "_", name = the rest without ".sql").
import fs from "node:fs";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";

const MIGRATIONS_TABLE_SQL =
  "create schema if not exists supabase_migrations;" +
  "create table if not exists supabase_migrations.schema_migrations (version text not null primary key, statements text[], name text);";

export function migrationVersion(file: string): { version: string; name: string } {
  const base = file.replace(/\.sql$/, "");
  const idx = base.indexOf("_");
  return idx === -1 ? { version: base, name: "" } : { version: base.slice(0, idx), name: base.slice(idx + 1) };
}

function sqlString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

export async function applyPrelude(db: PGlite, preludeFile: string): Promise<void> {
  await db.exec(fs.readFileSync(preludeFile, "utf8"));
}

export async function applyMigrations(db: PGlite, dir: string): Promise<{ applied: string[]; skipped: number }> {
  if (!fs.existsSync(dir)) throw new Error(`Migrations directory not found: ${dir}`);
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  if (files.length === 0) throw new Error(`No migrations in ${dir}`);
  await db.exec(MIGRATIONS_TABLE_SQL);
  const done = new Set(
    (await db.query<{ version: string }>("select version from supabase_migrations.schema_migrations")).rows.map(
      (r) => r.version,
    ),
  );
  const applied: string[] = [];
  let skipped = 0;
  for (const file of files) {
    const { version, name } = migrationVersion(file);
    if (done.has(version)) {
      skipped++;
      continue;
    }
    const body = fs.readFileSync(path.join(dir, file), "utf8");
    try {
      await db.exec(
        "begin;\n" +
          `${body}\n;\n` +
          "insert into supabase_migrations.schema_migrations (version, name, statements) " +
          `values (${sqlString(version)}, ${sqlString(name)}, '{}');\n` +
          "commit;\n",
      );
    } catch (e) {
      await db.exec("rollback").catch(() => undefined);
      throw new Error(`Migration ${file} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    applied.push(file);
  }
  return { applied, skipped };
}
