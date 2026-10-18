import { defineConfig } from '@playwright/test'
import base from './playwright.config.js'

/** Production Hub/Node/Runtime assembly; traces disabled to avoid archiving credentials. */
export default defineConfig({
  ...base,
  projects: [{ name: 'focused-workspace', testMatch: /focused-workspace\.spec\.ts/ }],
  use: { ...base.use, trace: 'off' },
})
