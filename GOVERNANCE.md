# Governance

This document describes how decisions are made in whalepod during its first
development phase. The project is young and the maintainer team is small; the
process is deliberately lightweight and will evolve as the community grows.

## Roles

- **Maintainers** own the repository and the roadmap. They review and merge
  pull requests, cut releases, and make final calls.
- **Contributors** are anyone who opens issues, pull requests, or
  participates in discussions. See [CONTRIBUTING.md](./CONTRIBUTING.md) for
  how to get involved.

## How decisions are made

- Day-to-day technical choices are made in the open, on the relevant GitHub
  Issue or pull request. Rough consensus among participants is enough.
- Where consensus does not emerge, or a decision affects the project's
  direction, **the maintainers make the final call**. In this phase there is
  no formal voting; the maintainer who owns the affected area decides and
  records the reasoning.
- Disagreements that cannot be resolved on the Issue/PR may be escalated to
  the maintainer group as a whole, whose decision is final.

## Architecture Decision Records (ADRs)

Decisions that are hard to reverse — protocol shapes, persistence layouts,
dependency choices, security posture — must be recorded as an ADR in
[docs/adr/](./docs/adr/) **before or together with** the change that
implements them. An ADR captures the context, the options considered, and the
decision, so future contributors can understand why the system looks the way
it does.

## Pull request review

- All changes land via pull request against `main`; no direct pushes.
- One Issue, one squash-merged PR, with `P1-XX` in the title.
- PRs touching any of the following require review and approval by **at
  least two people**, and the reviewers must be different from the author:
  - the runtime protocol (`03-领域模型与运行协议.md` territory),
  - data migrations,
  - the DSH adapter,
  - security policy or security-relevant code.
- Other PRs require at least one maintainer review.

## Quality gates

Merging requires the relevant quality gates (Q0–Q9, defined in
`04-验收矩阵与测试策略.md` and summarized in [AGENTS.md](./AGENTS.md)) to pass
with machine evidence. "Looks fine in the UI" is never sufficient evidence.
Tests are part of an Issue's deliverable; nothing is merged "with tests to
follow".

## Changing this document

Changes to this governance document follow the same process as any other
change: a pull request, reviewed by the maintainers, with the reasoning
recorded in the PR.
