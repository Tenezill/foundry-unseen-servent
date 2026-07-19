/**
 * Zero-dependency mock of the gateway API (docs/API.md) for standalone PWA dev.
 *
 *   node mock/server.mjs      # listens on :8090 (nuxt dev proxies /api here)
 *
 * - Accepts the invite token "demo" (Bearer header or ?token=).
 * - Serves a mutable in-memory dnd5e-ish view model, STRICTLY in the
 *   SheetViewModel shape from @companion/adapter-sdk (incl. M6 actions[]).
 * - POST /api/actors/:id/actions validates like the real gateway (403 for
 *   unknown action ids / kind mismatch, 422 for bad payloads) and returns
 *   { result, sheet }. Roll totals cycle 8, 15, 20 (20 = critical).
 * - SSE per actor: current sheet on connect, ping every 25s, and a random
 *   HP drift every ~20s so live updates are visible without a GM.
 */
import { createServer } from 'node:http'

const PORT = Number(process.env.PORT || 8090)
const TOKEN = 'demo'
const PLAYER = { name: 'Demo Player', actorIds: ['a-sariel', 'a-brakk'] }

const ABILITY_NAMES = {
  str: 'Strength',
  dex: 'Dexterity',
  con: 'Constitution',
  int: 'Intelligence',
  wis: 'Wisdom',
  cha: 'Charisma',
}

/* ------------------------------------------------------------------------- */
/* Mutable resource state. Descriptors match adapter-sdk ResourceDescriptor.  */
/* Internal-only fields on section defs (attackMod, equip, level, use) are    */
/* stripped by buildSheet — the wire format stays SheetViewModel-strict.      */
/* ------------------------------------------------------------------------- */

function r(id, label, value, opts = {}) {
  return { id, label, value, min: 0, step: 1, writable: true, ...opts }
}

const actors = new Map()

