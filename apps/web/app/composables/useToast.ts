import { reactive, readonly } from 'vue'

export interface Toast {
  id: number
  message: string
}

const state = reactive<{ toasts: Toast[] }>({ toasts: [] })
let nextId = 1

export function useToast() {
  function show(message: string, duration = 3200): void {
    const id = nextId++
    state.toasts.push({ id, message })
    setTimeout(() => {
      const i = state.toasts.findIndex((t) => t.id === id)
      if (i !== -1) state.toasts.splice(i, 1)
    }, duration)
  }

  return { toasts: readonly(state).toasts, show }
}
