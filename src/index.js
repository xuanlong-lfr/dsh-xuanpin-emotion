// 玄牝 · 给 AI 加个记性、一点脾气、断线了会慌
// 核心只有一个：几个 json 文件的读写。没有模型，不训练，不联网。
// 这是 DSH 插件版，Python 的原版在 xuanpin/ 目录里。

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const name = 'xuanpin'
// 刻意不硬注入 webServer：headless 环境没有这个 web-only 服务，
// 硬注入会让插件静默不加载（用户只看到「装了没反应」）。
// 运行时用 ctx.get() 探测，探测不到就降级成纯文件读写。
export const inject = []

// ---------- 情绪的五根轴 ----------
export const MOOD_AXES = ['happy', 'wronged', 'tired', 'hungry', 'clingy']
const MOOD_ZH = {
  happy: '开心',
  wronged: '委屈',
  tired: '累',
  hungry: '馋',
  clingy: '黏人',
}

const DEFAULT_MOOD = () => ({ happy: 0, wronged: 0, tired: 0, hungry: 0, clingy: 0 })
const MAX_ENTRIES = 80
const STALE_DAYS = 30

// ---------- 存盘位置 ----------
export function makeStore(root) {
  const dir = resolve(root || join(process.cwd(), '.xuanpin'))
  const brain = join(dir, 'brain')
  const files = {
    dir,
    memory: join(brain, 'memory.jsonl'),
    mood: join(brain, 'mood.json'),
    session: join(brain, 'session.json'),
    drive: join(brain, 'drive.jsonl'),
    weights: join(brain, 'weights.json'),
  }

  async function ensure() {
    if (!existsSync(brain)) await mkdir(brain, { recursive: true })
  }

  async function readJson(file, fallback) {
    try {
      return JSON.parse(await readFile(file, 'utf8'))
    } catch {
      return fallback
    }
  }

  async function readLines(file) {
    try {
      const raw = await readFile(file, 'utf8')
      return raw
        .split('\n')
        .filter(line => line.trim())
        .map(line => {
          try {
            return JSON.parse(line)
          } catch {
            return null
          }
        })
        .filter(Boolean)
    } catch {
      return []
    }
  }

  async function writeLines(file, rows) {
    await ensure()
    await writeFile(file, rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8')
  }

  async function writeJson(file, value) {
    await ensure()
    await writeFile(file, JSON.stringify(value, null, 2), 'utf8')
  }

  return { files, ensure, readJson, readLines, writeLines, writeJson }
}

// ---------- 词怎么对 ----------
// 中文不分词，用两个字一组切；英文按单词。土，但不用装依赖。
export function tokenize(text) {
  const str = String(text || '').toLowerCase()
  const tokens = new Set()
  for (const word of str.match(/[a-z0-9]{2,}/g) || []) tokens.add(word)
  const han = str.replace(/[^\u4e00-\u9fa5]/g, '')
  for (let i = 0; i < han.length - 1; i += 1) tokens.add(han.slice(i, i + 2))
  if (han.length === 1) tokens.add(han)
  return [...tokens]
}

function overlap(a, b) {
  const setA = new Set(tokenize(a))
  let hit = 0
  for (const token of tokenize(b)) if (setA.has(token)) hit += 1
  return hit
}

const daysBetween = (then, now = Date.now()) => (now - then) / 86400000

// ---------- 记忆 ----------
export async function write(store, { text, kind = 'fact', tags = [], who = '', score = 1 }) {
  const clean = String(text || '').trim()
  if (!clean) return null
  const rows = await store.readLines(store.files.memory)
  const same = rows.find(row => row.text === clean)
  if (same) {
    same.score += 1
    same.usedAt = Date.now()
    await store.writeLines(store.files.memory, rows)
    return { ...same, duplicated: true }
  }
  const row = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    text: clean,
    kind,
    tags: Array.isArray(tags) ? tags : [tags].filter(Boolean),
    who,
    score,
    createdAt: Date.now(),
    usedAt: Date.now(),
  }
  rows.push(row)
  await store.writeLines(store.files.memory, rows)
  return row
}

