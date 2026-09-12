import { db, initDb } from "./db/client";

initDb({ preserveConfiguration: true });
const migrations = db.prepare("SELECT version,name,applied_at AS appliedAt FROM schema_migrations ORDER BY version").all();
console.log(JSON.stringify({ currentVersion: migrations.at(-1)?.version ?? 0, migrations }, null, 2));
