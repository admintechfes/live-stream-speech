'use strict'

require('dotenv').config()

const fs = require('fs')
const path = require('path')
const http = require('http')
const express = require('express')
const { WebSocketServer } = require('ws')
const {
  azureLocalesToSonioxHints,
  phraseListToContext,
  resolveProvider,
  validateProviderConfig,
  issueAzureToken,
  mintSonioxKey,
} = require('./lib/providers')

const PORT = Number(process.env.PORT || 8080)
const HALLS = String(process.env.HALLS || 'hall-1')
  .split(',')
  .map((h) => h.trim())
  .filter(Boolean)
const REPLAY_LINES = Number(process.env.REPLAY_LINES || 6)
const CAPTION_DELAY_MS = Number(process.env.CAPTION_DELAY_MS || 0)
const CONTROL_KEY = process.env.CONTROL_KEY || '' // guards capture + operator roles
const SPEECH_PROVIDER = (process.env.SPEECH_PROVIDER || 'azure').trim().toLowerCase()
const SPEECH_KEY = process.env.AZURE_SPEECH_KEY || ''
const SPEECH_REGION = process.env.AZURE_SPEECH_REGION || ''
const SONIOX_KEY = process.env.SONIOX_API_KEY || ''
const SONIOX_MODEL = process.env.SONIOX_MODEL || 'stt-rt-v5'
const SOURCE_LANGS = process.env.SOURCE_LANGS || 'ta-IN,hi-IN,en-IN'
const TARGET_LANG = process.env.TARGET_LANG || 'en'
const PHRASE_LIST = (process.env.PHRASE_LIST || '')
  .split(',')
  .map((p) => p.trim())
  .filter(Boolean)

if (!HALLS.length) {
  console.error('HALLS is empty — refusing to start. Set HALLS=hall-1,hall-2,... in .env')
  process.exit(1)
}

// Credentials are checked at boot, not at first Start. A hall minder pressing
// Start at 9am is the wrong moment to find out the key is missing.
const configProblems = validateProviderConfig(SPEECH_PROVIDER, process.env)
if (configProblems.length) {
  console.error(`SPEECH_PROVIDER=${SPEECH_PROVIDER} — refusing to start:`)
  for (const p of configProblems) console.error(`  - ${p}`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Per-hall state. Halls are declared in config, never created by whoever
// connects first — a typo'd URL must fail loudly rather than open a ghost hall.
// ---------------------------------------------------------------------------

/** @type {Map<string, {screens:Set, operators:Set, publisher:any, finals:string[], partial:string, blanked:boolean, frozen:boolean, lastCaptionTs:number, lastPublisherTs:number, pending:Set}>} */
const halls = new Map()
for (const id of HALLS) {
  halls.set(id, {
    screens: new Set(),
    operators: new Set(),
    publisher: null,
    finals: [],
    partial: '',
    blanked: false,
    frozen: false,
    lastCaptionTs: 0,
    lastPublisherTs: 0,
    provider: null, // engine the live capture page reported, for the operator badge
    pending: new Set(), // in-flight delayed finals (timeout handles)
  })
}

const app = express()
app.disable('x-powered-by')
app.use(express.json())

// ---------------------------------------------------------------------------
// Short-lived credentials. Neither provider's real key ever reaches a browser.
// One endpoint, two payload shapes — capture.html makes the same single call
// either way and hands the result to whichever driver `provider` names.
// ---------------------------------------------------------------------------

const SOURCE_LANG_LIST = SOURCE_LANGS.split(',').map((s) => s.trim()).filter(Boolean)

app.get('/api/token', requireControlKey, async (req, res) => {
  let provider
  try {
    provider = resolveProvider(req.query.provider, SPEECH_PROVIDER)
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message })
  }

  const problems = validateProviderConfig(provider, process.env)
  if (problems.length) {
    // Reachable only via ?provider= naming the engine this server was not
    // configured for — the default provider is validated at boot.
    return res.status(503).json({ error: `${provider} is not configured: ${problems.join('; ')}` })
  }

  try {
    if (provider === 'soniox') {
      const { apiKey, expiresAt } = await mintSonioxKey({
        key: SONIOX_KEY,
        clientReferenceId: String(req.query.hall || 'unknown-hall'),
      })
      return res.json({
        provider,
        apiKey,
        expiresAt,
        model: SONIOX_MODEL,
        languageHints: azureLocalesToSonioxHints(SOURCE_LANG_LIST),
        targetLanguage: TARGET_LANG,
        context: phraseListToContext(PHRASE_LIST),
      })
    }

    res.json({
      provider,
      token: await issueAzureToken({ key: SPEECH_KEY, region: SPEECH_REGION }),
      region: SPEECH_REGION,
      sourceLanguages: SOURCE_LANG_LIST,
      targetLanguage: TARGET_LANG,
      phraseList: PHRASE_LIST,
    })
  } catch (err) {
    console.error('[token]', provider, err.message)
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/config', (req, res) => {
  res.json({
    halls: HALLS,
    captionDelayMs: CAPTION_DELAY_MS,
    controlKeyRequired: Boolean(CONTROL_KEY),
    provider: SPEECH_PROVIDER,
  })
})

app.get('/api/health', (req, res) => {
  res.json({ ok: true, halls: healthSnapshot(), ts: Date.now() })
})

function requireControlKey(req, res, next) {
  if (!CONTROL_KEY) return next()
  const provided = req.query.key || req.get('x-control-key')
  if (provided === CONTROL_KEY) return next()
  res.status(401).json({ error: 'bad or missing control key' })
}

// Static pages. Screens are the only unauthenticated surface.
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }))

