# Event Captions

Live speech translation captions for **4 physically separated halls**, each with its own speaker
and its own audio feed. Speakers may use Tamil, Hindi or English and switch mid-sentence; every
screen shows English.

```
Hall N mics ─► AV mixer ─► USB audio interface ─► capture laptop (Chrome)
                                                        │ Azure Speech Translation
                                                        │ WebSocket
                                                        ▼
                                            relay (this server, one VM)
                                          routes strictly by hallId
                                                        ▼
                                            that hall's screens only
```

Everything dials **outbound** to the relay, so the four halls can be on four unrelated networks.

## Quick start

```bash
cp .env.example .env      # fill in AZURE_SPEECH_KEY, AZURE_SPEECH_REGION, CONTROL_KEY
npm install
npm start
```

| Page | URL | Who opens it |
|---|---|---|
| Screen | `/screen.html?hall=hall-1` | Every TV/projector in that hall |
| Capture | `/capture.html?hall=hall-1&key=…` | The capture laptop in that hall, one per hall |
| Operator | `/operator.html?key=…` | The roaming lead |

Screens need no key. Capture and operator do, once `CONTROL_KEY` is set.

**HTTPS is mandatory** in production — browsers refuse microphone access on plain HTTP (localhost
excepted), so the capture page will not work without TLS.

## Day-1 spike

Decide Azure vs Soniox before building anything else:

```bash
ffmpeg -i raw-tamil.m4a -ar 16000 -ac 1 -c:a pcm_s16le sample-tamil.wav
node spike/azure-file-test.js sample-tamil.wav
```

Prints each translated line with its detected language and settle time. Judge the **text** by eye —
that is what the tool is for. File input is processed faster than realtime, so its timings
understate live lag; real latency can only be measured from the mixer, in the hall.

Verified working against a synthesized Tamil→Hindi→English clip: both non-English segments
translated correctly and continuous LID switched languages unprompted. Two things that showed up
and are worth watching with real speaker audio:

- **LID lags a language switch.** The English segment was still tagged `hi-IN` and came back
  slightly garbled (`You First Session Begins…`). Expect the first few words after a switch to be
  the weakest part of any caption.
- **`AZURE_SPEECH_REGION` is currently `eastus`.** If the venue is in India, move it to
  `centralindia` and re-run this spike — round-trip time is a direct addition to caption lag.

## Tests

```bash
npm test
```

Covers the failures that would actually embarrass you: **cross-talk between halls**, unknown/missing
hall refusal, the one-publisher-per-hall lock, replay on screen reload, per-hall blank, health
accuracy after a publisher drops, review-delay behaviour, and control-key auth. Run it after any
change and once on the deployed VM before doors open.

## Screen URL parameters

| Param | Effect |
|---|---|
| `hall` | **Required.** No hall, or an unknown one, shows a large NOT CONFIGURED card rather than guessing |
| `size` | Caption font size in px (default 52). Tune from the back row, not the laptop |
| `lines` | Visible lines (default 3) |
| `label=1` | Shows the hall name in the corner — use during setup to confirm each wall is on the right channel |

## Operator console

One row per hall: capture-live dot, screen count, last-caption age, and the live caption text.

- **Blank** — per hall. The button that matters. Instantly hides captions and discards anything
  still inside the review delay.
- **BLANK ALL HALLS** / **spacebar** — panic control across every hall at once.
- **Freeze**, **Clear**, **A− / A+** — per hall.
- A hall showing `NO CAPTURE` or a growing last-caption age is a hall to radio about.

Set `CAPTION_DELAY_MS=1500` to hold finals back before they reach the walls. The operator sees
them immediately in amber, so there is a real window to hit Blank. Partials are suppressed while a
delay is configured, otherwise un-reviewed text would run ahead of it.

## Resilience built in

- Screens reconnect forever with backoff and **keep the last captions visible** while doing so, so
  a short blip is invisible to the audience rather than a black wall.
- Screens repaint recent lines instantly on reload from a per-hall replay buffer.
- Capture page restarts the recognizer on `Canceled` / `SessionStopped`, plus a **20s silence
  watchdog** for the case where Azure goes quiet without saying so.
- Azure auth tokens refresh every 7 minutes; the subscription key never reaches a browser.
- One publisher per hall — a forgotten capture tab cannot interleave captions into a live wall.
- Uncaught errors are logged, not fatal: one bad event in one hall must not take the other three
  off the air.

**Not covered:** there is no hardware fallback. If a hall loses internet, that hall loses captions
until it returns. Mitigate with a 4G/5G hotspot pre-paired to each capture laptop — the uplink, not
the last HDMI metre, is the real single point of failure.

## Deploy

```bash
# on the VM
npm ci --omit=dev
npm i -g pm2
pm2 start server.js --name captions && pm2 save && pm2 startup
```

Caddy handles TLS in two lines:

```
captions.example.org {
    reverse_proxy localhost:8080
}
```

Open 443 only. Websockets pass through Caddy without extra config.

## Pre-event checklist

- [ ] Day-1 spike run on real Tamil audio; engine decision made
- [ ] `PHRASE_LIST` seeded with speaker names, org names, event terms
- [ ] `CONTROL_KEY` set; capture/operator URLs distributed only to staff
- [ ] Azure concurrency limit confirmed for 4 simultaneous streams
- [ ] Cross-talk test: publish to each hall, confirm the other three stay untouched
- [ ] Per-hall kit: laptop, USB interface, XLR, hotspot pre-paired and failover tested
- [ ] Mixer line-out confirmed in every hall — never a room mic; peaks near −12 dBFS
- [ ] Legibility checked from the back row of each hall
- [ ] Hall minders drilled hands-on: Blank, Clear, Restart
- [ ] Per-hall run sheet printed and taped to each capture laptop
- [ ] 30+ minute soak per hall with no recognizer stall

## Run sheet template (one per hall, printed)

```
HALL: hall-2                      MINDER: ______________

Screens : https://captions.example.org/screen.html?hall=hall-2
Capture : https://captions.example.org/capture.html?hall=hall-2&key=…
Lead    : ______________  (radio channel ___)

Captions frozen or wrong        -> Blank, then reload the capture page and press Start
Captions stopped                -> check the capture page dot; press Stop then Start
Screen black                    -> reload the screen URL; check it says hall-2 top-left
Everything down                 -> switch the capture laptop to the backup hotspot
Something said that must not    -> Blank. Ask afterwards.
be on the wall
```
