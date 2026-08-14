import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, scrypt, timingSafeEqual, webcrypto, createHash } from "node:crypto";
import bcrypt from 'bcryptjs';
import { promisify } from "node:util";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.env.PORT || 3030);
const DATA_DIR = join(__dirname, "data");
const ACCOUNTS_FILE = join(DATA_DIR, "accounts.json");
const sessions = new Map();
const nonces = new Map();
const scryptAsync = promisify(scrypt);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
};

const base58Alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

// Use SQLite for accounts storage. db.js exposes initDb, getAllAccounts, findAccountByWallet, upsertAccount, upsertManualAccount
import { initDb, getAllAccounts, findAccountByWallet, upsertAccount, upsertManualAccount, createEmailVerification, findEmailVerificationByHash, markEmailVerificationUsed, createOtp, getLatestOtpForEmail, incrementOtpAttempts, markOtpUsed, invalidateOtpsForEmail, findAccountByEmail } from './db.js';

// read/write helpers replaced by DB-backed implementations
import nodemailer from 'nodemailer';

async function sendVerificationEmail({ requestHost, baseUrl, email, token }) {
  const smtpHost = process.env.SMTP_HOST;
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;

  const verifyUrl = `${baseUrl || `http://${requestHost}`}/api/auth/verify-email?token=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}`;
  const subject = 'Verify your Kenny airdrop email';
  const text = `Click to verify your email: ${verifyUrl}`;
  const html = `<p>Click the link below to verify your email for Kenny the Cat Airdrop:</p><p><a href="${verifyUrl}">${verifyUrl}</a></p>`;

  if (!smtpHost || !smtpUser || !smtpPass) {
    // Fallback: log the verification URL to console when no SMTP configured
    console.log('Verification URL for', email, verifyUrl);
    return;
  }

  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: smtpUser,
      pass: smtpPass,
    },
  });

  await transporter.sendMail({
    from: process.env.SMTP_FROM || smtpUser,
    to: email,
    subject,
    text,
    html,
  });
}

// Send numeric OTP email
async function sendOtpEmail({ requestHost, baseUrl, email, otp }) {
  const smtpHost = process.env.SMTP_HOST;
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;

  const subject = 'Your Kenny verification code';
  const text = `Your verification code is: ${otp}\nIt expires in 10 minutes.`;
  const html = `<p>Your verification code is: <strong>${otp}</strong></p><p>It expires in 10 minutes.</p>`;

  if (!smtpHost || !smtpUser || !smtpPass) {
    console.log('OTP for', email, otp);
    return;
  }

  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: smtpUser,
      pass: smtpPass,
    },
  });

  await transporter.sendMail({
    from: process.env.SMTP_FROM || smtpUser,
    to: email,
    subject,
    text,
    html,
  });
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    ...corsHeaders(),
  });
  response.end(JSON.stringify(body));
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

async function readJsonBody(request) {
  let raw = "";

  for await (const chunk of request) {
    raw += chunk;
  }

  return raw ? JSON.parse(raw) : {};
}

