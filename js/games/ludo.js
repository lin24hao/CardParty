// 飞行棋（Ludo）—— 主机权威
//
// 规则：
// - 2-4 人，每人 4 架飞机，颜色按加入顺序分配（红/黄/蓝/绿）
// - 14x14 棋盘：外圈 52 格轨道（每色 13 格），4 个起飞格为安全格（不可踩）
// - 每色拥有：4 格停机坪、5 格终点跑道 + 家
// - 掷骰子：掷到 6 可起飞一架且可再掷一次；掷完选择一组飞机移动
// - 己方多架同格可一起走（叠机）；踩中敌方单机将其送回停机坪，敌方叠机不可踩（阻挡）
// - 飞机必须恰好走到家（多走无效）；4 架全部到家的玩家获胜
//
// 位置编码：pos = -1 停机坪 | 0-51 轨道（相对本玩家起点）| 52-56 终点跑道（56=家）
const Ludo = (() => {
  const COLORS = ['red', 'yellow', 'blue', 'green'];
  const COLOR_NAME = { red: '红', yellow: '黄', blue: '蓝', green: '绿' };
  const COLOR_HEX = { red: '#e5484d', yellow: '#f0a92e', blue: '#2f6fed', green: '#18a058' };
  const TRACK_LEN = 52;
  const START_INDEX = [0, 13, 26, 39];   // 每色在轨道上的起点（安全格）
  const HOME_POS = 56;                   // 到家

  // 轨道坐标（外圈，顺时针：红顶边 → 黄右边 → 蓝底边 → 绿左边）
  const TRACK_COORDS = [];
  for (let i = 0; i < 13; i++) TRACK_COORDS.push([0, i]);        // 红 0-12
  for (let i = 0; i < 13; i++) TRACK_COORDS.push([i, 13]);       // 黄 13-25
  for (let i = 0; i < 13; i++) TRACK_COORDS.push([13, 13 - i]);  // 蓝 26-38
  for (let i = 0; i < 13; i++) TRACK_COORDS.push([13 - i, 0]);   // 绿 39-51

  // 终点跑道（每色 5 格：pos 52-56，最后 1 格紧邻中心家）
  const RUNWAY_COORDS = [
    [[1,6],[2,6],[3,6],[4,6],[5,6]],        // 红：从顶边入口向下
    [[6,12],[6,11],[6,10],[6,9],[6,8]],     // 黄：从右边入口向左
    [[12,7],[11,7],[10,7],[9,7],[8,7]],     // 蓝：从底边入口向上
    [[7,1],[7,2],[7,3],[7,4],[7,5]],        // 绿：从左边入口向右
  ];
  // 家（中心 2x2）
  const HOME_COORDS = [[6,6],[6,7],[7,6],[7,7]];
  // 停机坪 4 个停机位（飞机 i 在机场时停在停机位 i）
  const HANGAR_COORDS = [
    [[2,2],[2,3],[3,2],[3,3]],
    [[2,10],[2,11],[3,10],[3,11]],
    [[10,10],[10,11],[11,10],[11,11]],
    [[10,2],[10,3],[11,2],[11,3]],
  ];

  let ctx = null;
  let state = null;
  let mirror = null;

  // ---------- 坐标工具 ----------
  function trackIndexAt(r, c) {
    if (r === 0 && c >= 0 && c <= 12) return c;
    if (c === 13 && r >= 0 && r <= 12) return 13 + r;
    if (r === 13 && c >= 1 && c <= 13) return 26 + (13 - c);
    if (c === 0 && r >= 1 && r <= 13) return 39 + (13 - r);
    return -1;
  }
  function runwayAt(r, c) {
    for (let ci = 0; ci < 4; ci++) {
      for (let k = 0; k < 5; k++) {
        if (RUNWAY_COORDS[ci][k][0] === r && RUNWAY_COORDS[ci][k][1] === c) return { ci, k };
      }
    }
    return null;
  }
  function homeAt(r, c) {
    for (let ci = 0; ci < 4; ci++) {
      if (HOME_COORDS[ci][0] === r && HOME_COORDS[ci][1] === c) return ci;
    }
    return -1;
  }
  function hangarAt(r, c) {
    for (let ci = 0; ci < 4; ci++) {
      for (let k = 0; k < 4; k++) {
        if (HANGAR_COORDS[ci][k][0] === r && HANGAR_COORDS[ci][k][1] === c) return { ci, k };
      }
    }
    return null;
  }
  function zoneOf(r, c) {
    if (r >= 1 && r <= 6 && c >= 1 && c <= 6) return 0;
    if (r >= 1 && r <= 6 && c >= 7 && c <= 12) return 1;
    if (r >= 7 && r <= 12 && c >= 7 && c <= 12) return 2;
    if (r >= 7 && r <= 12 && c >= 1 && c <= 6) return 3;
    return -1;
  }

  // ---------- 主机逻辑 ----------
  function init(c) {
    ctx = c;
    state = null;
    mirror = null;
    if (ctx.isHost) hostStart();
    else render();
  }

  function hostStart() {
    const players = ctx.players.map((p, i) => ({
      id: p.id, name: p.name, isHost: p.isHost, isBot: p.isBot, color: COLORS[i % 4],
    }));
    const planes = {};
    players.forEach(p => { planes[p.id] = [-1, -1, -1, -1]; });
    state = {
      players, planes,
      currentId: players.length ? players[0].id : null,
      phase: 'roll', dice: null, moves: [],
      lastEvent: '游戏开始！掷到 6 才能起飞，率先让 4 架飞机进港者获胜', winnerId: null,
    };
    pushState(); render();
  }

  function rollDice() { return 1 + Math.floor(Math.random() * 6); }
  function ciOf(pid) { return state.players.findIndex(p => p.id === pid); }
  function pName(pid) { const p = state.players.find(x => x.id === pid); return p ? p.name : '玩家'; }
  function homeCount(pid) { return state.planes[pid].filter(x => x === HOME_POS).length; }

  // 计算当前玩家掷出骰子后的所有可移动组（按相对位置分组）
  function computeMoves(pid) {
    const ci = ciOf(pid);
    if (ci < 0 || !state.dice) return [];
    const planes = state.planes[pid];
    const moves = [];
    const seen = new Set();
    for (let i = 0; i < 4; i++) {
      const rel = planes[i];
      if (seen.has(rel)) continue;
      seen.add(rel);
      const group = planes.filter(x => x === rel).length;
      if (rel === -1) {
        if (state.dice === 6) moves.push({ from: -1, to: 0, take: false, group, label: '起飞' });
        continue;
      }
      if (rel >= 52) { // 终点跑道内，无踩踏
        if (rel + state.dice <= HOME_POS) moves.push({ from: rel, to: rel + state.dice, take: false, group, label: '跑道' });
        continue;
      }
      const to = rel + state.dice;
      if (to <= 51) { // 仍在轨道
        const abs = (START_INDEX[ci] + to) % TRACK_LEN;
        if (abs % 13 === 0) { moves.push({ from: rel, to, take: false, group, label: '安全' }); continue; }
        let enemy = 0;
        state.players.forEach(op => {
          if (op.id === pid) return;
          const oi = ciOf(op.id);
          state.planes[op.id].forEach(orel => {
            if (orel >= 0 && orel <= 51 && (START_INDEX[oi] + orel) % TRACK_LEN === abs) enemy++;
          });
        });
        if (enemy >= 2) continue; // 敌方叠机阻挡
        moves.push({ from: rel, to, take: enemy === 1, group, label: enemy === 1 ? '踩' : '走' });
      } else { // 进入终点跑道
        if (to <= HOME_POS) moves.push({ from: rel, to, take: false, group, label: '进港' });
      }
    }
    return moves;
  }

  function hostRoll(fromId) {
    if (!state || state.phase !== 'roll' || fromId !== state.currentId) return;
    state.dice = rollDice();
    state.moves = computeMoves(fromId);
    if (!state.moves.length) {
      state.lastEvent = pName(fromId) + ' 掷出 ' + state.dice + '，无子可动';
      nextTurn();
      pushState(); render();
      return;
    }
    state.phase = 'choose';
    state.lastEvent = pName(fromId) + ' 掷出 ' + state.dice + (state.dice === 6 ? '（可再掷一次），请选择要移动的飞机' : '，请选择要移动的飞机');
    pushState(); render();
  }

  function hostMove(fromId, fromPos) {
    if (!state || state.phase !== 'choose' || fromId !== state.currentId) return;
    const mv = state.moves.find(m => m.from === fromPos);
    if (!mv) return;
    const ci = ciOf(fromId);
    // 整组一起移动（叠机）
    state.planes[fromId] = state.planes[fromId].map(p => (p === mv.from ? mv.to : p));
    // 踩踏：目标格敌方单机送回停机坪
    let taken = null;
    if (mv.take) {
      const abs = (START_INDEX[ci] + mv.to) % TRACK_LEN;
      state.players.forEach(op => {
        if (op.id === fromId) return;
        const oi = ciOf(op.id);
        state.planes[op.id] = state.planes[op.id].map(p => {
          if (p >= 0 && p <= 51 && (START_INDEX[oi] + p) % TRACK_LEN === abs) { taken = op.name; return -1; }
          return p;
        });
      });
    }
    let ev = pName(fromId) + ' 掷 ' + state.dice + '，' + describeMove(mv);
    if (taken) ev += '，踩回了 ' + taken + ' 的飞机！';
    if (mv.to === HOME_POS) ev += '，一架飞机到家！';
    // 胜负：4 架全部到家
    if (homeCount(fromId) === 4) {
      state.winnerId = fromId;
      state.phase = 'ended';
      state.lastEvent = '🏆 ' + pName(fromId) + ' 率先让全部 4 架飞机进港，获胜！';
      pushState(); render();
      return;
    }
    if (state.dice === 6) {
      state.phase = 'roll';
      state.lastEvent = ev + '（掷到 6，再掷一次）';
    } else {
      nextTurn();
      state.lastEvent = ev + ' · 轮到 ' + pName(state.currentId);
    }
    state.moves = [];
    pushState(); render();
  }

  function describeMove(mv) {
    if (mv.from === -1) return '起飞 1 架飞机';
    let s = '移动 ' + mv.group + ' 架飞机';
    if (mv.to === HOME_POS) s += '到家';
    return s;
  }

  function nextTurn() {
    const n = state.players.length;
    if (!n) return;
    const idx = state.players.findIndex(p => p.id === state.currentId);
    state.currentId = state.players[(idx + 1) % n].id;
    state.phase = 'roll';
    state.dice = null;
    state.moves = [];
  }

  // ---------- 消息 ----------
  function handleMessage(from, data) {
    if (!ctx || !data || !data.type) return;
    if (ctx.isHost) {
      if (data.type === 'ludo_roll') hostRoll(from);
      else if (data.type === 'ludo_move') hostMove(from, data.fromPos);
    } else {
      if (data.type === 'ludo_state') { mirror = data; render(); }
    }
  }

  function doRoll() { if (ctx.isHost) hostRoll(Net.myId()); else Net.sendToHost({ type: 'ludo_roll' }); }
  function doMove(fromPos) { if (ctx.isHost) hostMove(Net.myId(), fromPos); else Net.sendToHost({ type: 'ludo_move', fromPos }); }

  function buildPub() {
    return {
      players: state.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost, isBot: p.isBot, color: p.color })),
      planes: state.planes,
      currentId: state.currentId, phase: state.phase, dice: state.dice,
      moves: state.moves, lastEvent: state.lastEvent, winnerId: state.winnerId,
    };
  }
  function pushState() { Net.broadcast({ type: 'ludo_state', ...buildPub() }); }
  function view() { return ctx.isHost ? buildPub() : mirror; }

  // ---------- 视图 ----------
  function tokenEl(p) {
    const el = document.createElement('div');
    el.className = 'ludo-plane';
    el.style.background = COLOR_HEX[p.color];
    el.title = p.name;
    return el;
  }
  function addTokens(cell, list) {
    list.forEach(({ p }) => cell.appendChild(tokenEl(p)));
  }
  function planesAtTrack(v, ti) {
    const out = [];
    v.players.forEach((p, ci) => {
      v.planes[p.id].forEach(rel => {
        if (rel >= 0 && rel <= 51 && (START_INDEX[ci] + rel) % TRACK_LEN === ti) out.push({ p, rel });
      });
    });
    return out;
  }
  function planesAtRunway(v, ci, k) {
    const out = [];
    v.players.forEach(p => {
      v.planes[p.id].forEach(rel => { if (rel === 52 + k) out.push({ p, rel }); });
    });
    return out;
  }
  function planesAtHome(v, ci) {
    const out = [];
    v.players.forEach(p => {
      v.planes[p.id].forEach(rel => { if (rel === HOME_POS) out.push({ p, rel }); });
    });
    return out;
  }
  function homeCountOf(v, pid) { return (v.planes[pid] || []).filter(x => x === HOME_POS).length; }

  function buildBoard(v) {
    const board = document.createElement('div');
    board.className = 'ludo-board';
    const myId = Net.myId();
    const myCi = v.players.findIndex(p => p.id === myId);
    const myMoves = (v.currentId === myId && v.phase === 'choose') ? (v.moves || []) : [];
    for (let r = 0; r < 14; r++) {
      for (let c = 0; c < 14; c++) {
        const cell = document.createElement('div');
        cell.className = 'ludo-cell';
        const ti = trackIndexAt(r, c);
        const rw = runwayAt(r, c);
        const hm = homeAt(r, c);
        const hg = hangarAt(r, c);
        if (ti >= 0) {
          cell.classList.add('ludo-track', 'ludo-c-' + COLORS[Math.floor(ti / 13)]);
          if (ti % 13 === 0) cell.classList.add('ludo-safe');
          if (myCi >= 0 && myMoves.some(m => m.from >= 0 && m.from <= 51 && (START_INDEX[myCi] + m.from) % TRACK_LEN === ti)) cell.classList.add('ludo-avail');
          addTokens(cell, planesAtTrack(v, ti));
        } else if (hm >= 0) {
          cell.classList.add('ludo-home', 'ludo-c-' + COLORS[hm]);
          addTokens(cell, planesAtHome(v, hm));
        } else if (rw) {
          cell.classList.add('ludo-runway', 'ludo-c-' + COLORS[rw.ci]);
          if (rw.k === 4) cell.classList.add('ludo-runway-end');
          if (myCi >= 0 && myMoves.some(m => m.from === 52 + rw.k)) cell.classList.add('ludo-avail');
          addTokens(cell, planesAtRunway(v, rw.ci, rw.k));
        } else if (hg) {
          cell.classList.add('ludo-hangar', 'ludo-c-' + COLORS[hg.ci]);
          const p = v.players[hg.ci];
          if (p && v.planes[p.id] && v.planes[p.id][hg.k] === -1) {
            cell.appendChild(tokenEl(p));
            if (myCi >= 0 && myMoves.some(m => m.from === -1) && hg.ci === myCi) cell.classList.add('ludo-avail');
          }
        } else {
          const z = zoneOf(r, c);
          if (z >= 0) cell.classList.add('ludo-zone', 'ludo-c-' + COLORS[z]);
          else cell.classList.add('ludo-blank');
        }
        board.appendChild(cell);
      }
    }
    return board;
  }

  function renderActions(v) {
    const bar = document.createElement('div');
    bar.className = 'actionbar';
    const myId = Net.myId();
    if (!v) return bar;
    if (v.phase === 'ended') {
      if (ctx.isHost) {
        const again = document.createElement('button');
        again.className = 'btn btn-primary';
        again.textContent = '再来一局';
        again.addEventListener('click', () => hostStart());
        bar.appendChild(again);
      }
      const back = document.createElement('button');
      back.className = 'btn btn-ghost';
      back.textContent = '返回房间';
      back.addEventListener('click', () => ctx.leave());
      bar.appendChild(back);
      return bar;
    }
    const cur = v.players.find(p => p.id === v.currentId);
    if (v.currentId === myId) {
      if (v.phase === 'roll') {
        const b = document.createElement('button');
        b.className = 'btn btn-primary btn-lg';
        b.textContent = '🎲 掷骰子';
        b.addEventListener('click', doRoll);
        bar.appendChild(b);
      } else if (v.phase === 'choose') {
        const hint = document.createElement('div');
        hint.className = 'ludo-move-hint';
        hint.textContent = '选择要移动的飞机：';
        bar.appendChild(hint);
        const row = document.createElement('div');
        row.className = 'ludo-move-row';
        (v.moves || []).forEach(mv => {
          const b = document.createElement('button');
          b.className = 'btn ' + (mv.take ? 'btn-primary' : 'btn-ghost') + ' btn-sm ludo-move-btn';
          let label = mv.from === -1 ? '✈️ 起飞' : '移动 ' + mv.group + ' 架';
          if (mv.take) label += ' ⚔️ 踩';
          if (mv.to === HOME_POS) label += ' 🏠';
          b.textContent = label;
          b.addEventListener('click', () => doMove(mv.from));
          row.appendChild(b);
        });
        bar.appendChild(row);
      }
    } else {
      const wait = document.createElement('span');
      wait.className = 'ludo-wait';
      wait.textContent = '等待 ' + (cur ? cur.name : '') + (v.phase === 'roll' ? ' 掷骰子' : ' 移动飞机') + '…';
      bar.appendChild(wait);
    }
    return bar;
  }

  function render() {
    if (!ctx) return;
    const c = ctx.container;
    UI.clear(c);
    const v = view();
    const frame = document.createElement('div');
    frame.className = 'game-frame';

    // 顶栏
    const tb = document.createElement('div');
    tb.className = 'game-topbar';
    const title = document.createElement('span');
    title.className = 'game-title';
    title.textContent = '✈️ 飞行棋';
    tb.appendChild(title);
    const right = document.createElement('div');
    right.style.cssText = 'display:flex;gap:8px;align-items:center;';
    if (ctx.solo) {
      const sp = document.createElement('span');
      sp.className = 'phase-pill solo';
      sp.textContent = '🤖 人机';
      right.appendChild(sp);
    }
    const pill = document.createElement('span');
    pill.className = 'phase-pill' + (v && v.phase === 'ended' ? ' ok' : '');
    pill.textContent = !v ? '准备中' : (v.phase === 'roll' ? '掷骰' : (v.phase === 'choose' ? '移动' : '已结束'));
    right.appendChild(pill);
    const leaveBtn = document.createElement('button');
    leaveBtn.className = 'btn btn-ghost btn-sm';
    leaveBtn.textContent = '离开';
    leaveBtn.addEventListener('click', () => ctx.leave());
    right.appendChild(leaveBtn);
    tb.appendChild(right);
    frame.appendChild(tb);

    if (!v) {
      frame.appendChild(UI.banner('', '正在等待房主开局…'));
      c.appendChild(frame);
      return;
    }

    // 事件提示
    frame.appendChild(UI.banner(v.phase === 'ended' ? 'ok' : '', v.lastEvent || ''));

    // 骰子
    const mid = document.createElement('div');
    mid.className = 'ludo-mid';
    if (v.dice != null) {
      const dw = document.createElement('div');
      dw.className = 'ludo-die-wrap';
      const die = document.createElement('div');
      die.className = 'ludo-die' + (v.phase === 'choose' ? ' just' : '');
      die.dataset.val = String(v.dice);
      for (let i = 0; i < 9; i++) die.appendChild(document.createElement('i'));
      dw.appendChild(die);
      const dt = document.createElement('div');
      dt.className = 'ludo-die-text';
      dt.textContent = '掷出 ' + v.dice;
      dw.appendChild(dt);
      mid.appendChild(dw);
    }
    frame.appendChild(mid);

    // 玩家状态（含到家数）
    const sb = document.createElement('div');
    sb.className = 'scoreboard';
    v.players.forEach(p => {
      const chip = document.createElement('span');
      chip.className = 'score-chip' + (p.id === v.currentId && v.phase !== 'ended' ? ' win' : '');
      const dot = document.createElement('i');
      dot.className = 'ludo-dot';
      dot.style.background = COLOR_HEX[p.color];
      chip.appendChild(dot);
      const nm = document.createElement('span');
      nm.textContent = ' ' + p.name + ' ';
      chip.appendChild(nm);
      const cnt = document.createElement('b');
      cnt.textContent = homeCountOf(v, p.id) + '/4';
      chip.appendChild(cnt);
      sb.appendChild(chip);
    });
    frame.appendChild(sb);

    // 棋盘
    frame.appendChild(buildBoard(v));

    // 操作条
    frame.appendChild(renderActions(v));

    c.appendChild(frame);
  }

  return { init, handleMessage };
})();
