/**
 * Unit tests for stripMetadataEnvelope() in src/extract/utils.ts
 */

import { describe, it, expect } from "vitest";
import { stripMetadataEnvelope } from "../../src/extract/utils.js";

describe("stripMetadataEnvelope", () => {
  it("strips full envelope (Sender block + timestamp + content)", () => {
    const input = `Sender (untrusted metadata):
\`\`\`json
{"role":"user","session":"abc"}
\`\`\`

[Mon 2026-04-06 15:21 UTC] The user wants to refactor the DB layer.`;
    const result = stripMetadataEnvelope(input);
    expect(result).toBe("The user wants to refactor the DB layer.");
    expect(result).not.toContain("Sender");
    expect(result).not.toContain("2026-04-06");
  });

  it("returns empty or minimal for envelope only (Sender block, no real content)", () => {
    const input = `Sender (untrusted metadata):
\`\`\`json
{"role":"assistant"}
\`\`\`
`;
    const result = stripMetadataEnvelope(input);
    expect(result.trim()).toBe("");
  });

  it("strips leading timestamp when no Sender block present", () => {
    const input = `[Tue 2026-04-07 09:00 UTC] Deploy to production tonight.`;
    const result = stripMetadataEnvelope(input);
    expect(result).toBe("Deploy to production tonight.");
    expect(result).not.toContain("2026-04-07");
  });

  it("returns content unchanged when neither Sender block nor timestamp", () => {
    const input = "Plain content with no envelope.";
    const result = stripMetadataEnvelope(input);
    expect(result).toBe("Plain content with no envelope.");
  });

  it("preserves all lines of actual content after envelope", () => {
    const input = `Sender (untrusted metadata):
\`\`\`json
{"role":"user"}
\`\`\`

[Wed 2026-04-08 10:30 UTC] Line one of the message.
Line two of the message.
Line three of the message.`;
    const result = stripMetadataEnvelope(input);
    expect(result).toContain("Line one of the message.");
    expect(result).toContain("Line two of the message.");
    expect(result).toContain("Line three of the message.");
    expect(result).not.toContain("Sender");
  });
});
