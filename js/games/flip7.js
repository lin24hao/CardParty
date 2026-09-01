// 翻牌7 Flip 7 —— 主机权威
// 规则：牌堆含数字 1-6 各 6 张与炸牌 7 共 42 张。轮流翻牌，累计点数；
//       翻到 7 或累计超过 21 则本轮爆炸得 0 分；可随时停止结算（本轮累计 + 凑对加成：同数字每 2 张 +1）。
// 共 5 轮，总分最高者胜。
const Flip7 = (() => {
  let ctx = null;
  let state = null;
  let mirror = null;
  let epoch = 0;

  const ROUNDS = 5;
  const BUST_LIMIT = 21;

  function buildDeck() {
    const cards = [];
    for (let num = 1; num <= 7; num++) {
      for (let i = 0; i < 6; i++) cards.push(num);
    }
    return cards;
  }
  function pairBonus(nums) {
    const cnt = {};
    nums.forEach(n => { cnt[n] = (cnt[n] || 0) + 1; });
    let bonus = 0;
    for (const k in cnt) bonus += Math.floor(cnt[k] / 2);
    return bonus;
  }

  function init(c) {
    ctx = c;
    state = null;
    mirror = null;
    if (ctx.isHost) hostStart();
    else render();
  }

  // ---------- 主机逻辑 ----------
  function hostStart() {
    epoch++;
    const players = ctx.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost, isBot: p.isBot, total: 0, roundScores: [] }));
    state = {
      players, deck: Deck.shuffle(buildDeck()), round: 1, roundStep: 0, roundNums: [], sum: 0,
      currentIdx: 0, phase: 'preparing', action: '游戏开始：共 ' + ROUNDS + ' 轮，翻到 7 或超过 21 则爆炸', winnerIds: [], lastAction: '',
    };
    beginTurn();
  }

  function beginTurn() {
    const cur = state.players[state.currentIdx];
    state.phase = 'flipping';
    state.action = '第 ' + state.round + '/' + ROUNDS + ' 轮，轮到 ' + cur.name + '：翻一张或停止（当前累计 ' + state.sum + '）';
    pushState();
    render();
  }

  function doFlip(fromId) {
    if (!state || state.phase !== 'flipping') return;
    const cur = state.players[state.currentIdx];
    if (!cur || cur.id !== fromId) return;
    if (!state.deck.length) { autoStop(cur); return; }
    const card = state.deck.pop();
    if (card === 7) {
      state.lastAction = cur.name + ' 翻到 💥7，本轮爆炸，得 0 分';
      finishRound(cur, 0);
      return;
    }
    const newSum = state.sum + card;
    if (newSum > BUST_LIMIT) {
      state.lastAction = cur.name + ' 翻到 ' + card + '，累计 ' + newSum + ' 超过 ' + BUST_LIMIT + '，💥 爆炸，得 0 分';
      finishRound(cur, 0);
      return;
    }
    state.roundNums.push(card);
    state.sum = newSum;
    state.action = cur.name + ' 翻到 ' + card + '，累计 ' + newSum + '：继续翻或停止';
    pushState();
    render();
  }

  function doStop(fromId) {
    if (!state || state.phase !== 'flipping') return;
    const cur = state.players[state.currentIdx];
    if (!cur || cur.id !== fromId) return;
    const score = state.sum + pairBonus(state.roundNums);
    state.lastAction = cur.name + ' 停止，本轮得 ' + score + ' 分（累计 ' + state.sum + ' + 凑对 ' + pairBonus(state.roundNums) + '）';
    finishRound(cur, score);
  }

  function autoStop(cur) {
    const score = state.sum + pairBonus(state.roundNums);
    state.lastAction = '牌堆已空，' + cur.name + ' 自动停止，本轮得 ' + score + ' 分';
    finishRound(cur, score);
  }

  function finishRound(cur, score) {
    cur.roundScores.push(score);
    cur.total += score;
    state.roundStep++;
    if (state.roundStep >= state.players.length) {
      if (state.round >= ROUNDS) { endGame(); return; }
      state.round++;
      state.roundStep = 0;
      state.roundNums = [];
      state.sum = 0;
      state.currentIdx = 0;
      beginTurn();
      return;
    }
    state.roundNums = [];
    state.sum = 0;
    state.currentIdx = (state.currentIdx + 1) % state.players.length;
    beginTurn();
  }

  function endGame() {
    state.phase = 'ended';
    let max = -Infinity;
    state.players.forEach(p => { if (p.total > max) max = p.total; });
    state.winnerIds = state.players.filter(p => p.total === max).map(p => p.id);
    const names = state.players.filter(p => state.winnerIds.includes(p.id)).map(p => p.name).join('、');
    state.action = '🏆 游戏结束！' + names + ' 总分最高（' + max + '），获胜！';
    pushState();
    render();
  }

  function pushState() {
    const pub = state.players.map(p => ({
      id: p.id, name: p.name, isHost: p.isHost, isBot: p.isBot, total: p.total,
      roundScores: p.roundScores.slice(), handCount: 0,
    }));
    const cur = state.players[state.currentIdx];
    Net.broadcast({
      type: 'f7_state',
      deckCount: state.deck.length,
      round: state.round,
      roundNums: state.roundNums.slice(),
      sum: state.sum,
      currentId: cur ? cur.id : null,
      phase: state.phase,
      players: pub,
      action: state.action,
      lastAction: state.lastAction,
      winnerIds: state.winnerIds,
    });
  }

  // ---------- 消息处理 ----------
  function handleMessage(from, data) {
    if (!ctx || !data || !data.type) return;
    if (ctx.isHost) {
      if (data.type === 'f7_flip') doFlip(from);
      else if (data.type === 'f7_stop') doStop(from);
    } else {
      if (data.type === 'f7_state') { mirror = data; render(); }
    }
  }

  // ---------- 视图 ----------
  function view() {
    if (ctx.isHost) {
      const pub = state.players.map(p => ({
        id: p.id, name: p.name, isHost: p.isHost, isBot: p.isBot, total: p.total, roundScores: p.roundScores.slice(), handCount: 0,
      }));
      const cur = state.players[state.currentIdx];
      return {
        deckCount: state.deck.length, round: state.round, roundNums: state.roundNums.slice(), sum: state.sum,
        currentId: cur ? cur.id : null, phase: state.phase, players: pub, action: state.action,
        lastAction: state.lastAction, winnerIds: state.winnerIds,
      };
    }
    return mirror;
  }

  function isMyTurn(v) { return v.phase === 'flipping' && v.currentId === Net.myId(); }

  function doFlipClick() {
    const msg = { type: 'f7_flip' };
    if (ctx.isHost) doFlip(Net.myId());
    else Net.sendToHost(msg);
    render();
  }
  function doStopClick() {
    const msg = { type: 'f7_stop' };
    if (ctx.isHost) doStop(Net.myId());
    else Net.sendToHost(msg);
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
    title.textContent = '🎲 翻牌7 Flip 7';
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
    pill.textContent = v ? ('第 ' + v.round + '/' + ROUNDS + ' 轮 · 牌堆 ' + v.deckCount) : '准备中';
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
    scoreRow.className = 'f7-score-row';
    v.players.forEach(p => {
      const chip = document.createElement('div');
      chip.className = 'f7-score' + (v.currentId === p.id && v.phase === 'flipping' ? ' active' : '');
      chip.innerHTML = (v.winnerIds && v.winnerIds.includes(p.id) ? '🏆 ' : '') + UI.esc(p.name) + (p.id === myId ? '（你）' : '') + '：<b>' + p.total + '</b> 分' + (p.roundScores.length ? '（' + p.roundScores.join('/') + '）' : '');
      scoreRow.appendChild(chip);
    });
    frame.appendChild(scoreRow);

    // 本轮翻出的牌
    const board = document.createElement('div');
    board.className = 'f7-board';
    (v.roundNums || []).forEach((n, i) => {
      const cell = document.createElement('div');
      cell.className = 'f7-cell' + (i === v.roundNums.length - 1 ? ' new' : '');
      cell.textContent = n;
      board.appendChild(cell);
    });
    if (!v.roundNums || !v.roundNums.length) {
      const empty = document.createElement('span');
      empty.textContent = '本轮尚未翻牌';
      empty.style.cssText = 'color:var(--ink-2);font-size:13px;';
      board.appendChild(empty);
    }
    frame.appendChild(board);

    const sumEl = document.createElement('div');
    sumEl.className = 'f7-sum';
    sumEl.textContent = '当前累计：' + v.sum + ' / ' + BUST_LIMIT + '（超过即爆炸）';
    frame.appendChild(sumEl);

    if (v.lastAction) {
      const log = document.createElement('div');
      log.className = 't6-log';
      log.textContent = '📋 ' + v.lastAction;
      frame.appendChild(log);
    }

    // 操作条
    const bar = document.createElement('div');
    bar.className = 'actionbar';
    if (v.phase === 'flipping' && isMyTurn(v)) {
      const b1 = document.createElement('button');
      b1.className = 'btn btn-primary';
      b1.textContent = '翻一张';
      b1.disabled = v.deckCount <= 0;
      b1.addEventListener('click', doFlipClick);
      bar.appendChild(b1);
      const b2 = document.createElement('button');
      b2.className = 'btn btn-ghost';
      b2.textContent = '停止结算';
      b2.addEventListener('click', doStopClick);
      bar.appendChild(b2);
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
