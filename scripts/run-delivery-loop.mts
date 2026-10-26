/** #442: explicitly verify the production Office isolation fallback and review path. */
process.env['WHALEPOD_E2E_OFFICE_PREVIEW'] = '1'
await import('./run-handoff-loop.mts')
