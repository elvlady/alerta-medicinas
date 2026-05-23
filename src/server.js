import { Database } from "bun:sqlite";
import webpush from "web-push";
import { existsSync, mkdirSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes, randomUUID, pbkdf2Sync, timingSafeEqual } from "node:crypto";

const APP_TIMEZONE = process.env.APP_TIMEZONE || process.env.TZ || "America/Mazatlan";
process.env.TZ = APP_TIMEZONE;
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), "data");
const DB_PATH = process.env.DATABASE_PATH || join(DATA_DIR, "app.sqlite");
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
  treatment_id TEXT,
  name TEXT NOT NULL,
  dose TEXT NOT NULL DEFAULT '',
  time_of_day TEXT NOT NULL,
  interval_hours INTEGER NOT NULL DEFAULT 24,
  duration_days INTEGER,
  start_at TEXT,
  last_notified_at TEXT,
  next_reminder_at TEXT,
  notes TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  last_notified_on TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS medicines_user_idx ON medicines(user_id);
CREATE INDEX IF NOT EXISTS medicines_due_idx ON medicines(active, time_of_day, last_notified_on);

CREATE TABLE IF NOT EXISTS treatments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS treatments_user_idx ON treatments(user_id, start_at);

CREATE TABLE IF NOT EXISTS dose_completions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  medicine_id TEXT NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
  scheduled_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  UNIQUE(user_id, medicine_id, scheduled_at)
);

CREATE INDEX IF NOT EXISTS dose_completions_user_idx ON dose_completions(user_id, scheduled_at);

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