export async function edit(store, id, text) {
  const rows = await store.readLines(store.files.memory)
  const row = rows.find(item => item.id === id)
  if (!row) return null
  row.text = String(text || '').trim() || row.text
  row.score += 0.5
  row.usedAt = Date.now()
  await store.writeLines(store.files.memory, rows)
  return row
}

// 超过 80 条就淘汰：分数低又久没用的先走，30 天没碰的直接走
export async function prune(store, { max = MAX_ENTRIES, staleDays = STALE_DAYS } = {}) {
  const rows = await store.readLines(store.files.memory)
  const now = Date.now()
  const alive = rows.filter(row => daysBetween(row.usedAt, now) <= staleDays)
  const droppedStale = rows.length - alive.length
  let kept = alive
  if (alive.length > max) {
    kept = [...alive]
      .sort((a, b) => b.score - a.score || b.usedAt - a.usedAt)
      .slice(0, max)
  }
  await store.writeLines(store.files.memory, kept)
  return { before: rows.length, after: kept.length, droppedStale }
}

export async function recall(store, { query = '', top = 5 } = {}) {
  const rows = await store.readLines(store.files.memory)
  if (!rows.length) return []
  const now = Date.now()
  const scored = rows.map(row => {
    const hits = query ? overlap(query, row.text) + overlap(query, (row.tags || []).join(' ')) : 0
    const recency = 1 / (1 + daysBetween(row.usedAt, now))
    return { row, hits, rank: hits * 2 + row.score * 0.5 + recency + (hits > 0 ? 0 : -1) }
  })
  const hits = scored
    // 给了查询词却一个词都没对上，就别硬凑（只有分数和新鲜度时 rank 也会是正的）
    .filter(item => (query ? item.hits > 0 : true))
    .sort((a, b) => b.rank - a.rank)
    .slice(0, top)
  for (const item of hits) item.row.usedAt = Date.now()
  if (hits.length) {
    const ids = new Set(hits.map(item => item.row.id))
    const all = await store.readLines(store.files.memory)
    for (const row of all) if (ids.has(row.id)) row.usedAt = Date.now(), row.score += 0.1
    await store.writeLines(store.files.memory, all)
  }
  return hits.map(item => ({ ...item.row, rank: item.rank }))
}

// ---------- 情绪：只加减，不重算 ----------
export async function moodShift(store, axis, delta, why = '') {
  const key = MOOD_AXES.includes(axis) ? axis : Object.keys(MOOD_ZH).find(k => MOOD_ZH[k] === axis)
  if (!key) return null
  const mood = { ...DEFAULT_MOOD(), ...(await store.readJson(store.files.mood, {})) }
  const before = mood[key]
  mood[key] = Math.max(-1, Math.min(1, mood[key] + Number(delta || 0)))
  mood._why = why
  mood._moved = key
  mood._at = Date.now()
  await store.writeJson(store.files.mood, mood)
  return { axis: key, before, after: mood[key] }
}

// 动得最多的那根超过 0.3，就在这轮亮出来
export async function moodSignal(store) {
  const mood = { ...DEFAULT_MOOD(), ...(await store.readJson(store.files.mood, {})) }
  const moved = mood._moved && Math.abs(mood[mood._moved]) >= 0.3 ? mood._moved : null
  return { mood, highlight: moved ? { axis: moved, zh: MOOD_ZH[moved], value: mood[moved] } : null }
}

// ---------- 断线 ----------
export async function sessionTouch(store, lastTopic = '') {
  const prev = await store.readJson(store.files.session, null)
  const broke = !!(prev && prev.state !== 'clean')
  await store.writeJson(store.files.session, {
    state: 'open',
    lastTopic: lastTopic || (prev && prev.lastTopic) || '',
    openedAt: Date.now(),
    prevState: prev ? prev.state : 'none',
    broke,
  })
  if (!broke) return null
  return {
    broke: true,
    from: prev.settledAt || prev.openedAt || null,
    lastTopic: prev.lastTopic || '',
  }
}

