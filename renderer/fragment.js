/*
 * TimerFragment — renders one element of a timer layout into a container.
 * Types: timer parts (default), static text, rect, ellipse.
 * Shared by timer.html (one element per URL) and layout.html (many).
 *
 *   const frag = TimerFragment.create(containerEl, params)
 *   frag.feed(timersSnapshot)
 *   frag.destroy()
 *
 * Structure: container (positioned by caller; rotation applied here)
 *            └─ animWrap (entrance animation; flex alignment)
 *               └─ content (text span / shape / bar / ring svg)
 *
 * Sizing is container-relative (size = % of container height), so the
 * designer preview and the full-frame output look identical.
 */
window.TimerFragment = (() => {
  const ONES = ['zero','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen']
  const TENS = ['','','twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety']
  function words(n) {
    n = Math.abs(Math.round(n))
    if (n < 20) return ONES[n]
    if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? '-' + ONES[n % 10] : '')
    if (n < 1000) {
      const rest = n % 100
      return ONES[Math.floor(n / 100)] + ' hundred' + (rest ? ' and ' + words(rest) : '')
    }
    const rest = n % 1000
    return words(Math.floor(n / 1000)) + ' thousand' + (rest ? ' ' + words(rest) : '')
  }

  const mctx = document.createElement('canvas').getContext('2d')

  // ---- entrance animations (injected once) ----
  const ANIMS = ['fade','slide-up','slide-down','slide-left','slide-right','zoom','pop','wibble','bounce','spin','blur','flip','roll']
  function injectKeyframes() {
    if (document.getElementById('tfr-anims')) return
    const st = document.createElement('style')
    st.id = 'tfr-anims'
    st.textContent = `
@keyframes tfr-fade { from { opacity: 0 } }
@keyframes tfr-slide-up { from { opacity: 0; transform: translateY(45%) } }
@keyframes tfr-slide-down { from { opacity: 0; transform: translateY(-45%) } }
@keyframes tfr-slide-left { from { opacity: 0; transform: translateX(45%) } }
@keyframes tfr-slide-right { from { opacity: 0; transform: translateX(-45%) } }
@keyframes tfr-zoom { from { opacity: 0; transform: scale(0.4) } }
@keyframes tfr-pop {
  0% { opacity: 0; transform: scale(0) }
  60% { opacity: 1; transform: scale(1.12) }
  80% { transform: scale(0.96) }
  100% { transform: scale(1) }
}
@keyframes tfr-wibble {
  0% { opacity: 0; transform: scale(0.3) rotate(-14deg) }
  40% { opacity: 1; transform: scale(1.08) rotate(9deg) }
  60% { transform: scale(0.94) rotate(-5deg) }
  75% { transform: scale(1.03) rotate(3deg) }
  88% { transform: scale(0.99) rotate(-1deg) }
  100% { transform: scale(1) rotate(0) }
}
@keyframes tfr-bounce {
  0% { opacity: 0; transform: translateY(-130%) }
  45% { opacity: 1; transform: translateY(0) }
  62% { transform: translateY(-22%) }
  78% { transform: translateY(0) }
  88% { transform: translateY(-8%) }
  100% { transform: translateY(0) }
}
@keyframes tfr-spin { from { opacity: 0; transform: rotate(-200deg) scale(0.25) } }
@keyframes tfr-blur { from { opacity: 0; filter: blur(24px) } to { filter: blur(0) } }
@keyframes tfr-flip { from { opacity: 0; transform: perspective(600px) rotateX(85deg) } }
@keyframes tfr-roll { from { opacity: 0; transform: translateX(-70%) rotate(-160deg) scale(0.6) } }
`
    document.head.appendChild(st)
  }

  function create(container, rawParams) {
    const params = rawParams instanceof URLSearchParams
      ? Object.fromEntries(rawParams.entries())
      : { ...rawParams }
    const P = (k, d) => (params[k] != null && params[k] !== '' ? String(params[k]) : d)

    const type = P('type', 'timer')
    const part = P('part', 'time')
    injectKeyframes()

    if (getComputedStyle(container).position === 'static') container.style.position = 'relative'
    container.style.overflow = 'visible'

    // rotation on the container so it never fights animation transforms
    const rot = parseFloat(P('r', '0'))
    if (rot) container.style.transform = `rotate(${rot}deg)`
    container.style.opacity = P('opacity', '1')

    // animation wrapper
    const animWrap = document.createElement('div')
    animWrap.style.position = 'absolute'
    animWrap.style.inset = '0'
    animWrap.style.display = 'flex'
    const align = P('align', 'center')
    animWrap.style.justifyContent = align === 'left' ? 'flex-start' : align === 'right' ? 'flex-end' : 'center'
    const valign = P('valign', 'middle')
    animWrap.style.alignItems = valign === 'top' ? 'flex-start' : valign === 'bottom' ? 'flex-end' : 'center'
    container.appendChild(animWrap)

    const anim = P('anim', '')
    if (anim && ANIMS.includes(anim)) {
      const dur = Math.max(0.05, parseFloat(P('animdur', '0.8')))
      const delay = Math.max(0, parseFloat(P('animdelay', '0')))
      animWrap.style.animation = `tfr-${anim} ${dur}s cubic-bezier(.22,.9,.35,1) ${delay}s both`
    }

    const cleanups = []
    const onResize = []
    const ro = new ResizeObserver(() => onResize.forEach((f) => f()))
    ro.observe(container)
    cleanups.push(() => ro.disconnect())

    // ================= SHAPES =================
    if (type === 'rect' || type === 'ellipse') {
      const shape = document.createElement('div')
      shape.style.position = 'absolute'
      shape.style.inset = '0'
      shape.style.background = P('color', '#ffffff')
      animWrap.appendChild(shape)
      const update = () => {
        const h = container.clientHeight || 1
        if (type === 'ellipse') shape.style.borderRadius = '50%'
        else shape.style.borderRadius = ((parseFloat(P('radius', '0')) / 100) * h) + 'px'
        const bw = parseFloat(P('borderw', '0'))
        shape.style.border = bw > 0 ? ((bw / 100) * h) + 'px solid ' + P('borderc', '#000000') : 'none'
      }
      update()
      onResize.push(update)
      return { feed() {}, destroy: destroyer(cleanups, container, null) }
    }

    // ================= TEXT PIPELINE (timer + static text) =================
    const inner = document.createElement('span')
    const meas = document.createElement('span')
    for (const el of [inner, meas]) {
      el.style.whiteSpace = 'pre'
      el.style.lineHeight = '1.06'
      el.style.display = 'inline-block'
    }
    meas.style.position = 'fixed'
    meas.style.left = '-99999px'
    meas.style.top = '0'
    meas.style.visibility = 'hidden'
    meas.style.fontSize = '100px'
    animWrap.appendChild(inner)
    document.body.appendChild(meas)
    cleanups.push(() => meas.remove())

    const fontFamily = P('font', 'Helvetica, Arial, sans-serif')
    const weight = P('weight', '800')
    const italic = P('italic') === '1' ? 'italic' : 'normal'
    for (const el of [inner, meas]) {
      el.style.fontFamily = fontFamily
      el.style.fontWeight = weight
      el.style.fontStyle = italic
      el.style.fontVariantNumeric = 'tabular-nums'
      if (P('spacing')) el.style.letterSpacing = P('spacing') + 'em'
    }
    inner.style.color = P('color', '#ffffff')

    const shadow = P('shadow')
    if (shadow === '1' || shadow === 'true') inner.style.textShadow = '0 0.06em 0.18em rgba(0,0,0,0.65)'
    else if (shadow) {
      const [x = 0, y = 0, b = 0, c = 'rgba(0,0,0,.65)'] = shadow.split(',')
      inner.style.textShadow = `${x}px ${y}px ${b}px ${c}`
    }
    if (P('stroke')) {
      const [w = 2, c = '#000'] = P('stroke').split(',')
      inner.style.webkitTextStroke = `${w}px ${c}`
      inner.style.paintOrder = 'stroke fill'
    }
    const bgopacity = parseFloat(P('bgopacity', '0'))
    if (bgopacity > 0) {
      const bg = P('bg', '#000000')
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(bg.slice(i, i + 2), 16) || 0)
      for (const el of [inner, meas]) {
        el.style.background = `rgba(${r},${g},${b},${bgopacity})`
        if (P('radius')) el.style.borderRadius = P('radius') + 'em'
        const [px = 0.3, py = 0.12] = P('boxpad', '0.3,0.12').split(',').map(parseFloat)
        el.style.padding = `${py}em ${px}em`
      }
    }

    function applyCase(str) {
      const c = P('case', '')
      if (c === 'upper') return str.toUpperCase()
      if (c === 'lower') return str.toLowerCase()
      if (c === 'title') return str.replace(/(^|[\s-])[a-z]/g, (m) => m.toUpperCase())
      return str
    }

    // sizing: fit (default) or manual (% of container height)
    const sizeParam = P('size', 'fit')
    const manual = sizeParam !== 'fit' && !Number.isNaN(parseFloat(sizeParam))
    let fitpad = Math.min(1, Math.max(0.1, parseFloat(P('fitpad', '0.94'))))
    if (P('digitstyle', '') === 'flip') fitpad *= 0.8
    let lastMeasured = null
    let fitTemplate = null

    function applyManual() {
      inner.style.fontSize = ((parseFloat(sizeParam) / 100) * (container.clientHeight || 1)) + 'px'
    }
    function fit(stateText) {
      if (manual) { applyManual(); return }
      const target = stateText ?? fitTemplate ?? inner.textContent
      const key = target + '|' + container.clientWidth + 'x' + container.clientHeight
      if (key === lastMeasured || !target) return
      lastMeasured = key
      meas.textContent = target
      const w = meas.offsetWidth
      const h = meas.offsetHeight
      if (!w || !h) return
      const scale = Math.min((container.clientWidth * fitpad) / w, (container.clientHeight * fitpad) / h)
      inner.style.fontSize = Math.max(4, 100 * scale) + 'px'
    }
    onResize.push(() => { lastMeasured = null; fit() })
    if (document.fonts?.ready) document.fonts.ready.then(() => { lastMeasured = null; fit() })

    function setText(t, isStateText = false) {
      if (inner.textContent !== t) { inner.textContent = t; fit(isStateText ? t : undefined) }
    }

    // ================= STATIC TEXT =================
    if (type === 'text') {
      const txt = applyCase(P('text', 'TEXT'))
      fitTemplate = txt
      setText(txt)
      return { feed() {}, destroy: destroyer(cleanups, container, null) }
    }

    // ================= TIMER =================
    const padFlag = (k, dflt) => {
      const v = params[k]
      if (v == null || v === '') return dflt
      return v === '1' || v === 'true'
    }
    const PADH = padFlag('padh', false)
    const PADM = padFlag('padm', false)
    const PADS = padFlag('pads', true)
    const pdd = (n, on) => String(Math.abs(Math.round(n))).padStart(on ? 2 : 1, '0')

    function fmt(n, flag) {
      if (P('format', 'digits') === 'words') return applyCase(words(n))
      const legacy = parseInt(P('pad', '0'), 10) || 0
      if (legacy) return String(Math.abs(Math.round(n))).padStart(legacy, '0')
      return flag === undefined ? String(Math.abs(Math.round(n))) : pdd(n, flag)
    }

    let timer = null
    let templateKey = ''

    function widestOf(strings) {
      mctx.font = `${italic} ${weight} 100px ${fontFamily}`
      let best = '', bw = -1
      for (const str of strings) {
        const w = mctx.measureText(str).width
        if (w > bw) { bw = w; best = str }
      }
      return best
    }
    const digitsTemplate = (n) => '8'.repeat(Math.max(1, n))

    function computeTemplate() {
      if (!timer) return null
      const wordsMode = P('format', 'digits') === 'words'
      const pad = parseInt(P('pad', '0'), 10) || 0
      const dl = (maxVal, flag) => Math.max(flag ? 2 : 1, String(maxVal).length, pad)
      const maxTotal = Math.ceil(Math.max(timer.duration ?? 0, Math.abs(timer.remaining ?? 0), 1))
      const maxH = Math.floor(maxTotal / 3600)
      const maxM = Math.floor((maxTotal % 3600) / 60)
      const range = (n) => Array.from({ length: n + 1 }, (_, i) => i)
      const sign = timer.remaining < 0 && P('overrun', 'negative') === 'negative' ? '+' : ''
      switch (part) {
        case 'minutes': {
          const top = Math.min(maxTotal >= 3600 ? 59 : maxM, 59)
          if (wordsMode) return sign + applyCase(widestOf(range(top).map(words)))
          return sign + digitsTemplate(dl(top, PADM))
        }
        case 'seconds':
          if (wordsMode) return sign + applyCase(widestOf(range(59).map(words)))
          return sign + digitsTemplate(dl(maxTotal < 10 ? maxTotal : 59, PADS))
        case 'hours':
          if (wordsMode) return sign + applyCase(widestOf(range(Math.max(maxH, 1)).map(words)))
          return sign + digitsTemplate(dl(Math.max(maxH, 1), PADH))
        case 'total-seconds':
          if (wordsMode) return null
          return sign + digitsTemplate(dl(maxTotal, false))
        case 'total-minutes':
          if (wordsMode) return sign + applyCase(widestOf(range(Math.max(Math.floor(maxTotal / 60), 1)).map(words)))
          return sign + digitsTemplate(dl(Math.max(Math.floor(maxTotal / 60), 1), false))
        case 'time': {
          if (wordsMode) {
            const wM = widestOf(range(Math.min(maxM, 59)).map(words))
            const wS = widestOf(range(59).map(words))
            const bits = []
            if (maxH > 0) bits.push(widestOf(range(maxH).map(words)), 'hours')
            if (maxTotal >= 60) bits.push(wM, 'minutes')
            bits.push(wS, 'seconds')
            return sign + applyCase(bits.join(' '))
          }
          if (maxH > 0) return sign + `${digitsTemplate(dl(maxH, PADH))}:88:88`
          return sign + `${digitsTemplate(dl(Math.max(maxM, 1), PADM))}:${digitsTemplate(dl(59, PADS))}`
        }
        default:
          return null
      }
    }

    function pickTimer(snap) {
      const want = P('timer', '')
      const list = snap.timers ?? []
      if (P('demo') === '1') return list.find((t) => t.name === 'demo') ?? list[0] ?? null
      if (want) return list.find((t) => t.name === want) ?? null
      return list.find((t) => t.state === 'running') ?? list[0] ?? null
    }
    function feed(snap) {
      const t = pickTimer(snap)
      timer = t ? { ...t, clientAt: Date.now() } : null
      const key = t ? `${t.name}|${t.duration}|${t.remaining < 0}` : ''
      if (key !== templateKey) {
        templateKey = key
        fitTemplate = computeTemplate()
        lastMeasured = null
      }
    }
    function liveRemaining() {
      if (!timer) return null
      if (timer.state !== 'running') return timer.remaining
      return timer.remaining - (Date.now() - timer.clientAt) / 1000
    }

    // Server values arrive in whole seconds, so raw interpolation snaps on
    // every update. Run a display clock at exactly 1s/s and slew it gently
    // onto the server value; only genuine jumps (reset/seek) snap.
    let disp = null
    let lastFrameT = performance.now()
    function smoothRemaining() {
      const target = liveRemaining()
      const now = performance.now()
      const dt = Math.min(0.25, (now - lastFrameT) / 1000)
      lastFrameT = now
      if (target == null) { disp = null; return null }
      if (disp == null || timer.state !== 'running') { disp = target; return disp }
      disp -= dt
      const err = target - disp
      if (Math.abs(err) > 1.5) disp = target
      else disp += err * Math.min(1, dt * 1.2)
      return disp
    }

    // ---- animated digit displays (digitstyle=roll|flip|rollstep) --------
    const ROW = 1.06 // em, matches line-height
    const digitStyle = P('format', 'digits') === 'digits' &&
      !['progress-bar', 'progress-ring'].includes(part) ? P('digitstyle', '') : ''
    let digitCols = null
    let digitPattern = ''

    // base = how many values this digit cycles through (6 for tens-of-sec),
    // scale = seconds per unit step of this digit (for constant roll)
    function columnSpecs(str) {
      const specs = []
      const fields = []
      if (part === 'time') {
        const parts = str.replace(/^\+/, '').split(':')
        const scales = parts.length === 3 ? [3600, 60, 1] : [60, 1]
        parts.forEach((f, fi) => fields.push({ text: f, scale: scales[fi], sixTens: scales[fi] !== 3600 }))
      } else {
        const scale = part === 'minutes' ? 60 : part === 'total-minutes' ? 60 : part === 'hours' ? 3600 : 1
        const sixTens = part === 'minutes' || part === 'seconds'
        fields.push({ text: str.replace(/^\+/, ''), scale, sixTens })
      }
      let chIdx = 0
      if (str.startsWith('+')) { specs.push({ static: '+' }); chIdx = 1 }
      fields.forEach((f, fi) => {
        if (fi > 0) specs.push({ static: ':' })
        const n = f.text.length
        for (let i = 0; i < n; i++) {
          const power = n - 1 - i
          const base = f.sixTens && power === 1 && n <= 2 ? 6 : 10
          specs.push({ base, scale: f.scale * Math.pow(10, power) })
        }
      })
      return specs
    }

    function buildDigits(str) {
      inner.textContent = ''
      inner.style.display = 'inline-flex'
      inner.style.alignItems = 'flex-start'
      digitCols = columnSpecs(str).map((spec) => {
        if (spec.static) {
          const el = document.createElement('span')
          el.style.display = 'inline-block'
          el.textContent = spec.static
          inner.appendChild(el)
          return { spec, el, static: true }
        }
        if (digitStyle === 'flip') return makeFlipCol(spec)
        return makeWheelCol(spec)
      })
    }

    function makeWheelCol(spec) {
      const col = document.createElement('span')
      col.style.display = 'inline-block'
      col.style.width = '1ch'
      col.style.height = ROW + 'em'
      col.style.overflow = 'hidden'
      col.style.position = 'relative'
      const strip = document.createElement('div')
      strip.style.position = 'absolute'
      strip.style.left = '0'; strip.style.right = '0'; strip.style.top = '0'
      strip.style.willChange = 'transform'
      for (let band = 0; band < 3; band++) {
        for (let d = 0; d < spec.base; d++) {
          const row = document.createElement('div')
          row.style.height = ROW + 'em'
          row.style.lineHeight = ROW + 'em'
          row.style.textAlign = 'center'
          row.textContent = String(d)
          strip.appendChild(row)
        }
      }
      col.appendChild(strip)
      inner.appendChild(col)
      return { spec, strip, virtual: null, anim: null, lastTarget: null }
    }

    function makeFlipCol(spec) {
      const col = document.createElement('span')
      col.style.display = 'inline-block'
      col.style.width = '1.22ch'
      col.style.height = ROW + 'em'
      col.style.position = 'relative'
      col.style.margin = '0 0.03em'
      col.style.borderRadius = '0.07em'
      col.style.background = bgopacity > 0 ? inner.style.background : 'rgba(10,12,16,0.85)'
      col.style.boxShadow = 'inset 0 -1px 0 rgba(255,255,255,0.06), inset 0 1px 0 rgba(255,255,255,0.1)'
      const mkHalf = (topHalf) => {
        const h = document.createElement('div')
        h.style.position = 'absolute'; h.style.inset = '0'
        h.style.textAlign = 'center'; h.style.lineHeight = ROW + 'em'
        h.style.clipPath = topHalf ? 'inset(0 0 50% 0)' : 'inset(50% 0 0 0)'
        return h
      }
      const topNew = mkHalf(true)
      const botOld = mkHalf(false)
      // Single flap, two phases: old top half folds down to 90deg, then the
      // content + clip swap and the new bottom half folds the rest of the
      // way. No backfaces/preserve-3d (clip-path would flatten them anyway).
      const flap = mkHalf(true)
      flap.style.willChange = 'transform'
      flap.style.transformOrigin = '50% 50%'
      flap.style.display = 'none'
      flap.style.background = col.style.background
      flap.style.borderRadius = col.style.borderRadius
      // hairline across the middle
      const line = document.createElement('div')
      line.style.position = 'absolute'; line.style.left = '0'; line.style.right = '0'
      line.style.top = '50%'; line.style.height = '1px'
      line.style.background = 'rgba(0,0,0,0.5)'
      col.appendChild(botOld); col.appendChild(topNew); col.appendChild(flap); col.appendChild(line)
      inner.appendChild(col)
      return { spec, topNew, botOld, flap, cur: null, flipping: false, pending: null }
    }

    function runFlip(col) {
      const target = col.pending
      if (target == null || col.botOld.textContent === target) { col.flipping = false; return }
      col.flipping = true
      const oldCh = col.botOld.textContent
      // phase 1: old digit's top half folds down to the horizon
      col.flap.style.clipPath = 'inset(0 0 50% 0)'
      col.flap.textContent = oldCh
      col.flap.style.display = ''
      const a = col.flap.animate(
        [{ transform: 'perspective(2.6em) rotateX(0deg)' }, { transform: 'perspective(2.6em) rotateX(-90deg)' }],
        { duration: 200, easing: 'ease-in' }
      )
      a.onfinish = () => {
        // phase 2: new digit's bottom half folds down from the horizon
        col.flap.style.clipPath = 'inset(50% 0 0 0)'
        col.flap.textContent = target
        const b = col.flap.animate(
          [{ transform: 'perspective(2.6em) rotateX(90deg)' }, { transform: 'perspective(2.6em) rotateX(0deg)' }],
          { duration: 220, easing: 'ease-out' }
        )
        b.onfinish = () => {
          col.botOld.textContent = target
          col.flap.style.display = 'none'
          runFlip(col) // catch up if another change queued mid-flip
        }
      }
    }

    function shortestDelta(from, to, base) {
      let d = (to - from) % base
      if (d > base / 2) d -= base
      if (d < -base / 2) d += base
      return d
    }
    const easeOut = (t) => 1 - Math.pow(1 - t, 3)

    function updateDigits(str, V) {
      const pattern = str.replace(/\d/g, '#')
      if (!digitCols || pattern !== digitPattern) {
        digitPattern = pattern
        buildDigits(str)
      }
      const chars = str.split('')
      let ci = 0
      for (const col of digitCols) {
        if (col.static) { col.el.textContent = chars[ci]; ci++; continue }
        const ch = chars[ci]; ci++
        const val = parseInt(ch, 10) || 0
        const { base, scale } = col.spec

        if (digitStyle === 'roll') {
          // Odometer: this digit rolls during the final second before it
          // changes (in sync with the digit below wrapping); the fastest
          // digit (scale=1) rolls continuously.
          const u = V / scale
          const f = u - Math.floor(u)
          const w = Math.min(1, 1 / scale)
          const D = ((Math.floor(u) % base) + base) % base
          const pos = f < w ? D - (1 - f / w) : D
          const posMod = ((pos % base) + base) % base
          col.strip.style.transform = `translateY(${-(base + posMod) * ROW}em)`
        } else if (digitStyle === 'rollstep') {
          if (col.virtual == null) { col.virtual = val; col.lastTarget = val }
          if (val !== col.lastTarget) {
            col.anim = { from: col.virtual, to: col.virtual + shortestDelta(col.lastTarget, val, base), start: performance.now() }
            col.lastTarget = val
          }
          if (col.anim) {
            const t = Math.min(1, (performance.now() - col.anim.start) / 320)
            col.virtual = col.anim.from + (col.anim.to - col.anim.from) * easeOut(t)
            if (t >= 1) { col.virtual = col.anim.to; col.anim = null }
          }
          const pos = ((col.virtual % base) + base) % base
          col.strip.style.transform = `translateY(${-(base + pos) * ROW}em)`
        } else if (digitStyle === 'flip') {
          if (col.cur == null) {
            col.cur = val
            col.topNew.textContent = ch; col.botOld.textContent = ch
          } else if (val !== col.cur) {
            col.cur = val
            col.pending = ch
            col.topNew.textContent = ch
            if (!col.flipping) runFlip(col)
          }
        }
      }
    }

    function plainShow(t, isStateText = false) {
      if (digitCols) {
        digitCols = null
        digitPattern = ''
        inner.style.display = 'inline-block'
        inner.textContent = ''
      }
      setText(t, isStateText)
    }
    function digitShow(str, V) {
      updateDigits(str, V)
      fit()
    }
    const show = (str, V) => (digitStyle ? digitShow(str, V) : setText(str))

    let barEl = null, ringEl = null
    function progress(r) {
      // Explicit total (seconds) beats API/inferred duration - the reliable
      // choice for countdown-to-time timers with a known window.
      const dur = parseFloat(P('duration', '0')) || timer?.duration
      if (!dur) return 0
      return Math.min(1, Math.max(0, r / dur))
    }
    function renderBar(r) {
      if (!barEl) {
        inner.remove()
        barEl = document.createElement('div')
        barEl.style.position = 'absolute'
        barEl.style.left = '0'; barEl.style.top = '0'; barEl.style.bottom = '0'
        barEl.style.transformOrigin = 'left center'
        barEl.style.background = P('color', '#ffffff')
        barEl.style.width = '100%'
        animWrap.appendChild(barEl)
        const update = () => {
          const rad = parseFloat(P('radius', '0'))
          if (rad) barEl.style.borderRadius = ((rad / 100) * (container.clientHeight || 1)) + 'px'
        }
        update(); onResize.push(update)
      }
      const p = progress(r)
      barEl.style.transform = P('direction', 'ltr') === 'rtl' ? `scaleX(${1 - p})` : `scaleX(${p})`
    }
    function renderRing(r) {
      if (!ringEl) {
        inner.remove()
        const thickness = parseFloat(P('thickness', '8'))
        const ns = 'http://www.w3.org/2000/svg'
        const svg = document.createElementNS(ns, 'svg')
        svg.setAttribute('viewBox', '0 0 100 100')
        svg.setAttribute('preserveAspectRatio', 'xMidYMid meet')
        svg.style.position = 'absolute'; svg.style.inset = '0'
        svg.style.width = '100%'; svg.style.height = '100%'
        const track = document.createElementNS(ns, 'circle')
        for (const [k, v] of [['cx', 50], ['cy', 50], ['r', 44], ['fill', 'none'], ['stroke', 'rgba(255,255,255,0.15)'], ['stroke-width', thickness]]) track.setAttribute(k, v)
        const arc = document.createElementNS(ns, 'circle')
        for (const [k, v] of [['cx', 50], ['cy', 50], ['r', 44], ['fill', 'none'], ['stroke', P('color', '#ffffff')], ['stroke-width', thickness], ['stroke-linecap', 'round'], ['stroke-dasharray', 2 * Math.PI * 44], ['transform', 'rotate(-90 50 50)']]) arc.setAttribute(k, v)
        svg.appendChild(track); svg.appendChild(arc)
        animWrap.appendChild(svg)
        ringEl = arc
      }
      ringEl.style.strokeDashoffset = String(2 * Math.PI * 44 * (1 - progress(r)))
    }

    let raf = null
    function render() {
      raf = requestAnimationFrame(render)
      const rem = smoothRemaining()
      inner.style.visibility = ''
      if (rem == null) { setText(''); return }

      const stoppedMode = P('stopped', 'hold')
      if (timer.state === 'stopped' && stoppedMode === 'hide') { inner.style.visibility = 'hidden'; return }

      let r = rem
      const over = r < 0
      if (over) {
        const om = P('overrun', 'negative')
        if (om === 'hide') { inner.style.visibility = 'hidden'; return }
        if (om === 'zero') r = 0
      }
      if (r <= 0 && P('zero', '') && P('overrun', 'negative') !== 'negative') { plainShow(P('zero'), true); return }
      if (r <= 0 && !over && P('zero', '')) { plainShow(P('zero'), true); return }
      if (timer.state === 'stopped' && stoppedMode === 'dash') { plainShow('–', true); return }

      const total = Math.ceil(Math.abs(Math.max(r, over ? r : 0)))
      const h = Math.floor(total / 3600)
      const m = Math.floor((total % 3600) / 60)
      const sec = total % 60
      const sign = over && P('overrun', 'negative') === 'negative' ? '+' : ''

      const Vc = Math.abs(r)
      switch (part) {
        case 'minutes': show(sign + fmt(m, PADM), Vc); break
        case 'seconds': show(sign + fmt(sec, PADS), Vc); break
        case 'hours': show(sign + fmt(h, PADH), Vc); break
        case 'total-seconds': show(sign + fmt(total), Vc); break
        case 'total-minutes': show(sign + fmt(Math.floor(total / 60)), Vc); break
        case 'progress-bar': renderBar(r); break
        case 'progress-ring': renderRing(r); break
        case 'time':
        default: {
          if (P('format', 'digits') === 'words') {
            const bits = []
            if (h > 0) bits.push(words(h), h === 1 ? 'hour' : 'hours')
            if (m > 0 || h > 0) bits.push(words(m), m === 1 ? 'minute' : 'minutes')
            bits.push(words(sec), sec === 1 ? 'second' : 'seconds')
            setText(sign + applyCase(bits.join(' ')))
          } else {
            const str = h > 0
              ? sign + `${pdd(h, PADH)}:${pdd(m, true)}:${pdd(sec, PADS)}`
              : sign + `${pdd(m, PADM)}:${pdd(sec, PADS)}`
            show(str, Vc)
          }
        }
      }
    }
    render()

    return { feed, destroy: destroyer(cleanups, container, () => cancelAnimationFrame(raf)) }
  }

  function destroyer(cleanups, container, extra) {
    return () => {
      if (extra) extra()
      cleanups.forEach((f) => f())
      container.replaceChildren()
    }
  }

  return { create, ANIMS }
})()
