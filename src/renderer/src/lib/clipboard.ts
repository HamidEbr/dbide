/** Puts text on the clipboard. Falls back to the old path where the async API is refused. */
export async function writeClipboard(text: string): Promise<void> {
  // A smoke run must not overwrite the clipboard of the person who started it. It reads this instead.
  if (window.dbide.smoke) {
    window.__dbide_clipboard = text
    return
  }
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    document.execCommand('copy')
    area.remove()
  }
}
