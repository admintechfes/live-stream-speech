// Relay verification: cross-talk isolation, unknown-hall refusal, publisher
// lock, replay-on-reload, blank suppression.
const WebSocket = require('ws')

const BASE = 'ws://127.0.0.1:8099/ws'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0

function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  <- ' + detail}`)
  if (!cond) failures++
}

function open(query) {
  const ws = new WebSocket(`${BASE}?${query}`)
  ws.received = []
  ws.on('message', (d) => ws.received.push(JSON.parse(d)))
  return new Promise((resolve) => {
    ws.on('open', () => resolve(ws))
    ws.on('error', () => resolve(ws))
  })
}

const texts = (ws, type) => ws.received.filter((m) => m.type === type).map((m) => m.text)

;(async () => {
  // 4 halls of screens, 2 publishers
  const screens = {}
  for (const h of ['hall-1', 'hall-2', 'hall-3', 'hall-4']) {
    screens[h] = await open(`role=screen&hall=${h}`)
  }
  const pub1 = await open('role=publisher&hall=hall-1')
  const pub2 = await open('role=publisher&hall=hall-2')
  await sleep(150)

  // --- isolation ---
  pub1.send(JSON.stringify({ type: 'final', text: 'HALL ONE LINE', lang: 'ta-IN' }))
  pub2.send(JSON.stringify({ type: 'final', text: 'HALL TWO LINE', lang: 'hi-IN' }))
  await sleep(200)

  check('hall-1 screen got its own caption', texts(screens['hall-1'], 'final').includes('HALL ONE LINE'))
  check('hall-2 screen got its own caption', texts(screens['hall-2'], 'final').includes('HALL TWO LINE'))
  check('no cross-talk hall-2 -> hall-1', !texts(screens['hall-1'], 'final').includes('HALL TWO LINE'))
  check('no cross-talk hall-1 -> hall-2', !texts(screens['hall-2'], 'final').includes('HALL ONE LINE'))
  check('hall-3 silent', texts(screens['hall-3'], 'final').length === 0, JSON.stringify(screens['hall-3'].received))
  check('hall-4 silent', texts(screens['hall-4'], 'final').length === 0)

  // --- unknown hall refuses rather than guessing ---
  const bogus = await open('role=screen&hall=hall-9')
  await sleep(150)
  const err = bogus.received.find((m) => m.type === 'error')
  check('unknown hall rejected', err && err.code === 'unknown_hall', JSON.stringify(bogus.received))

  const noHall = await open('role=screen')
  await sleep(150)
  check('missing hall rejected', noHall.received.some((m) => m.code === 'no_hall'))

  // --- one publisher per hall ---
  const dupe = await open('role=publisher&hall=hall-1')
  await sleep(150)
  check('second publisher on hall-1 refused', dupe.received.some((m) => m.code === 'publisher_taken'))

  // --- replay buffer on screen reload ---
  const reloaded = await open('role=screen&hall=hall-1')
  await sleep(150)
  const hello = reloaded.received.find((m) => m.type === 'hello')
  check('reloaded screen repaints history', hello && hello.finals.includes('HALL ONE LINE'), JSON.stringify(hello))

  // --- operator blank suppresses only that hall ---
  const op = await open('role=operator')
  await sleep(100)
  op.send(JSON.stringify({ type: 'blank', hallId: 'hall-1', value: true }))
  await sleep(120)
  pub1.send(JSON.stringify({ type: 'final', text: 'SHOULD NOT APPEAR' }))
  pub2.send(JSON.stringify({ type: 'final', text: 'HALL TWO STILL LIVE' }))
  await sleep(200)
  check('blanked hall suppresses captions', !texts(screens['hall-1'], 'final').includes('SHOULD NOT APPEAR'))
  check('blank is per-hall, hall-2 unaffected', texts(screens['hall-2'], 'final').includes('HALL TWO STILL LIVE'))

  // --- health reflects reality ---
  const health = [...op.received].reverse().find((m) => m.type === 'health')
  const h1 = health && health.halls.find((h) => h.hallId === 'hall-1')
  const h3 = health && health.halls.find((h) => h.hallId === 'hall-3')
  check('health: hall-1 publisher live', h1 && h1.publisherLive === true, JSON.stringify(h1))
  check('health: hall-1 counts 2 screens', h1 && h1.screens === 2, JSON.stringify(h1))
  check('health: hall-3 has no publisher', h3 && h3.publisherLive === false, JSON.stringify(h3))

  // --- publisher disconnect is noticed ---
  pub1.close()
  await sleep(2300)
  const health2 = [...op.received].reverse().find((m) => m.type === 'health')
  const h1b = health2.halls.find((h) => h.hallId === 'hall-1')
  check('publisher loss shows in health', h1b.publisherLive === false, JSON.stringify(h1b))

  // --- hall released after publisher leaves ---
  const pub1b = await open('role=publisher&hall=hall-1')
  await sleep(150)
  check('hall reclaimable after disconnect', pub1b.received.some((m) => m.type === 'hello'))

  console.log(failures === 0 ? '\nALL RELAY TESTS PASSED' : `\n${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
})()
