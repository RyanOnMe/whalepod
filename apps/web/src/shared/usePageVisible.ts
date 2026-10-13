import { useSyncExternalStore } from 'react'

function subscribe(listener: () => void): () => void {
  document.addEventListener('visibilitychange', listener)
  return () => document.removeEventListener('visibilitychange', listener)
}
const isVisible = (): boolean => document.visibilityState === 'visible'

/** Subscribe only where activity is drawn; no parent or token-stream subscription. */
export function usePageVisible(): boolean {
  return useSyncExternalStore(subscribe, isVisible)
}
