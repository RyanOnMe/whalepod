# Contributing to project311

Thanks for your interest in contributing. This document is the short version;
[AGENTS.md](./AGENTS.md) is the authoritative in-repo guide for humans and AI
agents — read it before your first contribution. Where this file and
AGENTS.md disagree, AGENTS.md wins.

## Ground rules

- Work is tracked in GitHub Issues (`P1-XX`). Start from an Issue: claim it
  before writing code.
- `main` is protected. Never push directly to it.
- One Issue, one squash-merged PR, with `P1-XX` in the PR title.
- Tests are part of the same Issue's deliverable — code is not merged "with
  tests to follow".

## Setup

1. Use Node.js 24 and pnpm (the pinned version from `packageManager` in
   `package.json`; enable it with `corepack enable`).
2. After cloning, install the repository hooks — they are required, not
   optional:

   ```bash
   scripts/install-hooks.sh
   ```

3. Install dependencies and run the static gate:

   ```bash
   pnpm install
   pnpm check
   ```

## Branching

Short-lived branches, named after the Issue:

- `feat/p1-<issue>-<slug>` for features
- `fix/p1-<issue>-<slug>` for fixes

Example: `feat/p1-01-monorepo-baseline`.

## Commits and DCO

All commits must carry a Developer Certificate of Origin sign-off. Use:

```bash
git commit -s
```

The `commit-msg` hook installed above enforces this; unsigned commits are
rejected. By signing off you certify the
[Developer Certificate of Origin](https://developercertificate.org/):
that you wrote the change or otherwise have the right to submit it under the
project's license (Apache-2.0).

## Before you push

- Run the quality gates relevant to your change (see the gate table in
  AGENTS.md). At minimum, `pnpm check` must pass.
- Run the secret scan over anything you are about to commit:

  ```bash
  scripts/secret-scan.sh <paths>
  ```

  Secrets, tokens, and absolute local paths must never enter git, logs, or
  shared evidence bundles.

## Pull requests

- One PR per Issue, squash-merged, title contains `P1-XX`.
- Describe what changed and which quality gates you ran, with results.
- PRs touching the protocol, migrations, the DSH adapter, or security policy
  require review by at least two people — see [GOVERNANCE.md](./GOVERNANCE.md).
- Force pushes, `reset --hard`, and other history-rewriting operations that
  can clobber others' work are forbidden.

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](./LICENSE).
