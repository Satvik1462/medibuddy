const { Pool, types } = require("pg");
require("dotenv").config();

// IMPORTANT DATE FIX:
// By default node-postgres parses SQL DATE columns into JS Date
// objects at LOCAL MIDNIGHT in the server process's timezone. When
// that gets JSON.stringify'd (toISOString → UTC) anywhere — the AI
// chat prompt, API responses, etc. — a date can silently shift by a
// day (e.g. a "2026-09-04" row turning into "2026-09-03T18:30:00Z"
// when the server runs in IST). That was the cause of appointments
// getting booked for the wrong day. Fix: keep DATE columns as plain
// "YYYY-MM-DD" strings everywhere, never as Date objects.
types.setTypeParser(1082, (val) => val); // 1082 = PostgreSQL DATE OID

// Neon (and most managed Postgres hosts) require SSL. A local Postgres
// install — e.g. running this on your own laptop against `localhost` —
// does NOT support SSL by default and the connection fails with
// "The server does not support SSL connections" if we force it on.
//
// So: SSL is on by default (safe for Neon/production), auto-detected off
// for a localhost/127.0.0.1 DATABASE_URL (safe for local dev), and can
// always be overridden explicitly with DB_SSL=true or DB_SSL=false in .env.
function resolveSSL() {
  const explicit = (process.env.DB_SSL || "").trim().toLowerCase();
  if (explicit === "true") return { rejectUnauthorized: false };
  if (explicit === "false") return false;

  const url = process.env.DATABASE_URL || "";
  const isLocalHost = /\/\/(?:[^@/]+@)?(localhost|127\.0\.0\.1)(?::\d+)?\//i.test(url);
  return isLocalHost ? false : { rejectUnauthorized: false };
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: resolveSSL(),
});

pool.on("error", (err) => {
  console.error("Unexpected error on idle Postgres client", err);
});

module.exports = pool;
