import { z } from 'zod'
import { ArtifactManifestEntrySchema } from './http.js'
import { HandoffNarrativeSchema } from './handoff.js'
import { TaskSpecContentSchema } from './task-views.js'

/** A read-only projection of recorded provenance; never a correctness verdict. */
const InputsSchema = z
  .strictObject({
    status: z.enum(['recorded', 'unknown', 'not_selected']),
    complete: z.boolean(),
    artifacts: z.array(ArtifactManifestEntrySchema).max(64),
  })
  .refine(
    (value) =>
      value.status === 'recorded' ||
      (value.artifacts.length === 0 && value.complete === (value.status === 'not_selected')),
    'unknown inputs cannot be declared complete or contain guessed materials',
  )

export const ArtifactDeliveryBasisSchema = z.strictObject({
  artifactId: z.uuid(),
  taskId: z.uuid(),
  sourceRun: z
    .strictObject({
      id: z.uuid(),
      createdAt: z.iso.datetime(),
      status: z.enum([
        'queued',
        'dispatching',
        'running',
        'waiting_approval',
        'cancel_requested',
        'completed',
        'failed',
        'cancelled',
        'lost',
      ]),
    })
    .nullable(),
  agreement: z
    .strictObject({
      status: z.enum(['bound', 'unbound', 'unavailable']),
      revision: z
        .strictObject({
          id: z.uuid(),
          revisionNumber: z.number().int().positive(),
          content: TaskSpecContentSchema,
          confirmedByUserId: z.uuid().nullable(),
          confirmedAt: z.iso.datetime().nullable(),
        })
        .nullable(),
    })
    .refine((value) => (value.status === 'bound') === (value.revision !== null)),
  taskInputs: InputsSchema,
  handoffInputs: InputsSchema,
  /** Most recent published handoff explicitly naming this exact output. */
  handoffs: z
    .array(
      z.strictObject({
        id: z.uuid(),
        revisionNumber: z.number().int().positive(),
        publishedByUserId: z.uuid(),
        publishedAt: z.iso.datetime(),
        narrative: HandoffNarrativeSchema,
        referencesComplete: z.boolean(),
      }),
    )
    .max(1),
})
export type ArtifactDeliveryBasis = z.infer<typeof ArtifactDeliveryBasisSchema>
