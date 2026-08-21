// Per-language routing. The failure this guards against is the same class as
// cross-hall leakage: text reaching a screen it was never meant for, and the
// safety controls only covering half a hall.
const WebSocket = require('ws')
const BASE = 'ws://127.0.0.1:8097/ws'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
const check = (n, c, d) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  <- ' + d}`)
  if (!c) failures++
}

function open(q) {
  const ws = new WebSocket(`${BASE}?${q}`)
  ws.received = []
  ws.on('message', (d) => ws.received.push(JSON.parse(d)))
  return new Promise((r) => { ws.on('open', () => r(ws)); ws.on('error', () => r(ws)) })
}
const texts = (ws, t) => ws.received.filter((m) => m.type === t).map((m) => m.text)

;(async () => {
  const en = await open('role=screen&hall=hall-1&lang=en')
  const ta = await open('role=screen&hall=hall-1&lang=ta')
  const enOther = await open('role=screen&hall=hall-2&lang=en')
  const noLang = await open('role=screen&hall=hall-1')
  const pub = await open('role=publisher&hall=hall-1')
  const op = await open('role=operator')
  await sleep(200)

  check('screen with no ?lang joins the default language',
    noLang.received.some((m) => m.type === 'hello' && m.lang === 'en'),
    JSON.stringify(noLang.received[0]))

  // --- unknown language is refused, never served empty ----------------------
  const bogus = await open('role=screen&hall=hall-1&lang=fr')
  await sleep(150)
  check('unknown language rejected', bogus.received.some((m) => m.code === 'unknown_lang'))

  // --- tagged captions reach only their own language ------------------------
  pub.send(JSON.stringify({ type: 'final', text: 'Good morning', targetLang: 'en' }))
  pub.send(JSON.stringify({ type: 'final', text: 'காலை வணக்கம்', targetLang: 'ta' }))
  await sleep(250)

  check('english screen got the english line', texts(en, 'final').includes('Good morning'))
  check('tamil screen got the tamil line', texts(ta, 'final').includes('காலை வணக்கம்'))
  check('no leak: tamil text never reaches the english screen',
    !texts(en, 'final').includes('காலை வணக்கம்'), JSON.stringify(texts(en, 'final')))
  check('no leak: english text never reaches the tamil screen',
    !texts(ta, 'final').includes('Good morning'), JSON.stringify(texts(ta, 'final')))
  check('no leak across halls either', texts(enOther, 'final').length === 0)
  check('default-language screen tracked the english stream',
    texts(noLang, 'final').includes('Good morning'))

  // --- the multi-target payload shape (Azure) -------------------------------
  pub.send(JSON.stringify({ type: 'final', texts: { en: 'Welcome', ta: 'வரவேற்பு' } }))
  await sleep(250)
  check('texts map fans out to english', texts(en, 'final').includes('Welcome'))
  check('texts map fans out to tamil', texts(ta, 'final').includes('வரவேற்பு'))
  check('texts map does not cross languages',
    !texts(en, 'final').includes('வரவேற்பு') && !texts(ta, 'final').includes('Welcome'))

  // --- untagged payload keeps working (backwards compatibility) -------------
  pub.send(JSON.stringify({ type: 'final', text: 'untagged line' }))
  await sleep(250)
  check('untagged text routes to the default language', texts(en, 'final').includes('untagged line'))
  check('untagged text does not reach tamil', !texts(ta, 'final').includes('untagged line'))

  // --- a language the server does not carry is dropped, not invented --------
  pub.send(JSON.stringify({ type: 'final', text: 'should vanish', targetLang: 'de' }))
  await sleep(200)
  check('caption for an unconfigured language is dropped',
    !texts(en, 'final').includes('should vanish') && !texts(ta, 'final').includes('should vanish'))

  // --- per-language replay on reload ----------------------------------------
  const taReload = await open('role=screen&hall=hall-1&lang=ta')
  await sleep(200)
  const hello = taReload.received.find((m) => m.type === 'hello')
  check('reloaded tamil screen replays tamil history',
    hello.finals.includes('காலை வணக்கம்'), JSON.stringify(hello.finals))
  check('reloaded tamil screen replays NO english history',
    !hello.finals.includes('Good morning'), JSON.stringify(hello.finals))

  // --- per-language health --------------------------------------------------
  pub.send(JSON.stringify({ type: 'status', state: 'session', targetLang: 'ta', live: false }))
  await sleep(300)
  const health = [...op.received].reverse().find((m) => m.type === 'health')
  const hall1 = health.halls.find((h) => h.hallId === 'hall-1')
  const taHealth = hall1.languages.find((l) => l.lang === 'ta')
  const enHealth = hall1.languages.find((l) => l.lang === 'en')
  check('operator sees the tamil session reported dead', taHealth.live === false)
  check('english session unaffected by the tamil failure', enHealth.live === true)
  check('per-language screen counts are reported', taHealth.screens === 2 && enHealth.screens === 2,
    `ta=${taHealth.screens} en=${enHealth.screens}`)

  // --- THE SAFETY TEST: blank must cover every language ---------------------
  const enBefore = texts(en, 'final').length
  const taBefore = texts(ta, 'final').length
  op.send(JSON.stringify({ type: 'blank', hallId: 'hall-1', value: true }))
  await sleep(200)
  pub.send(JSON.stringify({ type: 'final', text: 'MUST NOT APPEAR', targetLang: 'en' }))
  pub.send(JSON.stringify({ type: 'final', text: 'தோன்றக் கூடாது', targetLang: 'ta' }))
  await sleep(300)

  check('blank suppresses english', texts(en, 'final').length === enBefore)
  check('blank suppresses tamil in the SAME press', texts(ta, 'final').length === taBefore,
    JSON.stringify(texts(ta, 'final').slice(taBefore)))
  check('both languages received the blank instruction',
    en.received.some((m) => m.type === 'blank' && m.value) &&
    ta.received.some((m) => m.type === 'blank' && m.value))

  // --- clear covers every language too --------------------------------------
  op.send(JSON.stringify({ type: 'blank', hallId: 'hall-1', value: false }))
  op.send(JSON.stringify({ type: 'clear', hallId: 'hall-1' }))
  await sleep(250)
  const afterClear = await open('role=screen&hall=hall-1&lang=ta')
  await sleep(200)
  check('clear emptied the tamil buffer as well as english',
    afterClear.received.find((m) => m.type === 'hello').finals.length === 0)

  console.log(failures === 0 ? '\nALL MULTI-LANGUAGE TESTS PASSED' : `\n${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
})()
