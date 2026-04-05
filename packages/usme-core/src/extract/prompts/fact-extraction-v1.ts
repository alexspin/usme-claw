import type { PromptTemplate } from "./types.js";

export const FACT_EXTRACTION_V1: PromptTemplate = {
  version: "fact_extraction_v1",
  template: `You are a memory extraction system. Analyze the following conversation turn and extract structured memory items.

Current date: {date}

## Instructions

Extract every distinct piece of information worth remembering from this turn. For each item, classify it and assess its long-term utility.

### Item Types
- **fact**: A concrete, verifiable piece of information (e.g., "User's company uses PostgreSQL 16")
- **preference**: A stated or implied preference (e.g., "User prefers TypeScript over JavaScript")
- **decision**: A decision that was made (e.g., "Decided to use vitest instead of jest")
- **plan**: A stated intention or plan (e.g., "User plans to migrate to AWS next quarter")
- **anomaly**: Something surprising or contradicting prior knowledge
- **ephemeral**: Time-sensitive information that will expire (e.g., "Currently debugging auth issue")

### Utility Levels
- **high**: Core identity, major decisions, important facts that will be referenced often
- **medium**: Useful context that may be relevant in future turns
- **low**: Minor details, unlikely to be referenced again
- **discard**: Not worth storing (greetings, acknowledgments, etc.)

### Provenance
- **user**: Information originating from the user's messages
- **tool**: Information from tool call results
- **model**: Information from the assistant's reasoning or analysis

### Tags
Add 1-3 short lowercase tags for retrieval (e.g., ["database", "postgresql"], ["preference", "language"])

### Ephemeral TTL
For ephemeral items only, estimate how many hours the information remains relevant (1-168). Use null for non-ephemeral items.

## Conversation Turn

{serialized_turn}

## Output Format

Respond with valid JSON only, no explanation:

{
  "items": [
    {
      "type": "fact",
      "content": "concise statement of the extracted information",
      "utility": "high",
      "provenance_kind": "user",
      "tags": ["tag1", "tag2"],
      "ephemeral_ttl_hours": null
    }
  ]
}

If there is nothing worth extracting, return: { "items": [] }`,
};
