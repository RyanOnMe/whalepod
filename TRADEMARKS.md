# Trademark Policy

WhalePod is the project's official name (decided in #133, 2026-09; former
development codenames: tabtin, project311). This policy applies to the name
WhalePod, its historical codenames, and any project logos or other brand
assets (together, the "Marks").

## What the license does not grant

The project is licensed under the [Apache License, Version 2.0](./LICENSE).
Section 6 of that license is explicit: it does **not** grant permission to use
the trade names, trademarks, service marks, or product names of the licensor,
except as required for reasonable and customary use in describing the origin of
the work.

In practical terms, this means you may not use the Marks in a way that suggests
official status, endorsement, sponsorship, or affiliation with the project or
its maintainers, without separate written permission.

## Allowed without asking

- Truthful, referential use: describing your software as "based on",
  "compatible with", or "built with whalepod" (or the final project name).
- Referring to the project by name in articles, talks, documentation, and
  comparisons, as long as it is clear you are not speaking for the project.
- Reproducing unmodified copyright and attribution notices, as the license
  requires.

## Requires separate permission

- Using the Marks in the name of a fork, derivative distribution, hosted
  service, or commercial offering (for example, names like "whalepod Cloud"
  or "whalepod Pro").
- Using project logos or stylized wordmarks on merchandise, marketing material,
  or your own product branding.
- Any use that could reasonably lead others to believe your product or service
  is official, endorsed, or certified by the project.

For permission requests, open a discussion with the maintainers through the
project's GitHub repository.

## Forks and redistributions

Forks and redistributions are welcome under the Apache-2.0 license, but they
must be clearly distinguishable from the official project: use your own name
and branding, and state the origin of the code as the license requires.

## Third-party marks: DeepSeek Harness (DSH)

WhalePod vendors a copy of selected **DeepSeek Harness client UI source code**
(see [NOTICE](./NOTICE) and
[docs/agent/dsh-ui-vendoring.md](./docs/agent/dsh-ui-vendoring.md)). This
policy section is about *their* marks, not ours.

**What the vendoring covers: code only.** The copy is limited to source files
under upstream `packages/client/ui-theme` and `packages/client/ui-primitives`.
It does **not** include the DSH name, logo, whale mark, wordmark, or any other
brand asset. Brand packages such as `ui-brand-official` — and brand artwork that
happens to live inside an otherwise vendored package (for example upstream
`FishLogo.tsx` and `BrandWordmark.tsx`) — are deliberately **not** copied. The
exclusion list and its review procedure are recorded in
[docs/agent/dsh-ui-vendoring.md](./docs/agent/dsh-ui-vendoring.md) §3.3.

The distinction matters because the two grants are separate: the MIT License
covers copyright only and conveys **no trademark rights**. Vendoring MIT code is
therefore not a license to use DSH branding, and the upstream brand guidelines
apply to us as they do to anyone else:

- You may truthfully describe the relationship, e.g. "includes MIT-licensed code
  from DeepSeek Harness" or "compatible with DSH".
- You may **not** use "DeepSeek Harness" in a product or project name, and you
  may not use DSH logos or brand artwork in a way suggesting official status,
  endorsement, sponsorship, or affiliation.
- WhalePod's own name and branding stay separate from DSH's; WhalePod ships its
  own visual identity.

Upstream reference:
[DeepSeek Harness Brand Asset Usage Guidelines](https://github.com/deepseek-ai/deepseek-harness/blob/master/BRAND_GUIDELINES.md).
