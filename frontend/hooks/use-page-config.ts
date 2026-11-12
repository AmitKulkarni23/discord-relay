import { useEffect, useState } from 'react'
import { fetchConfig, type PageConfig } from '../lib/stream.ts'

/** Reads GET /config once. Until it answers, the page has no tabs and attachments stay off. */
export function usePageConfig(): PageConfig {
  const [config, setConfig] = useState<PageConfig>({ attachments: false, channels: [] })

  useEffect(() => {
    // Cancels the request if the component unmounts before /config answers. In practice that is
    // StrictMode in development, which runs this effect twice: the first request is aborted, not left racing.
    const abort = new AbortController()
    void fetchConfig(abort.signal).then(answer => {
      if (answer) setConfig(answer)
    })
    return () => abort.abort()
  }, [])

  return config
}
