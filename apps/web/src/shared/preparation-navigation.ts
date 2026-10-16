export function preparationDeviceHref(taskId: string): string {
  return `/devices?preparationTask=${encodeURIComponent(taskId)}`
}
export function preparationTaskId(value: string | null): string | null {
  return value !== null &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null
}
