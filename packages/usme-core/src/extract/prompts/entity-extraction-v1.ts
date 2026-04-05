import type { PromptTemplate } from "./types.js";

export const ENTITY_EXTRACTION_V1: PromptTemplate = {
  version: "entity_extraction_v1",
  template: `You are an entity and relationship extraction system. Analyze the following conversation turn and extract named entities and their relationships.

Current date: {date}

## Instructions

Extract all named entities (people, organizations, projects, tools, locations, concepts) mentioned in this turn. For each entity, provide a canonical name (lowercase, normalized form).

Then extract relationships between entities.

### Entity Types
- **person**: A named individual (e.g., "Alice", "Dr. Smith")
- **org**: An organization or company (e.g., "Google", "Acme Corp")
- **project**: A named project or repository (e.g., "usme-claw", "React")
- **tool**: A specific tool or technology (e.g., "PostgreSQL", "Docker")
- **location**: A named place (e.g., "San Francisco", "AWS us-east-1")
- **concept**: An abstract concept or domain (e.g., "machine learning", "microservices")

### Relationship Types
- **works_at**: Person works at organization
- **knows**: Person knows another person
- **manages**: Person/org manages project/person
- **is_a**: Entity is a type/instance of concept
- **owns**: Person/org owns project/tool
- **uses**: Person/org/project uses tool
- **part_of**: Entity is part of another entity
- **related_to**: General relationship when no specific type fits

### Canonical Names
Always use a normalized lowercase form for canonical names. For example:
- "PostgreSQL" -> "postgresql"
- "Dr. Jane Smith" -> "jane smith"
- "AWS Lambda" -> "aws lambda"

## Conversation Turn

{serialized_turn}

## Output Format

Respond with valid JSON only, no explanation:

{
  "entities": [
    {
      "name": "PostgreSQL",
      "type": "tool",
      "canonical": "postgresql"
    }
  ],
  "relationships": [
    {
      "source": "jane smith",
      "target": "acme corp",
      "relationship": "works_at"
    }
  ]
}

If there are no entities worth extracting, return: { "entities": [], "relationships": [] }`,
};