function decodeBase58(value) {
  const bytes = [0];

  for (const char of value) {
    const carryIndex = base58Alphabet.indexOf(char);

    if (carryIndex < 0) {
      throw new Error("Invalid base58 character");
    }

    let carry = carryIndex;

    for (let index = 0; index < bytes.length; index += 1) {
      carry += bytes[index] * 58;
      bytes[index] = carry & 0xff;
      carry >>= 8;
    }

    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  for (const char of value) {
    if (char !== "1") {
      break;
    }

    bytes.push(0);
  }

  return new Uint8Array(bytes.reverse());
}

function createMessage(wallet, nonce) {
  return [
    "Sign in to Kenny the Cat Coin Airdrop.",
    `Wallet: ${wallet}`,
    `Nonce: ${nonce}`,
  ].join("\n");
}

async function verifyWalletSignature({ wallet, message, signature }) {
  const nonceRecord = nonces.get(wallet);

  if (!nonceRecord || nonceRecord.expiresAt < Date.now()) {
    return false;
  }

  if (nonceRecord.message !== message) {
    return false;
  }

  const publicKeyBytes = decodeBase58(wallet);
  const signatureBytes = Uint8Array.from(signature);
  const messageBytes = new TextEncoder().encode(message);
  const publicKey = await webcrypto.subtle.importKey("raw", publicKeyBytes, "Ed25519", false, ["verify"]);
  const verified = await webcrypto.subtle.verify("Ed25519", publicKey, signatureBytes, messageBytes);

  if (verified) {
    nonces.delete(wallet);
  }

  return verified;
}

function createSession(wallet) {
  const token = randomBytes(32).toString("hex");
  sessions.set(token, { wallet, expiresAt: Date.now() + 1000 * 60 * 60 * 24 * 7 });
  return token;
}

async function hashPasscode(passcode) {
  // legacy scrypt-based hash for compatibility (not used for new accounts)
  const salt = randomBytes(16).toString("hex");
  const derivedKey = await scryptAsync(passcode, salt, 64);
  return `${salt}:${derivedKey.toString("hex")}`;
}

async function verifyPasscode(passcode, storedHash) {
  if (!storedHash) return false;

  // If bcrypt hash (starts with $2), use bcrypt
  if (storedHash.startsWith('$2')) {
    try {
      return await bcrypt.compare(passcode, storedHash);
    } catch (e) {
      return false;
    }
  }

  // Legacy scrypt format: salt:hex
  if (storedHash.includes(':')) {
    const [salt, hash] = storedHash.split(":");
    const derivedKey = await scryptAsync(passcode, salt, 64);
    const storedKey = Buffer.from(hash, "hex");

    if (storedKey.length !== derivedKey.length) {
      return false;
    }

    const ok = timingSafeEqual(storedKey, derivedKey);

    // On successful legacy auth, rehash with bcrypt for storage
    return ok;
  }

  return false;
}

function publicAccount(account) {
  const { passcodeHash, ...safeAccount } = account;
  return safeAccount;
}

function requireSession(request) {
  const authHeader = request.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const session = sessions.get(token);

  if (!session || session.expiresAt < Date.now()) {
    return null;
  }

  return session;
}

async function handleApi(request, response, url) {
  if (request.method === "OPTIONS") {
    response.writeHead(204, corsHeaders());
    response.end();
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/auth/nonce") {
    const wallet = url.searchParams.get("wallet");

    if (!wallet) {
      sendJson(response, 400, { error: "wallet is required" });
      return;
    }

    const nonce = randomBytes(16).toString("hex");
    const message = createMessage(wallet, nonce);
    nonces.set(wallet, { message, expiresAt: Date.now() + 1000 * 60 * 5 });
    sendJson(response, 200, { message });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/auth/send-verification") {
    const body = await readJsonBody(request);
    const email = String(body.email || "").trim();
    const wallet = String(body.wallet || "").trim() || null;

    if (!email) {
      sendJson(response, 400, { error: 'email is required' });
      return;
    }

    // generate token and store only hash
    const token = randomBytes(24).toString('hex');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const expiresAt = Date.now() + 1000 * 60 * 60 * 24; // 24h

    await createEmailVerification({ email, wallet, tokenHash, expiresAt });

    const host = request.headers.host || `localhost:${PORT}`;
    const baseUrl = process.env.BASE_URL || `http://${host}`;

    try {
      await sendVerificationEmail({ requestHost: host, baseUrl, email, token });
    } catch (error) {
      console.error('Failed to send verification email:', error.message);
    }

    // Do not reveal account existence — respond generic success
    sendJson(response, 200, { success: true });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/auth/verify-email") {
    const token = String(url.searchParams.get('token') || '');
    const email = String(url.searchParams.get('email') || '').trim();

    if (!token || !email) {
      sendJson(response, 400, { error: 'token and email are required' });
      return;
    }

    const tokenHash = createHash('sha256').update(token).digest('hex');
    const record = await findEmailVerificationByHash(tokenHash);

    if (!record) {
      sendJson(response, 400, { error: 'Invalid or expired token' });
      return;
    }

    if (record.usedAt) {
      sendJson(response, 400, { error: 'Token already used' });
      return;
    }

    if (record.expiresAt < Date.now()) {
      sendJson(response, 400, { error: 'Token expired' });
      return;
    }

    // mark used
    await markEmailVerificationUsed(record.id);

    // mark account as verified
    const wallet = record.wallet;
    let account = null;

    if (wallet) {
      account = await findAccountByWallet(wallet);
    }

    if (!account) {
      // create a minimal account tied to wallet/email if needed
      const acct = {
        id: wallet || email,
        username: (account && account.username) || email.split('@')[0],
        wallet: wallet || null,
        email,
        emailVerified: 1,
        emailVerifiedAt: new Date().toISOString(),
        points: account ? account.points : 0,
        invites: account ? account.invites : 0,
        completedTasks: account ? account.completedTasks : [],
        meme: account ? account.meme : { title: 'No meme submission', status: 'pending' },
      };
      await upsertAccount(acct);
      sendJson(response, 200, { success: true });
      return;
    }

    account.email = email;
    account.emailVerified = 1;
    account.emailVerifiedAt = new Date().toISOString();
    await upsertAccount(account);

    sendJson(response, 200, { success: true });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/auth/wallet") {
      const body = await readJsonBody(request);
      const verified = await verifyWalletSignature(body);

      if (!verified) {
        sendJson(response, 401, { error: "Wallet signature could not be verified" });
        return;
      }

      const account = await findAccountByWallet(body.wallet);

      if (!account) {
        sendJson(response, 404, { error: "No account exists for this wallet" });
        return;
      }

      sendJson(response, 200, { token: createSession(body.wallet), account });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/auth/signup") {
      // Create account and send OTP
      const body = await readJsonBody(request);
      const name = String(body.name || "").trim();
      const email = String(body.email || "").trim();
      const password = String(body.password || "");
      const wallet = String(body.wallet || "").trim() || null;

      // Basic validation
      if (!name || !email || !password) {
        sendJson(response, 400, { error: 'name, email, and password are required' });
        return;
      }

      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        sendJson(response, 400, { error: 'invalid email' });
        return;
      }

      if (password.length < 8) {
        sendJson(response, 400, { error: 'password must be at least 8 characters' });
        return;
      }

      const existing = await findAccountByEmail(email);

      if (existing) {
        // Do not auto-verify; reject to avoid duplicate registrations
        sendJson(response, 400, { error: 'Email already registered' });
        return;
      }

      // Hash password with bcrypt for new accounts
      const passHash = await bcrypt.hash(password, 12);

      const account = {
        id: wallet || email,
        username: name,
        wallet: wallet,
        email,
        emailVerified: 0,
        emailVerifiedAt: null,
        passcodeHash: passHash,
        signedUpAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await upsertAccount(account);

      // generate 6-digit OTP
      const rawOtp = String(Math.floor(100000 + Math.random() * 900000));
      const salt = randomBytes(8).toString('hex');
      const otpHash = createHash('sha256').update(salt + rawOtp).digest('hex');
      const expiresAt = Date.now() + 1000 * 60 * 10; // 10 minutes

      await createOtp({ email, wallet, otpHash, salt, expiresAt, maxAttempts: 5 });

      // send email
      const host = request.headers.host || `localhost:${PORT}`;
      const baseUrl = process.env.BASE_URL || `http://${host}`;
      try {
        await sendOtpEmail({ requestHost: host, baseUrl, email, otp: rawOtp });
      } catch (err) {
        console.error('Failed to send OTP email:', err.message);
      }

      // generic success
      sendJson(response, 200, { success: true });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/auth/send-otp") {
      // Resend OTP (cooldown & invalidate previous)
      const body = await readJsonBody(request);
      const email = String(body.email || "").trim();
      const wallet = String(body.wallet || "").trim() || null;

      if (!email) {
        sendJson(response, 400, { error: 'email is required' });
        return;
      }

      const last = await getLatestOtpForEmail(email);
      const now = Date.now();
      const cooldownMs = 60 * 1000; // 60s

      if (last && now - (last.createdAt || 0) < cooldownMs) {
        sendJson(response, 429, { error: 'Please wait before requesting another code' });
        return;
      }

      // generate and store new OTP
      const rawOtp = String(Math.floor(100000 + Math.random() * 900000));
      const salt = randomBytes(8).toString('hex');
      const otpHash = createHash('sha256').update(salt + rawOtp).digest('hex');
      const expiresAt = Date.now() + 1000 * 60 * 10; // 10 minutes

      await createOtp({ email, wallet, otpHash, salt, expiresAt, maxAttempts: 5 });

      try {
        await sendOtpEmail({ requestHost: request.headers.host || `localhost:${PORT}`, baseUrl: process.env.BASE_URL || null, email, otp: rawOtp });
      } catch (err) {
        console.error('Failed to send OTP email:', err.message);
      }

      sendJson(response, 200, { success: true });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/auth/verify-otp") {
      const body = await readJsonBody(request);
      const email = String(body.email || "").trim();
      const otp = String(body.otp || "").trim();

      if (!email || !otp) {
        sendJson(response, 400, { error: 'email and otp are required' });
        return;
      }

      const record = await getLatestOtpForEmail(email);

      if (!record) {
        sendJson(response, 400, { error: 'Invalid or expired code' });
        return;
      }

      if (record.usedAt) {
        sendJson(response, 400, { error: 'Code already used' });
        return;
      }

      if (record.expiresAt < Date.now()) {
        sendJson(response, 400, { error: 'Code expired' });
        return;
      }

      if ((record.attempts || 0) >= (record.maxAttempts || 5)) {
        sendJson(response, 429, { error: 'Too many attempts' });
        return;
      }

      const candidateHash = createHash('sha256').update((record.salt || '') + otp).digest('hex');

      if (!timingSafeEqual(Buffer.from(candidateHash, 'hex'), Buffer.from(record.otpHash, 'hex'))) {
        await incrementOtpAttempts(record.id);
        const updated = await getLatestOtpForEmail(email);
        if ((updated.attempts || 0) >= (updated.maxAttempts || 5)) {
          await markOtpUsed(updated.id);
          sendJson(response, 429, { error: 'Too many attempts, code invalidated' });
          return;
        }

        sendJson(response, 401, { error: 'Incorrect code' });
        return;
      }

      // success
      await markOtpUsed(record.id);

      // mark account verified
      const account = await findAccountByEmail(email);
      if (account) {
        account.emailVerified = 1;
        account.emailVerifiedAt = new Date().toISOString();
        await upsertAccount(account);
        // create session token and return account
        const token = createSession(account.wallet || account.email || account.id);
        sendJson(response, 200, { success: true, token, account: publicAccount(account) });
        return;
      }

      sendJson(response, 200, { success: true });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/auth/manual") {
      const body = await readJsonBody(request);
      const wallet = String(body.wallet || "").trim();
      const passcode = String(body.passcode || "");

      if (!wallet || !passcode) {
        sendJson(response, 400, { error: "wallet and passcode are required" });
        return;
      }

      const account = await findAccountByWallet(wallet);

      if (!account) {
        sendJson(response, 404, { error: "No account exists for this wallet. Please sign up first." });
        return;
      }

      if (!(await verifyPasscode(passcode, account.passcodeHash))) {
        sendJson(response, 401, { error: "Incorrect wallet or passcode." });
        return;
      }

      if (!account.emailVerified) {
        sendJson(response, 403, { error: "Email not verified. Check your inbox for the verification code." });
        return;
      }

      sendJson(response, 200, { token: createSession(account.wallet), account: publicAccount(account) });
      return;
    }
  if (request.method === "POST" && url.pathname === "/api/accounts") {
      const body = await readJsonBody(request);
      const verified = await verifyWalletSignature(body);

      if (!verified) {
        sendJson(response, 401, { error: "Wallet signature could not be verified" });
        return;
      }

      const existing = await findAccountByWallet(body.wallet);
      const account = {
        id: body.wallet,
        username: body.username,
        wallet: body.wallet,
        xUsername: body.xUsername || "",
        telegramUsername: body.telegramUsername || "",
        points: existing ? existing.points : 0,
        invites: existing ? existing.invites : 0,
        completedTasks: existing ? existing.completedTasks : [],
        meme: existing ? existing.meme : { title: "No meme submission", status: "pending" },
        signedUpAt: existing ? existing.signedUpAt : new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await upsertAccount(account);
      sendJson(response, 200, { token: createSession(body.wallet), account });
      return;
    }

  if (request.method === "POST" && url.pathname === "/api/accounts/manual") {
    const body = await readJsonBody(request);
    const wallet = String(body.wallet || "").trim();
    const username = String(body.username || "").trim();
    const passcode = String(body.passcode || "");

    if (!wallet || !username || !passcode) {
      sendJson(response, 400, { error: "username, wallet, and passcode are required" });
      return;
    }

    if (passcode.length < 4) {
      sendJson(response, 400, { error: "passcode must be at least 4 characters" });
      return;
    }

    const existing = await findAccountByWallet(wallet);
    const account = {
      id: wallet,
      username,
      wallet,
      xUsername: body.xUsername || "",
      telegramUsername: body.telegramUsername || "",
      points: existing ? existing.points : 0,
      invites: existing ? existing.invites : 0,
      completedTasks: existing ? existing.completedTasks : [],
      meme: existing ? existing.meme : { title: "No meme submission", status: "pending" },
      passcodeHash: await hashPasscode(passcode),
      signedUpAt: existing ? existing.signedUpAt : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await upsertManualAccount(account);
    sendJson(response, 200, { token: createSession(account.wallet), account: publicAccount(account) });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/accounts/me") {
    const session = requireSession(request);

    if (!session) {
      sendJson(response, 401, { error: "Not signed in" });
      return;
    }

    let account = await findAccountByWallet(session.wallet);
    if (!account && String(session.wallet || '').includes('@')) {
      account = await findAccountByEmail(session.wallet);
    }
    sendJson(response, account ? 200 : 404, account ? { account: publicAccount(account) } : { error: "Account not found" });
    return;
  }

  sendJson(response, 404, { error: "API route not found" });
}

async function serveStatic(request, response, url) {
  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const normalizedPath = normalize(decodeURIComponent(requestedPath))
    .replace(/^[/\\]+/, "")
    .replace(/^(\.\.[/\\])+/, "");
  const filePath = join(__dirname, normalizedPath);

  if (!filePath.startsWith(__dirname)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const file = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      Pragma: "no-cache",
      Expires: "0",
      ...corsHeaders(),
    });
    response.end(file);
  } catch (error) {
    response.writeHead(404);
    response.end("Not found");
  }
}

await initDb();

createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url);
      return;
    }

    await serveStatic(request, response, url);
  } catch (error) {
    sendJson(response, 500, { error: error.message });
  }
}).listen(PORT, () => {
  console.log(`Kenny site running at http://localhost:${PORT}`);
});
