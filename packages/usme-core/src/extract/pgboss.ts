import { PgBoss } from "pg-boss";
import { logger } from "../logger.js";

const log = logger.child({ module: "pgboss" });

let boss: PgBoss | null = null;
let startPromise: Promise<PgBoss> | null = null;

export async function getPgBoss(): Promise<PgBoss> {
  if (boss) return boss;
  if (startPromise) return startPromise;

  startPromise = (async () => {
    const url = process.env.DATABASE_URL ?? "postgres://usme:usme_dev@localhost:5432/usme";
    const b = new PgBoss(url);
    b.on("error", (err: unknown) => log.error({ err }, "pg-boss error"));
    await b.start();
    boss = b;
    return b;
  })();

  return startPromise;
}

export async function closePgBoss(): Promise<void> {
  if (boss) {
    await boss.stop();
    boss = null;
    startPromise = null;
  }
}