actors.set('a-sariel', {
  id: 'a-sariel',
  name: 'Sariel Dawnwhisper',
  img: '/icons/portrait-caster.svg',
  systemId: 'dnd5e',
  baseAc: 12,
  // M8: sample active conditions + a concentrated spell (toggled off by End).
  conditions: [{ id: 'poisoned', label: 'Poisoned' }],
  concentration: { label: 'Haste' },
  resources: [
    r('currency.pp', 'Platinum', 4, { group: 'currency' }),
    r('hp', 'Hit Points', 24, { max: 31, group: 'hp' }),
    r('hp.temp', 'Temp HP', 0, { group: 'hp' }),
    r('slots.1', '1st Level', 3, { max: 4, group: 'slots', level: 1 }),
    r('slots.2', '2nd Level', 2, { max: 3, group: 'slots', level: 2 }),
    r('slots.3', '3rd Level', 1, { max: 2, group: 'slots', level: 3 }),
    r('hitdice.d6', 'Hit Dice (d6)', 4, { max: 5, group: 'hitdice' }),
    r('deathsaves.success', 'Successes', 0, { max: 3, group: 'deathsaves' }),
    r('deathsaves.failure', 'Failures', 0, { max: 3, group: 'deathsaves' }),
    r('currency.gp', 'Gold', 62, { group: 'currency' }),
    r('currency.sp', 'Silver', 30, { group: 'currency' }),
    r('item.i-potion.qty', 'Potion of Healing', 2, { max: 99, group: 'items' }),
    r('item.i-wand.uses', 'Wand of Magic Missiles', 5, { max: 7, group: 'items' }),
  ],
  headline: [
    { id: 'class', label: 'Class', value: 'Wizard 5' },
    { id: 'speed', label: 'Speed', value: '30 ft' },
    { id: 'prof', label: 'Prof', value: '+3' },
    { id: 'dc', label: 'Spell DC', value: 15 },
  ],
  staticSections: {
    abilities: [
      { id: 'str', label: 'STR', value: 8, sub: '-1' },
      { id: 'dex', label: 'DEX', value: 14, sub: '+2' },
      { id: 'con', label: 'CON', value: 14, sub: '+2' },
      { id: 'int', label: 'INT', value: 18, sub: '+4' },
      { id: 'wis', label: 'WIS', value: 12, sub: '+1' },
      { id: 'cha', label: 'CHA', value: 10, sub: '+0' },
    ],
    skills: [
      { id: 'arc', label: 'Arcana', value: '+7' },
      { id: 'inv', label: 'Investigation', value: '+7' },
      { id: 'per', label: 'Perception', value: '+1' },
    ],
    saves: [
      { id: 'int', label: 'INT Save', value: '+7' },
      { id: 'wis', label: 'WIS Save', value: '+4' },
      { id: 'dex', label: 'DEX Save', value: '+2' },
    ],
    inventory: [
      { id: 'i-staff', label: 'Quarterstaff', sub: '1d6 bludgeoning', attackMod: 2, equip: { equipped: false, acBonus: 0 } },
      { id: 'i-potion', label: 'Potion of Healing', sub: 'consumable', resourceId: 'item.i-potion.qty', detail: '<p>A swirling crimson draught, warm to the touch. <strong>Drink</strong> it and feel your wounds knit closed as ruby light spreads through your veins.</p><p><em>Half a flask remains after each sip.</em></p>' },
      { id: 'i-wand', label: 'Wand of Magic Missiles', sub: 'charges', resourceId: 'item.i-wand.uses', tags: ['attuned'], detail: '<p>A slender rod of pale ash, ringed with silver.</p><ul><li>Hums faintly when charges remain.</li><li>Grows cold and dull when spent.</li></ul>' },
      { id: 'i-book', label: 'Spellbook' },
      { id: 'i-pouch', label: 'Component Pouch' },
    ],
    spells: [
      { id: 's-firebolt', label: 'Fire Bolt', sub: 'Cantrip · V,S', level: 0, effectType: 'damage' },
      { id: 's-magearmor', label: 'Mage Armor', sub: '1st · V,S,M', tags: ['prepared'], level: 1, effectType: 'utility' },
      { id: 's-detect', label: 'Detect Magic', sub: '1st · V,S · 1/long rest', tags: ['free use', 'ritual', 'concentration'], level: 1, effectType: 'utility' },
      { id: 's-shield', label: 'Shield', sub: '1st · V,S', level: 1, effectType: 'utility', buff: { name: 'Shield', ac: 5 } },
      { id: 's-mistystep', label: 'Misty Step', sub: '2nd · V', level: 2, effectType: 'utility' },
      { id: 's-fireball', label: 'Fireball', sub: '3rd · V,S,M', tags: ['prepared'], level: 3, effectType: 'damage', detail: '<p>A bead of glowing amber streaks from your fingertip and blooms into roaring flame.</p><p><strong>The academy warns:</strong> mind your allies, and mind the drapes.</p>' },
    ],
    features: [
      { id: 'f-recovery', label: 'Arcane Recovery', sub: 'Wizard 1', use: true },
      { id: 'f-sculpt', label: 'Sculpt Spells', sub: 'Evocation 2' },
    ],
  },
})