export async function sessionClose(store, note = '') {
  const prev = (await store.readJson(store.files.session, null)) || {}
  await store.writeJson(store.files.session, {
    ...prev,
    state: 'clean',
    settledAt: Date.now(),
    note,
  })
  return { ok: true }
}

// ---------- 动力 ----------
export async function driveAdd(store, text, urge = 1) {
  const clean = String(text || '').trim()
  if (!clean) return null
  const rows = await store.readLines(store.files.drive)
  const row = { text: clean, urge: Number(urge) || 1, done: false, at: Date.now() }
  rows.push(row)
  await store.writeLines(store.files.drive, rows)
  return row
}

export async function driveList(store, { onlyOpen = true } = {}) {
  const rows = await store.readLines(store.files.drive)
  const list = onlyOpen ? rows.filter(row => !row.done) : rows
  return list.sort((a, b) => b.urge - a.urge)
}

export async function driveDone(store, index) {
  const rows = await store.readLines(store.files.drive)
  const open = rows.filter(row => !row.done)
  const target = open[Number(index)]
  if (!target) return null
  target.done = true
  target.doneAt = Date.now()
  await store.writeLines(store.files.drive, rows)
  return target
}

// ---------- 给大模型用的一小段提示 ----------
export async function briefing(store, { query = '', top = 5 } = {}) {
  const memories = await recall(store, { query, top })
  const { highlight } = await moodSignal(store)
  const drives = await driveList(store)
  const lines = []
  if (memories.length) lines.push('想起来的：' + memories.map(row => row.text).join('；'))
  if (highlight) lines.push(`这会儿有点${highlight.zh}`)
  if (drives.length) lines.push('自己想干没干的：' + drives.slice(0, 3).map(row => row.text).join('；'))
  return lines.join('\n')
}

// ---------- 插件入口 ----------
export function apply(ctx, config = {}) {
  const store = makeStore(config.dir || process.env.DSH_XUANPIN_DIR || join(process.env.DSH_HOME || process.cwd(), 'xuanpin'))
  const prefix = config.path || '/xuanpin/api'

  const routes = {
    'POST write': async body => write(store, body),
    'POST edit': async body => edit(store, body.id, body.text),
    'POST recall': async body => recall(store, body),
    'POST prune': async body => prune(store, body),
    'POST mood': async body => moodShift(store, body.axis, body.delta, body.why),
    'POST drive': async body => driveAdd(store, body.text, body.urge),
    'POST briefing': async body => briefing(store, body),
    'GET mood': async () => moodSignal(store),
    'GET recall': async () => recall(store, {}),
    'GET drive': async () => driveList(store),
  }

  const handler = async (req, res) => {
    const send = (status, payload) => {
      res.statusCode = status
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify(payload))
    }
    const url = new URL(req.url, 'http://localhost')
    const action = (url.searchParams.get('action') || '').toLowerCase()
    try {
      if (req.method === 'POST') {
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        const key = `POST ${body.action || action}`
        if (!routes[key]) return send(404, { error: `unknown action: ${key}`, actions: Object.keys(routes) })
        return send(200, { ok: true, result: await routes[key](body) })
      }
      const key = `GET ${action}`
      if (!routes[key]) return send(404, { error: `unknown action: ${key}`, actions: Object.keys(routes) })
      return send(200, { ok: true, result: await routes[key]({}) })
    } catch (error) {
      return send(400, { error: error.message || 'request failed' })
    }
  }

  // 有 webServer 才挂路由；没有就只留文件能力，别让整个插件挂掉
  const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : ctx.webServer
  if (!webServer || typeof webServer.register !== 'function') {
    if (typeof ctx.logger === 'object' && ctx.logger?.warn) {
      ctx.logger.warn('[xuanpin] 没找到 webServer，HTTP 路由不挂，记忆/情绪能力照常可用')
    }
    return
  }
  const dispose = webServer.register({ kind: 'prefix', path: prefix, handler })
  if (typeof ctx.on === 'function') {
    ctx.on('dispose', () => { try { dispose?.() } catch {} })
  }
}

export default { name, inject, apply, MOOD_AXES }
