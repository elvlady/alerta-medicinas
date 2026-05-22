import { Database } from "bun:sqlite";
import webpush from "web-push";
import { existsSync, mkdirSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID, pbkdf2Sync, timingSafeEqual } from "node:crypto";

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), "data");
const DB_PATH = process.env.DATABASE_PATH || join(DATA_DIR, "app.sqlite");
const APP_TIMEZONE = process.env.APP_TIMEZONE || "America/Chihuahua";
const SESSION_DAYS = 30;
const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));

mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA synchronous = NORMAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS medicines (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  dose TEXT NOT NULL DEFAULT '',
  time_of_day TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  last_notified_on TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS medicines_user_idx ON medicines(user_id);
CREATE INDEX IF NOT EXISTS medicines_due_idx ON medicines(active, time_of_day, last_notified_on);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  auth_token TEXT NOT NULL,
  content_encoding TEXT NOT NULL DEFAULT 'aes128gcm',
  user_agent TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions(user_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function base64Url(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

function hashPassword(password) {
  const salt = base64Url(randomBytes(18));
  const iterations = 210000;
  const hash = base64Url(pbkdf2Sync(password, fromBase64Url(salt), iterations, 32, "sha256"));
  return `pbkdf2-sha256$${iterations}$${salt}$${hash}`;
}

function verifyPassword(password, encoded) {
  const parts = encoded.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2-sha256") {
    return false;
  }
  const iterations = Number(parts[1]);
  const salt = fromBase64Url(parts[2]);
  const expected = fromBase64Url(parts[3]);
  const actual = pbkdf2Sync(password, salt, iterations, expected.length, "sha256");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function parseCookies(header) {
  const cookies = {};
  for (const part of (header || "").split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return cookies;
}

function secureCookie(req) {
  const proto = req.headers.get("x-forwarded-proto") || new URL(req.url).protocol.replace(":", "");
  return proto === "https";
}

function sessionCookie(sid, req) {
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  const secure = secureCookie(req) ? "; Secure" : "";
  return `med_session=${encodeURIComponent(sid)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function clearSessionCookie(req) {
  const secure = secureCookie(req) ? "; Secure" : "";
  return `med_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

function userCount() {
  return db.query("SELECT COUNT(*) AS total FROM users").get().total;
}

function publicUser(user) {
  return { id: user.id, username: user.username, name: user.name };
}

function getUserFromRequest(req) {
  const sid = parseCookies(req.headers.get("cookie")).med_session;
  if (!sid) return null;
  const session = db
    .query("SELECT user_id, expires_at FROM sessions WHERE sid = $sid")
    .get({ $sid: sid });
  if (!session || session.expires_at < Date.now()) {
    db.query("DELETE FROM sessions WHERE sid = $sid").run({ $sid: sid });
    return null;
  }
  return db
    .query("SELECT id, username, name FROM users WHERE id = $id")
    .get({ $id: session.user_id }) || null;
}

function requireUser(req) {
  const user = getUserFromRequest(req);
  if (!user) {
    throw new AppError(401, "Necesitas iniciar sesion.");
  }
  return user;
}

function createSession(userId) {
  const sid = base64Url(randomBytes(32));
  const expiresAt = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  db.query("INSERT INTO sessions (sid, user_id, expires_at, created_at) VALUES ($sid, $userId, $expiresAt, $createdAt)")
    .run({ $sid: sid, $userId: userId, $expiresAt: expiresAt, $createdAt: nowIso() });
  return sid;
}

async function readJson(req) {
  try {
    return await req.json();
  } catch {
    throw new AppError(400, "JSON invalido.");
  }
}

function requireString(data, key, label) {
  const value = String(data[key] || "").trim();
  if (!value) {
    throw new AppError(400, `${label} es requerido.`);
  }
  return value;
}

function normalizeTime(value) {
  const time = String(value || "").trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new AppError(400, "La hora debe tener formato HH:MM.");
  }
  return time;
}

function normalizeMedicine(row) {
  return {
    id: row.id,
    name: row.name,
    dose: row.dose,
    timeOfDay: row.time_of_day,
    notes: row.notes,
    active: Boolean(row.active),
    lastNotifiedOn: row.last_notified_on || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getSetting(key) {
  const row = db.query("SELECT value FROM settings WHERE key = $key").get({ $key: key });
  return row ? row.value : "";
}

function setSetting(key, value) {
  db.query(`
    INSERT INTO settings (key, value) VALUES ($key, $value)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run({ $key: key, $value: value });
}

function setupVapid() {
  let publicKey = process.env.VAPID_PUBLIC_KEY || getSetting("vapid_public_key");
  let privateKey = process.env.VAPID_PRIVATE_KEY || getSetting("vapid_private_key");

  if (!publicKey || !privateKey) {
    const generated = webpush.generateVAPIDKeys();
    publicKey = generated.publicKey;
    privateKey = generated.privateKey;
    setSetting("vapid_public_key", publicKey);
    setSetting("vapid_private_key", privateKey);
  }

  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || "mailto:admin@example.com",
    publicKey,
    privateKey,
  );
  return publicKey;
}

const vapidPublicKey = setupVapid();

function timezoneParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});

  return {
    today: `${parts.year}-${parts.month}-${parts.day}`,
    timeOfDay: `${parts.hour}:${parts.minute}`,
  };
}

async function sendPush(subscription, payload) {
  try {
    await webpush.sendNotification({
      endpoint: subscription.endpoint,
      keys: {
        p256dh: subscription.public_key,
        auth: subscription.auth_token,
      },
      contentEncoding: subscription.content_encoding || "aes128gcm",
    }, JSON.stringify(payload), {
      TTL: 86400,
      urgency: "high",
    });
    return true;
  } catch (error) {
    if (error && (error.statusCode === 404 || error.statusCode === 410)) {
      db.query("DELETE FROM push_subscriptions WHERE endpoint = $endpoint")
        .run({ $endpoint: subscription.endpoint });
    }
    console.error("push failed", error?.message || error);
    return false;
  }
}

let reminderRunning = false;

async function sendDueReminders() {
  if (reminderRunning) return;
  reminderRunning = true;
  try {
    const { today, timeOfDay } = timezoneParts();
    const medicines = db.query(`
      SELECT id, user_id, name, dose, notes
      FROM medicines
      WHERE active = 1
        AND time_of_day = $timeOfDay
        AND (last_notified_on IS NULL OR last_notified_on <> $today)
      ORDER BY user_id, name
    `).all({ $timeOfDay: timeOfDay, $today: today });

    for (const medicine of medicines) {
      const subscriptions = db.query(`
        SELECT endpoint, public_key, auth_token, content_encoding
        FROM push_subscriptions
        WHERE user_id = $userId
      `).all({ $userId: medicine.user_id });

      let delivered = false;
      const body = [medicine.name, medicine.dose, medicine.notes].filter(Boolean).join(" - ");
      for (const subscription of subscriptions) {
        const ok = await sendPush(subscription, {
          title: "Hora de medicina",
          body,
          tag: `medicine-${medicine.id}-${today}`,
          url: "/",
        });
        delivered = delivered || ok;
      }

      if (delivered) {
        db.query("UPDATE medicines SET last_notified_on = $today, updated_at = $updatedAt WHERE id = $id")
          .run({ $today: today, $updatedAt: nowIso(), $id: medicine.id });
      }
    }
  } finally {
    reminderRunning = false;
  }
}

setInterval(sendDueReminders, 20 * 1000);
sendDueReminders();

async function handleApi(req, url) {
  const method = req.method.toUpperCase();
  const path = url.pathname;

  if (path === "/api/health") {
    return json({ ok: true, storage: DB_PATH, timezone: APP_TIMEZONE });
  }

  if (path === "/api/me" && method === "GET") {
    const user = getUserFromRequest(req);
    return json({
      ok: true,
      authenticated: Boolean(user),
      setupRequired: userCount() === 0,
      user: user ? publicUser(user) : null,
      pushPublicKey: vapidPublicKey,
    });
  }

  if (path === "/api/setup" && method === "POST") {
    if (userCount() > 0) {
      throw new AppError(409, "La app ya esta configurada.");
    }
    const data = await readJson(req);
    const username = requireString(data, "username", "Usuario").toLowerCase();
    const password = requireString(data, "password", "Contrasena");
    if (password.length < 8) {
      throw new AppError(400, "La contrasena debe tener al menos 8 caracteres.");
    }
    const id = randomUUID();
    const name = String(data.name || username).trim();
    db.query(`
      INSERT INTO users (id, username, name, password_hash, created_at)
      VALUES ($id, $username, $name, $passwordHash, $createdAt)
    `).run({
      $id: id,
      $username: username,
      $name: name,
      $passwordHash: hashPassword(password),
      $createdAt: nowIso(),
    });
    const sid = createSession(id);
    return json({ ok: true }, 201, { "set-cookie": sessionCookie(sid, req) });
  }

  if (path === "/api/login" && method === "POST") {
    const data = await readJson(req);
    const username = requireString(data, "username", "Usuario").toLowerCase();
    const password = requireString(data, "password", "Contrasena");
    const user = db.query("SELECT * FROM users WHERE username = $username").get({ $username: username });
    if (!user || !verifyPassword(password, user.password_hash)) {
      throw new AppError(401, "Usuario o contrasena incorrectos.");
    }
    const sid = createSession(user.id);
    return json({ ok: true, user: publicUser(user) }, 200, { "set-cookie": sessionCookie(sid, req) });
  }

  if (path === "/api/logout" && method === "POST") {
    const sid = parseCookies(req.headers.get("cookie")).med_session;
    if (sid) {
      db.query("DELETE FROM sessions WHERE sid = $sid").run({ $sid: sid });
    }
    return json({ ok: true }, 200, { "set-cookie": clearSessionCookie(req) });
  }

  const user = requireUser(req);

  if (path === "/api/medicines" && method === "GET") {
    const medicines = db.query(`
      SELECT * FROM medicines
      WHERE user_id = $userId
      ORDER BY active DESC, time_of_day ASC, name ASC
    `).all({ $userId: user.id }).map(normalizeMedicine);
    return json({ ok: true, medicines });
  }

  if (path === "/api/medicines" && method === "POST") {
    const data = await readJson(req);
    const id = randomUUID();
    const timestamp = nowIso();
    db.query(`
      INSERT INTO medicines (id, user_id, name, dose, time_of_day, notes, active, created_at, updated_at)
      VALUES ($id, $userId, $name, $dose, $timeOfDay, $notes, $active, $createdAt, $updatedAt)
    `).run({
      $id: id,
      $userId: user.id,
      $name: requireString(data, "name", "Nombre"),
      $dose: String(data.dose || "").trim(),
      $timeOfDay: normalizeTime(data.timeOfDay),
      $notes: String(data.notes || "").trim(),
      $active: data.active === false ? 0 : 1,
      $createdAt: timestamp,
      $updatedAt: timestamp,
    });
    const medicine = db.query("SELECT * FROM medicines WHERE id = $id").get({ $id: id });
    return json({ ok: true, medicine: normalizeMedicine(medicine) }, 201);
  }

  const medicineMatch = path.match(/^\/api\/medicines\/([^/]+)$/);
  if (medicineMatch && (method === "PUT" || method === "PATCH")) {
    const id = medicineMatch[1];
    const data = await readJson(req);
    const existing = db.query("SELECT id FROM medicines WHERE id = $id AND user_id = $userId")
      .get({ $id: id, $userId: user.id });
    if (!existing) throw new AppError(404, "Medicina no encontrada.");
    db.query(`
      UPDATE medicines
      SET name = $name, dose = $dose, time_of_day = $timeOfDay, notes = $notes, active = $active, updated_at = $updatedAt
      WHERE id = $id AND user_id = $userId
    `).run({
      $id: id,
      $userId: user.id,
      $name: requireString(data, "name", "Nombre"),
      $dose: String(data.dose || "").trim(),
      $timeOfDay: normalizeTime(data.timeOfDay),
      $notes: String(data.notes || "").trim(),
      $active: data.active === false ? 0 : 1,
      $updatedAt: nowIso(),
    });
    const medicine = db.query("SELECT * FROM medicines WHERE id = $id").get({ $id: id });
    return json({ ok: true, medicine: normalizeMedicine(medicine) });
  }

  if (medicineMatch && method === "DELETE") {
    const id = medicineMatch[1];
    db.query("DELETE FROM medicines WHERE id = $id AND user_id = $userId")
      .run({ $id: id, $userId: user.id });
    return json({ ok: true });
  }

  if (path === "/api/push/subscribe" && method === "POST") {
    const data = await readJson(req);
    const subscription = data.subscription || {};
    const keys = subscription.keys || {};
    const endpoint = String(subscription.endpoint || "").trim();
    const publicKey = String(keys.p256dh || "").trim();
    const authToken = String(keys.auth || "").trim();
    if (!endpoint || !publicKey || !authToken) {
      throw new AppError(400, "Suscripcion push incompleta.");
    }
    const timestamp = nowIso();
    db.query(`
      INSERT INTO push_subscriptions (id, user_id, endpoint, public_key, auth_token, content_encoding, user_agent, created_at, updated_at, last_seen_at)
      VALUES ($id, $userId, $endpoint, $publicKey, $authToken, $contentEncoding, $userAgent, $createdAt, $updatedAt, $lastSeenAt)
      ON CONFLICT(endpoint) DO UPDATE SET
        user_id = excluded.user_id,
        public_key = excluded.public_key,
        auth_token = excluded.auth_token,
        content_encoding = excluded.content_encoding,
        user_agent = excluded.user_agent,
        updated_at = excluded.updated_at,
        last_seen_at = excluded.last_seen_at
    `).run({
      $id: randomUUID(),
      $userId: user.id,
      $endpoint: endpoint,
      $publicKey: publicKey,
      $authToken: authToken,
      $contentEncoding: subscription.contentEncoding || "aes128gcm",
      $userAgent: req.headers.get("user-agent") || "",
      $createdAt: timestamp,
      $updatedAt: timestamp,
      $lastSeenAt: timestamp,
    });
    return json({ ok: true });
  }

  if (path === "/api/push/test" && method === "POST") {
    const subscriptions = db.query(`
      SELECT endpoint, public_key, auth_token, content_encoding
      FROM push_subscriptions
      WHERE user_id = $userId
    `).all({ $userId: user.id });
    let sent = 0;
    for (const subscription of subscriptions) {
      if (await sendPush(subscription, {
        title: "Notificaciones listas",
        body: "Tus recordatorios de medicinas ya pueden llegar aqui.",
        tag: "push-test",
        url: "/",
      })) {
        sent++;
      }
    }
    return json({ ok: true, sent });
  }

  throw new AppError(404, "Ruta no encontrada.");
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

async function serveStatic(url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  if (pathname.includes("..")) {
    return new Response("Not found", { status: 404 });
  }
  let filePath = join(PUBLIC_DIR, pathname);
  let file = Bun.file(filePath);

  if (!(await file.exists()) && extname(pathname) === "") {
    filePath = join(PUBLIC_DIR, "index.html");
    file = Bun.file(filePath);
  }

  if (!(await file.exists())) {
    return new Response("Not found", { status: 404 });
  }

  return new Response(file, {
    headers: {
      "content-type": mimeTypes[extname(filePath)] || "application/octet-stream",
      "cache-control": pathname === "/sw.js" ? "no-cache" : "public, max-age=3600",
    },
  });
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    try {
      if (url.pathname.startsWith("/api/")) {
        return await handleApi(req, url);
      }
      return await serveStatic(url);
    } catch (error) {
      const status = error instanceof AppError ? error.status : 500;
      if (!(error instanceof AppError)) {
        console.error(error);
      }
      return json({ ok: false, error: error.message || "Error interno." }, status);
    }
  },
});

console.log(`Alerta Medicinas listo en http://0.0.0.0:${PORT}`);
console.log(`SQLite: ${DB_PATH}`);
