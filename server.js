import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, scrypt, timingSafeEqual, webcrypto } from "node:crypto";
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
import { initDb, getAllAccounts, findAccountByWallet, upsertAccount, upsertManualAccount } from './db.js';

// read/write helpers replaced by DB-backed implementations

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
  const salt = randomBytes(16).toString("hex");
  const derivedKey = await scryptAsync(passcode, salt, 64);
  return `${salt}:${derivedKey.toString("hex")}`;
}

async function verifyPasscode(passcode, storedHash) {
  if (!storedHash || !storedHash.includes(":")) {
    return false;
  }

  const [salt, hash] = storedHash.split(":");
  const derivedKey = await scryptAsync(passcode, salt, 64);
  const storedKey = Buffer.from(hash, "hex");

  if (storedKey.length !== derivedKey.length) {
    return false;
  }

  return timingSafeEqual(storedKey, derivedKey);
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

    const account = await findAccountByWallet(session.wallet);
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
