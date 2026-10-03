/**
 * 键盘快捷键速查（#265；P1-UX 三期刀四）。
 *
 * 硬规则：**面板是说明书，不是愿望清单**——只列**已实现**的快捷键。全仓今天只有
 * 三条（⌘K 全局搜索、⌘↵ 提交、Esc 关闭），就老实列三条；为了把面板填满而新造
 * 快捷键是另一种撒谎（列出来按不出，人按了没反应比不知道更糟）。
 *
 * `?` 只在不处于输入焦点时触发：在搜索框/指令框/留言框里打问号是正常输入
 * （`?` 是中文标点前的常见字符，抢它会把正常打字变成打不开的弹窗）。
 * Esc 关闭并还焦触发元素——Modal 自带 Esc 处理，这里只补「还焦」。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Modal } from '../vendor/dsh-ui/index.js'

const SHORTCUTS: readonly { keys: string; label: string }[] = [
  { keys: '⌘K / Ctrl+K', label: '全局搜索：任务、项目、Agent' },
  { keys: '⌘↵ / Ctrl+↵', label: '提交指令或留言（多行框里 ↵ 是换行）' },
  { keys: 'Esc', label: '关闭浮层/弹窗，并把焦点还给触发它的元素' },
  { keys: '?', label: '打开本面板' },
]

/** 焦点在可输入元素上时不抢键（问号是正常输入）。 */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT'
}

export function ShortcutHelp(): ReactNode {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== '?' || event.metaKey || event.ctrlKey || event.altKey) return
      if (isTypingTarget(event.target)) return
      event.preventDefault()
      triggerRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null
      setOpen(true)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  if (!open) return null
  const close = (): void => {
    setOpen(false)
    triggerRef.current?.focus()
  }

  return (
    <Modal open onClose={close} title="键盘快捷键" headless>
      <div className="shortcut-help">
        <dl>
          {SHORTCUTS.map((shortcut) => (
            <div key={shortcut.keys} className="shortcut-row">
              <dt>
                <kbd>{shortcut.keys}</kbd>
              </dt>
              <dd>{shortcut.label}</dd>
            </div>
          ))}
        </dl>
        <p className="global-search-hint">只列已实现的键；新增快捷键时同步这里。</p>
        {/*
          面板本身没有别的可聚焦内容：给一个关闭钮并 autoFocus，键盘/读屏用户进来
          焦点才落在面板里（否则焦点留在背后的页面上，aria-modal 说了模态而焦点没进来），
          Esc/点它关闭 → 还焦触发元素。
        */}
        <button type="button" className="button button-quiet" autoFocus onClick={close}>
          关闭
        </button>
      </div>
    </Modal>
  )
}
