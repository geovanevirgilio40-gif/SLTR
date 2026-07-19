// geofence.js — geofencing real, agora sempre filtrado por tenant_id, para que os
// dispositivos de um cliente nunca cruzem eventos com os de outro.

const crypto = require("crypto");
const db = require("./db");

function isValidLat(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= -90 && v <= 90;
}
function isValidLng(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= -180 && v <= 180;
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function listGeofences(tenantId) {
  const { rows } = await db.query(
    `SELECT * FROM geofences WHERE tenant_id = $1 ORDER BY created_at DESC`,
    [tenantId]
  );
  return rows;
}

async function createGeofence(tenantId, { name, lat, lng, radiusM }) {
  if (!name || typeof name !== "string" || !name.trim()) throw new Error("name é obrigatório.");
  if (!isValidLat(lat)) throw new Error("lat inválida — tem de ser um número entre -90 e 90.");
  if (!isValidLng(lng)) throw new Error("lng inválida — tem de ser um número entre -180 e 180.");
  if (typeof radiusM !== "number" || !Number.isFinite(radiusM) || radiusM <= 0 || radiusM > 200000) {
    throw new Error("radiusM inválido — tem de ser um número positivo (metros), até 200000.");
  }
  const id = "GF-" + crypto.randomUUID();
  await db.query(
    `INSERT INTO geofences (id, tenant_id, name, lat, lng, radius_m, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, tenantId, name.trim(), lat, lng, radiusM, Date.now()]
  );
  return { id, name: name.trim(), lat, lng, radiusM };
}

async function deleteGeofence(tenantId, id) {
  await db.query(`DELETE FROM geofences WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
}

async function recentEvents(tenantId, { page = 1, limit = 50 } = {}) {
  const safeLimit = Math.min(Math.max(limit, 1), 500);
  const safePage = Math.max(page, 1);
  const offset = (safePage - 1) * safeLimit;
  const { rows } = await db.query(
    `SELECT * FROM geofence_events WHERE tenant_id = $1 ORDER BY ts DESC LIMIT $2 OFFSET $3`,
    [tenantId, safeLimit, offset]
  );
  const { rows: totalRows } = await db.query(
    `SELECT COUNT(*)::int AS count FROM geofence_events WHERE tenant_id = $1`,
    [tenantId]
  );
  return { events: rows, page: safePage, limit: safeLimit, total: totalRows[0].count };
}

// Estado em memória: em que zonas está cada dispositivo agora mesmo.
const insideState = new Map(); // deviceId -> Set(geofenceId)

// Chamado uma vez no arranque: reconstrói o estado a partir da última posição
// conhecida de cada dispositivo — um redeploy no Railway não faz "esquecer"
// quem estava dentro de que zona.
async function initializeMembership() {
  const { rows: allZones } = await db.query(`SELECT * FROM geofences`);
  const { rows: positions } = await db.query(`SELECT id, tenant_id, lat, lng FROM entity_state`);

  const zonesByTenant = new Map();
  for (const z of allZones) {
    if (!zonesByTenant.has(z.tenant_id)) zonesByTenant.set(z.tenant_id, []);
    zonesByTenant.get(z.tenant_id).push(z);
  }

  insideState.clear();
  for (const row of positions) {
    const zones = zonesByTenant.get(row.tenant_id) || [];
    const set = new Set();
    for (const z of zones) {
      if (haversineMeters(row.lat, row.lng, z.lat, z.lng) <= z.radius_m) set.add(z.id);
    }
    insideState.set(row.id, set);
  }
  return positions.length;
}

async function checkGeofences(tenantId, deviceId, lat, lng) {
  const zones = await listGeofences(tenantId);
  const prevSet = insideState.get(deviceId) || new Set();
  const nextSet = new Set();
  const events = [];

  for (const z of zones) {
    const isInside = haversineMeters(lat, lng, z.lat, z.lng) <= z.radius_m;
    if (isInside) nextSet.add(z.id);
    const wasInside = prevSet.has(z.id);
    if (isInside && !wasInside) {
      events.push({ geofenceId: z.id, geofenceName: z.name, deviceId, event: "enter", ts: Date.now() });
    } else if (!isInside && wasInside) {
      events.push({ geofenceId: z.id, geofenceName: z.name, deviceId, event: "exit", ts: Date.now() });
    }
  }
  insideState.set(deviceId, nextSet);

  for (const e of events) {
    await db.query(
      `INSERT INTO geofence_events (tenant_id, geofence_id, device_id, event, ts) VALUES ($1,$2,$3,$4,$5)`,
      [tenantId, e.geofenceId, e.deviceId, e.event, e.ts]
    );
  }
  return events;
}

module.exports = {
  isValidLat, isValidLng, haversineMeters,
  listGeofences, createGeofence, deleteGeofence, recentEvents,
  initializeMembership, checkGeofences,
};
