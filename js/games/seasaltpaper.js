// 海盐与纸 Sea Salt & Paper —— 主机权威
// 规则：40 张海洋主题牌（4 色 × 点数 1-10）。每回合自动抽 1 张后二选一：
//   - 继续：保留手牌，回合结束；手牌达上限(8)时强制收分。
//   - 收分：结算手牌中最优组合得分（同点三张10 / 同点对3 / 同色3+张3+n / 同色对2），
//           计分牌移出游戏；第 2 次起收分翻倍（翻面加注）。
// 牌堆与弃牌堆抽空后结束，总分最高者胜。
const SeaSaltPaper = (() => {
  let ctx = null;
  let state = null;
  let mirror = null;
  let myHand = [];
  let epoch = 0;

  const MAX_HAND = 8;
  const COLORS = ['blue', 'green', 'orange', 'purple'];
  const COLOR_ICON = { blue: '🐟', green: '🦀', orange: '🐙', purple: '🦈' };
  const COLOR_NAME = { blue: '蓝', green: '绿', orange: '橙', purple: '紫' };

  function buildDeck() {
    const cards = [];
    let k = 0;
    for (let color = 0; color < 4; color++) {
      for (let num = 1; num <= 10; num++) {
        cards.push({ id: 'sp' + (k++), color, num });
      }
    }
    return cards;
  }

  function scoreCards(cards) {
    const pool = cards.slice();
    const usedIds = [];
    let total = 0;
    function take(gs) {
      gs.forEach(c => {
        const i = pool.findIndex(x => x.id === c.id);
        if (i >= 0) { pool.splice(i, 1); usedIds.push(c.id); }
      });
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (let num = 1; num <= 10; num++) {
        const g = pool.filter(c => c.num === num);
        if (g.length >= 3 && new Set(g.map(c => c.color)).size >= 3) {
          take(g.slice(0, 3)); total += 10; changed = true; break;
        }
      }
      if (changed) continue;
      for (let num = 1; num <= 10; num++) {
        const g = pool.filter(c => c.num === num);
        if (g.length >= 2 && new Set(g.map(c => c.color)).size >= 2) {
          take(g.slice(0, 2)); total += 3; changed = true; break;
        }
      }
      if (changed) continue;
      for (let color = 0; color < 4; color++) {
        const g = pool.filter(c => c.color === color);
        if (g.length >= 3) { take(g.slice()); total += 3 + (g.length - 3); changed = true; break; }
      }
      if (changed) continue;
      for (let color = 0; color < 4; color++) {
        const g = pool.filter(c => c.color === color);
        if (g.length >= 2) { take(g.slice(0, 2)); total += 2; changed = true; break; }
      }
    }
    return { score: total, usedIds };
  }

  function init(c) {
    ctx = c;
    state = null;
    mirror = null;
    myHand = [];
    if (ctx.isHost) hostStart();
    else render();
  }

  // ---------- 主机逻辑 ----------
  function hostStart() {
    epoch++;
    const players = ctx.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost, isBot: p.isBot, score: 0, collectCount: 0, hand: [] }));
    const deck = Deck.shuffle(buildDeck());
    for (const p of players) {
      for (let i = 0; i < 4; i++) if (deck.length) p.hand.push(deck.pop());
    }
    state = {
      players, deck, discard: [], currentIdx: 0, phase: 'preparing',
      action: '游戏开始：每人 4 张牌，轮流抽牌后选择继续或收分',
      winnerIds: [], lastAction: '', forcedCollectFor: null,
    };
    nextTurn();
  }

  function beginTurn() {
    if (state.deck.length === 0 && state.discard.length === 0) { endGame(); return; }
    const cur = state.players[state.currentIdx];
    if (cur.hand.length >= MAX_HAND) {
      state.phase = 'collect';
      state.forcedCollectFor = cur.id;
      state.action = cur.name + ' 手牌已达上限，必须收分';
      pushState();
      pushHands();
      render();
      return;
    }
    // 自动抽 1 张（优先牌堆，其次弃牌堆洗入）
    if (state.deck.length === 0) {
      state.deck = Deck.shuffle(state.discard);
      state.discard = [];
    }
    const card = state.deck.pop();
    cur.hand.push(card);
    state.phase = 'choose';
    state.action = '轮到 ' + cur.name + '：摸到 ' + COLOR_NAME[card.color] + '色 ' + card.num + '，选择继续或收分';
    pushState();
    pushHands();
    render();
  }

  function doCollect(fromId) {
    if (!state || state.phase !== 'choose') return;
    const cur = state.players[state.currentIdx];
    if (!cur || cur.id !== fromId) return;
    const r = scoreCards(cur.hand);
    if (r.score <= 0) {
      state.action = '当前手牌无可计分组合，不能收分，请选择继续';
      pushState();
      render();
      return;
    }
    const mult = cur.collectCount > 0 ? 2 : 1;
    const gain = r.score * mult;
    cur.score += gain;
    cur.collectCount++;
    cur.hand = cur.hand.filter(c => !r.usedIds.includes(c.id));
    state.lastAction = cur.name + ' 收分 +' + gain + '（组合 ' + r.score + (mult > 1 ? '，翻面加注 ×2' : '') + '）';
    nextTurn();
  }

  function doPass(fromId) {
    if (!state || state.phase !== 'choose') return;
    const cur = state.players[state.currentIdx];
    if (!cur || cur.id !== fromId) return;
    state.lastAction = cur.name + ' 选择继续，保留手牌';
    nextTurn();
  }

  function nextTurn() {
    if (state.deck.length === 0 && state.discard.length === 0) { endGame(); return; }
    state.currentIdx = (state.currentIdx + 1) % state.players.length;
    beginTurn();
  }

  function endGame() {
    state.phase = 'ended';
    state.forcedCollectFor = null;
    let max = -Infinity;
    state.players.forEach(p => { if (p.score > max) max = p.score; });
    state.winnerIds = state.players.filter(p => p.score === max).map(p => p.id);
    const names = state.players.filter(p => state.winnerIds.includes(p.id)).map(p => p.name).join('、');
    state.action = '🏆 游戏结束！' + names + ' 得分最高（' + max + '），获胜！';
    pushState();
    pushHands();
    render();
  }

  function pushState() {
    const pub = state.players.map(p => ({
      id: p.id, name: p.name, isHost: p.isHost, isBot: p.isBot, score: p.score, collectCount: p.collectCount, handCount: p.hand.length,
    }));
    const cur = state.players[state.currentIdx];
    Net.broadcast({
      type: 'sp_state',
      deckCount: state.deck.length,
      discardCount: state.discard.length,
      currentId: cur ? cur.id : null,
      phase: state.phase,
      players: pub,
      action: state.action,
      lastAction: state.lastAction,
      winnerIds: state.winnerIds,
      forcedCollectFor: state.forcedCollectFor,
    });
  }

  function pushHands() {
    for (const p of state.players) {
      if (p.id !== Net.myId()) Net.sendTo(p.id, { type: 'sp_hand', hand: p.hand });
    }
  }

  // ---------- 消息处理 ----------
  function handleMessage(from, data) {
    if (!ctx || !data || !data.type) return;
    if (ctx.isHost) {
      if (data.type === 'sp_collect') doCollect(from);
      else if (data.type === 'sp_pass') doPass(from);
    } else {
      if (data.type === 'sp_state') { mirror = data; render(); }
      else if (data.type === 'sp_hand') { myHand = data.hand || []; render(); }
    }
  }

  // ---------- 视图 ----------
  function view() {
    if (ctx.isHost) {
      const pub = state.players.map(p => ({
        id: p.id, name: p.name, isHost: p.isHost, isBot: p.isBot, score: p.score, collectCount: p.collectCount, handCount: p.hand.length,
      }));
      const cur = state.players[state.currentIdx];
      return {
        deckCount: state.deck.length, discardCount: state.discard.length, currentId: cur ? cur.id : null,
        phase: state.phase, players: pub, action: state.action, lastAction: state.lastAction,
        winnerIds: state.winnerIds, forcedCollectFor: state.forcedCollectFor,
      };
    }
    return mirror;
  }

  function myCards() { return ctx.isHost ? state.players.find(p => p.id === Net.myId()).hand : myHand; }
  function isMyChoose(v) { return v.phase === 'choose' && v.currentId === Net.myId(); }

  function doCollectClick() {
    const msg = { type: 'sp_collect' };
    if (ctx.isHost) doCollect(Net.myId());
    else Net.sendToHost(msg);
    render();
  }
  function doPassClick() {
    const msg = { type: 'sp_pass' };
    if (ctx.isHost) doPass(Net.myId());
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
    title.textContent = '🌊 海盐与纸 Sea Salt & Paper';
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
    pill.textContent = v ? ('牌堆 ' + v.deckCount + ' / 弃牌 ' + v.discardCount) : '准备中';
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
    scoreRow.className = 'sp-score-row';
    v.players.forEach(p => {
      const chip = document.createElement('div');
      chip.className = 'sp-score';
      chip.innerHTML = (v.winnerIds && v.winnerIds.includes(p.id) ? '🏆 ' : '') + UI.esc(p.name) + (p.id === myId ? '（你）' : '') + '：<b>' + p.score + '</b> 分' + (p.collectCount > 0 ? '（收分×' + p.collectCount + '）' : '');
      scoreRow.appendChild(chip);
    });
    frame.appendChild(scoreRow);

    if (v.lastAction) {
      const log = document.createElement('div');
      log.className = 't6-log';
      log.textContent = '📋 ' + v.lastAction;
      frame.appendChild(log);
    }

    // 我的手牌
    const handTitle = document.createElement('div');
    handTitle.style.cssText = 'font-weight:700;margin:16px 0 8px;font-size:14px;';
    handTitle.textContent = '我的手牌（' + (myCards() || []).length + ' / ' + MAX_HAND + ' 张）';
    frame.appendChild(handTitle);
    const handWrap = document.createElement('div');
    handWrap.className = 'sp-hand';
    const cards = myCards() || [];
    cards.forEach((cd) => {
      const el = document.createElement('div');
      el.className = 'sp-card sp-' + COLORS[cd.color];
      el.innerHTML = '<span class="sp-num">' + cd.num + '</span><span class="sp-icon">' + COLOR_ICON[COLORS[cd.color]] + '</span><span class="sp-color">' + COLOR_NAME[COLORS[cd.color]] + '</span>';
      handWrap.appendChild(el);
    });
    if (!cards.length) {
      const empty = document.createElement('span');
      empty.textContent = '（没有手牌）';
      empty.style.cssText = 'color:var(--ink-2);';
      handWrap.appendChild(empty);
    }
    frame.appendChild(handWrap);

    // 操作条
    const bar = document.createElement('div');
    bar.className = 'actionbar';
    if (v.phase === 'choose' && isMyChoose(v)) {
      const b1 = document.createElement('button');
      b1.className = 'btn btn-ghost';
      b1.textContent = '继续（保留手牌）';
      b1.addEventListener('click', doPassClick);
      bar.appendChild(b1);
      const b2 = document.createElement('button');
      b2.className = 'btn btn-primary';
      b2.textContent = '收分结算';
      b2.addEventListener('click', doCollectClick);
      bar.appendChild(b2);
    } else if (v.phase === 'collect' && v.forcedCollectFor === myId) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-primary';
      btn.textContent = '必须收分';
      btn.addEventListener('click', doCollectClick);
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
