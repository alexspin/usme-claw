import pino from "pino";

export const logger = pino({
  name: "usme",
  level: process.env.USME_LOG_LEVEL ?? "info",
});
