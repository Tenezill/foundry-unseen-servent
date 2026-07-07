<template>
  <div class="page">
    <div class="head">
      <span class="skel avatar" />
      <span class="skel line" style="width: 45%" />
    </div>
    <div class="chips">
      <span v-for="i in 4" :key="i" class="skel chip-skel" />
    </div>
    <div class="blocks">
      <span class="skel block" style="height: 96px" />
      <span class="skel block" style="height: 72px" />
      <span class="skel block" style="height: 180px" />
    </div>
  </div>
</template>

<style scoped>
.head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}

.avatar {
  width: 48px;
  height: 48px;
  flex: none;
}

.line {
  height: 22px;
}

.chips {
  display: flex;
  gap: 8px;
  margin-bottom: 20px;
}

.chip-skel {
  width: 64px;
  height: 48px;
}

.blocks {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.block {
  width: 100%;
  display: block;
}
</style>
