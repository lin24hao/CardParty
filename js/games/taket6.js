// 谁是牛头王 Take 6 —— 主机权威
// 规则：104 张数字牌（1~104），每张带牛头数（尾数5=2、尾数0=3、双数11/22…99=5、55=7、其余=1）。
// 每人 10 张手牌，桌面 4 行。每回合所有人同时暗出一张，按数字升序放入行尾
// （放入后达到第 6 张须吃走前 5 张计分；无行可放时选一行整行吃走计分）。
// 10 回合后牛头总数最少者获胜。
const TakeT6 = (() => {
  let ctx = null;
  let state = null;      // 主机状态
  let mirror = null;     // 客机：公开状态镜像
  let myHand = [];       // 客机：我的手牌
  let epoch = 0;
  let localCard = null;  // 本地选中的手牌数字
  let localRow = null;   // 本地选中的吃行索引

  const ROUNDS = 10;

  function horns(n) {
    let h = 1;
    if (n % 10 === 5) h += 1;
    if (n % 10 === 0) h += 2;
    if (n % 11 === 0) h += 4;
    if (n === 55) h += 1;
    return h;
  }
  function rowHorns(row) { return row.reduce((s, n) => s + horns(n), 0); }

  function init(c) {
    ctx = c;
    state = null;
    mirror = null;
    myHand = [];
    localCard = null;
    localRow = null;
    if (ctx.isHost) hostStart();
    else render();
  }

  // ---------- 主机逻辑 ----------
  function hostStart() {
    epoch++;
    const players = ctx.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost, isBot: p.isBot, score: 0, hand: [] }));
    const deck = Deck.shuffle(Array.from({ length: 104 }, (_, i) => i + 1));
    players.forEach(p => { for (let k = 0; k < ROUNDS; k++) p.hand.push(deck.pop()); });
    const rows = [deck.pop(), deck.pop(), deck.pop(), deck.pop()].map(n => [n]);
    state = {
      players, rows, round: 1, phase: 'playing', chosen: {},
      action: '游戏开始：每人 10 张牌，请选择一张打出',
      lastRound: [], winnerIds: [], eatPromptFor: null, pending: null,
    };
    pushState();
    pushHands();
    render();
  }

  function receivePlay(fromId, card) {
    if (!state || state.phase !== 'playing') return;
    const p = state.players.find(x => x.id === fromId);
    if (!p) return;
    if (state.chosen[fromId]) return; // 已选过
    if (typeof card !== 'number') return;
    const idx = p.hand.indexOf(card);
    if (idx < 0) return;
    p.hand.splice(idx, 1);
    state.chosen[fromId] = card;
    const n = Object.keys(state.chosen).length;
    state.action = '出牌中：' + n + '/' + state.players.length + ' 人已出牌，等待其余玩家…';
    pushState();
    render();
    if (n === state.players.length) reveal();
  }

  function reveal() {
    if (!state || state.phase !== 'playing') return;
    state.phase = 'reveal';
    const plays = state.players
      .map(p => ({ id: p.id, card: state.chosen[p.id] }))
      .filter(x => x.card != null)
      .sort((a, b) => a.card - b.card);
    state.chosen = {};
    state.lastRound = [];
    state.pending = { plays, idx: 0 };
    state.eatPromptFor = null;
    state.action = '揭示结果…';
    pushState();
    resolveNext();
  }

  // 找差值最小的可放入行（行尾 < card）
  function bestRow(card) {
    let bi = -1, bd = Infinity;
    state.rows.forEach((row, i) => {
      const tail = row[row.length - 1];
      if (tail < card && card - tail < bd) { bd = card - tail; bi = i; }
    });
    return bi;
  }

  function resolveNext() {
    const pending = state.pending;
    if (!pending) return;
    if (pending.idx >= pending.plays.length) { afterReveal(); return; }
    const play = pending.plays[pending.idx];
    const p = state.players.find(x => x.id === play.id);
    if (!p) { pending.idx++; resolveNext(); return; }
    const card = play.card;
    const ri = bestRow(card);
    if (ri >= 0) {
      const row = state.rows[ri];
      if (row.length >= 5) {
        // 放入后满 6 张：强制吃走前 5 张
        const taken = row.slice();
        const h = rowHorns(taken);
        p.score += h;
        state.rows[ri] = [card];
        state.lastRound.push({ id: p.id, name: p.name, card, row: ri, action: 'ate', horns: h });
      } else {
        row.push(card);
        state.lastRound.push({ id: p.id, name: p.name, card, row: ri, action: 'placed' });
      }
      pending.idx++;
      resolveNext();
      return;
    }
    // 无行可放：真人需选择吃哪行；Bot 自动选牛头最少的一行
    if (p.isBot) {
      let bi = 0, bh = Infinity;
      state.rows.forEach((row, i) => { const h = rowHorns(row); if (h < bh) { bh = h; bi = i; } });
      eatRow(p, card, bi);
      return;
    }
    state.eatPromptFor = p.id;
    state.phase = 'eat';
    state.action = p.name + ' 的牌 ' + card + ' 无处可放，请选择要吃掉的一行';
    pushState();
    render();
  }

  function eatRow(p, card, rowIndex) {
    const row = state.rows[rowIndex];
    if (!row) return;
    const taken = row.slice();
    const h = rowHorns(taken);
    p.score += h;
    state.rows[rowIndex] = [card];
    state.lastRound.push({ id: p.id, name: p.name, card, row: rowIndex, action: 'pick', horns: h });
    state.eatPromptFor = null;
    state.phase = 'reveal';
    state.pending.idx++;
    resolveNext();
  }

  function hostEat(fromId, rowIndex) {
    if (!state || state.phase !== 'eat') return;
    if (state.eatPromptFor !== fromId) return;
    const p = state.players.find(x => x.id === fromId);
    const play = state.pending && state.pending.plays[state.pending.idx];
    if (!p || !play) return;
    if (typeof rowIndex !== 'number' || rowIndex < 0 || rowIndex >= state.rows.length) return;
    eatRow(p, play.card, rowIndex);
    pushState();
    pushHands();
    render();
  }

  function afterReveal() {
    if (!state) return;
    state.pending = null;
    state.eatPromptFor = null;
    if (state.round >= ROUNDS) {
      state.phase = 'ended';
      let min = Infinity;
      state.players.forEach(p => { if (p.score < min) min = p.score; });
      state.winnerIds = state.players.filter(p => p.score === min).map(p => p.id);
      const names = state.players.filter(p => state.winnerIds.includes(p.id)).map(p => p.name).join('、');
      state.action = '🏆 游戏结束！' + names + ' 牛头数最少（' + min + '），获胜！';
    } else {
      state.round++;
      state.phase = 'playing';
      state.chosen = {};
      state.action = '第 ' + state.round + ' 回合，请选择一张打出';
    }
    pushState();
    pushHands();
    render();
  }

  function pushState() {
    const pub = state.players.map(p => ({
      id: p.id, name: p.name, isHost: p.isHost, isBot: p.isBot, score: p.score, handCount: p.hand.length,
    }));
    Net.broadcast({
      type: 't6_state',
      round: state.round, phase: state.phase, rows: state.rows, players: pub,
      action: state.action, lastRound: state.lastRound, winnerIds: state.winnerIds,
      eatPromptFor: state.eatPromptFor, chosenIds: Object.keys(state.chosen),
    });
  }

  function pushHands() {
    for (const p of state.players) {
      if (p.id !== Net.myId()) Net.sendTo(p.id, { type: 't6_hand', hand: p.hand });
    }
  }

  // ---------- 消息处理 ----------
  function handleMessage(from, data) {
    if (!ctx || !data || !data.type) return;
    if (ctx.isHost) {
      if (data.type === 't6_play') receivePlay(from, data.card);
      else if (data.type === 't6_eat') hostEat(from, data.rowIndex);
    } else {
      if (data.type === 't6_state') { mirror = data; localCard = null; localRow = null; render(); }
      else if (data.type === 't6_hand') { myHand = data.hand || []; render(); }
    }
  }

  // ---------- 视图 ----------
  function view() {
    if (ctx.isHost) {
      const pub = state.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost, isBot: p.isBot, score: p.score, handCount: p.hand.length }));
      return {
        round: state.round, phase: state.phase, rows: state.rows, players: pub,
        action: state.action, lastRound: state.lastRound, winnerIds: state.winnerIds,
        eatPromptFor: state.eatPromptFor, chosenIds: Object.keys(state.chosen),
      };
    }
    return mirror;
  }

  function myCards() { return ctx.isHost ? state.players.find(p => p.id === Net.myId()).hand : myHand; }
  function haveChosen(v) { return (v.chosenIds || []).includes(Net.myId()); }

  function doPlay() {
    if (localCard == null) return;
    const msg = { type: 't6_play', card: localCard };
    if (ctx.isHost) receivePlay(Net.myId(), localCard);
    else Net.sendToHost(msg);
    localCard = null;
    render();
  }

  function doEat() {
    if (localRow == null) return;
    const msg = { type: 't6_eat', rowIndex: localRow };
    if (ctx.isHost) hostEat(Net.myId(), localRow);
    else Net.sendToHost(msg);
    localRow = null;
    render();
  }

  // ---------- 渲染 ----------
  function render() {
    if (!ctx) return;
    const c = ctx.container;
    UI.clear(c);
    const myId = Net.myId();
    const v = view();

    const frame = document.createElement('div');
    frame.className = 'game-frame';

    const tb = document.createElement('div');
    tb.className = 'game-topbar';
    const title = document.createElement('span');
    title.className = 'game-title';
    title.textContent = '🐂 谁是牛头王 Take 6';
    tb.appendChild(title);
    const right = document.createElement('div');
    right.style.cssText = 'display:flex;gap:8px;align-items:center;';
    if (ctx.solo) {
      const soloPill = document.createElement('span');
      soloPill.className = 'phase-pill solo';
      soloPill.textContent = '🤖 人机';
      right.appendChild(soloPill);
    }
    const pill = document.createElement('span');
    pill.className = 'phase-pill' + (v && v.phase === 'ended' ? ' warn' : '');
    pill.textContent = v ? ('第 ' + v.round + '/' + ROUNDS + ' 回合') : '准备中';
    right.appendChild(pill);
    const leaveBtn = document.createElement('button');
    leaveBtn.className = 'btn btn-ghost btn-sm';
    leaveBtn.textContent = '离开';
    leaveBtn.addEventListener('click', () => ctx.leave());
    right.appendChild(leaveBtn);
    tb.appendChild(right);
    frame.appendChild(tb);

    if (!v) {
      frame.appendChild(UI.banner('', '正在等待房主发牌…'));
      c.appendChild(frame);
      return;
    }

    frame.appendChild(UI.banner(v.phase === 'ended' ? 'danger' : '', v.action));

    // 分数榜
    const scoreRow = document.createElement('div');
    scoreRow.className = 't6-score-row';
    v.players.forEach(p => {
      const chip = document.createElement('div');
      chip.className = 't6-score';
      chip.innerHTML = (v.winnerIds && v.winnerIds.includes(p.id) ? '🏆 ' : '') + UI.esc(p.name) + (p.id === myId ? '（你）' : '') + '：🐂 <b>' + p.score + '</b>';
      scoreRow.appendChild(chip);
    });
    frame.appendChild(scoreRow);

    // 桌面 4 行
    const board = document.createElement('div');
    board.className = 't6-board';
    const isEatPhase = v.phase === 'eat' && v.eatPromptFor === myId;
    v.rows.forEach((row, i) => {
      const rowEl = document.createElement('div');
      rowEl.className = 't6-row' + (isEatPhase ? ' pickable' : '') + (localRow === i ? ' selected' : '');
      const label = document.createElement('span');
      label.className = 't6-row-label';
      label.textContent = (i + 1);
      rowEl.appendChild(label);
      row.forEach((n, k) => {
        const cell = document.createElement('div');
        cell.className = 't6-cell' + (k === row.length - 1 ? ' new' : '');
        cell.innerHTML = n + '<span class="t6-h">🐂×' + horns(n) + '</span>';
        rowEl.appendChild(cell);
      });
      if (isEatPhase) {
        rowEl.addEventListener('click', () => { localRow = i; render(); });
      }
      board.appendChild(rowEl);
    });
    frame.appendChild(board);

    if (isEatPhase) {
      const hint = document.createElement('div');
      hint.style.cssText = 'font-size:12px;color:var(--ink-2);margin:2px 0 6px;';
      hint.textContent = '你的牌无处可放，点击选择要吃掉的一行（吃掉的牛头会计入你的分数）：';
      frame.appendChild(hint);
    }

    // 上回合摘要
    if (v.lastRound && v.lastRound.length) {
      const log = document.createElement('div');
      log.className = 't6-log';
      log.textContent = '📋 上回合：' + v.lastRound.map(e => {
        if (e.action === 'placed') return e.name + ' 出 ' + e.card + ' → 第' + (e.row + 1) + '行';
        if (e.action === 'ate') return e.name + ' 出 ' + e.card + ' 触发满行，吃走第' + (e.row + 1) + '行（-🐂' + e.horns + '）';
        return e.name + ' 出 ' + e.card + ' 选择吃掉第' + (e.row + 1) + '行（-🐂' + e.horns + '）';
      }).join('；');
      frame.appendChild(log);
    }

    // 我的手牌
    const handTitle = document.createElement('div');
    handTitle.style.cssText = 'font-weight:700;margin:16px 0 8px;font-size:14px;';
    handTitle.textContent = v.phase === 'ended' ? '我的手牌' : (haveChosen(v) ? '我已出牌，等待其他玩家…' : '我的手牌（点击选中一张）');
    frame.appendChild(handTitle);
    const handWrap = document.createElement('div');
    handWrap.className = 't6-hand';
    const cards = myCards() || [];
    const canPick = v.phase === 'playing' && !haveChosen(v);
    cards.forEach((n, i) => {
      const el = document.createElement('div');
      el.className = 't6-card' + (localCard === n ? ' selected' : '') + (canPick ? '' : ' disabled');
      el.innerHTML = n + '<span class="t6-h">🐂×' + horns(n) + '</span>';
      if (canPick) el.addEventListener('click', () => { localCard = (localCard === n) ? null : n; render(); });
      handWrap.appendChild(el);
    });
    if (cards.length === 0) {
      const empty = document.createElement('span');
      empty.textContent = '（没有牌）';
      empty.style.cssText = 'color:var(--ink-2);';
      handWrap.appendChild(empty);
    }
    frame.appendChild(handWrap);

    // 操作条
    const bar = document.createElement('div');
    bar.className = 'actionbar';
    if (v.phase === 'playing' && !haveChosen(v)) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-primary';
      btn.textContent = '出牌';
      btn.disabled = localCard == null;
      btn.addEventListener('click', doPlay);
      bar.appendChild(btn);
    } else if (isEatPhase) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-primary';
      btn.textContent = '吃掉这一行';
      btn.disabled = localRow == null;
      btn.addEventListener('click', doEat);
      bar.appendChild(btn);
    } else if (v.phase === 'ended') {
      const btn = document.createElement('button');
      btn.className = 'btn btn-primary';
      btn.textContent = '返回房间';
      btn.addEventListener('click', () => ctx.leave());
      bar.appendChild(btn);
    }
    frame.appendChild(bar);

    c.appendChild(frame);
  }

  return { init, handleMessage };
})();
