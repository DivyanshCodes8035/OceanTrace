/* WakeTrace · Response exercise · Ennore (illustrative simulation on a historical photo)
   Self-contained. Overlay coordinates live in the 618×606 viewBox of the after-spill image. */
(() => {
'use strict';
const NS = 'http://www.w3.org/2000/svg', W = 618, H = 606, FR = 480, FPS = 18, SPD = .4;
const $ = s => document.querySelector(s);
const launchButton = $('#launch-demo'), workspace = $('#simulation-workspace');
launchButton.addEventListener('click', () => {
  workspace.hidden = false;
  launchButton.textContent = 'Demo started';
  launchButton.disabled = true;
  workspace.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
});
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const el = (t, a, p) => { const n = document.createElementNS(NS, t); for (const k in a) n.setAttribute(k, a[k]); if (p) p.appendChild(n); return n; };
const rad = d => d * Math.PI / 180, copy = o => JSON.parse(JSON.stringify(o));
const RM = matchMedia('(prefers-reduced-motion: reduce)');
const svg = $('#scene-svg'), scene = $('#scene');
const G = { oil: $('#g-oil'), out: $('#g-out'), flow: $('#g-flow'), boom: $('#g-boom'), eq: $('#g-eq') };

const DEF_OUT = [[205,263],[262,236],[345,220],[450,222],[540,245],[592,290],[608,358],[575,388],[533,380],[512,430],[532,480],[540,520],[505,560],[440,552],[385,572],[378,520],[425,462],[372,412],[352,350],[385,288],[300,262],[232,300]];
const TITLES = ['Mark the apparent slick','Set water movement conditions','Simulate containment booms','Position skimmers and sorbents','Replay the illustrative cleanup'];
const BADGES = ['Estimated slick boundary · your estimate','Drift assumed · illustrative arrows','Boom placement example · illustrative','Equipment at the front end · illustrative','Cleanup replay · illustrative only'];
const S = { step:0, out:copy(DEF_OUT), dir:285, eq:null, eqKey:'', eqCustom:false, sel:-1, use:{boom:true,skim:true,sorb:true}, f:0, playing:false, dirty:true };
let K = 1, mask = null, drag = null, focusKey = null, sim = null, parts = [], lastStatus = '', geoC = null;

/* ---------- Step 0 (hidden): turn the photo into a map-style render ---------- */
const photo = $('#photo'), canvas = $('#map-canvas');
function buildMap() {
  const cw = 309, ch = 303, c = document.createElement('canvas'); c.width = cw; c.height = ch;
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(photo, 0, 0, cw, ch);
  let d; try { d = g.getImageData(0, 0, cw, ch); } catch (e) { return fail(); }
  const p = d.data, n = cw * ch, lum = new Float32Array(n), cls = new Int8Array(n);
  for (let i = 0; i < n; i++) { lum[i] = .3*p[i*4] + .59*p[i*4+1] + .11*p[i*4+2]; cls[i] = Math.min(p[i*4], p[i*4+1], p[i*4+2]) > 185 ? -1 : 9; } // -1 cloud, 9 undecided
  const flood = (sx, sy, th) => { const st = [Math.floor(sy*ch)*cw + Math.floor(sx*cw)];
    while (st.length) { const i = st.pop(); if (i < 0 || i >= n || cls[i] !== 9 || lum[i] >= th) continue; cls[i] = 0; const x = i % cw; if (x > 0) st.push(i-1); if (x < cw-1) st.push(i+1); st.push(i-cw, i+cw); } };
  [[.92,.12],[.85,.85],[.62,.5],[.8,.4]].forEach(s => flood(s[0], s[1], 105)); flood(.41, .35, 135);
  for (let i = 0; i < n; i++) if (cls[i] === 9) { const r = p[i*4], gg = p[i*4+1], b = p[i*4+2]; cls[i] = (r - b > 38 && lum[i] > 130) ? 1 : (gg > r + 6 && gg > b + 6) ? 2 : 3; }
  // cloud-covered pixels are filled in from their neighbours (no data under cloud)
  for (let pass = 0, left = 1; pass < 80 && left; pass++) { left = 0; const c2 = cls.slice(), l2 = lum.slice();
    for (let i = 0; i < n; i++) if (cls[i] < 0) { const x = i % cw, nb = [x > 0 ? i-1 : -1, x < cw-1 ? i+1 : -1, i-cw, i+cw]; let ok = false;
      for (const j of nb) if (j >= 0 && j < n && cls[j] >= 0) { c2[i] = cls[j]; l2[i] = lum[j]; ok = true; break; } if (!ok) left++; }
    cls.set(c2); lum.set(l2); }
  const o = g.createImageData(cw, ch), q = o.data, water = new Uint8Array(n);
  for (let i = 0; i < n; i++) { const k = cls[i], l = lum[i], x = i % cw; let R, Gc, B;
    if (k === 0) { water[i] = 1; const coast = (x > 0 && cls[i-1] > 0) || (x < cw-1 && cls[i+1] > 0) || (i >= cw && cls[i-cw] > 0) || (i < n-cw && cls[i+cw] > 0);
      if (coast) { R = 96; Gc = 121; B = 135; } else { R = 118 + l*.12; Gc = 142 + l*.12; B = 154 + l*.1; } }
    else if (k === 1) { R = 198; Gc = 186; B = 148; }
    else if (k === 2) { R = 128; Gc = 151; B = 134; }
    else { const v = .9 + .28 * clamp(l/255, 0, 1); R = 168*v; Gc = 162*v; B = 148*v; }
    q[i*4] = R; q[i*4+1] = Gc; q[i*4+2] = B; q[i*4+3] = 255; }
  g.putImageData(o, 0, 0);
  const x = canvas.getContext('2d'); x.imageSmoothingQuality = 'high'; x.filter = 'blur(.6px)'; x.drawImage(c, 0, 0, W, H); x.filter = 'none';
  x.font = 'italic 15px "Segoe UI",sans-serif'; x.fillStyle = 'rgba(40,62,78,.95)'; x.fillText('Bay of Bengal', 470, 120);
  x.font = '12px "Segoe UI",sans-serif'; x.fillStyle = 'rgba(38,38,38,.9)'; x.fillText('Ennore', 232, 372);
  const sw = photo.naturalWidth, sh = photo.naturalHeight; // keep the photo's own source marks
  [[.64,0,.36,.105],[.64,.92,.28,.08]].forEach(r => x.drawImage(photo, r[0]*sw, r[1]*sh, r[2]*sw, r[3]*sh, r[0]*W, r[1]*H, r[2]*W, r[3]*H));
  mask = { w: cw, h: ch, d: water };
  $('#map-note').textContent = 'Map-style render is generated in your browser from the photo’s colours. Cloud-covered areas are filled in from neighbouring pixels. It is a visual aid, not survey data.';
}
function fail() { setBase('photo'); $('[data-base="map"]').disabled = true; $('#map-note').textContent = 'Map-style render needs the page served over http(s). Showing the source photo instead.'; }
const isWater = (x, y) => mask ? !!mask.d[clamp(Math.floor(y/H*mask.h),0,mask.h-1)*mask.w + clamp(Math.floor(x/W*mask.w),0,mask.w-1)] : x > 335;
function setBase(b) { scene.dataset.base = b; document.querySelectorAll('.seg-btn').forEach(x => { const on = x.dataset.base === b; x.classList.toggle('on', on); x.setAttribute('aria-pressed', on); }); }
if (photo.complete && photo.naturalWidth) buildMap(); else { photo.addEventListener('load', buildMap); photo.addEventListener('error', () => { $('#map-note').textContent = 'Could not load ennore-2023-scene.png.'; }); }

/* ---------- geometry ---------- */
function smooth(P) { const n = P.length; let d = `M${P[0][0].toFixed(1)},${P[0][1].toFixed(1)}`;
  for (let i = 0; i < n; i++) { const a = P[(i-1+n)%n], b = P[i], c = P[(i+1)%n], e = P[(i+2)%n];
    d += `C${(b[0]+(c[0]-a[0])/6).toFixed(1)},${(b[1]+(c[1]-a[1])/6).toFixed(1)} ${(c[0]-(e[0]-b[0])/6).toFixed(1)},${(c[1]-(e[1]-b[1])/6).toFixed(1)} ${c[0].toFixed(1)},${c[1].toFixed(1)}`; } return d + 'Z'; }
function dense(P) { const n = P.length, out = [];
  for (let i = 0; i < n; i++) { const a = P[(i-1+n)%n], b = P[i], c = P[(i+1)%n], e = P[(i+2)%n];
    const c1 = [b[0]+(c[0]-a[0])/6, b[1]+(c[1]-a[1])/6], c2 = [c[0]-(e[0]-b[0])/6, c[1]-(e[1]-b[1])/6];
    for (let t = 0; t < 1; t += .125) { const u = 1-t; out.push([u*u*u*b[0]+3*u*u*t*c1[0]+3*u*t*t*c2[0]+t*t*t*c[0], u*u*u*b[1]+3*u*u*t*c1[1]+3*u*t*t*c2[1]+t*t*t*c[1]]); } } return out; }
const inPoly = (x, y, P) => { let r = false; for (let i = 0, j = P.length-1; i < P.length; j = i++) if ((P[i][1] > y) !== (P[j][1] > y) && x < (P[j][0]-P[i][0])*(y-P[i][1])/(P[j][1]-P[i][1])+P[i][0]) r = !r; return r; };
const rng = s => () => { s |= 0; s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const vec = b => [Math.sin(rad(b)), -Math.cos(rad(b))];
const COMP = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'], card = b => COMP[Math.round(b/22.5) % 16];
function geo() { // leading edge, boom ring, all derived from outline + drift direction
  const key = JSON.stringify([S.out, S.dir]); if (geoC && geoC.key === key) return geoC;
  const poly = dense(S.out), n = poly.length, d = vec(S.dir); let F = poly[0], best = -1e9;
  poly.forEach(q => { const s = q[0]*d[0] + q[1]*d[1]; if (s > best) { best = s; F = q; } });
  let area = 0; for (let i = 0; i < n; i++) { const j = (i+1) % n; area += poly[i][0]*poly[j][1] - poly[j][0]*poly[i][1]; } const sg = area > 0 ? 1 : -1;
  let ring = poly.map((q, i) => { const a = poly[(i-1+n)%n], b = poly[(i+1)%n]; let tx = b[0]-a[0], ty = b[1]-a[1]; const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l; return [q[0] + sg*ty*13, q[1] - sg*tx*13]; });
  for (let pass = 0; pass < 3; pass++) ring = ring.map((q, i) => { let x = 0, y = 0; for (let k = -2; k <= 2; k++) { const r = ring[(i+k+n)%n]; x += r[0]; y += r[1]; } return [x/5, y/5]; });
  return geoC = { key, poly, F, d, p: [-d[1], d[0]], ring };
}
function resample(P, sp) { const n = P.length, cum = [0]; for (let i = 0; i < n; i++) { const b = P[(i+1)%n]; cum.push(cum[i] + Math.hypot(b[0]-P[i][0], b[1]-P[i][1])); }
  const L = cum[n], N = Math.max(8, Math.round(L / sp)), out = []; let k = 0;
  for (let i = 0; i < N; i++) { const s = L * i / N; while (cum[k+1] < s) k++; const a = P[k], b = P[(k+1)%n], t = (s - cum[k]) / ((cum[k+1] - cum[k]) || 1); out.push([a[0] + (b[0]-a[0])*t, a[1] + (b[1]-a[1])*t]); } return out; }
function defaultEq() { const g = geo();
  return [['skimmer',24,0],['sorbent',52,-22],['sorbent',52,22],['skimmer',82,0],['sorbent',110,0]].map(([t, a, l]) => { let x, y;
    for (let k = 0; k < 5; k++) { x = g.F[0] - g.d[0]*a + g.p[0]*l; y = g.F[1] - g.d[1]*a + g.p[1]*l; if (inPoly(x, y, g.poly)) break; l *= .6; }
    return { t, x: clamp(x, 10, W-10), y: clamp(y, 10, H-10) }; }); }
function ensureEq() { const key = JSON.stringify([S.out, S.dir]); if (!S.eq || (!S.eqCustom && S.eqKey !== key)) { S.eq = defaultEq(); S.eqKey = key; } }

/* ---------- dragging (outline handles, equipment markers) ---------- */
const getPos = (k, i) => k === 'o' ? S.out[i] : [S.eq[i].x, S.eq[i].y];
function setPos(k, i, x, y) { x = clamp(x, 8, W-8); y = clamp(y, 8, H-8);
  if (k === 'o') { S.out[i] = [x, y]; S.dirty = true; rOut(); } else { S.eq[i].x = x; S.eq[i].y = y; S.eqCustom = true; S.dirty = true; rEq(); }
  if ($('#alert-preview') && !$('#alert-preview').hidden) updateAlertDraft(); }
const toView = e => { const r = svg.getBoundingClientRect(); return [(e.clientX - r.left)/r.width*W, (e.clientY - r.top)/r.height*H]; };
function makeDraggable(node, k, i) {
  node.dataset.key = k + i;
  node.addEventListener('pointerdown', e => { e.preventDefault(); drag = { k, i }; focusKey = k + i; svg.setPointerCapture(e.pointerId); });
  node.addEventListener('keydown', e => { const st = e.shiftKey ? 12 : 4, m = { ArrowLeft:[-st,0], ArrowRight:[st,0], ArrowUp:[0,-st], ArrowDown:[0,st] }[e.key];
    if (m) { e.preventDefault(); const p = getPos(k, i); focusKey = k + i; setPos(k, i, p[0]+m[0], p[1]+m[1]); } });
}
svg.addEventListener('pointermove', e => { if (!drag) return; const p = toView(e); setPos(drag.k, drag.i, p[0], p[1]); });
['pointerup','pointercancel'].forEach(t => svg.addEventListener(t, () => { drag = null; }));
const restoreFocus = g => { if (focusKey && !drag) { const n = g.querySelector(`[data-key="${focusKey}"]`); if (n && document.activeElement !== n) n.focus({ preventScroll: true }); } };

/* ---------- renderers ---------- */
function rOut() {
  const g = G.out; g.replaceChildren(); const d = smooth(S.out);
  el('path', { d, class: 'out-fill' }, g); el('path', { d, class: 'out-halo' }, g); el('path', { d, class: 'out-line' }, g);
  if (S.step === 0) S.out.forEach((_, i) => { const [x, y] = S.out[i], n = el('g', { transform: `translate(${x} ${y})`, class: 'hnd', tabindex: 0, role: 'button', 'aria-label': `Boundary handle ${i+1} of ${S.out.length}. Arrow keys move it.` }, g);
    el('circle', { r: 20*K, fill: 'transparent' }, n); el('circle', { r: 6.5*K, class: 'hv' }, n); makeDraggable(n, 'o', i); });
  restoreFocus(g);
}
function rFlow() { // two or three arrows at the leading edge only
  const g = G.flow; g.replaceChildren(); if (S.step < 1 || S.step > 3) return; g.setAttribute('opacity', S.step === 1 ? 1 : .6);
  const f = geo(), ang = Math.atan2(f.d[1], f.d[0]) * 180 / Math.PI, dur = (1.8 / (.25 + SPD)).toFixed(2) + 's';
  [[-36,100,22,7],[0,128,40,-3],[36,90,14,10]].forEach(([lat, L, ahead, jit]) => {
    const x = f.F[0] + f.d[0]*ahead + f.p[0]*lat, y = f.F[1] + f.d[1]*ahead + f.p[1]*lat, hl = 16*K, p = `M${-L},0 L${-hl},0`;
    const n = el('g', { transform: `translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${(ang + jit).toFixed(1)})`, style: `--dur:${dur}` }, g);
    el('path', { d: p, class: 'flow-halo' }, n); el('path', { d: p, class: 'flow-dash' }, n); el('path', { d: `M0,0 L${-hl},${-9*K} L${-hl},${9*K}Z`, class: 'flow-head' }, n); });
}
function rBoom() { // closed ring of linked boom sections around the whole patch
  const g = G.boom; g.replaceChildren(); if (S.step < 2 || (S.step === 4 && !S.use.boom)) return;
  const f = geo(), pts = resample(f.ring, 19 * Math.max(1, K * .9)), n = pts.length;
  el('path', { d: 'M' + pts.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join('L') + 'Z', class: 'boom-shadow' }, g);
  pts.forEach((a, i) => { const b = pts[(i+1)%n], dx = b[0]-a[0], dy = b[1]-a[1], len = Math.hypot(dx, dy);
    el('rect', { x: -len*.46, y: -4*K, width: len*.92, height: 8*K, rx: 4*K, class: 'boom-seg', transform: `translate(${((a[0]+b[0])/2).toFixed(1)} ${((a[1]+b[1])/2).toFixed(1)}) rotate(${(Math.atan2(dy, dx)*180/Math.PI).toFixed(1)})` }, g); });
  pts.forEach(a => el('circle', { cx: a[0].toFixed(1), cy: a[1].toFixed(1), r: 2.4*K, class: 'boom-conn' }, g));
}
function rEq() {
  const g = G.eq; g.replaceChildren(); if (S.step < 3) return; ensureEq();
  const cnt = { skimmer: 0, sorbent: 0 }, interactive = S.step === 3;
  S.eq.forEach((q, i) => { const sk = q.t === 'skimmer', name = `${sk ? 'Skimmer' : 'Sorbent'} ${++cnt[q.t]}`, off = S.step === 4 && !(sk ? S.use.skim : S.use.sorb);
    const n = el('g', { transform: `translate(${q.x} ${q.y})`, class: `eq ${sk ? 'skim' : 'sorb'}${off ? ' off' : ''}${interactive ? '' : ' static'}` }, g);
    if (interactive) { n.setAttribute('tabindex', 0); n.setAttribute('role', 'button'); n.setAttribute('aria-label', `${name} at the front end. Arrow keys move it.`); }
    const s = el('g', { transform: `scale(${K})` }, n); el('circle', { r: 22, fill: 'transparent' }, s); el('circle', { r: 14, class: 'pulse' }, s);
    if (sk) { el('rect', { x: -13, y: -10, width: 26, height: 20, rx: 5, class: 'sh' }, s); el('path', { d: 'M-13,-4 L-20,0 L-13,4Z', class: 'sh' }, s); }
    else { el('circle', { r: 12, class: 'sh' }, s); el('circle', { r: 7, fill: 'none', stroke: '#2a0f45', 'stroke-width': 1, 'stroke-dasharray': '2 2' }, s); }
    el('text', { class: 'ini', y: 5 }, s).textContent = sk ? 'S' : 'A'; el('text', { class: 'lbl', x: 18, y: -12 }, s).textContent = name;
    if (interactive) makeDraggable(n, 'e', i); });
  restoreFocus(g);
}

/* ---------- replay simulation (illustrative, deterministic) ---------- */
function simulate() {
  const g = geo(); ensureEq(); const CS = 6, gw = Math.ceil(W/CS), gh = Math.ceil(H/CS), boom = S.use.boom, ok = new Uint8Array(gw*gh);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) { const cx = (x+.5)*CS, cy = (y+.5)*CS; ok[y*gw+x] = boom ? +inPoly(cx, cy, g.ring) : +(isWater(cx, cy) || inPoly(cx, cy, g.poly)); }
  const act = S.eq.filter(q => q.t === 'skimmer' ? S.use.skim : S.use.sorb), tg = act.length ? act.map(q => [q.x, q.y]) : [[g.F[0]-g.d[0]*8, g.F[1]-g.d[1]*8]];
  const dist = new Float32Array(gw*gh).fill(1e9), Q = [];
  tg.forEach(t => { const i = clamp(Math.floor(t[1]/CS), 0, gh-1)*gw + clamp(Math.floor(t[0]/CS), 0, gw-1); ok[i] = 1; dist[i] = 0; Q.push(i); });
  for (let h = 0; h < Q.length; h++) { const i = Q[h], x = i % gw, y = (i/gw)|0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { if (!dx && !dy) continue; const nx = x+dx, ny = y+dy; if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
      const j = ny*gw+nx; if (!ok[j]) continue; const nd = dist[i] + (dx && dy ? 1.414 : 1); if (nd < dist[j] - 1e-6) { dist[j] = nd; Q.push(j); } } }
  const dirAt = (px, py) => { const cx = clamp(Math.floor(px/CS), 0, gw-1), cy = clamp(Math.floor(py/CS), 0, gh-1), d0 = dist[cy*gw+cx]; let vx = 0, vy = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { if (!dx && !dy) continue; const nx = cx+dx, ny = cy+dy; if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue; const dj = dist[ny*gw+nx]; if (dj < d0) { vx += dx*(d0-dj); vy += dy*(d0-dj); } }
    const l = Math.hypot(vx, vy); return l ? [vx/l, vy/l] : null; };
  const r = rng(7), nz = rng(99), P = [], N = 300, xs = g.poly.map(p => p[0]), ys = g.poly.map(p => p[1]), x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  for (let k = 0; P.length < N && k < 9000; k++) { const x = x0 + r()*(x1-x0), y = y0 + r()*(y1-y0); if (inPoly(x, y, g.poly)) P.push({ x, y, m: 1, r: 9 + r()*5, v: .8 + r()*.4, leak: !boom && r() < .35 }); }
  // Give each particle a nearby recovery point while balancing assignments
  // across all active units. This keeps one marker from acting like a global vacuum.
  const recoveryLoad = new Array(act.length).fill(0);
  if (act.length) P.forEach(p => {
    const order = act.map((q, i) => ({ i, d: Math.hypot(q.x-p.x, q.y-p.y) }))
      .sort((a, b) => a.d - b.d || recoveryLoad[a.i] - recoveryLoad[b.i]);
    const minLoad = Math.min(...recoveryLoad);
    const choice = order.find(c => recoveryLoad[c.i] <= minLoad + 1) || order[0];
    p.collector = choice.i; recoveryLoad[choice.i] += 1;
  });
  const frames = [];
  for (let f = 0; f < FR; f++) { const fr = new Float32Array(P.length*3);
    P.forEach((p, i) => { if (p.m > 0) { let mx = 0, my = 0;
        const target = act.length ? act[p.collector] : null;
        if (p.leak) { mx = g.d[0]; my = g.d[1]; } else if (target) { const tx=target.x-p.x, ty=target.y-p.y, tl=Math.hypot(tx,ty); if(tl>10){mx=tx/tl;my=ty/tl;} }
        else { const d = dirAt(p.x, p.y); if (d) { mx = d[0]; my = d[1]; } }
        const nx = p.x + mx*1.5*p.v + (nz()-.5)*.5, ny = p.y + my*1.5*p.v + (nz()-.5)*.5;
        if (boom ? inPoly(nx, ny, g.ring) : (isWater(nx, ny) || inPoly(nx, ny, g.poly))) { p.x = clamp(nx, 4, W-4); p.y = clamp(ny, 4, H-4); }
        if (target) {
          const distance = Math.hypot(target.x-p.x, target.y-p.y);
          // Each unit has a local pickup radius and its own gradual uptake.
          const pickupRadius = target.t === 'skimmer' ? 19 : 14;
          if (distance < pickupRadius) p.m -= target.t === 'skimmer' ? .018 : .012;
        }
        p.m = Math.max(0, p.m); }
      fr[i*3] = p.x; fr[i*3+1] = p.y; fr[i*3+2] = p.m; });
    frames.push(fr); }
  sim = { frames, radii: P.map(p => p.r) }; G.oil.replaceChildren();
  const gg = el('g', { filter: 'url(#goo)', opacity: .86 }, G.oil); parts = P.map(() => el('circle', { fill: '#000' }, gg)); S.dirty = false;
}
function rFrame() {
  if (!sim) return; const i0 = Math.floor(S.f), i1 = Math.min(i0+1, FR-1), a = S.f - i0, A = sim.frames[i0], B = sim.frames[i1];
  parts.forEach((c, i) => { const m = A[i*3+2] + (B[i*3+2]-A[i*3+2])*a;
    c.setAttribute('cx', (A[i*3] + (B[i*3]-A[i*3])*a).toFixed(1)); c.setAttribute('cy', (A[i*3+1] + (B[i*3+1]-A[i*3+1])*a).toFixed(1));
    c.setAttribute('r', (sim.radii[i]*Math.sqrt(m)*1.15).toFixed(1)); c.setAttribute('opacity', m < .04 ? 0 : 1); });
  G.eq.querySelectorAll('.eq').forEach(n => n.classList.toggle('work', S.playing && !n.classList.contains('off')));
  $('#scrub').value = Math.floor(S.f);
  const u = S.f/(FR-1), bm = S.use.boom, eq = (S.use.skim && S.eq.some(q => q.t === 'skimmer')) || (S.use.sorb && S.eq.some(q => q.t === 'sorbent')); let msg;
  if (S.f <= 0) msg = 'Ready. The dark patch starts at your estimated outline' + (bm ? ', held inside the boom.' : ', with no boom.');
  else if (u < .2) msg = 'The patch begins to move ahead toward its leading edge, the direction of the assumed drift.';
  else if (u < .6) msg = eq ? 'Oil reaches the front end, where skimmers and sorbents recover it first so less is pushed onward.' : 'No recovery equipment enabled: oil bunches up at the leading edge and keeps pressing onward.';
  else if (u < .97) msg = (bm ? 'The boom keeps the oil together while the ' : 'Without a boom, oil spreads out while the ') + (eq ? 'back of the patch thins out as oil is drawn forward and recovered. Used sorbent must be handled as contaminated waste.' : 'back empties toward the front. Nothing is being removed.');
  else msg = 'Replay complete. The shrinking is a conceptual metaphor, not a measured or predicted result. Oil may remain, escape or reach shore.';
  if (msg !== lastStatus) { lastStatus = msg; $('#status').textContent = msg; }
  if (!$('#alert-preview').hidden && Date.now() - lastNoticeFrameAt > 350) { lastNoticeFrameAt = Date.now(); updateAlertDraft(); }
}
let last = 0, acc = 0, lastNoticeFrameAt = 0;
function tick(ts) { if (!S.playing) return; const dt = Math.min(.1, (ts - last)/1000); last = ts;
  if (RM.matches) { acc += dt; if (acc >= .8) { acc = 0; S.f = Math.min(FR-1, S.f + 40); } } else S.f = Math.min(FR-1, S.f + dt*FPS);
  rFrame(); if (S.f >= FR-1) setPlaying(false); else requestAnimationFrame(tick); }
function setPlaying(p) { S.playing = p; $('#play').textContent = p ? 'Pause' : 'Play';
  if (p) { if (S.f >= FR-1) S.f = 0; if (S.dirty || !sim) simulate(); last = performance.now(); acc = 0; requestAnimationFrame(tick); } else rFrame(); }

/* ---------- steps & wiring ---------- */
function all() { rOut(); rFlow(); rBoom(); rEq(); }
function go(n) { n = clamp(n, 0, 4); if (S.playing) setPlaying(false); S.step = n; scene.dataset.step = n; focusKey = null;
  // Expose an explicit local-alert preview option after a location has been selected.
  if (n === 0) $('#alert-preview').hidden = true;
  document.querySelectorAll('.panel').forEach(p => p.hidden = +p.dataset.panel !== n);
  document.querySelectorAll('#stepper button').forEach((b, i) => { b.removeAttribute('aria-current'); if (i === n) b.setAttribute('aria-current', 'step'); b.classList.toggle('done', i < n); });
  $('#progress-bar').style.width = (n+1)*20 + '%'; $('#badge').textContent = BADGES[n]; $('#prev').disabled = n === 0; $('#next').disabled = n === 4;
  $('#live').textContent = `Step ${n+1} of 5: ${TITLES[n]}`; G.oil.style.display = n === 4 ? '' : 'none';
  if (n === 4) { if (S.dirty || !sim) simulate(); S.f = 0; lastStatus = ''; }
  all(); if (n === 4) rFrame(); if (!$('#alert-preview').hidden) updateAlertDraft(); }
function dirUi() { $('#o-dir').textContent = `${S.dir}° → ${card(S.dir)} (assumed)`; $('#compass-arrow').setAttribute('transform', `rotate(${S.dir})`); }
function syncInputs() { $('#drift-dir').value = S.dir; ['boom','skim','sorb'].forEach(k => $('#use-' + k).checked = S.use[k]); dirUi(); }
$('#drift-dir').addEventListener('input', e => { S.dir = +e.target.value; S.dirty = true; dirUi(); rFlow(); if (!$('#alert-preview').hidden) updateAlertDraft(); });
$('#prepare-alert').addEventListener('click', () => {
  $('#alert-preview').hidden = false;
  updateAlertDraft();
  $('#alert-preview').scrollIntoView({ behavior: RM.matches ? 'auto' : 'smooth', block: 'nearest' });
});
const alertAgencyNames = {
  icg: 'Indian Coast Guard', state: 'Tamil Nadu / district authorities',
  port: 'Relevant port / oil-handling facility', incois: 'ESSO-INCOIS · OOSA'
};
const alertAgencyRequests = {
  icg: 'Review the possible marine pollution lead and advise which response authority should coordinate.',
  state: 'Confirm shoreline jurisdiction and whether local shoreline observation is appropriate.',
  port: 'Confirm whether the location is within your jurisdiction and identify the facility response contact.',
  incois: 'Advise which verified coordinates and environmental inputs are needed for an OOSA trajectory advisory.'
};
let routedAlertText = null;
function selectedAlertAgencies() { return [...document.querySelectorAll('.alert-recipient:checked')].map(x => x.value); }
function noticeSceneSnapshot() {
  const shot=document.createElement('canvas'); shot.width=W; shot.height=H;
  const c=shot.getContext('2d');
  try { c.drawImage(scene.dataset.base==='map' ? canvas : photo,0,0,W,H); } catch { c.fillStyle='#153b42';c.fillRect(0,0,W,H); }
  const curve=new Path2D(smooth(S.out));
  if (S.step===4 && sim) {
    const i0=Math.floor(S.f),i1=Math.min(i0+1,FR-1),a=S.f-i0,A=sim.frames[i0],B=sim.frames[i1];
    for(let i=0;i<sim.radii.length;i++){const mass=A[i*3+2]+(B[i*3+2]-A[i*3+2])*a;if(mass<.04)continue;c.beginPath();c.arc(A[i*3]+(B[i*3]-A[i*3])*a,A[i*3+1]+(B[i*3+1]-A[i*3+1])*a,Math.max(1,sim.radii[i]*.72*Math.sqrt(mass)),0,Math.PI*2);c.fillStyle='rgba(8,10,8,.76)';c.fill();}
  } else { c.fillStyle='rgba(5,10,9,.42)';c.fill(curve); }
  c.save();c.setLineDash([3,5]);c.lineWidth=3;c.strokeStyle='#ffb629';c.stroke(curve);c.restore();
  const f=geo();
  if(S.use.boom){c.beginPath();f.ring.forEach(([x,y],i)=>i?c.lineTo(x,y):c.moveTo(x,y));c.closePath();c.lineWidth=5;c.strokeStyle='#2ee6d0';c.stroke();}
  c.save();c.strokeStyle='rgba(46,230,208,.92)';c.fillStyle='rgba(46,230,208,.92)';c.lineWidth=4;
  [[-30,95],[0,115],[30,85]].forEach(([side,len])=>{const x=f.F[0]+f.d[0]*22+f.p[0]*side,y=f.F[1]+f.d[1]*22+f.p[1]*side,ex=x+f.d[0]*len,ey=y+f.d[1]*len;c.beginPath();c.moveTo(x,y);c.lineTo(ex,ey);c.stroke();const ang=Math.atan2(f.d[1],f.d[0]);c.beginPath();c.moveTo(ex,ey);c.lineTo(ex-12*Math.cos(ang-.55),ey-12*Math.sin(ang-.55));c.lineTo(ex-12*Math.cos(ang+.55),ey-12*Math.sin(ang+.55));c.closePath();c.fill();});c.restore();
  S.eq.forEach(q=>{if(q.t==='skimmer'&&!S.use.skim||q.t==='sorbent'&&!S.use.sorb)return;c.beginPath();c.arc(q.x,q.y,13,0,Math.PI*2);c.fillStyle=q.t==='skimmer'?'#8fd0ff':'#d6a6ff';c.fill();c.lineWidth=2;c.strokeStyle='#fff';c.stroke();c.fillStyle='#10202a';c.font='bold 13px system-ui';c.textAlign='center';c.textBaseline='middle';c.fillText(q.t==='skimmer'?'S':'A',q.x,q.y);});
  return shot.toDataURL('image/png');
}
function renderNoticeSimulation({skimmers, sorbents, direction, tactics, recipients, confirmed}) {
  const root = $('#notice-simulation'); root.replaceChildren(); root.classList.toggle('routed', Boolean(routedAlertText));
  const facts = document.createElement('div'); facts.className = 'notice-fact-grid';
  const location = document.createElement('article'); location.className = 'notice-fact location-fact';
  location.innerHTML = `<small>WHERE IS THE EXERCISE?</small><b>Ennore coast</b><span>Chennai, Tamil Nadu · approximate area${confirmed ? ' · confirmed for this exercise' : ''}</span><i class="location-pulse" aria-hidden="true"></i>`;
  facts.appendChild(location);
  const evidence = document.createElement('article'); evidence.className = 'notice-fact evidence-fact';
  evidence.innerHTML = `<small>WHAT WAS MARKED?</small>`;
  const preview = document.createElement('img'); preview.className='brief-scene-preview'; preview.src=noticeSceneSnapshot(); preview.alt='Ennore response demo snapshot showing the current spill outline, assumed flow direction, boom, and selected recovery equipment'; evidence.appendChild(preview);
  facts.appendChild(evidence);
  const drift=document.createElement('article'); drift.className='notice-fact drift-fact'; drift.innerHTML=`<small>WHERE COULD IT MOVE?</small>`;
  const compass=document.createElement('div'); compass.className='brief-compass'; compass.innerHTML='<i></i><span>N</span>'; compass.querySelector('i').style.transform=`rotate(${S.dir}deg)`;
  const words={N:'north',NNE:'north-northeast',NE:'northeast',ENE:'east-northeast',E:'east',ESE:'east-southeast',SE:'southeast',SSE:'south-southeast',S:'south',SSW:'south-southwest',SW:'southwest',WSW:'west-southwest',W:'west',WNW:'west-northwest',NW:'northwest',NNW:'north-northwest'};
  const driftText=document.createElement('b'); driftText.textContent=`Toward ${words[card(S.dir)]} (assumed)`; drift.append(compass,driftText); facts.appendChild(drift);
  root.appendChild(facts);
}
function renderAlertTimeline(routed = false, acknowledged = 0, total = 0) {
  const timeline = $('#alert-timeline'); timeline.replaceChildren();
  const allAcked = routed && total > 0 && acknowledged === total;
  const items = [
    ['Exercise lead reviewed', true],
    ['Ennore exercise location confirmed', $('#confirm-ennore').checked],
    ['Notice routed (simulated)', routed],
    [allAcked ? `All ${total} groups acknowledged (simulated)` : `Agency acknowledgements (${acknowledged}/${total})`, allAcked]
  ];
  items.forEach(([label, complete], i) => {
    const confirmed = $('#confirm-ennore').checked;
    const current = (!confirmed && i === 1) || (confirmed && !routed && i === 2) || (routed && !allAcked && i === 3);
    const item = document.createElement('div'); item.className = 'timeline-item ' + (complete ? 'complete' : (current ? 'current' : 'pending'));
    const dot = document.createElement('i'); dot.setAttribute('aria-hidden','true');
    const text = document.createElement('span'); text.textContent = label;
    item.append(dot,text); timeline.appendChild(item);
  });
}
function updateAlertDraft() {
  const confirmed = $('#confirm-ennore').checked;
  const recipients = selectedAlertAgencies();
  ensureEq();
  const skimmers = S.eq.filter(q => q.t === 'skimmer').length;
  const sorbents = S.eq.filter(q => q.t === 'sorbent').length;
  const direction = `${S.dir}° toward ${card(S.dir)} (assumed)`;
  const tactics = `${S.use.boom ? 'boom on' : 'boom off'}; ${S.use.skim ? skimmers + ' skimmer marker(s)' : 'skimmers off'}; ${S.use.sorb ? sorbents + ' sorbent marker(s)' : 'sorbents off'}`;
  const outline = S.out.map(([x,y]) => `${x.toFixed(0)},${y.toFixed(0)}`).join(' · ');
  const markers = S.eq.map(q => `${q.t === 'skimmer' ? 'Skimmer' : 'Sorbent'} (${q.x.toFixed(0)},${q.y.toFixed(0)})`).join('; ');
  const draft = `EXERCISE NOTICE EX-ENNORE-01 · INFORMATION ONLY\nStatus: historical Ennore oil-spill image used for a response exercise.\nArea: Ennore coast, Chennai, Tamil Nadu. Location precision: locality only; supplied image has no GPS coordinates.\nEvidence: user-adjusted outline on the 11 Dec 2023 comparison image (after panel). This is image-based interpretation, not live satellite detection.\nConditions: surface drift ${direction}; scenario assumption, not measured environmental data.\nResponse layout: ${tactics}.\nOutline vertices in image pixels (not geographic coordinates): ${outline}\nEquipment markers in image pixels: ${markers || 'none'}\nCoordination requested: verify the exact location and jurisdiction before operational action. Agency-specific requests are listed in the dispatch record.\nSelected groups: ${recipients.map(k => alertAgencyNames[k]).join('; ') || 'none'}.\nSIMULATION ONLY — no real message is sent.`;
  if (routedAlertText && draft !== routedAlertText) {
    routedAlertText = null; $('#alert-delivery').hidden = true; $('#alert-delivery').replaceChildren();
    $('#send-demo-alert').textContent = 'Simulate alert routing'; $('#send-demo-alert').disabled = !confirmed || recipients.length === 0;
  }
  $('#alert-message').value = draft;
  $('#brief-tactics').textContent = `In this exercise, the assumed movement is ${direction}. The current plan shows ${S.use.boom ? 'a boom' : 'no boom'}, ${S.use.skim ? skimmers + ' skimmer markers' : 'no skimmers'}, and ${S.use.sorb ? sorbents + ' sorbent markers' : 'no sorbents'}.`;
  renderNoticeSimulation({skimmers,sorbents,direction,tactics,recipients,confirmed});
  $('#send-demo-alert').disabled = !confirmed || recipients.length === 0;
  renderAlertTimeline(Boolean(routedAlertText));
}
$('#confirm-ennore').addEventListener('change', updateAlertDraft);
document.querySelectorAll('.alert-recipient').forEach(input => input.addEventListener('change', updateAlertDraft));
$('#send-demo-alert').addEventListener('click', () => {
  const delivery = $('#alert-delivery'); delivery.replaceChildren(); delivery.hidden = false;
  routedAlertText = $('#alert-message').value;
  $('#notice-simulation').classList.add('routed');
  const simTime = new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
  const heading = document.createElement('h3'); heading.textContent = 'Dispatch record · EX-ENNORE-01'; delivery.appendChild(heading);
  const info = document.createElement('p'); info.textContent = `Simulated at ${simTime} · in-app exercise routing only · no message left this page.`; delivery.appendChild(info);
  const agencies = selectedAlertAgencies(); let acknowledged = 0;
  const refreshTimeline = () => renderAlertTimeline(true, acknowledged, agencies.length);
  agencies.forEach(key => {
    const row = document.createElement('div'); row.className = 'delivery-row';
    const copy = document.createElement('div'); copy.className = 'delivery-copy';
    const details = document.createElement('b'); details.textContent = `${alertAgencyNames[key]} · Simulated delivered · awaiting acknowledgement`; copy.appendChild(details);
    const request = document.createElement('small'); request.textContent = 'Requested follow-up: ' + alertAgencyRequests[key]; copy.appendChild(request);
    row.appendChild(copy);
    const ack = document.createElement('button'); ack.type = 'button'; ack.className = 'btn'; ack.textContent = 'Simulate acknowledgement';
    ack.addEventListener('click', () => { details.textContent = `${alertAgencyNames[key]} · Acknowledged at ${new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})} (simulated)`; ack.disabled = true; ack.textContent = 'Acknowledged'; acknowledged += 1; refreshTimeline(); });
    row.appendChild(ack); delivery.appendChild(row);
  });
  refreshTimeline();
  $('#send-demo-alert').textContent = 'Routed · exercise only';
  $('#send-demo-alert').disabled = true;
});
document.querySelectorAll('#stepper button').forEach(b => b.addEventListener('click', () => go(+b.dataset.go)));
$('#prev').addEventListener('click', () => go(S.step - 1)); $('#next').addEventListener('click', () => go(S.step + 1));
document.querySelectorAll('.seg-btn').forEach(b => b.addEventListener('click', () => setBase(b.dataset.base)));
$('#reset-out').addEventListener('click', () => { S.out = copy(DEF_OUT); S.dirty = true; rOut(); if (!$('#alert-preview').hidden) updateAlertDraft(); });
$('#reset-eq').addEventListener('click', () => { S.eqCustom = false; S.eq = null; S.dirty = true; rEq(); if (!$('#alert-preview').hidden) updateAlertDraft(); });
$('#reset-all').addEventListener('click', () => { S.out = copy(DEF_OUT); S.dir = 285; S.eq = null; S.eqCustom = false; S.use = { boom: true, skim: true, sorb: true }; S.f = 0; S.dirty = true; syncInputs(); go(0); });
$('#play').addEventListener('click', () => setPlaying(!S.playing));
$('#replay').addEventListener('click', () => { S.f = 0; lastStatus = ''; if (S.dirty || !sim) simulate(); setPlaying(true); });
$('#scrub').max = FR - 1;
$('#scrub').addEventListener('input', e => { if (S.playing) setPlaying(false); if (S.dirty || !sim) simulate(); S.f = +e.target.value; rFrame(); });
['boom','skim','sorb'].forEach(k => $('#use-' + k).addEventListener('change', e => { S.use[k] = e.target.checked; S.dirty = true; const was = S.playing; simulate(); rBoom(); rEq(); rFrame(); if (was) setPlaying(true); if (!$('#alert-preview').hidden) updateAlertDraft(); }));
function resize() { const k = clamp(W / (svg.clientWidth || W), .9, 2.2); if (Math.abs(k - K) > .02) { K = k; all(); } }
new ResizeObserver(resize).observe(svg);
if (RM.addEventListener) RM.addEventListener('change', () => { if (S.step === 4) rFrame(); });
K = clamp(W / (svg.clientWidth || W), .9, 2.2); syncInputs(); go(0);
})();
