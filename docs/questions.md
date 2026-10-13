# Open questions

Requirements that need a decision before they're built, and spec gaps found along the way (HANDOFF §14). Each item says what's needed to settle it. Once a question is decided, its answer goes in an ADR and the item leaves this file: ADR 0020 (hub admin) and ADR 0021 (agents, re-sharing, the first device, people on several hubs) settled the last batch.

## Ban evasion on open hubs

**Status:** known limitation, no action planned.

With no PII (§2), a banned person can generate a new key and join again. Hubs that care should use `join_mode approval`. Rate-limiting account creation per IP (in the Backlog, `docs/progress.md`) helps a little.