// Serve the Speech SDK from node_modules so a venue with flaky internet is not
// also fetching our JS from a CDN. Falls through to the CDN in capture.html if
// this file is missing.
const sdkBundle = path.join(
  __dirname,
  'node_modules',
  'microsoft-cognitiveservices-speech-sdk',
  'distrib',
  'browser',
  'microsoft.cognitiveservices.speech.sdk.bundle.js'
)
app.get('/vendor/speech-sdk.js', (req, res) => {
  if (!fs.existsSync(sdkBundle)) return res.status(404).send('// local SDK bundle not installed')
  res.type('application/javascript').sendFile(sdkBundle)
})

// Same deal for Soniox. This one is an ES module, imported dynamically by the
// capture page only when that provider is actually in use.
const sonioxBundle = path.join(
  __dirname,
  'node_modules',
  '@soniox',
  'speech-to-text-web',
  'dist',
  'speech-to-text-web.js'
)
app.get('/vendor/soniox-sdk.js', (req, res) => {
  if (!fs.existsSync(sonioxBundle)) return res.status(404).send('// local Soniox SDK not installed')
  res.type('application/javascript').sendFile(sonioxBundle)
})

app.get('/', (req, res) => res.redirect('/operator.html'))

const server = http.createServer(app)
const wss = new WebSocketServer({ server, path: '/ws' })

