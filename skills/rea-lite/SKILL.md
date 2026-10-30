---
name: rea-lite
description: Low-context access to installed REA CLI for artifact reverse engineering and Evidence views.
---
# REA Lite
Use normal code tools for complete source repositories, not REA.
Establish the requested artifact or runtime target before reverse engineering.
Invoke `node <absolute-skill-dir>/scripts/rea-lite.mjs`; resolve this skill's actual location, not cwd.
Discover only what is needed: `find <words>`, `help <command>`, `schema <command>`.
Execute with `run -- <command> [args...]`; this uses installed REA, not a new engine.
Full stdout/stderr stay in unique `.rea-lite/runs/` directories under caller cwd.
Provider variables may come from `~/.rea-lite/env.json`; caller env wins.
Previews are incomplete when truncated; use `read <file> --offset N --limit N` for needed fragments.
Cite real REA Evidence IDs; distinguish observed, inferred and unknown, preserving limitations.
Do not execute targets, install dependencies or change client configuration without authorization.
Read references only when relevant:
- [Usage and backend selection](references/usage.md)
- [Target routing](references/targets.md)
- [Evidence and inline view recipes](references/evidence.md)
