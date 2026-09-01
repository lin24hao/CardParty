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
  let angle = -90, aiming = false;

  function launcher(x) { return { x, angle: -90, color: 'r', active: false }; }

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
    if (!ft.cell) { q.pop(); q.unshift(color); return null; }
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
    return { ev, fx: BC.makeFx(ev, Date.now()) };
  }

  function broadcastState(fx) {
    const ids = Object.keys(st.players);
    for (const id of ids) {
      const msg = {
        type: MSG_STATE,
        board: st.board,
        queue: st.queues[id],
        launcherX: st.players[id].launcherX,
        score: st.score, failed: st.failed, over: st.over, win: st.win,
        fx,
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
    angle = -90; aiming = false; view = null;
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
    const myL = () => canvasOpts.launchers[0];
    const setAngle = (ev) => {
      const rect = canvas.getBoundingClientRect();
      const cx = (ev.touches ? ev.touches[0].clientX : ev.clientX) - rect.left;
      const cy = (ev.touches ? ev.touches[0].clientY : ev.clientY) - rect.top;
      const l = myL();
      let a = Math.atan2(cx - l.x, rect.height - 16 - cy) * 180 / Math.PI;
      a = Math.max(-160, Math.min(-20, a));
      angle = a;
      l.angle = a; l.active = true;
    };
    canvas.addEventListener('mousedown', (ev) => { aiming = true; setAngle(ev); ev.preventDefault(); });
    canvas.addEventListener('touchstart', (ev) => { aiming = true; setAngle(ev); ev.preventDefault(); }, { passive: false });
    window.addEventListener('mousemove', (ev) => { if (aiming) setAngle(ev); });
    window.addEventListener('touchmove', (ev) => { if (aiming) { setAngle(ev); ev.preventDefault(); } }, { passive: false });
    const release = () => {
      if (!aiming) return;
      aiming = false;
      myL().active = false;
      if (!isOver()) sendShot();
    };
    window.addEventListener('mouseup', release);
    window.addEventListener('touchend', release);
    window.addEventListener('keydown', (ev) => {
      const l = myL();
      if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
        angle = Math.max(-160, Math.min(-20, angle + (ev.key === 'ArrowLeft' ? -4 : 4)));
        l.angle = angle; l.active = true;
      } else if (ev.key === ' ' || ev.key === 'Enter') {
        ev.preventDefault();
        sendShot();
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
    myL.color = next === '-' ? 'r' : next;
    otherL.color = 'r';
    myL.angle = angle;
    canvasOpts.warning = !!(msg.failed) || BC.bottomRowHas(canvasGrid);
    canvasOpts.fx = msg.fx || [];
    if (msg.fx && msg.fx.some(f => f.type === 'inject')) canvasOpts.sinkOffset = 1;
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
        if (!st || st.over) return;
        const res = applyShot(from, data);
        if (res) broadcastState(res.fx);
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