function ensureColumn(table, column, definition) {
  const exists = db.query(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
  if (!exists) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}

ensureColumn("medicines", "interval_hours", "interval_hours INTEGER NOT NULL DEFAULT 24");
ensureColumn("medicines", "duration_days", "duration_days INTEGER");
ensureColumn("medicines", "start_at", "start_at TEXT");
ensureColumn("medicines", "last_notified_at", "last_notified_at TEXT");
ensureColumn("medicines", "next_reminder_at", "next_reminder_at TEXT");
ensureColumn("medicines", "treatment_id", "treatment_id TEXT");
db.exec("CREATE INDEX IF NOT EXISTS medicines_next_reminder_idx ON medicines(active, next_reminder_at)");
db.exec("CREATE INDEX IF NOT EXISTS medicines_treatment_idx ON medicines(user_id, treatment_id)");

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

function normalizeClientId(value) {
  const clientId = String(value || "").trim();
  if (!/^[a-zA-Z0-9_-]{20,120}$/.test(clientId)) return "";
  return clientId;
}

function localUsername(clientId) {
  return `local_${base64Url(createHash("sha256").update(clientId).digest()).slice(0, 36)}`;
}

function getOrCreateLocalUser(clientId) {
  const username = localUsername(clientId);
  const existing = db.query("SELECT id, username, name FROM users WHERE username = $username")
    .get({ $username: username });
  if (existing) return existing;

  const id = randomUUID();
  const timestamp = nowIso();
  db.query(`
    INSERT INTO users (id, username, name, password_hash, created_at)
    VALUES ($id, $username, $name, $passwordHash, $createdAt)
  `).run({
    $id: id,
    $username: username,
    $name: "Dispositivo",
    $passwordHash: `local-device$${base64Url(randomBytes(24))}`,
    $createdAt: timestamp,
  });

  return { id, username, name: "Dispositivo" };
}

function syncAdminFromEnv() {
  const username = String(process.env.ADMIN_USERNAME || "").trim().toLowerCase();
  const password = String(process.env.ADMIN_PASSWORD || "");
  const name = String(process.env.ADMIN_NAME || username).trim();

  if (!username && !password) return;
  if (!username || !password) {
    console.warn("ADMIN_USERNAME y ADMIN_PASSWORD deben configurarse juntos; se omitio el admin por entorno.");
    return;
  }
  if (password.length < 8) {
    console.warn("ADMIN_PASSWORD debe tener al menos 8 caracteres; se omitio el admin por entorno.");
    return;
  }

  const existing = db.query("SELECT id FROM users WHERE username = $username").get({ $username: username });
  const passwordHash = hashPassword(password);
  const timestamp = nowIso();

  if (existing) {
    db.query("UPDATE users SET name = $name, password_hash = $passwordHash WHERE id = $id")
      .run({ $id: existing.id, $name: name || username, $passwordHash: passwordHash });
    db.query("DELETE FROM sessions WHERE user_id = $id").run({ $id: existing.id });
    console.log(`Admin ${username} actualizado desde variables de entorno.`);
    return;
  }

  const id = randomUUID();
  db.query(`
    INSERT INTO users (id, username, name, password_hash, created_at)
    VALUES ($id, $username, $name, $passwordHash, $createdAt)
  `).run({
    $id: id,
    $username: username,
    $name: name || username,
    $passwordHash: passwordHash,
    $createdAt: timestamp,
  });
  console.log(`Admin ${username} creado desde variables de entorno.`);
}

syncAdminFromEnv();

function getUserFromRequest(req) {
  const clientId = normalizeClientId(req.headers.get("x-client-id"));
  if (clientId) {
    return getOrCreateLocalUser(clientId);
  }

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
    throw new AppError(401, "No se pudo identificar este dispositivo.");
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

function normalizeIntervalHours(value) {
  const hours = Number(value);
  if (!Number.isInteger(hours) || hours < 1 || hours > 168) {
    throw new AppError(400, "Cada horas debe ser entre 1 y 168.");
  }
  return hours;
}

function normalizeDurationDays(value) {
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    throw new AppError(400, "Por tantos dias debe ser entre 1 y 3650.");
  }
  return days;
}

function addHoursIso(value, hours) {
  const date = new Date(value);
  date.setTime(date.getTime() + hours * 60 * 60 * 1000);
  return date.toISOString();
}

function addDaysIso(value, days) {
  const date = new Date(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function validIso(value) {
  return value && !Number.isNaN(Date.parse(value));
}

function startAtFromTime(value, fallback = new Date()) {
  const text = String(value || "").trim();
  const date = fallback instanceof Date ? new Date(fallback) : new Date(fallback);
  if (Number.isNaN(date.getTime())) {
    date.setTime(Date.now());
  }
  if (!text) return date.toISOString();

  const match = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (!match) throw new AppError(400, "Hora de inicio invalida.");

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    throw new AppError(400, "Hora de inicio invalida.");
  }
  date.setHours(hours, minutes, 0, 0);
  return date.toISOString();
}

function normalizeStartAtInput(data, fallback = new Date()) {
  const startAt = String(data.startAt || "").trim();
  if (validIso(startAt)) {
    return new Date(startAt).toISOString();
  }
  return startAtFromTime(data.startTime, fallback);
}

function normalizeDateInput(value, label, endOfDate = false) {
  const text = String(value || "").trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) throw new AppError(400, `${label} no es valida.`);

  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(year, month, day, endOfDate ? 23 : 0, endOfDate ? 59 : 0, endOfDate ? 59 : 0, endOfDate ? 999 : 0);
  if (Number.isNaN(date.getTime()) || date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) {
    throw new AppError(400, `${label} no es valida.`);
  }
  return date.toISOString();
}

function normalizeTreatmentDateInput(data, key, label, endOfDate = false) {
  const iso = String(data[key === "start" ? "startAt" : "endAt"] || "").trim();
  if (validIso(iso)) {
    const date = new Date(iso);
    if (endOfDate) date.setHours(23, 59, 59, 999);
    else date.setHours(0, 0, 0, 0);
    return date.toISOString();
  }
  return normalizeDateInput(data[key === "start" ? "startDate" : "endDate"], label, endOfDate);
}

function treatmentEndAt(row) {
  if (!validIso(row.start_at) || !row.duration_days) return null;
  const date = new Date(row.start_at);
  date.setDate(date.getDate() + Math.max(1, row.duration_days) - 1);
  date.setHours(23, 59, 59, 999);
  return date.toISOString();
}

function nextReminderForSchedule(startAt, intervalHours, durationDays, now = new Date()) {
  if (!validIso(startAt)) return addHoursIso(now.toISOString(), intervalHours);
  const intervalMs = Math.max(1, intervalHours || 24) * 60 * 60 * 1000;
  let nextMs = Date.parse(startAt);
  const graceMs = 60 * 1000;
  while (nextMs + graceMs < now.getTime()) {
    nextMs += intervalMs;
  }

  const endsAt = treatmentEndAt({ start_at: startAt, duration_days: durationDays });
  if (endsAt && nextMs > Date.parse(endsAt)) {
    return null;
  }
  return new Date(nextMs).toISOString();
}

function treatmentStatus(row, now = new Date()) {
  const startAt = validIso(row.start_at) ? new Date(row.start_at) : null;
  const endsAt = treatmentEndAt(row);

  if (startAt && now < startAt) return "pending";
  if (endsAt && now > new Date(endsAt)) return "completed";
  return "active";
}

function isTreatmentActiveOn(row, now) {
  return treatmentStatus(row, now) === "active";
}

function nextReminderAfter(row, now = new Date()) {
  const intervalHours = row.interval_hours || 24;
  let nextMs = Date.parse(row.next_reminder_at || addHoursIso(row.start_at || now.toISOString(), intervalHours));
  if (Number.isNaN(nextMs)) {
    nextMs = Date.parse(addHoursIso(now.toISOString(), intervalHours));
  }

  const intervalMs = intervalHours * 60 * 60 * 1000;
  while (nextMs <= now.getTime()) {
    nextMs += intervalMs;
  }

  const endsAt = treatmentEndAt(row);
  if (endsAt && nextMs > Date.parse(endsAt)) {
    return null;
  }
  return new Date(nextMs).toISOString();
}

function normalizeMedicine(row, completedDoses = []) {
  const intervalHours = row.interval_hours || 24;
  const durationDays = row.duration_days || 7;
  const startAt = row.start_at || row.created_at;
  const normalizedRow = { ...row, interval_hours: intervalHours, duration_days: durationDays, start_at: startAt };
  return {
    id: row.id,
    treatmentId: row.treatment_id || "",
    name: row.name,
    dose: row.dose,
    intervalHours,
    durationDays,
    startAt,
    endsAt: treatmentEndAt(normalizedRow),
    nextReminderAt: row.next_reminder_at || null,
    treatmentStatus: treatmentStatus(normalizedRow),
    notes: row.notes,
    active: Boolean(row.active),
    completedDoses,
    lastNotifiedAt: row.last_notified_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeTreatment(row) {
  return {
    id: row.id,
    name: row.name,
    startAt: row.start_at,
    endAt: row.end_at,
    notes: row.notes || "",
    active: Boolean(row.active),
    medicineCount: Number(row.medicine_count || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function requireTreatment(userId, treatmentId) {
  const id = String(treatmentId || "").trim();
  if (!id) throw new AppError(400, "Tratamiento requerido.");
  const treatment = db.query("SELECT * FROM treatments WHERE id = $id AND user_id = $userId")
    .get({ $id: id, $userId: userId });
  if (!treatment) throw new AppError(404, "Tratamiento no encontrado.");
  return treatment;
}

function backfillReminderSchedule() {
  const timestamp = nowIso();
  const nextReminderAt = addHoursIso(timestamp, 24);
  db.query(`
    UPDATE medicines
    SET interval_hours = COALESCE(interval_hours, 24),
        duration_days = COALESCE(duration_days, 7),
        start_at = COALESCE(start_at, created_at, $timestamp),
        next_reminder_at = COALESCE(next_reminder_at, $nextReminderAt)
    WHERE start_at IS NULL OR next_reminder_at IS NULL OR duration_days IS NULL
  `).run({ $timestamp: timestamp, $nextReminderAt: nextReminderAt });
}

backfillReminderSchedule();

function backfillTreatments() {
  const rows = db.query(`
    SELECT *
    FROM medicines
    WHERE treatment_id IS NULL OR treatment_id = ''
    ORDER BY user_id, start_at, created_at
  `).all();
  const byUser = new Map();
  for (const row of rows) {
    if (!byUser.has(row.user_id)) byUser.set(row.user_id, []);
    byUser.get(row.user_id).push(row);
  }

  for (const [userId, medicines] of byUser) {
    if (!medicines.length) continue;
    let startAt = null;
    let endAt = null;
    for (const medicine of medicines) {
      const medicineStart = validIso(medicine.start_at) ? new Date(medicine.start_at) : new Date(medicine.created_at);
      const medicineEndText = treatmentEndAt(medicine);
      const medicineEnd = medicineEndText ? new Date(medicineEndText) : medicineStart;
      if (!Number.isNaN(medicineStart.getTime()) && (!startAt || medicineStart < startAt)) startAt = medicineStart;
      if (!Number.isNaN(medicineEnd.getTime()) && (!endAt || medicineEnd > endAt)) endAt = medicineEnd;
    }

    const timestamp = nowIso();
    const id = randomUUID();
    db.query(`
      INSERT INTO treatments (id, user_id, name, start_at, end_at, notes, active, created_at, updated_at)
      VALUES ($id, $userId, $name, $startAt, $endAt, '', 1, $createdAt, $updatedAt)
    `).run({
      $id: id,
      $userId: userId,
      $name: "Tratamiento actual",
      $startAt: (startAt || new Date()).toISOString(),
      $endAt: (endAt || startAt || new Date()).toISOString(),
      $createdAt: timestamp,
      $updatedAt: timestamp,
    });
    db.query("UPDATE medicines SET treatment_id = $treatmentId WHERE user_id = $userId AND (treatment_id IS NULL OR treatment_id = '')")
      .run({ $treatmentId: id, $userId: userId });
  }
}

backfillTreatments();

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
    const now = new Date();
    const timestamp = now.toISOString();
    const medicines = db.query(`
      SELECT id, user_id, name, dose, notes, interval_hours, duration_days, start_at, next_reminder_at
      FROM medicines
      WHERE active = 1
        AND next_reminder_at IS NOT NULL
        AND next_reminder_at <= $now
      ORDER BY user_id, name
    `).all({ $now: timestamp });

    for (const medicine of medicines) {
      if (!isTreatmentActiveOn(medicine, now)) {
        db.query("UPDATE medicines SET active = 0, next_reminder_at = NULL, updated_at = $updatedAt WHERE id = $id")
          .run({ $updatedAt: timestamp, $id: medicine.id });
        continue;
      }

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
          tag: `medicine-${medicine.id}`,
          url: "/",
        });
        delivered = delivered || ok;
      }

      if (delivered) {
        const nextReminderAt = nextReminderAfter(medicine, now);
        db.query(`
          UPDATE medicines
          SET last_notified_at = $lastNotifiedAt,
              next_reminder_at = $nextReminderAt,
              active = $active,
              updated_at = $updatedAt
          WHERE id = $id
        `).run({
          $lastNotifiedAt: timestamp,
          $nextReminderAt: nextReminderAt,
          $active: nextReminderAt ? 1 : 0,
          $updatedAt: timestamp,
          $id: medicine.id,
        });
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
      setupRequired: false,
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

  if (path === "/api/treatments" && method === "GET") {
    const rows = db.query(`
      SELECT t.*,
             COUNT(m.id) AS medicine_count
      FROM treatments t
      LEFT JOIN medicines m ON m.treatment_id = t.id AND m.user_id = t.user_id
      WHERE t.user_id = $userId
      GROUP BY t.id
      ORDER BY t.start_at DESC, t.created_at DESC
    `).all({ $userId: user.id });
    return json({ ok: true, treatments: rows.map(normalizeTreatment) });
  }

  if (path === "/api/treatments" && method === "POST") {
    const data = await readJson(req);
    const timestamp = nowIso();
    const startAt = normalizeTreatmentDateInput(data, "start", "Fecha inicio");
    const endAt = normalizeTreatmentDateInput(data, "end", "Fecha termino", true);
    if (Date.parse(endAt) < Date.parse(startAt)) {
      throw new AppError(400, "Fecha termino debe ser igual o posterior a fecha inicio.");
    }

    const id = randomUUID();
    db.query(`
      INSERT INTO treatments (id, user_id, name, start_at, end_at, notes, active, created_at, updated_at)
      VALUES ($id, $userId, $name, $startAt, $endAt, $notes, 1, $createdAt, $updatedAt)
    `).run({
      $id: id,
      $userId: user.id,
      $name: requireString(data, "name", "Tratamiento"),
      $startAt: startAt,
      $endAt: endAt,
      $notes: String(data.notes || "").trim(),
      $createdAt: timestamp,
      $updatedAt: timestamp,
    });
    const treatment = db.query("SELECT *, 0 AS medicine_count FROM treatments WHERE id = $id").get({ $id: id });
    return json({ ok: true, treatment: normalizeTreatment(treatment) }, 201);
  }

  const treatmentMatch = path.match(/^\/api\/treatments\/([^/]+)$/);
  if (treatmentMatch && (method === "PUT" || method === "PATCH")) {
    const id = treatmentMatch[1];
    requireTreatment(user.id, id);
    const data = await readJson(req);
    const timestamp = nowIso();
    const startAt = normalizeTreatmentDateInput(data, "start", "Fecha inicio");
    const endAt = normalizeTreatmentDateInput(data, "end", "Fecha termino", true);
    if (Date.parse(endAt) < Date.parse(startAt)) {
      throw new AppError(400, "Fecha termino debe ser igual o posterior a fecha inicio.");
    }

    db.query(`
      UPDATE treatments
      SET name = $name,
          start_at = $startAt,
          end_at = $endAt,
          notes = $notes,
          updated_at = $updatedAt
      WHERE id = $id AND user_id = $userId
    `).run({
      $id: id,
      $userId: user.id,
      $name: requireString(data, "name", "Tratamiento"),
      $startAt: startAt,
      $endAt: endAt,
      $notes: String(data.notes || "").trim(),
      $updatedAt: timestamp,
    });
    const treatment = db.query(`
      SELECT t.*, COUNT(m.id) AS medicine_count
      FROM treatments t
      LEFT JOIN medicines m ON m.treatment_id = t.id AND m.user_id = t.user_id
      WHERE t.id = $id AND t.user_id = $userId
      GROUP BY t.id
    `).get({ $id: id, $userId: user.id });
    return json({ ok: true, treatment: normalizeTreatment(treatment) });
  }

  if (treatmentMatch && method === "DELETE") {
    const id = treatmentMatch[1];
    requireTreatment(user.id, id);
    db.query(`
      DELETE FROM dose_completions
      WHERE user_id = $userId
        AND medicine_id IN (
          SELECT id FROM medicines WHERE user_id = $userId AND treatment_id = $treatmentId
        )
    `).run({ $userId: user.id, $treatmentId: id });
    db.query("DELETE FROM medicines WHERE user_id = $userId AND treatment_id = $treatmentId")
      .run({ $userId: user.id, $treatmentId: id });
    db.query("DELETE FROM treatments WHERE id = $id AND user_id = $userId")
      .run({ $id: id, $userId: user.id });
    return json({ ok: true });
  }

  if (path === "/api/medicines" && method === "GET") {
    const treatmentId = String(url.searchParams.get("treatmentId") || "").trim();
    if (treatmentId) requireTreatment(user.id, treatmentId);
    const rows = db.query(`
      SELECT * FROM medicines
      WHERE user_id = $userId
        ${treatmentId ? "AND treatment_id = $treatmentId" : ""}
      ORDER BY active DESC, next_reminder_at ASC, name ASC
    `).all({ $userId: user.id, $treatmentId: treatmentId });
    const completedByMedicine = new Map();
    const completionRows = db.query(`
      SELECT medicine_id, scheduled_at
      FROM dose_completions
      WHERE user_id = $userId
    `).all({ $userId: user.id });

    for (const completion of completionRows) {
      if (!completedByMedicine.has(completion.medicine_id)) {
        completedByMedicine.set(completion.medicine_id, []);
      }
      completedByMedicine.get(completion.medicine_id).push(completion.scheduled_at);
    }

    const medicines = rows.map((row) => normalizeMedicine(row, completedByMedicine.get(row.id) || []));
    return json({ ok: true, medicines });
  }

  if (path === "/api/medicines" && method === "POST") {
    const data = await readJson(req);
    const id = randomUUID();
    const timestamp = nowIso();
    const intervalHours = normalizeIntervalHours(data.intervalHours);
    const durationDays = normalizeDurationDays(data.durationDays);
    const startAt = normalizeStartAtInput(data, new Date(timestamp));
    const treatment = requireTreatment(user.id, data.treatmentId);
    const active = data.active === false ? 0 : 1;
    const nextReminderAt = active ? nextReminderForSchedule(startAt, intervalHours, durationDays, new Date(timestamp)) : null;
    db.query(`
      INSERT INTO medicines (id, user_id, treatment_id, name, dose, time_of_day, interval_hours, duration_days, start_at, next_reminder_at, notes, active, created_at, updated_at)
      VALUES ($id, $userId, $treatmentId, $name, $dose, $timeOfDay, $intervalHours, $durationDays, $startAt, $nextReminderAt, $notes, $active, $createdAt, $updatedAt)
    `).run({
      $id: id,
      $userId: user.id,
      $treatmentId: treatment.id,
      $name: requireString(data, "name", "Nombre"),
      $dose: String(data.dose || "").trim(),
      $timeOfDay: "00:00",
      $intervalHours: intervalHours,
      $durationDays: durationDays,
      $startAt: startAt,
      $nextReminderAt: nextReminderAt,
      $notes: String(data.notes || "").trim(),
      $active: active,
      $createdAt: timestamp,
      $updatedAt: timestamp,
    });
    const medicine = db.query("SELECT * FROM medicines WHERE id = $id").get({ $id: id });
    return json({ ok: true, medicine: normalizeMedicine(medicine) }, 201);
  }

  const completionMatch = path.match(/^\/api\/medicines\/([^/]+)\/completions$/);
  if (completionMatch && method === "POST") {
    const id = completionMatch[1];
    const medicine = db.query("SELECT id FROM medicines WHERE id = $id AND user_id = $userId")
      .get({ $id: id, $userId: user.id });
    if (!medicine) throw new AppError(404, "Medicina no encontrada.");

    const data = await readJson(req);
    const scheduledAt = String(data.scheduledAt || "").trim();
    if (!validIso(scheduledAt)) {
      throw new AppError(400, "La toma programada no es valida.");
    }

    const normalizedScheduledAt = new Date(scheduledAt).toISOString();
    if (data.completed === false) {
      db.query(`
        DELETE FROM dose_completions
        WHERE user_id = $userId AND medicine_id = $medicineId AND scheduled_at = $scheduledAt
      `).run({ $userId: user.id, $medicineId: id, $scheduledAt: normalizedScheduledAt });
      return json({ ok: true, scheduledAt: normalizedScheduledAt, completed: false });
    }

    db.query(`
      INSERT INTO dose_completions (id, user_id, medicine_id, scheduled_at, completed_at)
      VALUES ($id, $userId, $medicineId, $scheduledAt, $completedAt)
      ON CONFLICT(user_id, medicine_id, scheduled_at)
      DO UPDATE SET completed_at = excluded.completed_at
    `).run({
      $id: randomUUID(),
      $userId: user.id,
      $medicineId: id,
      $scheduledAt: normalizedScheduledAt,
      $completedAt: nowIso(),
    });
    return json({ ok: true, scheduledAt: normalizedScheduledAt, completed: true });
  }

  const medicineMatch = path.match(/^\/api\/medicines\/([^/]+)$/);
  if (medicineMatch && (method === "PUT" || method === "PATCH")) {
    const id = medicineMatch[1];
    const data = await readJson(req);
    const existing = db.query("SELECT * FROM medicines WHERE id = $id AND user_id = $userId")
      .get({ $id: id, $userId: user.id });
    if (!existing) throw new AppError(404, "Medicina no encontrada.");
    const timestamp = nowIso();
    const intervalHours = normalizeIntervalHours(data.intervalHours);
    const durationDays = normalizeDurationDays(data.durationDays);
    const active = data.active === false ? 0 : 1;
    const treatmentId = data.treatmentId ? requireTreatment(user.id, data.treatmentId).id : existing.treatment_id;
    const requestedStartAt = normalizeStartAtInput(
      data,
      validIso(existing.start_at) ? new Date(existing.start_at) : new Date(timestamp),
    );
    const intervalChanged = intervalHours !== (existing.interval_hours || 24);
    const durationChanged = durationDays !== (existing.duration_days || 7);
    const startChanged = !validIso(existing.start_at) || Date.parse(requestedStartAt) !== Date.parse(existing.start_at);
    const wasReactivated = !existing.active && active;
    const shouldResetSchedule = intervalChanged || durationChanged || startChanged || wasReactivated || !existing.start_at;
    const startAt = shouldResetSchedule ? requestedStartAt : existing.start_at;
    const nextReminderAt = active
      ? (shouldResetSchedule || !existing.next_reminder_at
        ? nextReminderForSchedule(startAt, intervalHours, durationDays, new Date(timestamp))
        : existing.next_reminder_at)
      : null;
    db.query(`
      UPDATE medicines
      SET name = $name,
          dose = $dose,
          treatment_id = $treatmentId,
          time_of_day = $timeOfDay,
          interval_hours = $intervalHours,
          duration_days = $durationDays,
          start_at = $startAt,
          next_reminder_at = $nextReminderAt,
          notes = $notes,
          active = $active,
          updated_at = $updatedAt
      WHERE id = $id AND user_id = $userId
    `).run({
      $id: id,
      $userId: user.id,
      $treatmentId: treatmentId,
      $name: requireString(data, "name", "Nombre"),
      $dose: String(data.dose || "").trim(),
      $timeOfDay: "00:00",
      $intervalHours: intervalHours,
      $durationDays: durationDays,
      $startAt: startAt,
      $nextReminderAt: nextReminderAt,
      $notes: String(data.notes || "").trim(),
      $active: active,
      $updatedAt: timestamp,
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

function staticCacheControl(pathname) {
  if (pathname === "/sw.js") return "no-cache";
  const extension = extname(pathname);
  if (extension === ".html" || extension === ".js" || extension === ".css" || extension === ".webmanifest") {
    return "no-cache";
  }
  return "public, max-age=86400";
}

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
      "cache-control": staticCacheControl(pathname),
    },
  });
}

const server = Bun.serve({
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

function shutdown(signal) {
  console.log(`${signal} recibido, cerrando Alerta Medicinas...`);
  server.stop(true);
  db.close();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