actors.set('a-brakk', {
  id: 'a-brakk',
  name: 'Brakk Ironhide',
  img: '/icons/portrait-martial.svg',
  systemId: 'dnd5e',
  baseAc: 16,
  conditions: [{ id: 'prone', label: 'Prone' }],
  concentration: null,
  resources: [
    r('hp', 'Hit Points', 39, { max: 45, group: 'hp' }),
    r('hp.temp', 'Temp HP', 0, { group: 'hp' }),
    r('hitdice.d10', 'Hit Dice (d10)', 3, { max: 5, group: 'hitdice' }),
    r('deathsaves.success', 'Successes', 0, { max: 3, group: 'deathsaves' }),
    r('deathsaves.failure', 'Failures', 0, { max: 3, group: 'deathsaves' }),
    r('currency.gp', 'Gold', 15, { group: 'currency' }),
    r('item.i-arrows.qty', 'Arrows', 28, { max: 99, group: 'items' }),
    r('item.i-javelin.qty', 'Javelins', 4, { max: 12, group: 'items' }),
  ],
  headline: [
    { id: 'class', label: 'Class', value: 'Fighter 5' },
    { id: 'speed', label: 'Speed', value: '30 ft' },
    { id: 'prof', label: 'Prof', value: '+3' },
  ],
  staticSections: {
    abilities: [
      { id: 'str', label: 'STR', value: 18, sub: '+4' },
      { id: 'dex', label: 'DEX', value: 12, sub: '+1' },
      { id: 'con', label: 'CON', value: 16, sub: '+3' },
      { id: 'int', label: 'INT', value: 9, sub: '-1' },
      { id: 'wis', label: 'WIS', value: 13, sub: '+1' },
      { id: 'cha', label: 'CHA', value: 10, sub: '+0' },
    ],
    skills: [
      { id: 'ath', label: 'Athletics', value: '+7' },
      { id: 'itm', label: 'Intimidation', value: '+3' },
      { id: 'prc', label: 'Perception', value: '+4' },
    ],
    saves: [
      { id: 'str', label: 'STR Save', value: '+7' },
      { id: 'con', label: 'CON Save', value: '+6' },
      { id: 'dex', label: 'DEX Save', value: '+1' },
    ],
    inventory: [
      { id: 'i-sword', label: 'Longsword', sub: '1d8 slashing', attackMod: 7, equip: { equipped: true, acBonus: 0 }, detail: '<p>A well-worn blade with a leather-wrapped grip, notched from a hundred skirmishes.</p><p><em>Balanced enough to wield in one hand or two.</em></p>' },
      { id: 'i-bow', label: 'Longbow', sub: '1d8 piercing', attackMod: 4, equip: { equipped: false, acBonus: 0 } },
      { id: 'i-arrows', label: 'Arrows', sub: 'ammunition', resourceId: 'item.i-arrows.qty' },
      { id: 'i-javelin', label: 'Javelins', sub: '1d6 piercing', resourceId: 'item.i-javelin.qty', attackMod: 7 },
      { id: 'i-shield', label: 'Shield', sub: '+2 AC', equip: { equipped: true, acBonus: 2 } },
    ],
    spells: null,
    features: [
      { id: 'f-secondwind', label: 'Second Wind', sub: 'Fighter 1', use: true },
      { id: 'f-surge', label: 'Action Surge', sub: 'Fighter 2', use: true },
    ],
  },
})

/* ------------------------------------------------------------------------- */
/* Actions (M6): ActionDescriptor[] derived from the mutable state            */
/* ------------------------------------------------------------------------- */

function availableSlotLevels(actor, minLevel) {
  return actor.resources
    .filter((x) => x.group === 'slots' && x.value > 0)
    .map((x) => Number(x.id.split('.')[1]))
    .filter((n) => n >= minLevel)
    .sort((a, b) => a - b)
}

