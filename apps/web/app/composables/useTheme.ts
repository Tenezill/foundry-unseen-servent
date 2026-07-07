/**
 * Theme override for the Gilded Tome design system.
 *
 * The CSS defaults to prefers-color-scheme; stamping `data-theme` on <html>
 * overrides it (see assets/css/main.css). This composable persists the user's
 * explicit choice and exposes a toggle. `null` = follow the device.
 */
import { ref } from 'vue'

type ThemeChoice = 'dark' | 'light'

const THEME_KEY = 'fc:theme'
const choice = ref<ThemeChoice | null>(null)

function safeGet(): ThemeChoice | null {
  try {
    const v = localStorage.getItem(THEME_KEY)
    return v === 'dark' || v === 'light' ? v : null
  } catch {
    return null
  }
}

function stamp(value: ThemeChoice | null): void {
  const root = document.documentElement
  if (value) root.dataset.theme = value
  else delete root.dataset.theme
}

/** Effective theme right now (explicit choice, else the device preference). */
function effective(): ThemeChoice {
  if (choice.value) return choice.value
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/** Apply any stored override. Call once on app mount. */
export function applyStoredTheme(): void {
  choice.value = safeGet()
  stamp(choice.value)
}

export function useTheme() {
  function toggle(): void {
    const next: ThemeChoice = effective() === 'dark' ? 'light' : 'dark'
    choice.value = next
    stamp(next)
    try {
      localStorage.setItem(THEME_KEY, next)
    } catch {
      /* private mode / quota — override still applies for this session */
    }
  }

  return { choice, effective, toggle }
}
