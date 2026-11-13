/**
 * Pure helpers for attachments: is this URL on Discord's CDN, how to show this file type,
 * human-readable sizes, and fitting media into a box.
 */
/** True when `url` is an https URL on a Discord CDN host, the only images the page loads. */
export function isDiscordCdn(url: string | null): url is string {
  if (!url) return false
  try {
    const { protocol, host } = new URL(url)
    return protocol === 'https:' && (host === 'cdn.discordapp.com' || host === 'media.discordapp.net')
  } catch {
    return false
  }
}

/** How an attachment is shown. SVG is a plain file: it can carry script when opened directly. */
export function attachmentKind(contentType: string | null): 'image' | 'video' | 'audio' | 'file' {
  if (!contentType || contentType.startsWith('image/svg')) return 'file'
  if (contentType.startsWith('image/')) return 'image'
  if (contentType.startsWith('video/')) return 'video'
  if (contentType.startsWith('audio/')) return 'audio'
  return 'file'
}

/** A byte count as `512 B`, `47.1 KB` or `25.0 MB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Scales `width` x `height` down to fit inside `maxW` x `maxH`, keeping the
 * aspect ratio, so the feed reserves the right space before the media loads.
 * Null when Discord did not report a size.
 */
export function fitBox(width: number | null, height: number | null, maxW: number, maxH: number): { width: number; height: number } | null {
  if (!width || !height) return null
  const scale = Math.min(1, maxW / width, maxH / height)
  return { width: Math.round(width * scale), height: Math.round(height * scale) }
}
