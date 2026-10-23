import { defineConfig } from '@playwright/test'
import base from './playwright.operations.config.js'

/** P1-432 keeps the user's preview and the parallel checkout untouched. */
export default defineConfig({
  ...base,
  projects: [{ name: 'management-pages', testMatch: /management-pages\.spec\.ts/ }],
})
