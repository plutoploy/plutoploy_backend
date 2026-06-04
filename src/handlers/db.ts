import { Database } from "bun:sqlite";

const db = new Database("routes.db");
db.run(`
    CREATE TABLE IF NOT EXISTS routes (
      route TEXT,
      container TEXT,
      port INTEGER
    );
  `);
export default db;
