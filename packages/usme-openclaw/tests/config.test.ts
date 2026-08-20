import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";

describe("resolveConfig", () => {
  it("honors Joy dotted database config", () => {
    const config = resolveConfig({
      "db.database": "joy_usme",
      "db.user": "joy_usme",
      "db.password": "password",
    });

    expect(config.db.database).toBe("joy_usme");
    expect(config.db.user).toBe("joy_usme");
    expect(config.db.password).toBe("password");
  });

  it("honors Rufus dotted poolMax config", () => {
    const config = resolveConfig({
      "db.poolMax": 25,
    });

    expect(config.db.poolMax).toBe(25);
  });

  it("preserves nested db compatibility", () => {
    const config = resolveConfig({
      db: {
        host: "db.example.test",
        port: 5433,
        database: "nested_usme",
        user: "nested_user",
        password: "nested_password",
        poolMax: 12,
        idleTimeoutMs: 45_000,
      },
    });

    expect(config.db).toMatchObject({
      host: "db.example.test",
      port: 5433,
      database: "nested_usme",
      user: "nested_user",
      password: "nested_password",
      poolMax: 12,
      idleTimeoutMs: 45_000,
    });
  });
});
