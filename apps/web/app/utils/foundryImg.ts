/**
 * Resolve an image path from a Foundry document (actor img, effect icon).
 *
 * Foundry serializes world-relative paths like 'systems/dnd5e/tokens/x.webp'.
 * Those are served by Foundry itself (cross-origin), not by this app. When a
 * `foundryBase` origin is configured we prefix relative paths with it; absolute
 * URLs and same-origin ('/…') paths pass through untouched. Callers still fall
 * back to a glyph on load error, so an unreachable image never blocks the UI.
 */
export function foundryImgUrl(img: string | undefined, foundryBase: string): string | undefined {
  if (!img) return undefined
  if (/^(https?:)?\/\//i.test(img) || img.startsWith('data:') || img.startsWith('/')) return img
  if (!foundryBase) return img
  return `${foundryBase.replace(/\/$/, '')}/${img.replace(/^\/+/, '')}`
}
