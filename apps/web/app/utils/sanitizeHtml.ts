/**
 * Minimal client-side HTML sanitizer for world-authored item descriptions
 * (SheetViewModel ListItem.detail). The repo ships no game text — this only
 * renders what the user's OWN world legally contains — but we still strip
 * anything executable before v-html: script/style/embed elements, every
 * `on*` event handler attribute, and `javascript:`/`data:` URLs.
 *
 * Runs client-only (the app is ssr:false), so DOMParser is always present.
 */

const BLOCKED_TAGS = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'link',
  'meta',
  'base',
  'form',
])
const URL_ATTRS = new Set(['href', 'src', 'xlink:href'])

export function sanitizeHtml(input: string | undefined | null): string {
  if (!input) return ''
  if (typeof window === 'undefined' || typeof DOMParser === 'undefined') return ''

  const doc = new DOMParser().parseFromString(input, 'text/html')

  for (const el of Array.from(doc.body.querySelectorAll('*'))) {
    if (BLOCKED_TAGS.has(el.tagName.toLowerCase())) {
      el.remove()
      continue
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase()
      const value = attr.value.replace(/\s+/g, '').toLowerCase()
      if (name.startsWith('on')) {
        el.removeAttribute(attr.name)
      } else if (URL_ATTRS.has(name) && (value.startsWith('javascript:') || value.startsWith('data:'))) {
        el.removeAttribute(attr.name)
      } else if (name === 'style' && /expression|url\(|@import/i.test(attr.value)) {
        el.removeAttribute(attr.name)
      }
    }
  }

  return doc.body.innerHTML
}
