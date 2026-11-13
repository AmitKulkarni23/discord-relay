/**
 * Loads GET /config once when the page opens: the channel list (for the tabs) and the
 * feature flags.
 */
import { useEffect, useState } from 'react'
import { fetchConfig, type PageConfig } from '../lib/config.ts'

/** Reads GET /config once. Until it answers, the page has no tabs and attachments stay off. */
export function usePageConfig(): PageConfig {
  const [config, setConfig] = useState<PageConfig>({ attachments: false, channels: [] })

  useEffect(() => {
    // Cancels the request if the component unmounts before /config answers. In practice that is
    // StrictMode in development, which runs this effect twice: the first request is aborted, not left racing.
    const controller = new AbortController()
    void fetchConfig(controller.signal).then(answer => {
      if (answer) setConfig(answer)
    })
    return () => controller.abort()
  }, [])

  return config
}
