// Postgres storage: memos, uploaded files, OAuth clients, codes and tokens.
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
// TLS follows the URL (add ?sslmode=require for an external database URL); Render's internal URL needs none.
export const pool = new pg.Pool({ connectionString: url, max: 5 });

export async function migrate() {
  await pool.query(`
    create table if not exists memos (
      id text primary key, text text not null, author text, created_at timestamptz not null default now());
    create index if not exists memos_created on memos (created_at desc);
    create table if not exists files (
      id text primary key, name text not null, content_type text not null, size integer not null,
      data bytea not null, created_at timestamptz not null default now());
    alter table files alter column data drop not null;
    create table if not exists file_chunks (
      file_id text not null, seq integer not null, data bytea not null, primary key (file_id, seq));
    create table if not exists upload_slots (
      token_hash text primary key, file_id text not null, name text not null, content_type text not null,
      expires_at timestamptz not null);
    create table if not exists oauth_clients (
      client_id text primary key, metadata jsonb not null, created_at timestamptz not null default now());
    create table if not exists oauth_codes (
      code_hash text primary key, client_id text not null, redirect_uri text not null, code_challenge text not null,
      resource text not null, scope text not null, expires_at timestamptz not null);
    create table if not exists oauth_tokens (
      token_hash text primary key, kind text not null, client_id text not null, resource text not null,
      scope text not null, expires_at timestamptz not null, created_at timestamptz not null default now());
  `);
}

export const q = (text, params) => pool.query(text, params);

// Files are stored in 1 MB chunks: the driver sends bytea as hex text, so one big value would
// briefly cost several times its size in memory on a 512 MB host.
const CHUNK = 1024 * 1024;

export async function saveFile({ id, name, contentType, data }) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("insert into files (id, name, content_type, size) values ($1,$2,$3,$4)", [id, name, contentType, data.length]);
    for (let seq = 0, at = 0; at < data.length; seq++, at += CHUNK) {
      await client.query("insert into file_chunks (file_id, seq, data) values ($1,$2,$3)", [id, seq, data.subarray(at, at + CHUNK)]);
    }
    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function fileMeta(id) {
  const { rows } = await q("select id, name, content_type, size from files where id = $1", [id]);
  return rows[0] || null;
}

// Yields the file's bytes chunk by chunk (older rows keep their bytes in files.data).
export async function* fileChunks(id) {
  const { rows: [legacy] } = await q("select data from files where id = $1 and data is not null", [id]);
  if (legacy) { yield legacy.data; return; }
  for (let seq = 0; ; seq++) {
    const { rows } = await q("select data from file_chunks where file_id = $1 and seq = $2", [id, seq]);
    if (!rows[0]) return;
    yield rows[0].data;
  }
}

export async function readFile(id) {
  const parts = [];
  for await (const part of fileChunks(id)) parts.push(part);
  return Buffer.concat(parts);
}