function buildActions(actor) {
  const s = actor.staticSections
  const actions = []
  for (const a of s.abilities) {
    actions.push({ id: `ability.${a.id}.check`, label: `${ABILITY_NAMES[a.id]} check`, kind: 'check' })
  }
  for (const a of s.saves ?? []) {
    actions.push({ id: `ability.${a.id}.save`, label: `${ABILITY_NAMES[a.id]} save`, kind: 'save' })
  }
  for (const a of s.skills ?? []) {
    actions.push({ id: `skill.${a.id}`, label: `${a.label} check`, kind: 'check' })
  }
  for (const it of s.inventory) {
    if (it.attackMod !== undefined) {
      actions.push({ id: `item.${it.id}.attack`, label: it.label, kind: 'attack' })
      // Companion damage roll, like the real dnd5e adapter (M14). Accepts
      // the nat-20 `critical` flag (doubled dice).
      actions.push({ id: `item.${it.id}.damage`, label: it.label, kind: 'damage' })
    }
    if (it.equip) {
      actions.push({ id: `item.${it.id}.equip`, label: it.label, kind: 'equip', equipped: it.equip.equipped })
    }
  }
  for (const sp of s.spells ?? []) {
    const a = { id: `spell.${sp.id}.cast`, label: sp.label, kind: 'cast', level: sp.level }
    if (sp.effectType) a.effectType = sp.effectType
    if (sp.level > 0) a.slotLevels = availableSlotLevels(actor, sp.level)
    actions.push(a)
  }
  for (const f of s.features) {
    if (f.use) actions.push({ id: `feature.${f.id}.use`, label: f.label, kind: 'use' })
  }
  // M8 actor-scoped commands (no item target).
  actions.push({ id: 'rest.short', label: 'Short Rest', kind: 'rest' })
  actions.push({ id: 'rest.long', label: 'Long Rest', kind: 'rest' })
  actions.push({ id: 'deathsave.roll', label: 'Death Save', kind: 'deathsave' })
  if (actor.concentration) {
    actions.push({ id: 'concentration.end', label: 'End Concentration', kind: 'endconcentration' })
  }
  // M-buff: a flagged condition (pushed by a self-buff cast) carries its own
  // removeActionId; surface an 'endeffect' action for it while it's active.
  for (const c of actor.conditions ?? []) {
    if (c.removeActionId) {
      actions.push({ id: c.removeActionId, label: `End ${c.label}`, kind: 'endeffect' })
    }
  }
  return actions
}

/* ------------------------------------------------------------------------- */
/* SheetViewModel assembly                                                    */
/* ------------------------------------------------------------------------- */

function listItem(def, actionId, toggleActionId) {
  const item = { id: def.id, label: def.label }
  if (def.sub) item.sub = def.sub
  if (def.img) item.img = def.img
  if (def.resourceId) item.resourceId = def.resourceId
  if (def.detail) item.detail = def.detail
  const tags = [...(def.tags ?? [])]
  if (def.equip?.equipped) tags.push('equipped')
  if (tags.length > 0) item.tags = tags
  if (actionId) item.actionId = actionId
  if (toggleActionId) item.toggleActionId = toggleActionId
  return item
}

