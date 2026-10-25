import { useNotices } from '@/state/notices'

export function Notices() {
  const notices = useNotices((state) => state.notices)
  const dismiss = useNotices((state) => state.dismiss)
  if (notices.length === 0) return null
  return (
    <div className="notices" role="status" aria-live="polite">
      {notices.map((notice) => (
        <button
          key={notice.id}
          type="button"
          className={`notice notice-${notice.kind}`}
          onClick={() => dismiss(notice.id)}
        >
          {notice.message}
        </button>
      ))}
    </div>
  )
}
