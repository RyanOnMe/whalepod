/** Input modality only controls the optional page motion; never business state. */
import { useEffect } from 'react'
export function useMotionInput(): void {
  useEffect(() => {
    const root = document.documentElement
    const pointer = () => {
      root.dataset.uiInput = 'pointer'
    }
    const keyboard = () => {
      root.dataset.uiInput = 'keyboard'
    }
    document.addEventListener('pointerdown', pointer, true)
    document.addEventListener('keydown', keyboard, true)
    return () => {
      document.removeEventListener('pointerdown', pointer, true)
      document.removeEventListener('keydown', keyboard, true)
      delete root.dataset.uiInput
    }
  }, [])
}
