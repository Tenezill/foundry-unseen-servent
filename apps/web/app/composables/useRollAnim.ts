/**
 * Roll-animation preference (2026-07-18). Mirrors useTheme's storage pattern:
 * one localStorage key, a reactive value, and a toggle. The animation is a
 * client-side suspense overlay only — dice are still rolled server-side.
 *
 * `enabled()` is the single gate: user preference AND the OS
 * prefers-reduced-motion setting (reduced motion always wins).
 */
import { ref } from 'vue'

const KEY = 'fc:rollAnim'
const on = ref(true)

function safeGet(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'off'
  } catch {
    return true
  }
}

/** Apply the stored preference. Call once on page setup (client-only app). */
export function applyStoredRollAnim(): void {
  on.value = safeGet()
}

export function useRollAnim() {
  function enabled(): boolean {
    if (!on.value) return false
    try {
      return !window.matchMedia('(prefers-reduced-motion: reduce)').matches
    } catch {
      return true
    }
  }

  function toggle(): void {
    on.value = !on.value
    try {
      localStorage.setItem(KEY, on.value ? 'on' : 'off')
    } catch {
      /* private mode / quota — the choice still applies for this session */
    }
  }

  return { on, enabled, toggle }
}
