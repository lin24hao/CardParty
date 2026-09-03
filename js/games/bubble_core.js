// 泡泡龙共享核心（BubbleCore）v2 —— 动态下落 + 碰墙弹射 + 粒子特效 + 多炮台
// 被 bubble_pvp.js / bubble_coop.js 引用，挂在全局
// 坐标系：grid[row][col]，row=0 为顶线；偶数行不偏移、奇数行右移半格（蜂窝）
// 颜色：r/g/b/y/p（5 色），垃圾泡泡 x（灰色，不可消除）
const BubbleCore = (() => {
  const COLS = 10;
  const ROWS = 12;
  const COLORS = ['r', 'g', 'b', 'y', 'p'];
  const GRAY = 'x';
  const CELL_W = 30;
  const CELL_H = 26;
  const LAUNCH_Y = ROWS * CELL_H + 24;
  const COLOR_HEX = { r: '#e5484d', g: '#18a058', b: '#2f6fed', y: '#f0a92e', p: '#a855f7', x: '#9aa0b4' };

  function makeGrid() {
    const g = [];
    for (let r = 0; r < ROWS; r++) g.push(new Array(COLS).fill(null));
    return g;
  }
  function makeInitial(seedRows = 4, rnd = Math.random) {
    const g = makeGrid();
    for (let r = 0; r < seedRows; r++)
      for (let c = 0; c < COLS; c++)
        if (rnd() < 0.85) g[r][c] = COLORS[Math.floor(rnd() * COLORS.length)];
    return g;
  }
  function makeQueue(n = 40, rnd = Math.random) {
    const a = [];
    for (let i = 0; i < n; i++) a.push(COLORS[Math.floor(rnd() * COLORS.length)]);
    return a;
  }
  function isOdd(r) { return r % 2 === 1; }
  function xAt(r, c) { return (isOdd(r) ? CELL_W / 2 : 0) + c * CELL_W + CELL_W / 2; }
  function neighbors(r, c) {
    const odd = isOdd(r);
    const n = [
      [r - 1, odd ? c : c - 1], [r - 1, odd ? c + 1 : c],
      [r, c - 1], [r, c + 1],
      [r + 1, odd ? c : c - 1], [r + 1, odd ? c + 1 : c],
    ];
    return n.filter(p => p[0] >= 0 && p[0] < ROWS && p[1] >= 0 && p[1] < COLS);
  }
  function cellAt(px, py) {
    let best = null, bd = Infinity;
    for (let r = 0; r < ROWS; r++) {
      const c = Math.round((px - (isOdd(r) ? CELL_W / 2 : 0)) / CELL_W);
      if (c < 0 || c >= COLS) continue;
      const dx = xAt(r, c) - px, dy = r * CELL_H + CELL_H / 2 - py;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = { r, c }; }
    }
    return best;
  }
  function nearestEmpty(grid, cell, px, py) {
    let best = null, bd = Infinity;
    const cands = [cell].concat(neighbors(cell.r, cell.c));
    for (const p of cands) {
      const r = p[0], c = p[1];
      if (!grid[r] || grid[r][c]) continue;
      const dx = xAt(r, c) - px, dy = r * CELL_H + CELL_H / 2 - py;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = { r, c }; }
    }
    return best;
  }

  // ---------- 发射物理：碰墙弹射 ----------
  // 从 (sx,sy) 沿角度 angleDeg（0=正上）发射，左右墙反弹，撞泡泡/顶线粘附
  // 返回 { trail: 轨迹点数组, x, y, cell }
  function flyTrail(grid, sx, sy, angleDeg) {
    const rad = angleDeg * Math.PI / 180;
    let dx = Math.sin(rad), dy = -Math.cos(rad);
    const W = COLS * CELL_W;
    let x = sx, y = sy;
    const trail = [];
    const step = 3;
    // 起手前若干步不判定碰撞，避免炮口正上方已有泡泡时刚出膛就被吸附
    const SAFE_STEPS = 6;
    for (let i = 0; i < 700; i++) {
      x += dx * step; y += dy * step;
      if (x < CELL_W / 2) { x = CELL_W / 2 + (CELL_W / 2 - x); dx = -dx; }
      else if (x > W - CELL_W / 2) { x = W - CELL_W / 2 - (x - (W - CELL_W / 2)); dx = -dx; }
      trail.push({ x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 });
      if (i < SAFE_STEPS) continue;
      if (y <= CELL_H / 2) {
        const cell = cellAt(x, Math.max(y, 1));
        if (cell) {
          const lx = xAt(cell.r, cell.c), ly = cell.r * CELL_H + CELL_H / 2;
          trail.push({ x: Math.round(lx * 10) / 10, y: Math.round(ly * 10) / 10 });
          return { trail, x: lx, y: ly, cell };
        }
      }
      const cell = cellAt(x, y);
      if (cell && grid[cell.r] && grid[cell.r][cell.c]) {
        const place = nearestEmpty(grid, cell, x, y);
        if (place) {
          const lx = xAt(place.r, place.c), ly = place.r * CELL_H + CELL_H / 2;
          trail.push({ x: Math.round(lx * 10) / 10, y: Math.round(ly * 10) / 10 });
          return { trail, x: lx, y: ly, cell: place };
        }
        break;
      }
    }
    return null;
  }
  // 由轨迹构造飞行动画（所有客户端用同一份轨迹回放，保证观感一致）
  function makeAnim(trail, color, sy, dur) {
    if (!trail || trail.length < 2) return null;
    return {
      trail, color,
      sx: trail[0].x, sy: sy != null ? sy : trail[0].y,
      start: Date.now(),
      dur: Math.max(180, Math.min(620, Math.round(trail.length * 4.5))),
    };
  }
  // 兼容旧接口：直线飞行（新代码用 flyTrail）
  function fly(grid, sx, sy, dx, dy) {
    const deg = Math.atan2(dx, -dy) * 180 / Math.PI;
    return flyTrail(grid, sx, sy, deg);
  }

  // ---------- 整体下移（动态下落） ----------
  function bottomRowHas(grid) { for (let c = 0; c < COLS; c++) if (grid[ROWS - 1][c]) return true; return false; }
  function topRowHas(grid) { for (let c = 0; c < COLS; c++) if (grid[0][c]) return true; return false; }
  // 下移 1 行，顶部补 fill（null=空 / 'x'=垃圾）；底行已有泡泡则触底，返回 false 且不移动
  function sinkStep(grid, fill) {
    if (bottomRowHas(grid)) return false;
    for (let r = ROWS - 1; r >= 1; r--) grid[r] = grid[r - 1].slice();
    grid[0] = new Array(COLS).fill(fill || null);
    return true;
  }
  function sinkRows(grid, n, fill) {
    let ok = true;
    for (let i = 0; i < n && ok; i++) ok = sinkStep(grid, fill);
    return ok;
  }

  // ---------- 消除 / 掉落 ----------
  function pop3(grid, r, c, color) {
    const seen = new Set(), q = [[r, c]];
    seen.add(r + ',' + c);
    while (q.length) {
      const p = q.shift();
      for (const nb of neighbors(p[0], p[1])) {
        const k = nb[0] + ',' + nb[1];
        if (!seen.has(k) && grid[nb[0]][nb[1]] === color) { seen.add(k); q.push(nb); }
      }
    }
    if (seen.size >= 3) {
      seen.forEach(k => { const p = k.split(',').map(Number); grid[p[0]][p[1]] = null; });
      return seen.size;
    }
    return 0;
  }
  function dropFloating(grid) {
    const attached = new Set(), q = [];
    for (let c = 0; c < COLS; c++) if (grid[0][c]) { const k = '0,' + c; attached.add(k); q.push([0, c]); }
    while (q.length) {
      const p = q.shift();
      for (const nb of neighbors(p[0], p[1])) {
        const k = nb[0] + ',' + nb[1];
        if (!attached.has(k) && grid[nb[0]][nb[1]]) { attached.add(k); q.push(nb); }
      }
    }
    let n = 0;
    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c < COLS; c++)
        if (grid[r][c] && !attached.has(r + ',' + c)) { grid[r][c] = null; n++; }
    return n;
  }
  function resolve(grid, cell, color) {
    grid[cell.r][cell.c] = color;
    const removed = pop3(grid, cell.r, cell.c, color);
    const dropped = removed ? dropFloating(grid) : 0;
    return { removed, dropped };
  }
  function countPop(grid) {
    let n = 0;
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (grid[r][c]) n++;
    return n;
  }
  function topRowPop(grid) { return topRowHas(grid); }
  function shiftRowsUp(grid, times) {
    let overflow = false;
    const n = times || 1;
    for (let k = 0; k < n; k++) {
      if (topRowPop(grid)) overflow = true;
      for (let r = ROWS - 1; r >= 1; r--) grid[r] = grid[r - 1].slice();
      grid[0] = new Array(COLS).fill(null);
      for (let c = 0; c < COLS; c++) grid[ROWS - 1][c] = GRAY;
    }
    return !overflow;
  }

  // ---------- 粒子特效数据 ----------
  // events: [{type:'pop'|'hit'|'inject'|'fail', cells:[[r,c]...], x, y, color}]
  function makeFx(events, now) {
    const fx = [];
    events.forEach((ev, i) => {
      const base = 'fx' + now + '_' + i;
      if (ev.type === 'pop') {
        (ev.cells || []).forEach((cc, k) => {
          fx.push({ id: base + '_' + k, type: 'burst', x: xAt(cc[0], cc[1]), y: cc[0] * CELL_H + CELL_H / 2, color: ev.color || '#fff', t0: now, dur: 460 + Math.random() * 220 });
        });
      } else if (ev.type === 'hit') {
        fx.push({ id: base, type: 'ring', x: ev.x, y: ev.y, color: ev.color || '#fff', t0: now, dur: 360 });
      } else if (ev.type === 'inject') {
        fx.push({ id: base, type: 'inject', color: '#9aa0b4', t0: now, dur: 520 });
      } else if (ev.type === 'fail') {
        fx.push({ id: base, type: 'flash', color: '#f87171', t0: now, dur: 700 });
      }
    });
    return fx;
  }

  // ---------- Canvas 渲染 ----------
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function drawBubble(ctx, x, y, rad, col) {
    ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2);
    ctx.fillStyle = COLOR_HEX[col] || '#ccc'; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(0,0,0,.18)'; ctx.stroke();
    ctx.beginPath(); ctx.arc(x - rad * 0.3, y - rad * 0.3, rad * 0.28, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,.55)'; ctx.fill();
  }
  // opts: { launchers:[{x,color,angle,active}], anim:{sx,sy,trail,color,start,dur,cell}, now, hideCell, sinkOffset, fx, warning }
  function renderCanvas(canvas, grid, opts = {}) {
    const W = COLS * CELL_W, H = ROWS * CELL_H + 40;
    if (canvas.width !== W) canvas.width = W;
    if (canvas.height !== H) canvas.height = H;
    const ctx = canvas.getContext('2d');
    const now = opts.now || Date.now();
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#fbf7ec';
    ctx.strokeStyle = '#e7dcc3';
    ctx.lineWidth = 3;
    roundRect(ctx, 1, 1, W - 2, H - 2, 14); ctx.fill(); ctx.stroke();

    // 底线警告
    if (opts.warning) {
      const a = 0.10 + 0.10 * Math.abs(Math.sin(now / 150));
      ctx.fillStyle = 'rgba(248,113,113,' + a + ')';
      ctx.fillRect(3, H - CELL_H - 2, W - 6, CELL_H - 4);
    }

    const off = opts.sinkOffset || 0;
    const animDone = !!(opts.anim && (now - opts.anim.start) >= opts.anim.dur);
    const hideCell = animDone ? null : (opts.hideCell || null);
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const col = grid[r][c];
        if (!col) continue;
        if (hideCell && hideCell.r === r && hideCell.c === c) continue;
        drawBubble(ctx, xAt(r, c), r * CELL_H + CELL_H / 2 + off * CELL_H, CELL_W * 0.44, col);
      }
    }

    // 炮台（多炮台）
    (opts.launchers || []).forEach(l => {
      const sx = l.x, sy = H - 16;
      if (l.angle != null && l.color && l.active) {
        const rad = l.angle * Math.PI / 180;
        const dx = Math.sin(rad), dy = -Math.cos(rad);
        ctx.setLineDash([6, 6]); ctx.strokeStyle = 'rgba(90,90,150,.65)'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx + dx * 320, sy + dy * 320); ctx.stroke();
        ctx.setLineDash([]);
        drawBubble(ctx, sx, sy, 12, l.color);
        ctx.beginPath(); ctx.arc(sx, sy, 15, 0, Math.PI * 2);
        ctx.strokeStyle = l.active ? 'rgba(91,91,214,.85)' : 'rgba(0,0,0,.12)';
        ctx.lineWidth = 2.5; ctx.stroke();
      } else {
        ctx.beginPath(); ctx.arc(sx, sy, 9, 0, Math.PI * 2);
        ctx.fillStyle = '#d8d3c8'; ctx.fill(); ctx.strokeStyle = '#4a4a5a'; ctx.stroke();
      }
    });

    // 飞行泡泡（沿弹射轨迹缓动）
    if (opts.anim && !animDone) {
      const a = opts.anim;
      const t = Math.max(0, Math.min(1, (now - a.start) / a.dur));
      const ease = 1 - Math.pow(1 - t, 3);
      const idx = Math.floor(ease * (a.trail.length - 1));
      const p = a.trail[Math.max(0, Math.min(a.trail.length - 1, idx))];
      drawBubble(ctx, p.x, p.y, CELL_W * 0.44, a.color);
      // 拖尾
      for (let k = 1; k <= 4; k++) {
        const j = Math.max(0, idx - k * 3);
        if (j >= a.trail.length) continue;
        const tp = a.trail[j];
        ctx.beginPath(); ctx.arc(tp.x, tp.y, CELL_W * 0.44 * (1 - k * 0.18), 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,' + (0.35 - k * 0.07) + ')'; ctx.fill();
      }
    }

    // 粒子特效
    (opts.fx || []).forEach(f => {
      // t0 可以是未来时间（用于等飞行落地后再爆开），未到点不绘制
      if (now < f.t0) return;
      const t = Math.max(0, Math.min(1, (now - f.t0) / f.dur));
      if (t >= 1) return;
      if (f.type === 'burst') {
        const ang = (f.id.length + f.x) % 7 * Math.PI / 3.5;
        const dist = t * 34;
        const px = f.x + Math.cos(ang) * dist, py = f.y + Math.sin(ang) * dist;
        ctx.beginPath(); ctx.arc(px, py, 5 * (1 - t) + 1, 0, Math.PI * 2);
        ctx.fillStyle = (f.color || '#fff'); ctx.globalAlpha = 1 - t; ctx.fill(); ctx.globalAlpha = 1;
      } else if (f.type === 'ring') {
        ctx.beginPath(); ctx.arc(f.x, f.y, 6 + t * 30, 0, Math.PI * 2);
        ctx.strokeStyle = f.color || '#fff'; ctx.globalAlpha = 1 - t; ctx.lineWidth = 3; ctx.stroke(); ctx.globalAlpha = 1;
      } else if (f.type === 'inject') {
        const top = -CELL_H + t * CELL_H * 2;
        ctx.fillStyle = 'rgba(154,160,180,' + (0.85 * (1 - t * 0.6)) + ')';
        roundRect(ctx, 4, top + 2, W - 8, CELL_H - 4, 8); ctx.fill();
      } else if (f.type === 'flash') {
        ctx.fillStyle = 'rgba(248,113,113,' + (0.35 * (1 - t)) + ')';
        ctx.fillRect(0, 0, W, H);
      }
    });
  }

  // 动画循环
  const canvasInfo = new WeakMap();
  let animLoop = false;
  function attachCanvas(canvas, grid, opts) { canvasInfo.set(canvas, { grid, opts }); }
  function drawCanvas(canvas) {
    const info = canvasInfo.get(canvas);
    if (!info) return;
    renderCanvas(canvas, info.grid, Object.assign({}, info.opts, { now: Date.now() }));
  }
  function needsAnim(opts) {
    const now = Date.now();
    if (opts.anim && now - opts.anim.start < opts.anim.dur) return true;
    // 未来才开始的特效也要维持循环，否则泡泡落地后粒子不会被触发
    if (opts.fx && opts.fx.some(f => now < f.t0 || now - f.t0 < f.dur)) return true;
    return !!opts.live;
  }
  function tickCanvas() {
    let active = false;
    document.querySelectorAll('.bubble-canvas').forEach(cv => {
      const info = canvasInfo.get(cv);
      if (!info) return;
      if (info.opts.sinkOffset && info.opts.sinkOffset > 0) {
        info.opts.sinkOffset = Math.max(0, info.opts.sinkOffset - 0.09);
      }
      renderCanvas(cv, info.grid, Object.assign({}, info.opts, { now: Date.now() }));
      if (needsAnim(info.opts)) active = true;
    });
    if (active) requestAnimationFrame(tickCanvas);
    else animLoop = false;
  }
  function ensureAnim() { if (!animLoop) { animLoop = true; requestAnimationFrame(tickCanvas); } }

  return {
    COLS, ROWS, COLORS, GRAY, CELL_W, CELL_H, LAUNCH_Y, COLOR_HEX,
    makeGrid, makeInitial, makeQueue, isOdd, xAt, neighbors, cellAt,
    fly, flyTrail, makeAnim, pop3, dropFloating, resolve, countPop, topRowPop, shiftRowsUp,
    sinkStep, sinkRows, bottomRowHas, makeFx,
    renderCanvas, attachCanvas, drawCanvas, ensureAnim,
  };
})();
window.BubbleCore = BubbleCore;
