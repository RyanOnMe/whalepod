#!/usr/bin/env bash
# RD-03c3a checkpoints. This does not activate private draft sharing.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
pnpm --filter @whalepod/hub... --filter @whalepod/runtime... build
pnpm exec vitest run --project unit \
  apps/hub/tests/draft-share-eligibility.spec.ts \
  apps/hub/tests/artifact-preview-projection.spec.ts \
  packages/protocol/tests/managed-draft.spec.ts
pnpm test:integration \
  apps/hub/tests/work-dispatch.integration.spec.ts \
  apps/hub/tests/managed-draft-source.integration.spec.ts \
  apps/hub/tests/artifact.integration.spec.ts \
  apps/hub/tests/artifact-review.integration.spec.ts \
  apps/hub/tests/realtime.integration.spec.ts
pnpm test:dsh-contract \
  packages/runtime-dsh/tests/dsh-contract/managed-draft-model.contract.spec.ts \
  packages/runtime-dsh/tests/dsh-contract/managed-draft-broker.contract.spec.ts \
  apps/runtime/tests/dsh-contract/managed-draft-worker.contract.spec.ts
