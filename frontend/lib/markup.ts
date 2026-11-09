/** One piece of a message's text. Only http and https ever become links. */
export type Part =
  | { kind: 'text' | 'code' | 'block'; text: string }
  | { kind: 'link'; href: string }
  | { kind: 'time'; iso: string }
  | { kind: 'bold' | 'italic' | 'underline' | 'strike' | 'spoiler'; parts: Part[] }

/**
 * Discord's inline syntax, leftmost match first. Headings, quotes, lists and masked links stay as typed.
 * Timestamps stop at 11 digits, because anything longer can be out of range for a Date.
 */
const TOKEN = new RegExp(
  [
    '\\\\(?<escaped>[*_~`|\\\\])',
    '```(?:[a-z0-9+-]*\\n)?(?<block>[\\s\\S]+?)\\n?```',
    '`(?<code>[^`\\n]+)`',
    '<(?<wrapped>https?://[^\\s>]+)>',
    '(?<url>https?://[^\\s<]+)',
    '<t:(?<time>\\d{1,11})(?::[tTdDfFR])?>',
    '\\*\\*(?<bold>[\\s\\S]+?)\\*\\*(?!\\*)',
    '__(?<underline>[\\s\\S]+?)__(?!_)',
    '~~(?<strike>[\\s\\S]+?)~~',
    '\\|\\|(?<spoiler>[\\s\\S]+?)\\|\\|',
    '\\*(?<star>[^*\\s](?:[^*\\n]*[^*\\s])?)\\*',
    '(?<!\\w)_(?<under>[^_\\s](?:[^_\\n]*[^_\\s])?)_(?!\\w)',
  ].join('|'),
  'gi',
)

/** Length of `url` without trailing punctuation, keeping a closing bracket opened inside the URL. */
function linkLength(url: string): number {
  let end = url.length
  while (end > 0) {
    const last = url.charAt(end - 1)
    const closes = last === ')' && url.slice(0, end).split('(').length < url.slice(0, end).split(')').length
    if (!closes && !'.,;:!?\'"]'.includes(last)) break
    end--
  }
  return end
}

/** Splits a message's text into parts for React to render; nothing here ever becomes HTML. */
export function parseMarkup(text: string): Part[] {
  const parts: Part[] = []
  let at = 0
  const addText = (chunk: string): void => {
    const last = parts.at(-1)
    if (last?.kind === 'text') last.text += chunk
    else if (chunk) parts.push({ kind: 'text', text: chunk })
  }
  for (const match of text.matchAll(TOKEN)) {
    const groups = match.groups ?? {}
    const before = text.slice(at, match.index)
    addText(groups.block !== undefined ? before.replace(/\n$/, '') : before)
    at = match.index + match[0].length
    if (groups.block !== undefined && text[at] === '\n') at++
    if (groups.escaped !== undefined) addText(groups.escaped)
    else if (groups.block !== undefined) parts.push({ kind: 'block', text: groups.block })
    else if (groups.code !== undefined) parts.push({ kind: 'code', text: groups.code })
    else if (groups.wrapped !== undefined) parts.push({ kind: 'link', href: groups.wrapped })
    else if (groups.url !== undefined) {
      const href = groups.url.slice(0, linkLength(groups.url))
      // Trimming punctuation can leave only the scheme, which is not an address.
      if (href.endsWith('://')) addText(groups.url)
      else {
        at = match.index + href.length
        parts.push({ kind: 'link', href })
      }
    } else if (groups.time !== undefined) parts.push({ kind: 'time', iso: new Date(Number(groups.time) * 1000).toISOString() })
    else if (groups.bold !== undefined) parts.push({ kind: 'bold', parts: parseMarkup(groups.bold) })
    else if (groups.underline !== undefined) parts.push({ kind: 'underline', parts: parseMarkup(groups.underline) })
    else if (groups.strike !== undefined) parts.push({ kind: 'strike', parts: parseMarkup(groups.strike) })
    else if (groups.spoiler !== undefined) parts.push({ kind: 'spoiler', parts: parseMarkup(groups.spoiler) })
    else parts.push({ kind: 'italic', parts: parseMarkup(groups.star ?? groups.under ?? '') })
  }
  addText(text.slice(at))
  return parts
}
