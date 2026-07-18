/**
 * PWA install prompt plumbing (2026-07-18).
 *
 * Chrome/Android fires `beforeinstallprompt` when the app is installable;
 * we stash the event (preventDefault so Chrome's mini-infobar stays quiet)
 * and re-fire it from our own banner's Install button. iOS has no such
 * event — the banner shows Share → Add to Home Screen instructions instead.
 * Never shown when already running standalone or after a dismissal
 * (`fc:installDismissed`, per device).
 */
import { computed, ref } from 'vue'

const KEY = 'fc:installDismissed'

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

const deferred = ref<BeforeInstallPromptEvent | null>(null)
const dismissed = ref(false)
const installed = ref(false)

/** Register the listeners. Call once on app mount — the event can fire any
 *  time after load, so the listener must exist before pages render. */
export function initInstallPrompt(): void {
  try {
    dismissed.value = localStorage.getItem(KEY) === '1'
  } catch {
    /* private mode — banner just won't remember dismissal */
  }
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    deferred.value = e as BeforeInstallPromptEvent
  })
  window.addEventListener('appinstalled', () => {
    deferred.value = null
    installed.value = true
  })
}

function isStandalone(): boolean {
  try {
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      (navigator as unknown as { standalone?: boolean }).standalone === true
    )
  } catch {
    return false
  }
}

function isIOS(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent)
}

export function useInstallPrompt() {
  /** 'native' → we can trigger the real install dialog; 'ios' → show manual
   *  instructions; null → nothing to offer (installed, dismissed, or the
   *  browser hasn't declared installability). */
  const mode = computed<'native' | 'ios' | null>(() => {
    if (dismissed.value || installed.value || isStandalone()) return null
    if (deferred.value) return 'native'
    if (isIOS()) return 'ios'
    return null
  })

  async function install(): Promise<void> {
    const evt = deferred.value
    if (!evt) return
    deferred.value = null
    await evt.prompt()
    const choice = await evt.userChoice.catch(() => null)
    if (choice?.outcome !== 'accepted') dismiss() // declined = don't re-nag
  }

  function dismiss(): void {
    dismissed.value = true
    try {
      localStorage.setItem(KEY, '1')
    } catch {
      /* noop */
    }
  }

  return { mode, install, dismiss }
}
