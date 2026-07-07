<template>
  <div class="scrim" @click.self="emit('answer', false)">
    <div class="modal-sheet" role="alertdialog" aria-modal="true">
      <p class="msg">{{ message }}</p>
      <div class="row">
        <button class="btn" type="button" @click="emit('answer', false)">Cancel</button>
        <button class="btn btn-accent" type="button" @click="emit('answer', true)">Confirm</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{ message: string }>()
const emit = defineEmits<{ (e: 'answer', value: boolean): void }>()
</script>

<style scoped>
.msg {
  font-size: 1rem;
  font-weight: 600;
  text-align: center;
  padding: 8px 4px 18px;
}

.row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
</style>
