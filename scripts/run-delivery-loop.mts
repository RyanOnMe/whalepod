/** #442: opt into the real LibreOffice lane; missing tool or proof is a failure. */
process.env['WHALEPOD_E2E_OFFICE_PREVIEW'] = '1'
await import('./run-handoff-loop.mts')
