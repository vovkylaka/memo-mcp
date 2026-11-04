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
