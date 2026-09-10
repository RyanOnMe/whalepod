# whalepod-fixed-time

An ecosystem-shaped **fixture**: a minimal, unmodified DSH tool plugin written
the way a third-party Cordis ecosystem package would be written. It registers a
single tool, `fixed_time`, that always returns `2030-01-02T03:04:05.000Z`.

This package is the "unmodified plugin" evidence for whalepod's curated plugin
pack flow (P1-17): it contains **no** whalepod-specific branches, no patching
hooks, and no knowledge of the host product. Everything whalepod-specific
(manifest review overlay, lockfile, pack digest) lives *outside* the tarball in
`plugins/catalog/`, `plugins/locks/`, and `plugins/curated-pack.json`.

- Runtime dependency: none. `@deepseek-ai/dsh-tools` is declared as a
  `peerDependency` — the host DSH distribution provides it at runtime, so the
  package installs with an empty dependency closure.
- Tool behavior is deterministic so integration tests can assert the exact
  canonical return value (`{ iso: '2030-01-02T03:04:05.000Z' }`).

## Tool registration path (research notes)

How an ecosystem tool plugin gets itself into an agent's tool scope, verified
against `@deepseek-ai/dsh-tools@0.1.0-rc.8` / `@deepseek-ai/cordis@4.0.1`:

1. **Canonical path — register on the plugin context (what this fixture does).**
   `dsh-tools` exposes a `tools` service (`ctx.tools`). Calling
   `ctx.tools.register(definition)` inside `apply(ctx)` — a *plain* plugin
   context — registers the definition in the **process-global layer**. Every
   agent created under that context then sees the tool: the registry feeds its
   schemas into the system-prompt assembly automatically
   (`ctx.systemPrompt.tools()`), under both native and Code Mode presentation.
   This is the documented extension point: "Tool plugins call
   `ctx.tools.register()` — schemas flow into the assembly automatically"
   (dsh-tools README, Extension points). Registration is disposed with the
   plugin's fiber, so unloading the plugin unregisters the tool.

2. **Per-agent path — register inside agent creation setup.** A host that wants
   a tool scoped to one agent calls it in `ctx.agents.create({ setup:
   (agentCtx) => agentCtx.tools.register(...) })`; an `agent.ctx` registration
   applies to that agent alone and **shadows** a same-named global there.
   whalepod's own runtime uses exactly this for its run-scoped
   `publish_artifact` tool (`packages/runtime-dsh/src/session-owner.ts`,
   `agentCtx.tools.register(...)`). A plugin that cannot hook `create` can
   listen for the `agent/created` event and call
   `payload.agent.ctx.tools.register(...)` — `Agent.ctx` is a public readonly
   field and `agent/created` fires after setup with composition-only
   semantics, so late registration still lands before the agent's next turn.

3. **Visibility modifiers are agent-scoped and host-owned.** `ctx.tools.restrict()`
   and `ctx.tools.presentAs()` throw on a plain context — they are per-agent
   composition tools, not something an ecosystem plugin should reach for.
   Scope layers never merge downward: agent-scope registration hides but does
   not mutate the global definition.

4. **Mandatory canonical output.** `ctx.tools.register` rejects definitions
   without `output { schema, render }`; `defineTool` (exported from
   `@deepseek-ai/dsh-tools`) builds a validated, typed definition with argument
   checking. This fixture declares a no-parameter tool
   (`parameters: {}`) and an object output schema with one required `iso`
   string, `additionalProperties: false`.

5. **Entry convention.** The Cordis plugin loader normalizes
   `exports.default ?? exports` before applying, so a named
   `export function apply(ctx)` is sufficient for an ESM plugin; the loader
   then calls `.apply(ctx)` on the module object. No default export is needed.

6. **Service requirements are self-declared (`inject`).** Cordis gates service
   access on the fiber's declared `inject` list: reading `ctx.tools` inside
   `apply` without it fails with "cannot get property 'tools' without inject"
   (verified empirically by the whalepod Q3 contract probe). This fixture
   therefore declares `export const inject = ['tools']` in source. That is the
   ecosystem contract: the host mounts the package **unmodified** and never
   annotates service needs on the plugin's behalf (no patching, no mount-time
   `inject` rows). Reviewers of catalog entries must reject packages that use
   `ctx.*` services without declaring `inject`.

The `fixed_time` tool itself is deliberately trivial (a constant), so the
fixture exercises the full registration surface — define → register → schema
assembly → execute → canonical output — without carrying any logic that could
hide a side effect.
