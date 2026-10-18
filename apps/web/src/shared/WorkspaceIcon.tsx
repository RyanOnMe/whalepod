/** Small application navigation glyphs; drawn locally, no icon dependency. */
export function WorkspaceIcon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    返回: 'M15 5l-7 7 7 7',
    关闭: 'M6 6l12 12 M6 18L18 6',
    添加: 'M12 5v14 M5 12h14',
    更多: 'M5 12h.01 M12 12h.01 M19 12h.01',
    设置: 'M4 7h16 M4 17h16 M8 4v6 M16 14v6',
    项目: 'M3 5h6l2 2h10v13H3z M3 10h18',
    成员: 'M8 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M2 21v-2a6 6 0 0 1 12 0v2 M16 5a4 4 0 0 1 0 8 M18 16a5 5 0 0 1 4 5',
    Agents: 'M5 7h14v13H5z M12 3v4 M9 12h.01 M15 12h.01 M9 16h6 M2 11v5 M22 11v5',
    插件: 'M8 3h8v5h5v8h-5v5H8v-5H3V8h5z',
    设备: 'M3 4h18v13H3z M8 21h8 M12 17v4',
  }
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {name === '更多' ? (
        <>
          {[5, 12, 19].map((cx) => (
            <circle key={cx} cx={cx} cy="12" r="1.6" fill="currentColor" stroke="none" />
          ))}
        </>
      ) : (
        <path d={paths[name] ?? paths.项目} />
      )}
    </svg>
  )
}