// ---------------------------------------------------------------------------
// WebSocket relay. Every socket is scoped to a hall (operators to all halls).
// There is deliberately no global broadcast path anywhere in this file.
// ---------------------------------------------------------------------------

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost')
  const role = url.searchParams.get('role') || 'screen'
  const hallId = url.searchParams.get('hall') || ''
  const key = url.searchParams.get('key') || ''

  ws.isAlive = true
  ws.on('pong', () => {
    ws.isAlive = true
  })

  if (role === 'operator') {
    if (CONTROL_KEY && key !== CONTROL_KEY) return reject(ws, 'unauthorized', 'Bad control key.')
    ws.role = 'operator'
    for (const hall of halls.values()) hall.operators.add(ws)
    send(ws, {
      type: 'hello',
      role: 'operator',
      halls: HALLS,
      captionDelayMs: CAPTION_DELAY_MS,
      defaultProvider: SPEECH_PROVIDER,
    })
    send(ws, { type: 'health', halls: healthSnapshot() })
    ws.on('message', (raw) => guard('operator', () => handleOperatorMessage(ws, raw)))
    ws.on('close', () => {
      for (const hall of halls.values()) hall.operators.delete(ws)
    })
    return
  }

  // Screens and publishers must name a valid hall.
  if (!hallId) return reject(ws, 'no_hall', 'No hall specified. Use ?hall=<id>.')
  if (!halls.has(hallId)) return reject(ws, 'unknown_hall', `Unknown hall "${hallId}".`)
  const hall = halls.get(hallId)
  ws.hallId = hallId

  if (role === 'publisher') {
    if (CONTROL_KEY && key !== CONTROL_KEY) return reject(ws, 'unauthorized', 'Bad control key.')
    // One publisher per hall: a forgotten tab in a green room must not
    // interleave captions into a live wall.
    if (hall.publisher && hall.publisher.readyState === ws.OPEN) {
      return reject(ws, 'publisher_taken', `${hallId} already has a live capture session.`)
    }
    ws.role = 'publisher'
    hall.publisher = ws
    hall.lastPublisherTs = Date.now()
    send(ws, { type: 'hello', role: 'publisher', hallId })
    broadcastHealth()
    console.log(`[ws] publisher connected: ${hallId}`)

    ws.on('message', (raw) => guard(`publisher ${hallId}`, () => handlePublisherMessage(ws, hall, raw)))
    ws.on('close', () => {
      if (hall.publisher === ws) {
        hall.publisher = null
        hall.provider = null
      }
      console.log(`[ws] publisher gone: ${hallId}`)
      broadcastHealth()
    })
    return
  }

  // Screen.
  ws.role = 'screen'
  hall.screens.add(ws)
  send(ws, {
    type: 'hello',
    role: 'screen',
    hallId,
    blanked: hall.blanked,
    frozen: hall.frozen,
    finals: hall.finals.slice(-REPLAY_LINES),
    partial: hall.partial,
  })
  broadcastHealth()
  ws.on('close', () => {
    hall.screens.delete(ws)
    broadcastHealth()
  })
})

function handlePublisherMessage(ws, hall, raw) {
  let msg
  try {
    msg = JSON.parse(raw)
  } catch {
    return
  }
  hall.lastPublisherTs = Date.now()

  if (msg.type === 'partial' || msg.type === 'final') {
    const text = String(msg.text || '').trim()
    if (!text) return
    const event = {
      type: msg.type,
      hallId: ws.hallId,
      text,
      lang: msg.lang || null,
      ts: Date.now(),
    }
    if (msg.type === 'final') return emitFinal(hall, event)
    // With a review delay configured we suppress partials — showing them would
    // leak the un-reviewed text ahead of the delayed finals.
    if (CAPTION_DELAY_MS > 0) return
    hall.partial = text
    hall.lastCaptionTs = event.ts
    toScreens(hall, event)
    toOperators(hall, event)
  } else if (msg.type === 'status') {
    // The capture page reports the engine it actually started, which during an
    // A/B is the only trustworthy source — .env says nothing about a hall
    // flipped with ?provider=.
    if (msg.provider) {
      hall.provider = String(msg.provider).slice(0, 24)
      broadcastHealth()
    }
    toOperators(hall, { type: 'publisher_status', hallId: ws.hallId, ...msg, ts: Date.now() })
  }
}

function emitFinal(hall, event) {
  let handle = null
  const deliver = () => {
    if (handle) hall.pending.delete(handle)
    if (hall.blanked || hall.frozen) return // decided at fire time, not queue time
    hall.finals.push(event.text)
    if (hall.finals.length > 200) hall.finals.splice(0, hall.finals.length - 200)
    hall.partial = ''
    hall.lastCaptionTs = Date.now()
    toScreens(hall, event)
    toOperators(hall, event)
  }
  if (CAPTION_DELAY_MS <= 0) return deliver()
  handle = setTimeout(deliver, CAPTION_DELAY_MS)
  hall.pending.add(handle)
  // Operators see it immediately so they can blank before it reaches a wall.
  toOperators(hall, { ...event, type: 'preview' })
}

