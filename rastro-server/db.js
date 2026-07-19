// db.js — persistência real em PostgreSQL (plugin nativo do Railway).
//
// No Railway: Add a Database -> PostgreSQL. Isto injeta automaticamente a
// variável DATABASE_URL no teu serviço — não precisas de a copiar à mão.
// Ao contrário do SQLite anterior, isto sobrevive a redeploys/reinícios
// (o ficheiro local do container é efémero; a base de dados gerida não é).

const { Pool } = require("pg");
const logger = require("./logger");

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL não definida. No Railway: adiciona o plugin PostgreSQL ao projeto — " +
      "a variável é injetada automaticamente no serviço da app."
  );
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // A rede interna do Railway normalmente não precisa de SSL; a ligação pública, sim.
  // Define PGSSL=false explicitamente se estiveres a usar a URL interna e isto falhar.
  ssl: process.env.PGSSL === "false" ? false : { rejectUnauthorized: false },
});

async function query(text, params) {
  return pool.query(text, params);
}

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      admin_key_hash TEXT NOT NULL UNIQUE,
      viewer_key_hash TEXT NOT NULL UNIQUE,
      created_at BIGINT NOT NULL,
      suspended BOOLEAN NOT NULL DEFAULT FALSE
    );

    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'dispositivo',
      api_key_hash TEXT NOT NULL UNIQUE,
      created_at BIGINT NOT NULL,
      revoked BOOLEAN NOT NULL DEFAULT FALSE
    );
    CREATE INDEX IF NOT EXISTS idx_devices_tenant ON devices(tenant_id);

    CREATE TABLE IF NOT EXISTS entity_state (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      name TEXT,
      type TEXT,
      status TEXT,
      lat DOUBLE PRECISION,
      lng DOUBLE PRECISION,
      speed DOUBLE PRECISION,
      battery DOUBLE PRECISION,
      updated_at BIGINT
    );
    CREATE INDEX IF NOT EXISTS idx_entity_state_tenant ON entity_state(tenant_id);

    CREATE TABLE IF NOT EXISTS history (
      id BIGSERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      device_id TEXT NOT NULL,
      lat DOUBLE PRECISION NOT NULL,
      lng DOUBLE PRECISION NOT NULL,
      ts BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_history_device_ts ON history(device_id, ts);
    CREATE INDEX IF NOT EXISTS idx_history_tenant ON history(tenant_id);

    CREATE TABLE IF NOT EXISTS geofences (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      name TEXT NOT NULL,
      lat DOUBLE PRECISION NOT NULL,
      lng DOUBLE PRECISION NOT NULL,
      radius_m DOUBLE PRECISION NOT NULL,
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_geofences_tenant ON geofences(tenant_id);

    CREATE TABLE IF NOT EXISTS geofence_events (
      id BIGSERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      geofence_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      event TEXT NOT NULL,
      ts BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_geofence_events_tenant_ts ON geofence_events(tenant_id, ts);
  `);
  logger.info("esquema da base de dados (Postgres) verificado/criado");
}

module.exports = { pool, query, migrate };
