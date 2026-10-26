import { defineConfig } from '@playwright/test'
import base from './playwright.operations.config.js'
/** Runs production workspace flows at isolated ports with frame-level motion observations. */
export default defineConfig({
  ...base,
  projects: [{ name: 'motion-workspace', testMatch: /focused-workspace\.spec\.ts/ }],
})
