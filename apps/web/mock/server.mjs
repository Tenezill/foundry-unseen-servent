/**
 * Zero-dependency mock of the gateway API (docs/API.md) for standalone PWA dev.
 *
 *   node mock/server.mjs      # listens on :8090 (nuxt dev proxies /api here)
 *
 * - Accepts the invite token "demo" (Bearer header or ?token=).
 * - Serves a mutable in-memory dnd5e-ish view model, STRICTLY in the
 *   SheetViewModel shape from @companion/adapter-sdk.
 * - SSE per actor: current sheet on connect, ping every 25s, and a random
 *   HP drift every ~20s so live updates are visible without a GM.
 */
import { createServer } from 'node:http'

const PORT = Number(process.env.PORT || 8090)
const TOKEN = 'demo'
const PLAYER = { name: 'Demo Player', actorIds: ['a-sariel', 'a-brakk'] }

/* ------------------------------------------------------------------------- */
/* Mutable resource state. Descriptors match adapter-sdk ResourceDescriptor.  */
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
  resources: [
    r('hp', 'Hit Points', 24, { max: 31, group: 'hp' }),
    r('hp.temp', 'Temp HP', 0, { group: 'hp' }),
    r('slots.1', '1st Level', 3, { max: 4, group: 'slots' }),
    r('slots.2', '2nd Level', 2, { max: 3, group: 'slots' }),
    r('slots.3', '3rd Level', 1, { max: 2, group: 'slots' }),
    r('hitdice.d6', 'Hit Dice (d6)', 4, { max: 5, group: 'hitdice' }),
    r('deathsaves.success', 'Successes', 0, { max: 3, group: 'deathsaves' }),
    r('deathsaves.failure', 'Failures', 0, { max: 3, group: 'deathsaves' }),
    r('currency.gp', 'Gold', 62, { group: 'currency' }),
    r('currency.sp', 'Silver', 30, { group: 'currency' }),
    r('item.i-potion.qty', 'Potion of Healing', 2, { max: 99, group: 'items' }),
    r('item.i-wand.uses', 'Wand of Magic Missiles', 5, { max: 7, group: 'items' }),
  ],
  headline: [
    { id: 'ac', label: 'AC', value: 12 },
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
    inventory: [
      { id: 'i-staff', label: 'Quarterstaff', sub: '1d6 bludgeoning' },
      { id: 'i-potion', label: 'Potion of Healing', sub: 'consumable', resourceId: 'item.i-potion.qty' },
      { id: 'i-wand', label: 'Wand of Magic Missiles', sub: 'charges', resourceId: 'item.i-wand.uses', tags: ['attuned'] },
      { id: 'i-book', label: 'Spellbook' },
      { id: 'i-pouch', label: 'Component Pouch' },
    ],
    spells: [
      { id: 's-firebolt', label: 'Fire Bolt', sub: 'Cantrip · V,S' },
      { id: 's-magearmor', label: 'Mage Armor', sub: '1st · V,S,M', tags: ['prepared'] },
      { id: 's-mistystep', label: 'Misty Step', sub: '2nd · V' },
      { id: 's-fireball', label: 'Fireball', sub: '3rd · V,S,M', tags: ['prepared'] },
    ],
    features: [
      { id: 'f-recovery', label: 'Arcane Recovery', sub: 'Wizard 1' },
      { id: 'f-sculpt', label: 'Sculpt Spells', sub: 'Evocation 2' },
    ],
  },
})

actors.set('a-brakk', {
  id: 'a-brakk',
  name: 'Brakk Ironhide',
  img: '/icons/portrait-martial.svg',
  systemId: 'dnd5e',
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
    { id: 'ac', label: 'AC', value: 18 },
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
    inventory: [
      { id: 'i-sword', label: 'Longsword', sub: '1d8 slashing', tags: ['equipped'] },
      { id: 'i-bow', label: 'Longbow', sub: '1d8 piercing' },
      { id: 'i-arrows', label: 'Arrows', sub: 'ammunition', resourceId: 'item.i-arrows.qty' },
      { id: 'i-javelin', label: 'Javelins', sub: '1d6 piercing', resourceId: 'item.i-javelin.qty' },
      { id: 'i-shield', label: 'Shield', sub: '+2 AC', tags: ['equipped'] },
    ],
    spells: null,
    features: [
      { id: 'f-secondwind', label: 'Second Wind', sub: 'Fighter 1' },
      { id: 'f-surge', label: 'Action Surge', sub: 'Fighter 2' },
    ],
  },
})

/* ------------------------------------------------------------------------- */
/* SheetViewModel assembly                                                    */
/* ------------------------------------------------------------------------- */

function buildSheet(actor) {
  const s = actor.staticSections
  const sections = [
    { kind: 'stats', id: 'abilities', label: 'Abilities', stats: s.abilities },
    {
      kind: 'tracks',
      id: 'hp',
      label: 'Hit Points',
      resourceIds: actor.resources.filter((x) => x.group === 'hp').map((x) => x.id),
    },
  ]
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
    { kind: 'list', id: 'inventory', label: 'Inventory', items: s.inventory },
  )
  if (s.spells) {
    sections.push({ kind: 'list', id: 'spells', label: 'Spells', items: s.spells })
  }
  sections.push({ kind: 'list', id: 'features', label: 'Features', items: s.features })

  return {
    actorId: actor.id,
    systemId: actor.systemId,
    name: actor.name,
    img: actor.img,
    headline: actor.headline,
    sections,
    resources: actor.resources.map((x) => ({ ...x })),
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

  const match = path.match(/^\/api\/actors\/([^/]+)\/(sheet|intents|events)$/)
  if (match) {
    const [, actorId, tail] = match
    const actor = PLAYER.actorIds.includes(actorId) ? actors.get(actorId) : undefined
    if (!actor) return sendError(res, 404, 'NOT_FOUND', 'no such actor')

    if (tail === 'sheet' && req.method === 'GET') {
      return sendJson(res, 200, { sheet: buildSheet(actor) })
    }

    if (tail === 'intents' && req.method === 'POST') {
      let intent
      try {
        intent = JSON.parse((await readBody(req)) || 'null')
      } catch {
        return sendError(res, 422, 'INVALID_INTENT', 'body is not valid JSON')
      }
      return handleIntent(actor, intent, res)
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
