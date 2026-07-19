// server.js — Rastro backend multi-tenant, pensado para correr inteiramente no Railway:
//   - PostgreSQL (plugin Railway) para persistência real
//   - Redis (plugin Railway, opcional) só se precisares de mais do que uma instância
//   - Sem dados simulados, sem seeds

const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const http = require("http");
const rateLimit = require("express-rate-limit");
const { Server } = require("socket.io");

const db = require("./db");
const auth = require("./auth");
const geofence = require("./geofence");
const logger = require("./logger");

const PORT = process.env.PORT || 3000;
const REDIS_URL = process.env.REDIS_URL || null; // o plugin Redis do Railway injeta isto sozinho
const HISTORY_RETENTION_DAYS = parseInt(process.env.HISTORY_RETENTION_DAYS) || 90;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const FORCE_HTTPS = process.env.FORCE_HTTPS === "true";

if (CORS_ORIGIN === "*") {
  logger.warn("CORS_ORIGIN não definido — a aceitar pedidos de qualquer origem. Define nas Variables do Railway em produção.");
}
if (!process.env.SUPER_ADMIN_KEY) {
  process.env.SUPER_ADMIN_KEY = crypto.randomBytes(16).toString("hex");
  logger.warn(
    { superAdminKey: process.env.SUPER_ADMIN_KEY },
    "SUPER_ADMIN_KEY não definida — gerada uma chave temporária para esta sessão. " +
      "Define SUPER_ADMIN_KEY nas Variables do Railway para persistir entre deploys."
  );
}

const app = express();
if (FORCE_HTTPS) app.set("trust proxy", 1);
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());
app.use((req, res, next) => {
  if (!FORCE_HTTPS) return next();
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  if (proto !== "https") return res.status(400).json({ error: "HTTPS obrigatório neste servidor." });
  next();
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: CORS_ORIGIN } });

let redisAdapterReady = false;
async function setupRedis() {
  if (!REDIS_URL) {
    logger.info("Sem REDIS_URL — Socket.io numa só instância (normal com um único serviço no Railway).");
    return;
  }
  const { createAdapter } = require("@socket.io/redis-adapter");
  const { createClient } = require("redis");
  const pubClient = createClient({ url: REDIS_URL });
  const subClient = pubClient.duplicate();
  await Promise.all([pubClient.connect(), subClient.connect()]);
  io.adapter(createAdapter(pubClient, subClient));
  redisAdapterReady = true;
  logger.info("Socket.io ligado ao Redis do Railway — pronto para escalar para várias instâncias.");
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------
const locationLimiter = rateLimit({
  windowMs: 10_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.device ? req.device.id : req.ip),
  message: { error: "Demasiadas posições enviadas em pouco tempo. Aguarda um pouco." },
});
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Demasiados pedidos administrativos. Tenta novamente mais tarde." },
});
const superAdminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Demasiados pedidos. Tenta novamente mais tarde." },
});

// ---------------------------------------------------------------------------
// Persistência + difusão de posições
// ---------------------------------------------------------------------------
async function persistLocation(tenantId, device, { lat, lng, status, speed, battery }) {
  const now = Date.now();
  const merged = {
    id: device.id, name: device.name, type: device.type,
    status: status || "ativo", lat, lng,
    speed: speed ?? null, battery: battery ?? null, updated_at: now,
  };
  await db.query(
    `
    INSERT INTO entity_state (id, tenant_id, name, type, status, lat, lng, speed, battery, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (id) DO UPDATE SET
      name=EXCLUDED.name, type=EXCLUDED.type, status=EXCLUDED.status,
      lat=EXCLUDED.lat, lng=EXCLUDED.lng, speed=EXCLUDED.speed, battery=EXCLUDED.battery, updated_at=EXCLUDED.updated_at
    `,
    [merged.id, tenantId, merged.name, merged.type, merged.status, merged.lat, merged.lng, merged.speed, merged.battery, merged.updated_at]
  );
  await db.query(
    `INSERT INTO history (tenant_id, device_id, lat, lng, ts) VALUES ($1,$2,$3,$4,$5)`,
    [tenantId, device.id, lat, lng, now]
  );
  return merged;
}

