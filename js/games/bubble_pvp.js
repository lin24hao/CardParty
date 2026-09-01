// 泡泡龙·对抗版（BubblePVP）v2 —— 单场比分制：双方各自场地消除泡泡，隐藏对方场景只更新分数
// 一方出局后等待另一方也出局，再按比分定胜负；无轮次限制，双方独立自由发射
// 接口：init(ctx) / handleMessage(from, data)，主机权威
window.BubblePvp = (() => {
  const BC = window.BubbleCore;
  const MSG_SHOT = 'bubble_pvp_shot';
  const MSG_STATE = 'bubble_pvp_state';
  const MSG_RESTART = 'bubble_pvp_restart';
  const COLS = BC.COLS, ROWS = BC.ROWS, CELL_W = BC.CELL_W, CELL_H = BC.CELL_H;

  let ctx = null;            // init 注入的上下文 {container, players, myId, isHost, gameType, solo, leave}
  let st = null;             // 主机权威状态
  let me = null;             // 非主机：我的视图 {board, queue, score, failed}
  let rival = null;          // 非主机：对手视图 {score, failed}
  let over = false, winner = null;
  let canvas = null;
  let canvasGrid = BC.makeGrid();
  let canvasOpts = { launchers: [launcher(COLS * CELL_W / 2)], warning: false, live: true, fx: [] };
  let angle = -90, aiming = false;

  function launcher(x) { return { x, angle: -90, color: 'r', active: false }; }

  function makeState() {
    const players = {};
    (ctx.players || []).forEach((pl, i) => { players[pl.id] = { id: pl.id, name: pl.name, idx: i }; });
    return {
      players, boards: {}, queues: {}, scores: {}, failed: {},
      failedSeq: [], over: false, winner: null, tick: 0,
    };
  }

  function newGame() {
    st = makeState();
    for (const id of Object.keys(st.players)) {
      st.boards[id] = BC.makeInitial(4, Math.random);
      st.queues[id] = BC.makeQueue(60, Math.random);
      st.scores[id] = 0;
      st.failed[id] = false;
    }
    st.failedSeq = []; st.over = false; st.winner = null;
    over = false; winner = null; me = null; rival = null;
  }

  function hostStart() { newGame(); broadcastState(null); }

  function applyShot(id, payload) {
    const grid = st.boards[id];
    const q = st.queues[id];
    if (st.failed[id] || st.over || !payload || payload.angle == null) return null;
    const color = q.shift() || BC.COLORS[0];
    q.push(color);
    const before = JSON.stringify(grid);
    const ft = BC.flyTrail(grid, COLS * CELL_W / 2, BC.LAUNCH_Y, payload.angle);
    if (!ft.cell) { q.pop(); q.unshift(color); return null; }
    const res = BC.resolve(grid, ft.cell, color);
    st.scores[id] += res.removed * 10 + res.dropped * 5;
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
      st.failed[id] = true;
      st.failedSeq.push(id);
      ev.push({ type: 'fail' });
      const ids = Object.keys(st.players);
      if (st.failedSeq.length >= ids.length) {
        st.over = true;
        const sorted = ids.slice().sort((a, b) => st.scores[b] - st.scores[a]);
        st.winner = st.scores[sorted[0]] === st.scores[sorted[1]] ? null : sorted[0];
      }
    }
    return { ev, fx: BC.makeFx(ev, Date.now()) };
  }
  function broadcastState(fxById) {
    const ids = Object.keys(st.players);
    for (const id of ids) {
      const rivalId = ids.find(x => x !== id);
      const msg = {
        type: MSG_STATE,
        me: { board: st.boards[id], queue: st.queues[id], score: st.scores[id], failed: st.failed[id] },
        rival: { score: rivalId ? st.scores[rivalId] : 0, failed: !!(rivalId && st.failed[rivalId]) },
        over: st.over, winner: st.winner,
        fx: fxById ? fxById[id] : null,
      };
      if (id === Net.myId()) { applyState(msg); } else { Net.sendTo(id, msg); }
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
    over = false; winner = null; me = null; rival = null; angle = -90; aiming = false;
    buildUI();
    if (ctx.isHost) hostStart();
  }

  function buildUI() {
    if (!ctx || !ctx.container) return;
    const host = document.createElement('div');
    host.className = 'bubble-wrap';
    host.innerHTML = ''
      + '<div class="bubble-head"><span class="bubble-title">泡泡龙对抗</span><span class="bubble-score" id="pvp-my-score">0</span></div>'
      + '<div class="bubble-stage"><canvas class="bubble-canvas" id="pvp-my-canvas"></canvas></div>'
      + '<div class="bubble-bar">'
      + '  <span>下一颗：<b id="pvp-next">-</b></span>'
      + '  <span id="pvp-rival">对手 0 分</span>'
      + '  <button class="bubble-btn" id="pvp-reset">再来一局</button>'
      + '</div>'
      + '<div class="bubble-status" id="pvp-status">准备中…</div>';
    ctx.container.appendChild(host);
    canvas = document.getElementById('pvp-my-canvas');
    canvasGrid = BC.makeGrid();
    canvasOpts = { launchers: [launcher(COLS * CELL_W / 2)], warning: false, live: true, fx: [] };
    BC.attachCanvas(canvas, canvasGrid, canvasOpts);
    BC.ensureAnim();
    bindInput();
  }

  function bindInput() {
    if (!canvas) return;
    const setAngle = (ev) => {
      const rect = canvas.getBoundingClientRect();
      const cx = (ev.touches ? ev.touches[0].clientX : ev.clientX) - rect.left;
      const cy = (ev.touches ? ev.touches[0].clientY : ev.clientY) - rect.top;
      let a = Math.atan2(cx - rect.width / 2, rect.height - 16 - cy) * 180 / Math.PI;
      a = Math.max(-160, Math.min(-20, a));
      angle = a;
      canvasOpts.launchers[0].angle = a;
      canvasOpts.launchers[0].active = true;
    };
    canvas.addEventListener('mousedown', (ev) => { aiming = true; setAngle(ev); ev.preventDefault(); });
    canvas.addEventListener('touchstart', (ev) => { aiming = true; setAngle(ev); ev.preventDefault(); }, { passive: false });
    window.addEventListener('mousemove', (ev) => { if (aiming) setAngle(ev); });
    window.addEventListener('touchmove', (ev) => { if (aiming) { setAngle(ev); ev.preventDefault(); } }, { passive: false });
    const release = () => {
      if (!aiming) return;
      aiming = false;
      canvasOpts.launchers[0].active = false;
      if (!isOver()) sendShot();
    };
    window.addEventListener('mouseup', release);
    window.addEventListener('touchend', release);
    window.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
        angle = Math.max(-160, Math.min(-20, angle + (ev.key === 'ArrowLeft' ? -4 : 4)));
        canvasOpts.launchers[0].angle = angle;
        canvasOpts.launchers[0].active = true;
      } else if (ev.key === ' ' || ev.key === 'Enter') {
        ev.preventDefault();
        sendShot();
      }
    });
    const btn = document.getElementById('pvp-reset');
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

  function isOver() { return over || (me && me.failed); }

  // 收到主机状态
  function applyState(msg) {
    me = msg.me || me;
    rival = msg.rival || rival;
    over = msg.over;
    winner = msg.winner;
    if (!me) return;
    canvasGrid = me.board || BC.makeGrid();
    const next = (me.queue && me.queue[0]) || '-';
    canvasOpts.launchers[0].color = next === '-' ? 'r' : next;
    canvasOpts.launchers[0].angle = angle;
    canvasOpts.warning = !!(me.failed) || BC.bottomRowHas(canvasGrid);
    if (msg.fx) {
      canvasOpts.fx = msg.fx;
      if (msg.fx.some(f => f.type === 'inject')) canvasOpts.sinkOffset = 1;
    } else {
      canvasOpts.fx = [];
    }
    BC.attachCanvas(canvas, canvasGrid, canvasOpts);
    BC.ensureAnim();
    const scoreEl = document.getElementById('pvp-my-score');
    if (scoreEl) scoreEl.textContent = me.score != null ? me.score : 0;
    const nextEl = document.getElementById('pvp-next');
    if (nextEl) nextEl.textContent = next;
    const rEl = document.getElementById('pvp-rival');
    if (rEl) rEl.textContent = '对手 ' + (rival ? rival.score : 0) + ' 分' + (rival && rival.failed ? '（已出局）' : '');
    const stEl = document.getElementById('pvp-status');
    if (stEl) {
      if (over) {
        if (winner == null) stEl.textContent = '平局！';
        else stEl.textContent = '你' + (winner === ctx.myId ? '赢了！' : '输了');
      } else if (me.failed) {
        stEl.textContent = '你已出局，等待对手结束…';
      } else {
        stEl.textContent = '按住瞄准，松开发射（键盘 ←→ 调整、空格发射）';
      }
    }
  }

  function handleMessage(from, data) {
    if (!ctx || !data || !data.type) return;
    if (ctx.isHost) {
      if (data.type === MSG_SHOT) {
        if (!st || st.over) return;
        const res = applyShot(from, data);
        if (res) broadcastState({ [from]: res.fx });
      } else if (data.type === MSG_RESTART) {
        newGame(); broadcastState(null);
      }
    } else {
      if (data.type === MSG_STATE) applyState(data);
    }
  }

  return { init, handleMessage };
})();
window.BubblePvp = BubblePvp;
