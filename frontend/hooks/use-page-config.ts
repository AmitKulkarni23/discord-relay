import { useEffect, useState } from 'react'
import { fetchConfig, type PageConfig } from '../lib/stream.ts'

/** Reads GET /config once. Until it answers, the page has no tabs and attachments stay off. */
export function usePageConfig(): PageConfig {
  const [config, setConfig] = useState<PageConfig>({ attachments: false, channels: [] })

  useEffect(() => {
    const abort = new AbortController()
    void fetchConfig(abort.signal).then(answer => {
      if (answer) setConfig(answer)
    })
    return () => abort.abort()
  }, [])

  return config
}
