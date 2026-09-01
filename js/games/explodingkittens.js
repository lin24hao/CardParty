// 炸弹猫 Exploding Kittens —— 主机权威
// 规则：牌堆含爆炸猫（玩家人数-1）、拆弹、跳过、攻击、透视、洗牌与普通猫牌。
// 每人 1 张普通牌起手，轮流抽牌；摸到爆炸猫时若无拆弹则出局，有拆弹自动打出并把爆炸猫放回牌堆。
// 效果牌：跳过=本回合免抽；攻击=下家需连续抽 2 张；透视=偷看牌堆顶 3 张；洗牌=重洗牌堆。
// 最后存活玩家获胜。
const ExplodingKittens = (() => {
  let ctx = null;
  let state = null;      // 主机状态
  let mirror = null;     // 客机：公开状态镜像
  let myHand = [];       // 客机：我的手牌
  let epoch = 0;
  let localPlay = null;  // 本地选中的手牌索引

  const CARD_META = {
    explode: { name: '爆炸猫', icon: '💣' },
    defuse: { name: '拆弹', icon: '🧯' },
    skip: { name: '跳过', icon: '⏭️' },
    attack: { name: '攻击', icon: '⚔️' },
    peek: { name: '透视', icon: '👀' },
    shuffle: { name: '洗牌', icon: '🔀' },
    cat: { name: '猫牌', icon: '🐱' },
  };

  function buildDeck(n) {
    const cards = [];
    for (let i = 0; i < n - 1; i++) cards.push({ type: 'explode', id: 'ex' + i });
    const counts = { defuse: 6, skip: 4, attack: 4, peek: 3, shuffle: 4, cat: 12 };
    let k = 0;
    for (const t of ['defuse', 'skip', 'attack', 'peek', 'shuffle', 'cat']) {
      for (let i = 0; i < counts[t]; i++) cards.push({ type: t, id: t + (k++) });
    }
    return cards;
  }
  function cardName(c) { return (CARD_META[c.type] || { name: c.type, icon: '' }); }

  function init(c) {
    ctx = c;
    state = null;
    mirror = null;
    myHand = [];
    localPlay = null;
    if (ctx.isHost) hostStart();
    else render();
  }

  // ---------- 主机逻辑 ----------
  function hostStart() {
    epoch++;
    const players = ctx.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost, isBot: p.isBot, alive: true, exploded: false, hand: [] }));
    const deck = Deck.shuffle(buildDeck(players.length));
    players.forEach(p => { p.hand.push({ type: 'cat', id: 'start-' + p.id }); });
    state = {
      players, deck, currentIdx: 0, drawCount: 0, phase: 'preparing',
      action: '游戏开始：每人 1 张猫牌，轮流抽牌，摸到爆炸猫且无拆弹则出局',
      winnerIds: [], lastAction: '',
    };
    nextTurn();
  }

  function aliveList() { return state.players.filter(p => p.alive); }
  function nextAliveIdx(fromIdx) {
    const n = state.players.length;
    for (let step = 1; step <= n; step++) {
      const i = (fromIdx + step) % n;
      if (state.players[i].alive) return i;
    }
    return -1;
  }

  function beginTurn() {
    if (aliveList().length <= 1) {
      const winner = aliveList()[0];
      state.phase = 'ended';
      state.winnerIds = winner ? [winner.id] : [];
      state.action = winner ? ('🏆 ' + winner.name + ' 是最后存活的玩家，获胜！') : '🏆 游戏结束';
      pushState();
      pushHands();
      render();
      return;
    }
    state.drawCount = 1;
    state.phase = 'playing';
    const cur = state.players[state.currentIdx];
    state.action = '轮到 ' + cur.name + '：可打出效果牌或抽牌（本回合需抽 ' + state.drawCount + ' 张）';
    pushState();
    pushHands();
    render();
  }

  function nextTurn() {
    const cur = state.players[state.currentIdx];
    if (aliveList().length <= 1) { beginTurn(); return; }
    state.currentIdx = nextAliveIdx(state.currentIdx);
    beginTurn();
  }

  function doPlay(fromId, cardIndex) {
    if (!state || state.phase !== 'playing') return;
    const cur = state.players[state.currentIdx];
    if (!cur || cur.id !== fromId || !cur.alive) return;
    const c = cur.hand[cardIndex];
    if (!c) return;
    if (c.type === 'defuse') { state.action = '拆弹只能在摸到爆炸猫时使用，不能主动打出'; pushState(); render(); return; }
    if (c.type === 'cat') { state.action = '猫牌没有效果，不能主动打出'; pushState(); render(); return; }
    if (c.type === 'explode') { state.action = '爆炸猫在牌堆里，不能从手牌打出'; pushState(); render(); return; }
    cur.hand.splice(cardIndex, 1);
    if (c.type === 'skip') {
      state.lastAction = cur.name + ' 打出跳过，免抽本轮';
      nextTurn();
    } else if (c.type === 'attack') {
      const ti = nextAliveIdx(state.currentIdx);
      const t = state.players[ti];
      state.attackOn = t.id;
      state.lastAction = cur.name + ' 打出攻击，' + t.name + ' 需连续抽 2 张';
      nextTurn();
    } else if (c.type === 'peek') {
      const top = state.deck.slice(0, 3);
      Net.sendTo(cur.id, { type: 'ek_peek', cards: top });
      state.action = cur.name + ' 打出透视，已查看牌堆顶 ' + top.length + ' 张';
      pushState();
      render();
    } else if (c.type === 'shuffle') {
      state.deck = Deck.shuffle(state.deck);
      state.action = cur.name + ' 打出洗牌，牌堆已重洗';
      pushState();
      render();
    }
  }

  function doDraw(fromId) {
    if (!state || state.phase !== 'playing') return;
    const cur = state.players[state.currentIdx];
    if (!cur || cur.id !== fromId || !cur.alive) return;
    if (state.drawCount <= 0) return;
    if (!state.deck.length) { state.action = '牌堆已空，' + cur.name + ' 安全通过本轮'; nextTurn(); return; }
    const c = state.deck.pop();
    if (c.type === 'explode') {
      const defIdx = cur.hand.findIndex(x => x.type === 'defuse');
      if (defIdx >= 0) {
        cur.hand.splice(defIdx, 1);
        const pos = Math.floor(Math.random() * (state.deck.length + 1));
        state.deck.splice(pos, 0, c);
        state.lastAction = cur.name + ' 摸到爆炸猫！打出拆弹化解，爆炸猫回到牌堆';
        state.drawCount = 0;
        nextTurn();
      } else {
        cur.alive = false;
        cur.exploded = true;
        state.lastAction = cur.name + ' 摸到爆炸猫，没有拆弹，💥 出局！';
        state.drawCount = 0;
        nextTurn();
      }
      return;
    }
    cur.hand.push(c);
    state.drawCount--;
    if (state.drawCount <= 0) {
      state.lastAction = cur.name + ' 摸到 ' + cardName(c).name + '，完成抽牌';
      nextTurn();
    } else {
      state.action = cur.name + ' 摸到 ' + cardName(c).name + '，被攻击需再抽 ' + state.drawCount + ' 张';
      pushState();
      pushHands();
      render();
    }
  }

  function pushState() {
    const pub = state.players.map(p => ({
      id: p.id, name: p.name, isHost: p.isHost, isBot: p.isBot, alive: p.alive, exploded: p.exploded, handCount: p.hand.length,
    }));
    const cur = state.players[state.currentIdx];
    Net.broadcast({
      type: 'ek_state',
      deckCount: state.deck.length,
      currentId: cur ? cur.id : null,
      drawCount: state.drawCount,
      phase: state.phase,
      players: pub,
      action: state.action,
      lastAction: state.lastAction,
      winnerIds: state.winnerIds,
    });
  }

  function pushHands() {
    for (const p of state.players) {
      if (p.id !== Net.myId()) Net.sendTo(p.id, { type: 'ek_hand', hand: p.hand });
    }
  }

  // ---------- 消息处理 ----------
  function handleMessage(from, data) {
    if (!ctx || !data || !data.type) return;
    if (ctx.isHost) {
      if (data.type === 'ek_play') doPlay(from, data.cardIndex);
      else if (data.type === 'ek_draw') doDraw(from);
    } else {
      if (data.type === 'ek_state') { mirror = data; localPlay = null; render(); }
      else if (data.type === 'ek_hand') { myHand = data.hand || []; render(); }
      else if (data.type === 'ek_peek') { showPeek(data.cards || []); }
    }
  }

  let peekModalShown = false;
  function showPeek(cards) {
    if (peekModalShown) return;
    peekModalShown = true;
    const lines = cards.map(c => cardName(c).icon + ' ' + cardName(c).name).join('、');
    UI.modal({
      title: '👀 透视结果',
      body: '牌堆顶 ' + cards.length + ' 张：' + (lines || '（牌堆已空）'),
      actions: [{ text: '知道了', cls: 'btn btn-primary' }],
    }, () => { peekModalShown = false; });
  }

  // ---------- 视图 ----------
  function view() {
    if (ctx.isHost) {
      const pub = state.players.map(p => ({
        id: p.id, name: p.name, isHost: p.isHost, isBot: p.isBot, alive: p.alive, exploded: p.exploded, handCount: p.hand.length,
      }));
      const cur = state.players[state.currentIdx];
      return {
        deckCount: state.deck.length, currentId: cur ? cur.id : null, drawCount: state.drawCount,
        phase: state.phase, players: pub, action: state.action, lastAction: state.lastAction, winnerIds: state.winnerIds,
      };
    }
    return mirror;
  }

  function myCards() { return ctx.isHost ? state.players.find(p => p.id === Net.myId()).hand : myHand; }
  function isMyTurn(v) { return v.phase === 'playing' && v.currentId === Net.myId(); }

  function doPlayClick() {
    if (localPlay == null) return;
    const msg = { type: 'ek_play', cardIndex: localPlay };
    if (ctx.isHost) doPlay(Net.myId(), localPlay);
    else Net.sendToHost(msg);
    localPlay = null;
    render();
  }
  function doDrawClick() {
    const msg = { type: 'ek_draw' };
    if (ctx.isHost) doDraw(Net.myId());
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
    title.textContent = '💣 炸弹猫 Exploding Kittens';
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
    pill.textContent = v ? ('牌堆 ' + v.deckCount + ' 张') : '准备中';
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

    // 玩家区
    const seats = document.createElement('div');
    seats.className = 'seat-row';
    v.players.forEach(p => {
      const seat = document.createElement('div');
      seat.className = 'seat' + (p.alive ? '' : ' dead') + (v.currentId === p.id ? ' active' : '') + (v.winnerIds && v.winnerIds.includes(p.id) ? ' winner' : '');
      seat.appendChild(UI.avatarEl(p.id, p.name));
      const nm = document.createElement('div');
      nm.className = 'seat-name';
      nm.textContent = p.name + (p.id === myId ? '（你）' : '');
      seat.appendChild(nm);
      const info = document.createElement('div');
      info.className = 'seat-info';
      info.textContent = p.exploded ? '💥 出局' : ('手牌 ' + p.handCount + ' 张');
      seat.appendChild(info);
      if (p.id === myId) seat.classList.add('me');
      seats.appendChild(seat);
    });
    frame.appendChild(seats);

    if (v.lastAction) {
      const log = document.createElement('div');
      log.className = 't6-log';
      log.textContent = '📋 ' + v.lastAction;
      frame.appendChild(log);
    }

    // 我的手牌
    const handTitle = document.createElement('div');
    handTitle.style.cssText = 'font-weight:700;margin:16px 0 8px;font-size:14px;';
    handTitle.textContent = '我的手牌（' + (myCards() || []).length + ' 张）';
    frame.appendChild(handTitle);
    const handWrap = document.createElement('div');
    handWrap.className = 'ek-hand';
    const cards = myCards() || [];
    const canPick = isMyTurn(v);
    cards.forEach((cd, i) => {
      const el = document.createElement('div');
      const meta = cardName(cd);
      const selectable = canPick && (cd.type === 'skip' || cd.type === 'attack' || cd.type === 'peek' || cd.type === 'shuffle');
      el.className = 'ek-card' + (localPlay === i ? ' selected' : '') + (selectable ? '' : ' disabled');
      el.innerHTML = '<span class="ek-icon">' + meta.icon + '</span><span class="ek-name">' + meta.name + '</span>';
      if (selectable) el.addEventListener('click', () => { localPlay = (localPlay === i) ? null : i; render(); });
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
    if (v.phase === 'playing' && isMyTurn(v)) {
      const b1 = document.createElement('button');
      b1.className = 'btn btn-ghost';
      b1.textContent = '打出效果牌';
      b1.disabled = localPlay == null;
      b1.addEventListener('click', doPlayClick);
      bar.appendChild(b1);
      const b2 = document.createElement('button');
      b2.className = 'btn btn-primary';
      b2.textContent = '🎴 抽牌（本回合 ' + (v.drawCount > 0 ? '还需 ' + v.drawCount + ' 张' : '0 张') + '）';
      b2.disabled = v.drawCount <= 0;
      b2.addEventListener('click', doDrawClick);
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