function buildSheet(actor) {
  const s = actor.staticSections
  const acBonus = s.inventory.reduce(
    (sum, it) => sum + (it.equip?.equipped ? it.equip.acBonus : 0),
    0,
  )
  const headline = [{ id: 'ac', label: 'AC', value: actor.baseAc + acBonus + (actor.acBuff ?? 0) }, ...actor.headline]

  const sections = [
    {
      kind: 'stats',
      id: 'abilities',
      label: 'Abilities',
      stats: s.abilities.map((a) => ({ ...a, actionId: `ability.${a.id}.check` })),
    },
  ]
  if (s.saves) {
    sections.push({
      kind: 'stats',
      id: 'saves',
      label: 'Saving Throws',
      stats: s.saves.map((a) => ({ ...a, id: `save-${a.id}`, actionId: `ability.${a.id}.save` })),
    })
  }
  if (s.skills) {
    sections.push({
      kind: 'stats',
      id: 'skills',
      label: 'Skills',
      stats: s.skills.map((a) => ({ ...a, actionId: `skill.${a.id}` })),
    })
  }
  sections.push({
    kind: 'tracks',
    id: 'hp',
    label: 'Hit Points',
    resourceIds: actor.resources.filter((x) => x.group === 'hp').map((x) => x.id),
  })
  const slots = actor.resources.filter((x) => x.group === 'slots')
  if (slots.length > 0) {
    sections.push({ kind: 'tracks', id: 'slots', label: 'Spell Slots', resourceIds: slots.map((x) => x.id) })
  }
  sections.push(
    {
      kind: 'tracks',
      id: 'hitdice',
      label: 'Hit Dice',
      resourceIds: actor.resources.filter((x) => x.group === 'hitdice').map((x) => x.id),
    },
    {
      kind: 'tracks',
      id: 'deathsaves',
      label: 'Death Saves',
      resourceIds: actor.resources.filter((x) => x.group === 'deathsaves').map((x) => x.id),
    },
    {
      kind: 'tracks',
      id: 'currency',
      label: 'Currency',
      resourceIds: actor.resources.filter((x) => x.group === 'currency').map((x) => x.id),
    },
    {
      kind: 'list',
      id: 'inventory',
      label: 'Inventory',
      items: s.inventory.map((it) =>
        listItem(
          it,
          it.attackMod !== undefined ? `item.${it.id}.attack` : undefined,
          it.equip ? `item.${it.id}.equip` : undefined,
        ),
      ),
    },
  )
  if (s.spells) {
    // Per-level sections with headers, mirroring adapter-dnd5e (2026-07-18).
    const byLevel = new Map()
    for (const sp of s.spells) {
      const lvl = sp.level ?? 0
      if (!byLevel.has(lvl)) byLevel.set(lvl, [])
      byLevel.get(lvl).push(sp)
    }
    const ord = (n) => (n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`)
    for (const lvl of [...byLevel.keys()].sort((a, b) => a - b)) {
      const group = byLevel.get(lvl)
      const label = lvl === 0 ? 'Cantrips' : `${ord(lvl)} Level`
      sections.push({
        kind: 'list',
        id: `spells.l${lvl}`,
        label,
        header: { id: `spells.l${lvl}.header`, label, sub: `${group.length} ${group.length === 1 ? 'spell' : 'spells'}` },
        items: group.map((sp) => listItem(sp, `spell.${sp.id}.cast`, undefined)),
      })
    }
  }
  sections.push({
    kind: 'list',
    id: 'features',
    label: 'Features',
    items: s.features.map((f) => listItem(f, f.use ? `feature.${f.id}.use` : undefined, undefined)),
  })

  return {
    actorId: actor.id,
    systemId: actor.systemId,
    name: actor.name,
    img: actor.img,
    headline,
    sections,
    resources: actor.resources.map((x) => ({ ...x })),
    actions: buildActions(actor),
    conditions: (actor.conditions ?? []).map((c) => ({ ...c })),
    concentration: actor.concentration ? { label: actor.concentration.label } : null,
    // Library collections, mirroring adapter-dnd5e (the real gateway serves
    // these; without them no "Add …" button ever renders in the mock).
    library: [
      { id: 'spells', label: 'Learn spell' },
      { id: 'feats', label: 'Add feat' },
      { id: 'gear', label: 'Add item' },
    ],
  }
}

/* ------------------------------------------------------------------------- */
/* SSE fan-out                                                                */
/* ------------------------------------------------------------------------- */

/** actorId -> Set<ServerResponse> */
const subscribers = new Map()

function broadcast(actorId) {
  const subs = subscribers.get(actorId)
  if (!subs || subs.size === 0) return
  const payload = `event: sheet\ndata: ${JSON.stringify(buildSheet(actors.get(actorId)))}\n\n`
  for (const res of subs) res.write(payload)
}

// Random HP drift every ~20s to demo live updates.
setInterval(() => {
  const ids = [...actors.keys()]
  const actor = actors.get(ids[Math.floor(Math.random() * ids.length)])
  const hp = actor.resources.find((x) => x.id === 'hp')
  if (!hp) return
  const delta = Math.random() < 0.5 ? -(1 + Math.floor(Math.random() * 5)) : 1 + Math.floor(Math.random() * 4)
  hp.value = clamp(hp.value + delta, hp.min, hp.max)
  console.log(`[mock] drift: ${actor.name} HP ${delta > 0 ? '+' : ''}${delta} -> ${hp.value}`)
  broadcast(actor.id)
}, 20_000)

function clamp(v, min, max) {
  if (min !== undefined) v = Math.max(min, v)
  if (max !== undefined) v = Math.min(max, v)
  return v
}

/* ------------------------------------------------------------------------- */
/* HTTP plumbing                                                              */
/* ------------------------------------------------------------------------- */

function sendJson(res, status, body) {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
  })
  res.end(data)
}

function sendError(res, status, code, message) {
  sendJson(res, status, { error: { code, message } })
}

function authed(req, url) {
  const header = req.headers.authorization || ''
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  return bearer === TOKEN || url.searchParams.get('token') === TOKEN
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 64 * 1024) reject(new Error('body too large'))
    })
    req.on('end', () => resolve(raw))
    req.on('error', reject)
  })
}

function handleIntent(actor, intent, res) {
  if (typeof intent !== 'object' || intent === null) {
    return sendError(res, 422, 'INVALID_INTENT', 'body must be a ResourceIntent object')
  }
  const { kind, resourceId } = intent
  if (kind !== 'set' && kind !== 'delta') {
    return sendError(res, 422, 'INVALID_INTENT', `unknown intent kind: ${String(kind)}`)
  }
  const descriptor = actor.resources.find((x) => x.id === resourceId)
  if (!descriptor || !descriptor.writable) {
    return sendError(res, 403, 'FORBIDDEN_RESOURCE', `resource not writable: ${String(resourceId)}`)
  }
  const raw = kind === 'set' ? intent.value : intent.amount
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return sendError(res, 422, 'INVALID_INTENT', 'value/amount must be a finite number')
  }
  if (intent.expected !== undefined) {
    if (typeof intent.expected !== 'number' || !Number.isFinite(intent.expected)) {
      return sendError(res, 422, 'INVALID_INTENT', 'expected must be a finite number')
    }
    if (intent.expected !== descriptor.value) {
      return sendJson(res, 409, {
        error: { code: 'CONFLICT', message: 'value changed since last read' },
        sheet: buildSheet(actor),
      })
    }
  }
  const target = kind === 'set' ? raw : descriptor.value + raw
  descriptor.value = clamp(target, descriptor.min, descriptor.max)
  sendJson(res, 200, { sheet: buildSheet(actor) })
  broadcast(actor.id)
}

/* ---- POST /api/actors/:id/actions (M6) ----------------------------------- */

const ROLL_TOTALS = [8, 15, 20]
let rollCursor = 0

function mockRoll(mode, mod) {
  const total = ROLL_TOTALS[rollCursor++ % ROLL_TOTALS.length]
  const die = mode === 'advantage' ? '2d20kh' : mode === 'disadvantage' ? '2d20kl' : '1d20'
  return {
    formula: `${die} + ${mod}`,
    total,
    isCritical: total === 20,
    isFumble: false,
  }
}

const ACTION_KINDS = ['check', 'save', 'attack', 'damage', 'cast', 'use', 'equip', 'rest', 'deathsave', 'endconcentration', 'endeffect']

/** Long rest fully recovers; short rest clears death saves (mock behavior). */
function applyRest(actor, actionId) {
  const restore = (id) => {
    const res = actor.resources.find((x) => x.id === id)
    if (res && res.max !== undefined) res.value = res.max
  }
  const zero = (id) => {
    const res = actor.resources.find((x) => x.id === id)
    if (res) res.value = 0
  }
  zero('deathsaves.success')
  zero('deathsaves.failure')
  if (actionId === 'rest.long') {
    for (const res of actor.resources) {
      if ((res.group === 'hp' && res.id === 'hp') || res.group === 'slots' || res.group === 'hitdice') {
        restore(res.id)
      }
    }
    zero('hp.temp')
  }
}

function handleAction(actor, intent, res) {
  if (typeof intent !== 'object' || intent === null) {
    return sendError(res, 422, 'INVALID_INTENT', 'body must be an ActionIntent object')
  }
  const { kind, actionId } = intent
  if (!ACTION_KINDS.includes(kind)) {
    return sendError(res, 422, 'INVALID_INTENT', `unknown action kind: ${String(kind)}`)
  }
  const action = buildActions(actor).find((a) => a.id === actionId)
  if (!action || action.kind !== kind) {
    return sendError(res, 403, 'FORBIDDEN_RESOURCE', `no such action: ${String(actionId)}`)
  }

  let result = null

  if (kind === 'check' || kind === 'save') {
    const { mode } = intent
    if (mode !== undefined && mode !== 'advantage' && mode !== 'disadvantage') {
      return sendError(res, 422, 'INVALID_INTENT', 'mode must be advantage or disadvantage')
    }
    result = mockRoll(mode, 5)
  } else if (kind === 'attack') {
    const itemId = actionId.split('.')[1]
    const it = actor.staticSections.inventory.find((x) => x.id === itemId)
    result = mockRoll(undefined, it?.attackMod ?? 5)
  } else if (kind === 'damage') {
    // Mirrors the real gateway: optional boolean `critical` doubles the dice,
    // optional integer `slotLevel` (>=1) scales dice count for upcast damage.
    if (intent.critical !== undefined && typeof intent.critical !== 'boolean') {
      return sendError(res, 422, 'INVALID_INTENT', 'critical must be a boolean')
    }
    if (intent.slotLevel !== undefined && (!Number.isInteger(intent.slotLevel) || intent.slotLevel < 1)) {
      return sendError(res, 422, 'INVALID_INTENT', 'slotLevel must be a positive integer')
    }
    const crit = intent.critical === true
    const dice = 1 + Math.max(0, (intent.slotLevel ?? 1) - 1)
    const shown = crit ? dice * 2 : dice
    result = { formula: `${shown}d8 + 3`, total: 4 * shown + 3, isCritical: false, isFumble: false }
  } else if (kind === 'cast') {
    if (action.slotLevels !== undefined) {
      // Mirrors the real adapter: a missing slotLevel defaults to the spell's
      // base level; it must still resolve to a payable slot, else 422.
      const lvl = intent.slotLevel ?? action.level
      if (typeof lvl !== 'number' || !action.slotLevels.includes(lvl)) {
        return sendError(res, 422, 'INVALID_INTENT', `illegal slotLevel: ${String(intent.slotLevel)}`)
      }
      const slot = actor.resources.find((x) => x.id === `slots.${lvl}`)
      slot.value = clamp(slot.value - 1, slot.min, slot.max)
    }
    // SHOULD-FIX 5: no slotLevels descriptor (cantrip/free-use/pact) means
    // any slotLevel is ignored, mirroring the real adapter (dnd5e/src/index.ts
    // buildAction 'cast': "Without a list ... any slotLevel is ignored").
    result = mockRoll(undefined, 7)
    // M-buff: a self-buff spell (internal `buff` marker) pushes a flagged,
    // removable condition and bumps the mock AC modifier. Dedupe re-casts.
    const spellId = actionId.split('.')[1]
    const spell = actor.staticSections.spells?.find((sp) => sp.id === spellId)
    if (spell?.buff) {
      const condId = `ae-${spellId.slice(2)}`
      const alreadyActive = (actor.conditions ?? []).some((c) => c.id === condId)
      if (!alreadyActive) {
        actor.conditions = [
          ...(actor.conditions ?? []),
          { id: condId, label: spell.buff.name, removeActionId: `effect.${condId}.remove` },
        ]
        actor.acBuff = (actor.acBuff ?? 0) + (spell.buff.ac ?? 0)
      }
    }
  } else if (kind === 'use') {
    result = mockRoll(undefined, 3)
  } else if (kind === 'equip') {
    if (typeof intent.equipped !== 'boolean') {
      return sendError(res, 422, 'INVALID_INTENT', 'equipped must be a boolean')
    }
    const itemId = actionId.split('.')[1]
    const it = actor.staticSections.inventory.find((x) => x.id === itemId)
    it.equip.equipped = intent.equipped
  } else if (kind === 'rest') {
    applyRest(actor, actionId)
    // result stays null — the real command posts its own chat card.
  } else if (kind === 'deathsave') {
    // Foundry rolls and updates the trackers; the mock bumps a success so the
    // panel visibly reacts. result stays null (no roll pill for this command).
    const success = actor.resources.find((x) => x.id === 'deathsaves.success')
    if (success) success.value = clamp(success.value + 1, success.min, success.max)
  } else if (kind === 'endconcentration') {
    actor.concentration = null
  } else if (kind === 'endeffect') {
    // Reverse of the cast-time push above: find the condition this action
    // removes, revert whatever AC bump its source buff spell applied, drop it.
    const cond = (actor.conditions ?? []).find((c) => c.removeActionId === actionId)
    if (cond) {
      const spellId = `s-${cond.id.slice(3)}`
      const spell = actor.staticSections.spells?.find((sp) => sp.id === spellId)
      if (spell?.buff?.ac) actor.acBuff = (actor.acBuff ?? 0) - spell.buff.ac
      actor.conditions = actor.conditions.filter((c) => c.id !== cond.id)
    }
  }

  sendJson(res, 200, { result, sheet: buildSheet(actor) })
  broadcast(actor.id)
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
  const path = url.pathname

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
    })
    return res.end()
  }

  if (path === '/healthz') {
    return sendJson(res, 200, { ok: true, relay: 'connected' })
  }

  if (!path.startsWith('/api/')) {
    return sendError(res, 404, 'NOT_FOUND', 'no such route')
  }

  if (!authed(req, url)) {
    return sendError(res, 401, 'UNAUTHORIZED', 'missing or unknown token')
  }

  if (req.method === 'GET' && path === '/api/me') {
    return sendJson(res, 200, { player: { name: PLAYER.name, actorIds: PLAYER.actorIds } })
  }

  if (req.method === 'GET' && path === '/api/actors') {
    return sendJson(res, 200, {
      actors: PLAYER.actorIds
        .map((id) => actors.get(id))
        .filter(Boolean)
        .map((a) => ({ id: a.id, name: a.name, img: a.img, systemId: a.systemId })),
    })
  }

  const match = path.match(/^\/api\/actors\/([^/]+)\/(sheet|intents|actions|events)$/)
  if (match) {
    const [, actorId, tail] = match
    const actor = PLAYER.actorIds.includes(actorId) ? actors.get(actorId) : undefined
    if (!actor) return sendError(res, 404, 'NOT_FOUND', 'no such actor')

    if (tail === 'sheet' && req.method === 'GET') {
      return sendJson(res, 200, { sheet: buildSheet(actor) })
    }

    if ((tail === 'intents' || tail === 'actions') && req.method === 'POST') {
      let body
      try {
        body = JSON.parse((await readBody(req)) || 'null')
      } catch {
        return sendError(res, 422, 'INVALID_INTENT', 'body is not valid JSON')
      }
      return tail === 'intents' ? handleIntent(actor, body, res) : handleAction(actor, body, res)
    }

    if (tail === 'events' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'access-control-allow-origin': '*',
      })
      res.write(`event: sheet\ndata: ${JSON.stringify(buildSheet(actor))}\n\n`)
      const ping = setInterval(() => res.write('event: ping\ndata: {}\n\n'), 25_000)
      let subs = subscribers.get(actor.id)
      if (!subs) subscribers.set(actor.id, (subs = new Set()))
      subs.add(res)
      req.on('close', () => {
        clearInterval(ping)
        subs.delete(res)
      })
      return
    }
  }

  return sendError(res, 404, 'NOT_FOUND', 'no such route')
})

server.listen(PORT, () => {
  console.log(`[mock] gateway mock on http://localhost:${PORT}`)
  console.log(`[mock] invite token: ${TOKEN}  ->  http://localhost:3000/join#${TOKEN}`)
})
