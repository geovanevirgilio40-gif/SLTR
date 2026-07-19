// auth.js — modelo multi-tenant (isola os dados de cada cliente teu).
//
// Camadas de chave:
//   SUPER_ADMIN_KEY  — só tu (dono do serviço). Cria/lista/suspende tenants.
//   tenant.adminKey  — o teu cliente. Regista dispositivos, cria geofences, vê tudo do SEU tenant.
//   tenant.viewerKey — só leitura do SEU tenant. É a que embebes num dashboard partilhado.
//   device.apiKey    — um dispositivo específico. Só consegue reportar a própria posição.
//
// Todas as chaves são geradas aleatoriamente e guardadas só como hash SHA-256.

const crypto = require("crypto");
const db = require("./db");

function generateKey() {
  return crypto.randomBytes(24).toString("hex");
}
function hashKey(key) {
  return crypto.createHash("sha256").update(key).digest("hex");
}

// ---------------------------------------------------------------------------
// Tenants — os teus clientes
// ---------------------------------------------------------------------------
async function createTenant({ name }) {
  if (!name) throw new Error("name é obrigatório.");
  const id = crypto.randomUUID();
  const adminKey = generateKey();
  const viewerKey = generateKey();
  await db.query(
    `INSERT INTO tenants (id, name, admin_key_hash, viewer_key_hash, created_at) VALUES ($1,$2,$3,$4,$5)`,
    [id, name, hashKey(adminKey), hashKey(viewerKey), Date.now()]
  );
  // adminKey/viewerKey em claro só existem aqui — nunca são lidas de volta da BD.
  return { id, name, adminKey, viewerKey };
}

async function listTenants() {
  const { rows } = await db.query(
    `SELECT id, name, created_at, suspended FROM tenants ORDER BY created_at DESC`
  );
  return rows;
}

async function setTenantSuspended(id, suspended) {
  await db.query(`UPDATE tenants SET suspended = $1 WHERE id = $2`, [suspended, id]);
}

async function findTenantByAdminKey(key) {
  const { rows } = await db.query(
    `SELECT id, name FROM tenants WHERE admin_key_hash = $1 AND suspended = FALSE`,
    [hashKey(key)]
  );
  return rows[0] || null;
}

// Aceita admin_key OU viewer_key — usado nos endpoints só de leitura.
async function findTenantByAnyKey(key) {
  const h = hashKey(key);
  const { rows } = await db.query(
    `SELECT id, name FROM tenants WHERE (admin_key_hash = $1 OR viewer_key_hash = $1) AND suspended = FALSE`,
    [h]
  );
  return rows[0] || null;
}

// ---------------------------------------------------------------------------
// Dispositivos — sempre presos a um tenant
// ---------------------------------------------------------------------------
async function createDevice(tenantId, { name, type }) {
  if (!name) throw new Error("name é obrigatório.");
  const id = crypto.randomUUID();
  const apiKey = generateKey();
  await db.query(
    `INSERT INTO devices (id, tenant_id, name, type, api_key_hash, created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, tenantId, name, type || "dispositivo", hashKey(apiKey), Date.now()]
  );
  return { id, name, type: type || "dispositivo", apiKey };
}

async function findDeviceByApiKey(apiKey) {
  const { rows } = await db.query(
    `SELECT id, tenant_id, name, type FROM devices WHERE api_key_hash = $1 AND revoked = FALSE`,
    [hashKey(apiKey)]
  );
  return rows[0] || null;
}

async function findDeviceById(tenantId, id) {
  const { rows } = await db.query(
    `SELECT id, tenant_id, name, type FROM devices WHERE id = $1 AND tenant_id = $2 AND revoked = FALSE`,
    [id, tenantId]
  );
  return rows[0] || null;
}

async function listDevices(tenantId) {
  const { rows } = await db.query(
    `SELECT id, name, type, created_at, revoked FROM devices WHERE tenant_id = $1 ORDER BY created_at DESC`,
    [tenantId]
  );
  return rows;
}

async function revokeDevice(tenantId, id) {
  await db.query(`UPDATE devices SET revoked = TRUE WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
}

// ---------------------------------------------------------------------------
// Middlewares
// ---------------------------------------------------------------------------
function superAdminMiddleware(req, res, next) {
  const header = req.headers["authorization"] || "";
  const key = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!key || key !== process.env.SUPER_ADMIN_KEY) {
    return res.status(401).json({ error: "Super admin key inválida ou em falta." });
  }
  next();
}

function tenantAdminMiddleware() {
  return async (req, res, next) => {
    const header = req.headers["authorization"] || "";
    const key = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!key) {
      return res.status(401).json({ error: "Authorization: Bearer <admin_key do teu tenant> em falta." });
    }
    const tenant = await findTenantByAdminKey(key);
    if (!tenant) return res.status(401).json({ error: "Admin key inválida, ou conta suspensa." });
    req.tenant = tenant;
    next();
  };
}

function tenantViewerMiddleware() {
  return async (req, res, next) => {
    const header = req.headers["authorization"] || "";
    const key = header.startsWith("Bearer ") ? header.slice(7) : req.query.key || null;
    if (!key) return res.status(401).json({ error: "Chave de acesso em falta (admin_key ou viewer_key)." });
    const tenant = await findTenantByAnyKey(key);
    if (!tenant) return res.status(401).json({ error: "Chave inválida, ou conta suspensa." });
    req.tenant = tenant;
    next();
  };
}

function deviceAuthMiddleware() {
  return async (req, res, next) => {
    const header = req.headers["authorization"] || "";
    const apiKey = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!apiKey) return res.status(401).json({ error: "Authorization: Bearer <api_key do dispositivo> em falta." });
    const device = await findDeviceByApiKey(apiKey);
    if (!device) return res.status(401).json({ error: "API key inválida, ou dispositivo revogado." });
    req.device = device;
    next();
  };
}

module.exports = {
  createTenant, listTenants, setTenantSuspended, findTenantByAdminKey, findTenantByAnyKey,
  createDevice, findDeviceByApiKey, findDeviceById, listDevices, revokeDevice,
  superAdminMiddleware, tenantAdminMiddleware, tenantViewerMiddleware, deviceAuthMiddleware,
};
