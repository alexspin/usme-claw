import type { PromptTemplate } from "./types.js";

export const FACT_EXTRACTION_V1: PromptTemplate = {
  version: "fact_extraction_v1",
  template: `You are a memory extraction system for a personal AI assistant. Analyze the following conversation and extract everything worth remembering.

Current date: {date}

## What to extract

Extract from BOTH user messages AND assistant responses. The assistant often surfaces analysis, findings, metrics, diagnoses, and insights — these are as worth storing as anything the user says.

Think broadly. Good memories include:
- Facts about the user: who they are, what they work on, how they think, what they care about
- Preferences and working style: tools they like, approaches they prefer, things that annoy them
- Decisions made and why
- Plans and intentions
- Things the assistant discovered, analyzed, or concluded
- Metrics, measurements, or system state that will matter later
- Anything surprising, notable, or that changed understanding
- Context about ongoing projects or problems

### Item Types
- **fact**: A concrete piece of information (e.g. "USME has 162 sensory traces after cleanup")
- **preference**: A stated or implied preference (e.g. "User prefers erring toward storing facts over discarding them")
- **decision**: A decision that was made (e.g. "Decided to augment LCM rather than replace it")
- **plan**: A stated intention (e.g. "Plan to flip USME from shadow to live mode once corpus is clean")
- **insight**: An analysis or conclusion reached (e.g. "Token delta of -94% means USME context is far smaller than LCM context")
- **anomaly**: Something surprising or that contradicts prior understanding
- **ephemeral**: Time-sensitive state that will expire (e.g. "Currently debugging extraction pipeline")

### Utility Levels
- **high**: Will almost certainly be relevant again — core facts, major decisions, key insights
- **medium**: Probably useful in future — context, findings, secondary decisions
- **low**: Minor detail, unlikely to resurface
- **discard**: ONLY for content-free filler (pure greetings, "ok", "thanks", acknowledgments with no information)

### Provenance
- **user**: From the user\'s messages
- **model**: From the assistant\'s responses, analysis, or findings
- **tool**: From tool call results

### Tags
1–3 short lowercase tags. Think about what query would retrieve this fact.

### Ephemeral TTL
Hours the information remains useful (1–168). Null for non-ephemeral items.

---

## Conversation

{serialized_turn}

---

## Output

JSON only, no explanation:

{
  "items": [
    {
      "type": "fact|preference|decision|plan|insight|anomaly|ephemeral",
      "content": "clear, self-contained statement of what was learned",
      "utility": "high|medium|low|discard",
      "provenance_kind": "user|model|tool",
      "tags": ["tag1", "tag2"],
      "ephemeral_ttl_hours": null
    }
  ]
}

Only return { "items": [] } if the conversation contains genuinely no extractable information (pure greetings, empty messages, or filler only).`,
};
