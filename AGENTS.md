# Project Agent Instructions

Follow `CODING_GUIDELINES.md` for all coding work in this repository.

## GitHub Workflow

- Use the installed GitHub connector for repository reads, commits, and pushes.
- Do not use local `git add`, `git commit`, or `git push` when `.git` is read-only.
- Do not retry Git through multiple shells or browser automation after a permission failure.
- Before updating an existing remote file, fetch its current content and SHA through the connector.
- Publish only files intentionally changed for the current task. Never include unrelated working-tree changes.
- After a connector write, fetch the updated path from `main` once to verify the commit.
- If the connector is unavailable or rejects a write, stop and give the user one concise, exact action.

## Token Efficiency

- Prefer direct connectors and APIs, then local commands, then browser automation.
- Use one control surface per operation and allow at most one retry.
- Do not repeat a check unless code or external state changed.
- Run relevant preflight validation before expensive external operations.
- Keep progress updates and tool output summaries concise.