function handleOperatorMessage(ws, raw) {
  let msg
  try {
    msg = JSON.parse(raw)
  } catch {
    return
  }

  const targets =
    msg.hallId === '*' || !msg.hallId ? [...halls.keys()] : halls.has(msg.hallId) ? [msg.hallId] : []

  for (const id of targets) {
    const hall = halls.get(id)
    switch (msg.type) {
      case 'blank':
        hall.blanked = Boolean(msg.value)
        if (hall.blanked) dropPending(hall)
        toScreens(hall, { type: 'blank', hallId: id, value: hall.blanked })
        console.log(`[op] ${id} blank=${hall.blanked}`)
        break
      case 'freeze':
        hall.frozen = Boolean(msg.value)
        toScreens(hall, { type: 'freeze', hallId: id, value: hall.frozen })
        break
      case 'clear':
        dropPending(hall)
        hall.finals = []
        hall.partial = ''
        toScreens(hall, { type: 'clear', hallId: id })
        break
      case 'style':
        toScreens(hall, { type: 'style', hallId: id, size: msg.size, lines: msg.lines })
        break
      default:
        break
    }
  }
  broadcastHealth()
}

function dropPending(hall) {
  for (const handle of hall.pending) clearTimeout(handle)
  hall.pending.clear()
}

// One malformed event in one hall must never take the other three off the air.
function guard(where, fn) {
  try {
    fn()
  } catch (err) {
    console.error(`[error:${where}]`, err && err.stack ? err.stack : err)
  }
}

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj))
}

function reject(ws, code, message) {
  send(ws, { type: 'error', code, message })
  ws.close(4000, code)
}

function toScreens(hall, event) {
  if (hall.blanked && event.type !== 'blank') return
  const payload = JSON.stringify(event)
  for (const s of hall.screens) if (s.readyState === s.OPEN) s.send(payload)
}

function toOperators(hall, event) {
  const payload = JSON.stringify(event)
  for (const o of hall.operators) if (o.readyState === o.OPEN) o.send(payload)
}

function healthSnapshot() {
  const now = Date.now()
  return HALLS.map((id) => {
    const hall = halls.get(id)
    return {
      hallId: id,
      screens: hall.screens.size,
      publisherLive: Boolean(hall.publisher && hall.publisher.readyState === hall.publisher.OPEN),
      lastCaptionAgeMs: hall.lastCaptionTs ? now - hall.lastCaptionTs : null,
      provider: hall.provider,
      blanked: hall.blanked,
      frozen: hall.frozen,
    }
  })
}

function broadcastHealth() {
  const payload = JSON.stringify({ type: 'health', halls: healthSnapshot() })
  const seen = new Set()
  for (const hall of halls.values()) {
    for (const o of hall.operators) {
      if (seen.has(o) || o.readyState !== o.OPEN) continue
      seen.add(o)
      o.send(payload)
    }
  }
}

// Heartbeat: drop half-open sockets so screen counts stay honest.
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate()
      continue
    }
    ws.isAlive = false
    ws.ping()
  }
}, 15000).unref()

setInterval(broadcastHealth, 2000).unref()

// Last-resort net. Staying up with one broken hall beats dying with four.
// pm2 restarts us if we ever do exit, but a restart drops every screen.
process.on('uncaughtException', (err) => console.error('[uncaught]', err.stack || err))
process.on('unhandledRejection', (err) => console.error('[unhandled]', (err && err.stack) || err))
wss.on('error', (err) => console.error('[wss]', err.message))

// A bind failure is fatal and must look fatal — staying alive with nothing
// listening would let pm2 report a healthy service that no screen can reach.
server.on('error', (err) => {
  console.error(`[fatal] cannot listen on :${PORT} — ${err.message}`)
  process.exit(1)
})

server.listen(PORT, () => {
  console.log(`event-captions listening on :${PORT}`)
  console.log(`  halls        : ${HALLS.join(', ')}`)
  console.log(`  screens      : /screen.html?hall=${HALLS[0]}`)
  console.log(`  capture      : /capture.html?hall=${HALLS[0]}`)
  console.log(`  operator     : /operator.html`)
  console.log(`  provider     : ${SPEECH_PROVIDER}${SPEECH_PROVIDER === 'soniox' ? ` (${SONIOX_MODEL})` : ` (${SPEECH_REGION})`}`)
  console.log(`  caption delay: ${CAPTION_DELAY_MS}ms`)
  console.log(`  control key  : ${CONTROL_KEY ? 'required' : 'NOT SET (open access)'}`)
})
