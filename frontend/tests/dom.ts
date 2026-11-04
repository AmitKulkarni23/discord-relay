import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll } from 'bun:test'
import { cleanup } from '@testing-library/react'

const register = (): void => {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register({ url: 'http://localhost/' })
}

// Before the components load, because Emotion checks for a document once, on import.
register()

/**
 * Gives one test file a DOM. Not a preload, because replacing fetch and Response globally would
 * break the backend's tests, which run in the same process. Modules are shared across test files,
 * so each file has to ask for it again.
 */
export function setupDom(): void {
  beforeAll(register)
  afterEach(cleanup)
  afterAll(() => GlobalRegistrator.unregister())
}
