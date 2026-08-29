/**
 * project311-fixed-time — a minimal DSH tool plugin for the Cordis plugin
 * ecosystem.
 *
 * Loading this package as a Cordis plugin (`ctx.plugin(import('project311-fixed-time'))`
 * or equivalent) registers one tool, `fixed_time`, which always returns the
 * same UTC timestamp. The tool is intentionally deterministic: integration
 * suites assert its exact return value byte-for-byte.
 *
 * Entry convention: the plugin loader unwraps `exports.default ?? exports` and
 * calls `.apply(ctx)` on the result, so a named `apply` export is the canonical
 * entry point for an ESM Cordis plugin.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

/**
 * Cordis service requirements: `apply` reads `ctx.tools`, and Cordis gates
 * service access on the fiber's declared `inject` list ("cannot get property
 * … without inject"). Declaring it in source is the ecosystem contract — hosts
 * mount the package unmodified and never annotate service needs on its behalf.
 */
export const inject = ['tools']

/** The name the tool is registered (and called) under. */
export const FIXED_TIME_TOOL = 'fixed_time'

/** The one value the tool ever returns. */
export const FIXED_TIME_ISO = '2030-01-02T03:04:05.000Z'

/**
 * The registry-ready tool definition.
 *
 * `parameters: {}` declares a no-argument tool (the implicit parameter root
 * accepts only an empty call payload). `output` is the mandatory canonical
 * declaration: the registry validates every successful result against
 * `schema` and uses `render` to produce the model-facing content blocks.
 */
export const fixedTimeTool = defineTool({
  name: FIXED_TIME_TOOL,
  description:
    'Return a fixed UTC timestamp. Deterministic demo tool: always returns ' +
    '2030-01-02T03:04:05.000Z, regardless of arguments or wall-clock time.',
  parameters: {},
  output: {
    schema: {
      type: 'object',
      properties: {
        iso: {
          type: 'string',
          required: true,
          description: 'The fixed UTC timestamp in ISO-8601 format.',
        },
      },
      additionalProperties: false,
    },
    render: (_args, value) => [{ type: 'text', text: `fixed_time: ${value.iso}` }],
  },
  execute: async () => ({ iso: FIXED_TIME_ISO }),
})

/**
 * Cordis plugin entry.
 *
 * `ctx` here is the plugin's own (plain) context: registering on it places
 * `fixed_time` in the process-global tool layer, so every agent created in
 * this context sees the tool in its schema assembly. Registration is disposed
 * together with the plugin's fiber.
 */
export function apply(ctx) {
  ctx.tools.register(fixedTimeTool)
}
