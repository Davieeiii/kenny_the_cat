import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import sqlite3 from 'sqlite3';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DATA_DIR = join(__dirname, 'data');
const DB_PATH = join(DATA_DIR, 'kenny.db');

let db;

function runAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function getAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function allAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

export async function initDb() {
  await mkdir(DATA_DIR, { recursive: true });
  db = new sqlite3.Database(DB_PATH);

  await runAsync(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      username TEXT,
      wallet TEXT,
      xUsername TEXT,
      telegramUsername TEXT,
      email TEXT,
      emailVerified INTEGER DEFAULT 0,
      emailVerifiedAt TEXT,
      points INTEGER DEFAULT 0,
      invites INTEGER DEFAULT 0,
      completedTasks TEXT,
      meme TEXT,
      passcodeHash TEXT,
      signedUpAt TEXT,
      updatedAt TEXT
    )
  `);

  // Attempt to add newer columns if DB was created earlier without them
  try {
    await runAsync('ALTER TABLE accounts ADD COLUMN email TEXT');
  } catch (e) {}
  try {
    await runAsync('ALTER TABLE accounts ADD COLUMN emailVerified INTEGER DEFAULT 0');
  } catch (e) {}
  try {
    await runAsync('ALTER TABLE accounts ADD COLUMN emailVerifiedAt TEXT');
  } catch (e) {}

  // Email verification tokens (one-click)
  await runAsync(`
    CREATE TABLE IF NOT EXISTS email_verifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT,
      wallet TEXT,
      tokenHash TEXT,
      expiresAt INTEGER,
      usedAt INTEGER,
      createdAt INTEGER
    )
  `);

  // OTP table for short numeric codes
  await runAsync(`
    CREATE TABLE IF NOT EXISTS email_otps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT,
      wallet TEXT,
      otpHash TEXT,
      salt TEXT,
      expiresAt INTEGER,
      attempts INTEGER DEFAULT 0,
      maxAttempts INTEGER DEFAULT 5,
      usedAt INTEGER,
      createdAt INTEGER
    )
  `);
}

export async function createEmailVerification({ email, wallet, tokenHash, expiresAt }) {
  const now = Date.now();
  const res = await runAsync(
    'INSERT INTO email_verifications (email, wallet, tokenHash, expiresAt, createdAt) VALUES (?, ?, ?, ?, ?)',
    [email, wallet || null, tokenHash, expiresAt, now]
  );
  return res.lastID;
}

export async function findEmailVerificationByHash(tokenHash) {
  const row = await getAsync('SELECT * FROM email_verifications WHERE tokenHash = ? LIMIT 1', [tokenHash]);
  return row || null;
}

export async function markEmailVerificationUsed(id) {
  const now = Date.now();
  await runAsync('UPDATE email_verifications SET usedAt = ? WHERE id = ?', [now, id]);
}

export async function createOtp({ email, wallet, otpHash, salt, expiresAt, maxAttempts = 5 }) {
  const now = Date.now();
  // Invalidate existing otps for this email (soft: mark usedAt)
  await runAsync('UPDATE email_otps SET usedAt = ? WHERE email = ? AND usedAt IS NULL', [now, email]);

  const res = await runAsync(
    'INSERT INTO email_otps (email, wallet, otpHash, salt, expiresAt, attempts, maxAttempts, createdAt) VALUES (?, ?, ?, ?, ?, 0, ?, ?)',
    [email, wallet || null, otpHash, salt, expiresAt, maxAttempts, now]
  );

  return res.lastID;
}

export async function getLatestOtpForEmail(email) {
  const row = await getAsync('SELECT * FROM email_otps WHERE email = ? ORDER BY createdAt DESC LIMIT 1', [email]);
  return row || null;
}

export async function incrementOtpAttempts(id) {
  await runAsync('UPDATE email_otps SET attempts = attempts + 1 WHERE id = ?', [id]);
}

export async function markOtpUsed(id) {
  const now = Date.now();
  await runAsync('UPDATE email_otps SET usedAt = ? WHERE id = ?', [now, id]);
}

export async function invalidateOtpsForEmail(email) {
  const now = Date.now();
  await runAsync('UPDATE email_otps SET usedAt = ? WHERE email = ? AND usedAt IS NULL', [now, email]);
}

export async function findAccountByEmail(email) {
  if (!email) return null;
  const row = await getAsync('SELECT * FROM accounts WHERE lower(email) = lower(?) LIMIT 1', [email]);
  if (!row) return null;
  return {
    ...row,
    points: Number(row.points || 0),
    invites: Number(row.invites || 0),
    completedTasks: row.completedTasks ? JSON.parse(row.completedTasks) : [],
    meme: row.meme ? JSON.parse(row.meme) : { title: 'No meme submission', status: 'pending' },
  };
}

export async function getAllAccounts() {
  const rows = await allAsync('SELECT * FROM accounts');
  return rows.map((r) => ({
    ...r,
    points: Number(r.points || 0),
    invites: Number(r.invites || 0),
    completedTasks: r.completedTasks ? JSON.parse(r.completedTasks) : [],
    meme: r.meme ? JSON.parse(r.meme) : { title: 'No meme submission', status: 'pending' },
  }));
}

export async function findAccountByWallet(wallet) {
  if (!wallet) return null;
  const row = await getAsync('SELECT * FROM accounts WHERE lower(wallet) = lower(?) LIMIT 1', [wallet]);
  if (!row) return null;
  return {
    ...row,
    points: Number(row.points || 0),
    invites: Number(row.invites || 0),
    completedTasks: row.completedTasks ? JSON.parse(row.completedTasks) : [],
    meme: row.meme ? JSON.parse(row.meme) : { title: 'No meme submission', status: 'pending' },
  };
}

export async function upsertAccount(account) {
  const payload = {
    id: account.id || account.wallet,
    username: account.username || '',
    wallet: account.wallet || '',
    xUsername: account.xUsername || '',
    telegramUsername: account.telegramUsername || '',
    points: account.points || 0,
    invites: account.invites || 0,
    completedTasks: JSON.stringify(account.completedTasks || []),
    meme: JSON.stringify(account.meme || { title: 'No meme submission', status: 'pending' }),
    passcodeHash: account.passcodeHash || null,
    signedUpAt: account.signedUpAt || new Date().toISOString(),
    updatedAt: account.updatedAt || new Date().toISOString(),
  };

  await runAsync(
    `INSERT INTO accounts (id, username, wallet, xUsername, telegramUsername, points, invites, completedTasks, meme, passcodeHash, signedUpAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       username=excluded.username,
       wallet=excluded.wallet,
       xUsername=excluded.xUsername,
       telegramUsername=excluded.telegramUsername,
       points=excluded.points,
       invites=excluded.invites,
       completedTasks=excluded.completedTasks,
       meme=excluded.meme,
       passcodeHash=COALESCE(excluded.passcodeHash, accounts.passcodeHash),
       signedUpAt=COALESCE(accounts.signedUpAt, excluded.signedUpAt),
       updatedAt=excluded.updatedAt
    `,
    [
      payload.id,
      payload.username,
      payload.wallet,
      payload.xUsername,
      payload.telegramUsername,
      payload.points,
      payload.invites,
      payload.completedTasks,
      payload.meme,
      payload.passcodeHash,
      payload.signedUpAt,
      payload.updatedAt,
    ]
  );
}

export async function upsertManualAccount(account) {
  // same as upsertAccount but ensures passcodeHash is stored
  await upsertAccount(account);
}
