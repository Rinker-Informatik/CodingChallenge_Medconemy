import { Invitations } from './application/invitations.js';
import { OfficeSessions } from './application/office.js';
import { OnlyOffice } from './infrastructure/onlyoffice.js';
import { randomUUID } from 'node:crypto';
import { AccountCommands } from './application/commands/accounts.js';
import { FolderCommands } from './application/commands/folders.js';
import { FileCommands } from './application/commands/files.js';
import { ShareCommands } from './application/commands/shares.js';
import { AccountQueries } from './application/queries/accounts.js';
import { FolderQueries } from './application/queries/folders.js';
import { FileQueries } from './application/queries/files.js';
import { Trash } from './application/trash.js';
import { Activity } from './application/activity.js';
import { createApp } from './http/app.js';
import { PostgresDatabase } from './infrastructure/postgres.js';
import { JwtCredentials, MailNotifier, S3ObjectStore } from './infrastructure/services.js';

function env(name: string, fallback?: string): string {
  const value = process.env[name] || fallback;
  if (!value) throw new Error(`${name} fehlt`);
  return value;
}

async function main() {
  const db = new PostgresDatabase(env('DATABASE_URL'));
  const credentials = new JwtCredentials(env('JWT_SECRET'));
  const objects = new S3ObjectStore(env('S3_BUCKET', 'files'), env('S3_ENDPOINT'), env('S3_ACCESS_KEY'), env('S3_SECRET_KEY'));
  const smtpPort = Number(env('SMTP_PORT', '1025'));
  if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) throw new Error('SMTP_PORT ist ungültig');
  const notifier = new MailNotifier({ host: env('SMTP_HOST', 'localhost'), port: smtpPort,
    secure: process.env.SMTP_SECURE === 'true', requireTLS: process.env.SMTP_REQUIRE_TLS === 'true',
    from: env('SMTP_FROM', 'demo@example.test'), user: process.env.SMTP_USER, password: process.env.SMTP_PASSWORD });
  // Idempotent schema upgrade for databases initialized before account types existed.
  await db.pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS account_type
    text CONSTRAINT users_account_type_check CHECK (account_type IN ('internal','external'))`);
  await db.pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true, ADD COLUMN IF NOT EXISTS session_version integer NOT NULL DEFAULT 0');
  // Keep historical dates unknown for files created before tracking was introduced.
  await db.pool.query(`ALTER TABLE files ADD COLUMN IF NOT EXISTS created_at timestamptz,
    ADD COLUMN IF NOT EXISTS updated_at timestamptz, ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES users(id),
    ADD COLUMN IF NOT EXISTS version integer`);
  await db.pool.query(`ALTER TABLE files ALTER COLUMN created_at SET DEFAULT now(),
    ALTER COLUMN updated_at SET DEFAULT now(), ALTER COLUMN version SET DEFAULT 1`);
  await db.pool.query(`CREATE TABLE IF NOT EXISTS user_invitations (user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, token_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL)`);
  await db.pool.query(`CREATE TABLE IF NOT EXISTS file_edit_locks (file_id uuid PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, token uuid NOT NULL, expires_at timestamptz NOT NULL)`);
  await db.pool.query('ALTER TABLE shares ADD COLUMN IF NOT EXISTS granted_by uuid REFERENCES users(id)');
  await db.pool.query('ALTER TABLE shares ADD COLUMN IF NOT EXISTS expires_at timestamptz');
  await db.pool.query(`CREATE TABLE IF NOT EXISTS file_versions (id uuid PRIMARY KEY, file_id uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE, object_key text NOT NULL, content_type text NOT NULL, size bigint NOT NULL, version integer, saved_at timestamptz NOT NULL DEFAULT now(), saved_by uuid REFERENCES users(id))`);
  await db.pool.query(`CREATE TABLE IF NOT EXISTS trash_batches (id uuid PRIMARY KEY, kind text NOT NULL CHECK(kind IN ('file','folder')), target_id uuid NOT NULL, parent_id uuid, name text NOT NULL, deleted_by uuid NOT NULL REFERENCES users(id), deleted_at timestamptz NOT NULL DEFAULT now())`);
  await db.pool.query('ALTER TABLE folders ADD COLUMN IF NOT EXISTS trash_id uuid REFERENCES trash_batches(id)');
  await db.pool.query('ALTER TABLE files ADD COLUMN IF NOT EXISTS trash_id uuid REFERENCES trash_batches(id)');
  await db.pool.query(`CREATE TABLE IF NOT EXISTS activity_events (id uuid PRIMARY KEY, object_type text NOT NULL CHECK(object_type IN ('file','folder')), object_id uuid NOT NULL, object_name text NOT NULL, action text NOT NULL, actor_id uuid NOT NULL REFERENCES users(id), occurred_at timestamptz NOT NULL DEFAULT now())`);
  const email = env('ADMIN_EMAIL', 'admin@example.test').toLowerCase();
  const hash = await credentials.hash(env('ADMIN_PASSWORD'));
  await db.pool.query(`INSERT INTO users(id,email,password_hash,is_admin,account_type) VALUES ($1,$2,$3,true,'internal') ON CONFLICT(email) DO NOTHING`, [randomUUID(), email, hash]);
  await objects.ensureBucket();
  const files = new FileCommands(db, objects);
  const trash = new Trash(db, objects);
  let cleaning = false;
  const cleanTrash = async () => {
    if (cleaning) return;
    cleaning = true;
    try { await trash.purgeExpired(); await db.transaction(repo => repo.purgeActivity()); } catch (error) { console.error('Bereinigung fehlgeschlagen:', error); }
    finally { cleaning = false; }
  };
  void cleanTrash();
  setInterval(() => void cleanTrash(), 60 * 60 * 1000).unref();
  const editor = process.env.OFFICE_SECRET ? new OfficeSessions(db, objects, files,
    new OnlyOffice(env('OFFICE_SECRET'), env('OFFICE_BACKEND_ORIGIN'), env('OFFICE_INTERNAL_ORIGIN'), env('OFFICE_BROWSER_ORIGIN'))) : undefined;
  const app = createApp({
    trash,
    activity: new Activity(db),
    editor,
    invitations: new Invitations(db, credentials, notifier, env('PUBLIC_APP_URL', 'http://localhost:8080')),
    accountCommands: new AccountCommands(db, credentials),
    accountQueries: new AccountQueries(db, credentials),
    folderCommands: new FolderCommands(db, objects),
    folderQueries: new FolderQueries(db),
    fileCommands: files,
    fileQueries: new FileQueries(db, objects),
    shareCommands: new ShareCommands(db, notifier),
  });
  app.listen(3000, () => console.log('API auf Port 3000'));
}

main().catch(error => { console.error(error); process.exit(1); });