function validateLocationBody({ lat, lng, speed, battery }) {
  if (!geofence.isValidLat(lat)) return "lat inválida — tem de ser um número entre -90 e 90.";
  if (!geofence.isValidLng(lng)) return "lng inválida — tem de ser um número entre -180 e 180.";
  if (speed !== undefined && (typeof speed !== "number" || speed < 0)) return "speed, se enviado, tem de ser um número >= 0.";
  if (battery !== undefined && (typeof battery !== "number" || battery < 0 || battery > 100)) return "battery, se enviado, tem de ser um número entre 0 e 100.";
  return null;
}

async function applyLocation(tenantId, device, body) {
  const merged = await persistLocation(tenantId, device, body);
  io.to("tenant:" + tenantId).emit("location:update", merged);
  const events = await geofence.checkGeofences(tenantId, device.id, body.lat, body.lng);
  events.forEach((e) => io.to("tenant:" + tenantId).emit("geofence:event", e));
  return { merged, events };
}

async function cleanupHistory() {
  const cutoff = Date.now() - HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const res = await db.query(`DELETE FROM history WHERE ts < $1`, [cutoff]);
  if (res.rowCount) logger.info({ deleted: res.rowCount, retentionDays: HISTORY_RETENTION_DAYS }, "limpeza de histórico");
}

