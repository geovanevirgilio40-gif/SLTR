// logger.js — logs estruturados (JSON) em produção via Pino, em vez de console.log solto.
// Em desenvolvimento, se "pino-pretty" estiver instalado, formata de forma legível.

const pino = require("pino");

let transport;
if (process.env.NODE_ENV !== "production") {
  try {
    require.resolve("pino-pretty");
    transport = { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } };
  } catch {
    transport = undefined; // pino-pretty não instalado — cai para JSON simples, sem partir nada
  }
}

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  transport,
});

module.exports = logger;
