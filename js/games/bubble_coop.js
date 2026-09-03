// 泡泡龙·合作版（BubbleCoop）v2 —— 双炮台同场自由发射（非轮流），共享场地与目标分
// 任一玩家触底/顶线即整场失败；累计 120 分通关
// 接口：init(ctx) / handleMessage(from, data)，主机权威
window.BubbleCoop = (() => {
  const BC = window.BubbleCore;
  const MSG_SHOT = 'bubble_coop_shot';
  const MSG_STATE = 'bubble_coop_state';
  const MSG_RESTART = 'bubble_coop_restart';
  const COLS = BC.COLS, ROWS = BC.ROWS, CELL_W = BC.CELL_W, CELL_H = BC.CELL_H;
  const TARGET = 120;

  let ctx = null;
  let st = null;            // 主机权威状态
  let view = null;          // 非主机视图 {board, queue, launcherX, score, failed, over, win}
  let canvas = null;
  let canvasGrid = BC.makeGrid();
  let canvasOpts = { launchers: [launcher(COLS * CELL_W / 3), launcher(COLS * CELL_W * 2 / 3)], warning: false, live: true, fx: [] };
  let angle = -45, aiming = false;
  let myIdx = 0;            // 我的炮台在 launchers 数组中的下标（1 号位=0，2 号位=1）
  let lastShotAt = 0;
  let bound = [];           // 已绑定的 window 监听，重进游戏时统一解绑
  const MAX_AIM = 78;       // 炮台可旋转到的最大偏角（0=正上，正=右，负=左）
  const SHOT_CD = 260;      // 本地连发间隔，避免飞行还没播完就又射一发

  function launcher(x) { return { x, angle: -90, color: 'r', active: true }; }

  function on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    bound.push([target, type, fn]);
  }
  function unbind() {
    bound.forEach(b => { try { b[0].removeEventListener(b[1], b[2]); } catch (e) { /* ignore */ } });
    bound = [];
  }

  function makeState() {
    const players = {};
    (ctx.players || []).forEach((pl, i) => {
      players[pl.id] = { id: pl.id, name: pl.name, idx: i, launcherX: (i === 0 ? COLS * CELL_W / 3 : COLS * CELL_W * 2 / 3) };
    });
    return { players, board: BC.makeGrid(), queues: {}, score: 0, failed: false, over: false, win: false, tick: 0 };
  }

  function newGame() {
    st = makeState();
    st.board = BC.makeInitial(4, Math.random);
    for (const id of Object.keys(st.players)) st.queues[id] = BC.makeQueue(60, Math.random);
    st.score = 0; st.failed = false; st.over = false; st.win = false;
    view = null;
  }

  function hostStart() { newGame(); broadcastState(null); }

  function applyShot(id, payload) {
    if (st.over || st.failed || !payload || payload.angle == null) return null;
    const grid = st.board;
    const q = st.queues[id];
    const color = q.shift() || BC.COLORS[0];
    q.push(color);
    const before = JSON.stringify(grid);
    const sx = st.players[id].launcherX;
    const ft = BC.flyTrail(grid, sx, BC.LAUNCH_Y, payload.angle);
    if (!ft || !ft.cell) { q.pop(); q.unshift(color); return null; }
    const anim = BC.makeAnim(ft.trail, color, BC.LAUNCH_Y);
    const flyMs = anim ? anim.dur : 0;
    const res = BC.resolve(grid, ft.cell, color);
    st.score += res.removed * 10 + res.dropped * 5;
    const ev = [];
    if (res.removed) ev.push({ type: 'pop', cells: diffCells(grid, before), color: BC.COLOR_HEX[color] });
    else ev.push({ type: 'hit', x: ft.x, y: ft.y, color: BC.COLOR_HEX[color] });
    // 上方球缓慢下落：间隔随局内发射次数加快（8 发下沉一行 -> 最快 2 发下沉一行）
    st.tick++;
    const interval = Math.max(2, 8 - Math.floor(st.tick / 5));
    if (st.tick % interval === 0) {
      BC.sinkStep(grid, null);
      ev.push({ type: 'inject' });
    }
    // 碰底线才失败
    if (BC.bottomRowHas(grid)) {
      st.failed = true; st.over = true;
      ev.push({ type: 'fail' });
    } else if (st.score >= TARGET) {
      st.over = true; st.win = true;
    }
    // 特效延后到飞行落地那一刻再播
    return { ev, fx: BC.makeFx(ev, Date.now() + flyMs), anim, hideCell: ft.cell };
  }

  // 主机本地发射（房主自己操作时走这里，等价于收到客机的 MSG_SHOT）
  function hostInput(fromId, data) {
    if (!st || st.over) return;
    const res = applyShot(fromId, data);
    if (res) broadcastState(res.fx, res.anim, res.hideCell);
  }

  function broadcastState(fx, anim, hideCell) {
    const ids = Object.keys(st.players);
    for (const id of ids) {
      const msg = {
        type: MSG_STATE,
        board: st.board,
        queue: st.queues[id],
        launcherX: st.players[id].launcherX,
        score: st.score, failed: st.failed, over: st.over, win: st.win,
        fx, anim, hideCell,
      };
      if (id === Net.myId()) applyState(msg); else Net.sendTo(id, msg);
    }
  }

  function diffCells(grid, beforeJson) {
    const before = JSON.parse(beforeJson);
    const cells = [];
    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c < COLS; c++)
        if (before[r][c] && !grid[r][c]) cells.push([r, c]);
    return cells;
  }

  // ---------- 客户端 ----------
  function init(c) {
    ctx = c;
    unbind();
    angle = -45; aiming = false; view = null;
    myIdx = 0; lastShotAt = 0;
    buildUI();
    if (ctx.isHost) hostStart();
  }

  function buildUI() {
    if (!ctx || !ctx.container) return;
    const host = document.createElement('div');
    host.className = 'bubble-wrap';
    host.innerHTML = ''
      + '<div class="bubble-head"><span class="bubble-title">泡泡龙合作</span><span class="bubble-score">目标 ' + TARGET + ' 分</span></div>'
      + '<div class="bubble-stage"><canvas class="bubble-canvas" id="coop-canvas"></canvas></div>'
      + '<div class="bubble-bar">'
      + '  <span>下一颗：<b id="coop-next">-</b></span>'
      + '  <span id="coop-score">0 / ' + TARGET + '</span>'
      + '  <button class="bubble-btn" id="coop-reset">再来一局</button>'
      + '</div>'
      + '<div class="bubble-status" id="coop-status">准备中…</div>';
    ctx.container.appendChild(host);
    canvas = document.getElementById('coop-canvas');
    canvasGrid = BC.makeGrid();
    canvasOpts = { launchers: [launcher(COLS * CELL_W / 3), launcher(COLS * CELL_W * 2 / 3)], warning: false, live: true, fx: [] };
    BC.attachCanvas(canvas, canvasGrid, canvasOpts);
    BC.ensureAnim();
    bindInput();
  }

  function bindInput() {
    if (!canvas) return;
    const myL = () => canvasOpts.launchers[myIdx] || canvasOpts.launchers[0];
    const clampAim = (a) => Math.max(-MAX_AIM, Math.min(MAX_AIM, a));

    // 画布被 CSS 缩放过（width:100%），必须把鼠标坐标换算回画布内部坐标
    const setAngle = (ev) => {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width) return;
      // 用逻辑坐标而非 canvas.width/height —— 首帧渲染前画布还是默认 300x150
      const scale = (COLS * CELL_W) / rect.width;
      const pt = ev.touches ? ev.touches[0] : ev;
      const px = (pt.clientX - rect.left) * scale;
      const py = (pt.clientY - rect.top) * scale;
      const l = myL();
      const dyUp = BC.LAUNCH_Y - py;
      if (dyUp <= 6) return;                       // 指针在炮口下方，不响应
      const a = clampAim(Math.atan2(px - l.x, dyUp) * 180 / Math.PI);
      angle = a;
      l.angle = a; l.active = true;
      BC.ensureAnim();
    };

    canvas.addEventListener('mousedown', (ev) => { aiming = true; setAngle(ev); ev.preventDefault(); });
    canvas.addEventListener('touchstart', (ev) => { aiming = true; setAngle(ev); ev.preventDefault(); }, { passive: false });
    on(window, 'mousemove', (ev) => { if (aiming) setAngle(ev); });
    on(window, 'touchmove', (ev) => { if (aiming) { setAngle(ev); ev.preventDefault(); } }, { passive: false });
    const release = () => {
      if (!aiming) return;
      aiming = false;
      if (!isOver()) sendShot();
    };
    on(window, 'mouseup', release);
    on(window, 'touchend', release);
    on(window, 'keydown', (ev) => {
      const l = myL();
      if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
        angle = clampAim(angle + (ev.key === 'ArrowLeft' ? -4 : 4));
        l.angle = angle; l.active = true;
        BC.ensureAnim();
      } else if (ev.key === ' ' || ev.key === 'Enter') {
        ev.preventDefault();
        if (!isOver()) sendShot();
      }
    });
    const btn = document.getElementById('coop-reset');
    if (btn) btn.addEventListener('click', () => {
      if (ctx.isHost) { newGame(); broadcastState(null); }
      else Net.sendToHost({ type: MSG_RESTART });
    });
  }

  function sendShot() {
    if (isOver()) return;
    const now = Date.now();
    if (now - lastShotAt < SHOT_CD) return;
    lastShotAt = now;
    const msg = { type: MSG_SHOT, angle };
    if (ctx.isHost) hostInput(Net.myId(), msg);
    else Net.sendToHost(msg);
  }

  function isOver() { return view ? (view.over || view.failed) : false; }

  function applyState(msg) {
    view = msg;
    canvasGrid = msg.board || BC.makeGrid();
    const next = (msg.queue && msg.queue[0]) || '-';
    // 我的炮台：按 launcherX 定位，另一炮台保持中立色
    const l0 = canvasOpts.launchers[0], l1 = canvasOpts.launchers[1];
    const myX = msg.launcherX != null ? msg.launcherX : COLS * CELL_W / 3;
    l0.x = COLS * CELL_W / 3; l1.x = COLS * CELL_W * 2 / 3;
    const myL = Math.abs(l0.x - myX) < 2 ? l0 : l1;
    const otherL = myL === l0 ? l1 : l0;
    myIdx = (myL === l0) ? 0 : 1;
    myL.color = next === '-' ? 'r' : next;
    otherL.color = 'r';
    myL.angle = angle;
    // 两个炮台都常驻显示，否则松手后自己的炮台会消失
    myL.active = true;
    if (otherL.angle == null || otherL.angle <= -90) otherL.angle = 0;
    otherL.active = true;
    canvasOpts.warning = !!(msg.failed) || BC.bottomRowHas(canvasGrid);
    canvasOpts.fx = msg.fx || [];
    if (msg.fx && msg.fx.some(f => f.type === 'inject')) canvasOpts.sinkOffset = 1;
    // 飞行动画：所有客户端用主机下发的同一条轨迹回放
    canvasOpts.anim = msg.anim || null;
    canvasOpts.hideCell = msg.hideCell || null;
    BC.attachCanvas(canvas, canvasGrid, canvasOpts);
    BC.ensureAnim();
    const nextEl = document.getElementById('coop-next');
    if (nextEl) nextEl.textContent = next;
    const scEl = document.getElementById('coop-score');
    if (scEl) scEl.textContent = (msg.score || 0) + ' / ' + TARGET;
    const stEl = document.getElementById('coop-status');
    if (stEl) {
      if (msg.over) stEl.textContent = msg.win ? '胜利！一起通关！' : '失败…场地触底了';
      else stEl.textContent = '双炮台自由发射，累计 ' + TARGET + ' 分通关';
    }
  }

  function handleMessage(from, data) {
    if (!ctx || !data || !data.type) return;
    if (ctx.isHost) {
      if (data.type === MSG_SHOT) {
        hostInput(from, data);
      } else if (data.type === MSG_RESTART) {
        newGame(); broadcastState(null);
      }
    } else {
      if (data.type === MSG_STATE) applyState(data);
    }
  }

  return { init, handleMessage };
})();
window.BubbleCoop = BubbleCoop;