// ---------------------------------------------------------------------------
// Plataforma — só tu, dono do serviço (SUPER_ADMIN_KEY)
// ---------------------------------------------------------------------------
app.post("/api/tenants", superAdminLimiter, auth.superAdminMiddleware, async (req, res) => {
  try {
    const tenant = await auth.createTenant({ name: req.body?.name });
    res.status(201).json(tenant); // adminKey/viewerKey só aparecem aqui — guarda-os já
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/tenants", superAdminLimiter, auth.superAdminMiddleware, async (req, res) => {
  res.json({ tenants: await auth.listTenants() });
});

app.post("/api/tenants/:id/suspend", superAdminLimiter, auth.superAdminMiddleware, async (req, res) => {
  await auth.setTenantSuspended(req.params.id, true);
  res.json({ ok: true });
});

app.post("/api/tenants/:id/unsuspend", superAdminLimiter, auth.superAdminMiddleware, async (req, res) => {
  await auth.setTenantSuspended(req.params.id, false);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Dispositivos — geridos pelo admin_key do tenant
// ---------------------------------------------------------------------------
app.post("/api/devices", adminLimiter, auth.tenantAdminMiddleware(), async (req, res) => {
  try {
    const device = await auth.createDevice(req.tenant.id, req.body || {});
    res.status(201).json(device);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/devices", adminLimiter, auth.tenantAdminMiddleware(), async (req, res) => {
  res.json({ devices: await auth.listDevices(req.tenant.id) });
});

app.delete("/api/devices/:id", adminLimiter, auth.tenantAdminMiddleware(), async (req, res) => {
  await auth.revokeDevice(req.tenant.id, req.params.id);
  res.json({ ok: true });
});

app.post("/api/devices/:id/location", adminLimiter, auth.tenantAdminMiddleware(), async (req, res) => {
  const device = await auth.findDeviceById(req.tenant.id, req.params.id);
  if (!device) return res.status(404).json({ error: "Dispositivo não encontrado ou revogado." });
  const error = validateLocationBody(req.body || {});
  if (error) return res.status(400).json({ error });
  const { merged, events } = await applyLocation(req.tenant.id, device, req.body);
  res.status(202).json({ ok: true, entity: merged, geofenceEvents: events });
});

// ---------------------------------------------------------------------------
// Dispositivo auto-reporta (api_key própria)
// ---------------------------------------------------------------------------
app.post("/api/locations", auth.deviceAuthMiddleware(), locationLimiter, async (req, res) => {
  const error = validateLocationBody(req.body || {});
  if (error) return res.status(400).json({ error });
  const { merged, events } = await applyLocation(req.device.tenant_id, req.device, req.body);
  res.status(202).json({ ok: true, entity: merged, geofenceEvents: events });
});

// ---------------------------------------------------------------------------
// Leitura — agora protegida por admin_key ou viewer_key do tenant
// ---------------------------------------------------------------------------
app.get("/api/locations", auth.tenantViewerMiddleware(), async (req, res) => {
  const { rows } = await db.query(`SELECT * FROM entity_state WHERE tenant_id = $1`, [req.tenant.id]);
  res.json({ entities: rows });
});

app.get("/api/locations/:id/history", auth.tenantViewerMiddleware(), async (req, res) => {
  const device = await auth.findDeviceById(req.tenant.id, req.params.id);
  if (!device) return res.status(404).json({ error: "Dispositivo não encontrado." });
  const page = Math.max(parseInt(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 500);
  const offset = (page - 1) * limit;
  const { rows } = await db.query(
    `SELECT lat, lng, ts FROM history WHERE device_id = $1 AND tenant_id = $2 ORDER BY ts DESC LIMIT $3 OFFSET $4`,
    [req.params.id, req.tenant.id, limit, offset]
  );
  const { rows: totalRows } = await db.query(
    `SELECT COUNT(*)::int AS count FROM history WHERE device_id = $1 AND tenant_id = $2`,
    [req.params.id, req.tenant.id]
  );
  res.json({ id: req.params.id, page, limit, total: totalRows[0].count, points: rows.reverse() });
});

app.post("/api/geofences", adminLimiter, auth.tenantAdminMiddleware(), async (req, res) => {
  try {
    const zone = await geofence.createGeofence(req.tenant.id, req.body || {});
    res.status(201).json(zone);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/geofences", auth.tenantViewerMiddleware(), async (req, res) => {
  res.json({ geofences: await geofence.listGeofences(req.tenant.id) });
});

app.delete("/api/geofences/:id", adminLimiter, auth.tenantAdminMiddleware(), async (req, res) => {
  await geofence.deleteGeofence(req.tenant.id, req.params.id);
  res.json({ ok: true });
});

app.get("/api/geofences/events", auth.tenantViewerMiddleware(), async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 50;
  res.json(await geofence.recentEvents(req.tenant.id, { page, limit }));
});

app.get("/api/health", async (req, res) => {
  const { rows } = await db.query(`SELECT COUNT(*)::int AS c FROM tenants WHERE suspended = FALSE`);
  res.json({ ok: true, mode: redisAdapterReady ? "redis" : "single-instance", tenants: rows[0].c });
});

// ---------------------------------------------------------------------------
// Socket.io — uma "sala" por tenant; a chave (admin ou viewer) autentica a ligação
// ---------------------------------------------------------------------------
io.use(async (socket, next) => {
  const key = socket.handshake.auth?.key;
  if (!key) return next(new Error("chave de acesso em falta"));
  const tenant = await auth.findTenantByAnyKey(key);
  if (!tenant) return next(new Error("chave inválida"));
  socket.tenantId = tenant.id;
  next();
});

io.on("connection", async (socket) => {
  socket.join("tenant:" + socket.tenantId);
  logger.info({ socketId: socket.id, tenant: socket.tenantId }, "cliente ligado");
  const { rows } = await db.query(`SELECT * FROM entity_state WHERE tenant_id = $1`, [socket.tenantId]);
  socket.emit("snapshot", { entities: rows });
  socket.on("disconnect", () => logger.info({ socketId: socket.id }, "cliente desligado"));
});

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------
async function start() {
  await db.migrate();
  await setupRedis().catch((err) => logger.error({ err }, "erro ao ligar ao Redis"));

  const restored = await geofence.initializeMembership();
  logger.info({ devices: restored }, "estado de geofencing reconstruído a partir da base de dados");

  cleanupHistory();
  setInterval(cleanupHistory, 6 * 60 * 60 * 1000);

  server.listen(PORT, () => logger.info({ port: PORT }, "servidor Rastro a correr"));
}

start().catch((err) => {
  logger.error({ err }, "falha fatal ao arrancar");
  process.exit(1);
});
