# Tenets: USME

> **Canonical copy:** `/home/alex/ai/projects/rufus-projects/usme-claw/pm/TENETS.md`


Principles that guide decisions when data isn't available.
These are not goals — they are how we think. Change them only by stepping back and revisiting explicitly.

---

## Tenet 1: Curation over compression

The right question is "what should the model know right now?" not "how do we fit everything in?"
*A brain that selects beats a filing cabinet that shrinks.*

## Tenet 2: Formula before learning

Build a tunable, transparent scoring formula before building a learning system.
*You can't improve what you can't inspect. Ship deterministic first, then layer in feedback.*

## Tenet 3: Editorial, not adversarial

The memory critic is a curating editor, not a security guard (in single-user context).
*Protect quality by asking "is this still true and relevant?" — not by assuming bad intent.*

## Tenet 4: Local services only — no remote dependencies

No cloud databases, no remote vector stores, no external API dependencies in the storage layer.
Local Postgres (Docker) is acceptable and appropriate. Remote services require explicit justification.
*Ops complexity is a real cost — but the right local stack pays for itself immediately.*

## Tenet 5: Skill distillation is the pitch

The capability that justifies USME to a user or investor is skill distillation — the agent gets durably better at things it does often, automatically, without anyone writing a skill by hand.
*Everything else is infrastructure. This is the demo.*
