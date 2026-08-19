// Review-delay path + control-key auth.
const WebSocket = require('ws')
const BASE = 'ws://127.0.0.1:8098/ws'
const KEY = 'testkey'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, c, d) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  <- ' + d}`); if (!c) failures++ }

function open(q) {
  const ws = new WebSocket(`${BASE}?${q}`)
  ws.received = []
  ws.on('message', (d) => ws.received.push(JSON.parse(d)))
  return new Promise((r) => { ws.on('open', () => r(ws)); ws.on('error', () => r(ws)) })
}
const types = (ws, t) => ws.received.filter((m) => m.type === t)

;(async () => {
  // auth
  const noKey = await open('role=publisher&hall=hall-1')
  await sleep(150)
  check('publisher without key refused', noKey.received.some((m) => m.code === 'unauthorized'))
  const opNoKey = await open('role=operator')
  await sleep(150)
  check('operator without key refused', opNoKey.received.some((m) => m.code === 'unauthorized'))
  const screenNoKey = await open('role=screen&hall=hall-1')
  await sleep(150)
  check('screens need no key', screenNoKey.received.some((m) => m.type === 'hello'))

  const tokenRes = await fetch('http://127.0.0.1:8098/api/token')
  check('token endpoint refuses without key', tokenRes.status === 401, tokenRes.status)

  // delay behaviour
  const pub = await open(`role=publisher&hall=hall-1&key=${KEY}`)
  const op = await open(`role=operator&key=${KEY}`)
  const screen = screenNoKey
  await sleep(150)

  pub.send(JSON.stringify({ type: 'partial', text: 'partial should be suppressed' }))
  pub.send(JSON.stringify({ type: 'final', text: 'DELAYED LINE' }))
  await sleep(200)
  check('partials suppressed under review delay', types(screen, 'partial').length === 0)
  check('final not yet on screen at 200ms', types(screen, 'final').length === 0)
  check('operator sees preview immediately', types(op, 'preview').some((m) => m.text === 'DELAYED LINE'))

  await sleep(1200)
  check('final lands on screen after delay', types(screen, 'final').some((m) => m.text === 'DELAYED LINE'))

  // blank must kill text that is still in flight
  pub.send(JSON.stringify({ type: 'final', text: 'MUST NEVER APPEAR' }))
  await sleep(150)
  op.send(JSON.stringify({ type: 'blank', hallId: 'hall-1', value: true }))
  await sleep(1600)
  check('blank drops in-flight caption', !types(screen, 'final').some((m) => m.text === 'MUST NEVER APPEAR'),
    JSON.stringify(types(screen, 'final').map((m) => m.text)))

  console.log(failures === 0 ? '\nALL DELAY/AUTH TESTS PASSED' : `\n${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
})()
