// UNO —— 主机权威
// 规则：每人 7 张牌，出与弃牌堆顶颜色相同或数字/符号相同的牌；特殊牌：
//   skip（跳过下家）、reverse（反转方向）、draw2（下家抽 2 张并跳过）、
//   wild（万能，选颜色）、wild4（选颜色，下家抽 4 张并跳过）。
// 无牌可出时抽 1 张（若抽到可出可立即出）；先出完手牌者获胜。
const Uno = (() => {
  let ctx = null;
  let state = null;      // 主机状态
  let mirror = null;     // 客机：公开状态镜像
  let myHand = [];       // 客机：我的手牌
  let epoch = 0;         // 局次，用于作废上一局遗留的定时器

  const COLORS = {
    red:    { bg: '#e5484d', name: '红', emoji: '🔴' },
    yellow: { bg: '#f7b500', name: '黄', emoji: '🟡' },
    green:  { bg: '#18a058', name: '绿', emoji: '🟢' },
    blue:   { bg: '#0ea5e9', name: '蓝', emoji: '🔵' },
  };
  const COLOR_ORDER = ['red', 'yellow', 'green', 'blue'];

  function cardLabel(card) {
    if (!card) return '';
    if (card.value === 'wild') return '✦';
    if (card.value === 'wild4') return '+4';
    if (card.value === 'draw2') return '+2';
    if (card.value === 'skip') return '🚫';
    if (card.value === 'reverse') return '🔄';
    return card.value;
  }
  function cardName(card) {
    if (!card) return '';
    if (card.color === 'wild') return card.value === 'wild4' ? '万能 +4' : '万能';
    return (COLORS[card.color] ? COLORS[card.color].name : '') + ' ' + cardLabel(card);
  }

  function buildDeck() {
    const deck = [];
    for (const color of COLOR_ORDER) {
      deck.push({ color, value: '0' });
      for (let n = 1; n <= 9; n++) {
        deck.push({ color, value: String(n) });
        deck.push({ color, value: String(n) });
      }
      for (const v of ['skip', 'reverse', 'draw2']) {
        deck.push({ color, value: v });
        deck.push({ color, value: v });
      }
    }
    for (let i = 0; i < 4; i++) {
      deck.push({ color: 'wild', value: 'wild' });
      deck.push({ color: 'wild', value: 'wild4' });
    }
    return deck; // 108 张
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
    let drawPile = Deck.shuffle(buildDeck());
    const players = ctx.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost, isBot: p.isBot }));
    const hands = {};
    players.forEach(p => hands[p.id] = []);
    for (let k = 0; k < 7; k++) players.forEach(p => hands[p.id].push(drawPile.pop()));
    // 首张牌：翻到非万能牌为止（避免开局无颜色可对）
    let top = drawPile.pop();
    while (top && top.color === 'wild') {
      drawPile.unshift(top);
      drawPile = Deck.shuffle(drawPile);
      top = drawPile.pop();
    }
    state = {
      players, hands, drawPile, discard: [top],
      current: 0, direction: 1,
      currentColor: top.color, currentValue: top.value,
      phase: 'playing', winner: null, action: '游戏开始',
      hasDrawn: false,
    };
    beginTurn(0);
  }

  // 带局次守卫的延时：避免上一局遗留的定时器污染新一局
  function later(fn, ms) {
    const e = epoch;
    setTimeout(() => { if (e === epoch) fn(); }, ms);
  }

  function cardPlayable(card, color, value) {
    if (!card) return false;
    if (card.color === 'wild') return true;
    if (color && card.color === color) return true;
    if (value && card.value === value) return true;
    return false;
  }
  function isPlayable(card) {
    if (ctx.isHost && state) return cardPlayable(card, state.currentColor, state.currentValue);
    if (mirror) return cardPlayable(card, mirror.currentColor, mirror.currentValue);
    return false;
  }
  function hasPlayableCard(hand) {
    return hand.some(c => isPlayable(c));
  }

  function refillDrawPile() {
    if (state.drawPile.length > 0) return;
    if (state.discard.length <= 1) return;
    const top = state.discard.pop();
    state.drawPile = Deck.shuffle(state.discard);
    state.discard = [top];
  }

  function drawCards(playerId, n) {
    const drawn = [];
    for (let i = 0; i < n; i++) {
      refillDrawPile();
      if (state.drawPile.length === 0) break;
      const c = state.drawPile.pop();
      state.hands[playerId].push(c);
      drawn.push(c);
    }
    return drawn;
  }

  function nextIndex(i) {
    const n = state.players.length;
    return ((i + state.direction) % n + n) % n;
  }

  function beginTurn(index) {
    if (!state || state.phase === 'ended') return;
    state.phase = 'playing';
    state.current = ((index % state.players.length) + state.players.length) % state.players.length;
    state.hasDrawn = false;
    const p = state.players[state.current];
    state.action = '轮到 ' + p.name + ' 出牌';
    pushState();
    pushHands();
    render();
  }

  function advance(afterIdx) {
    beginTurn(nextIndex(afterIdx));
  }

  function hostPlay(fromId, index) {
    if (!state || state.phase !== 'playing') return;
    const idx = state.players.findIndex(p => p.id === fromId);
    if (idx !== state.current) return;
    const hand = state.hands[fromId];
    if (typeof index !== 'number' || index < 0 || index >= hand.length) return;
    const card = hand[index];
    if (!isPlayable(card)) return;
    hand.splice(index, 1);
    state.discard.push(card);
    state.currentColor = card.color === 'wild' ? state.currentColor : card.color;
    state.currentValue = card.value;
    const p = state.players[idx];
    let action = p.name + ' 出了 ' + cardName(card);

    // 出完手牌即获胜
    if (hand.length === 0) {
      state.winner = fromId;
      state.phase = 'ended';
      state.action = action + '，' + p.name + ' 获胜！';
      pushState(); pushHands(); render();
      return;
    }

    const n = state.players.length;
    if (card.color === 'wild') {
      state.phase = 'color';
      state.action = action + '，请选择颜色';
      pushState(); pushHands(); render();
      return;
    }
    if (card.value === 'skip') {
      state.phase = 'transition';
      const skipped = nextIndex(idx);
      state.action = action + '，' + state.players[skipped].name + ' 被跳过';
      pushState(); pushHands(); render();
      later(() => beginTurn(nextIndex(skipped)), 900);
      return;
    }
    if (card.value === 'reverse') {
      state.phase = 'transition';
      state.direction *= -1;
      if (n === 2) {
        state.action = action + '，方向反转（相当于跳过对方）';
        pushState(); pushHands(); render();
        later(() => beginTurn(idx), 900);
      } else {
        state.action = action + '，出牌方向反转';
        pushState(); pushHands(); render();
        later(() => advance(idx), 900);
      }
      return;
    }
    if (card.value === 'draw2') {
      state.phase = 'transition';
      const victim = nextIndex(idx);
      const drawn = drawCards(state.players[victim].id, 2);
      state.action = action + '，' + state.players[victim].name + ' 抽 ' + drawn.length + ' 张并被跳过';
      pushState(); pushHands(); render();
      later(() => beginTurn(nextIndex(victim)), 1000);
      return;
    }
    // 普通数字牌
    state.phase = 'transition';
    state.action = action;
    pushState(); pushHands(); render();
    later(() => advance(idx), 700);
  }

  function hostColor(fromId, color) {
    if (!state || state.phase !== 'color') return;
    const idx = state.players.findIndex(p => p.id === fromId);
    if (idx !== state.current) return;
    if (!COLOR_ORDER.includes(color)) return;
    state.currentColor = color;
    state.phase = 'transition';
    const p = state.players[idx];
    const top = state.discard[state.discard.length - 1];
    let action = p.name + ' 选择颜色 ' + COLORS[color].name;
    if (top && top.value === 'wild4') {
      const victim = nextIndex(idx);
      const drawn = drawCards(state.players[victim].id, 4);
      action += '，' + state.players[victim].name + ' 抽 ' + drawn.length + ' 张并被跳过';
      state.action = action;
      pushState(); pushHands(); render();
      later(() => beginTurn(nextIndex(victim)), 1000);
    } else {
      state.action = action;
      pushState(); pushHands(); render();
      later(() => advance(idx), 700);
    }
  }

  function hostDraw(fromId) {
    if (!state || state.phase !== 'playing') return;
    const idx = state.players.findIndex(p => p.id === fromId);
    if (idx !== state.current) return;
    if (state.hasDrawn) return; // 每回合只能抽一次
    const p = state.players[idx];
    refillDrawPile();
    if (state.drawPile.length === 0) {
      state.hasDrawn = true;
      state.phase = 'transition';
      state.action = p.name + ' 无牌可抽，结束回合';
      pushState(); pushHands(); render();
      later(() => advance(idx), 800);
      return;
    }
    const c = state.drawPile.pop();
    state.hands[fromId].push(c);
    state.hasDrawn = true;
    const playable = isPlayable(c);
    state.action = p.name + ' 抽了一张牌' + (playable ? '（可以出）' : '（不能出，结束回合）');
    pushState(); pushHands(); render();
    if (!playable && !hasPlayableCard(state.hands[fromId])) {
      state.phase = 'transition';
      later(() => advance(idx), 900);
    }
  }

  function hostPass(fromId) {
    if (!state || state.phase !== 'playing') return;
    const idx = state.players.findIndex(p => p.id === fromId);
    if (idx !== state.current) return;
    if (!state.hasDrawn) return; // 必须先抽牌才能结束回合
    state.phase = 'transition';
    state.action = state.players[idx].name + ' 结束回合';
    pushState(); pushHands(); render();
    later(() => advance(idx), 700);
  }

  function snapshot() {
    return {
      players: state.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost, isBot: p.isBot, count: state.hands[p.id].length })),
      currentId: state.players[state.current].id,
      direction: state.direction,
      top: state.discard[state.discard.length - 1],
      currentColor: state.currentColor,
      currentValue: state.currentValue,
      phase: state.phase,
      winner: state.winner,
      action: state.action,
      drawPileCount: state.drawPile.length,
      hasDrawn: state.hasDrawn,
    };
  }
  function pushState() { Net.broadcast(Object.assign({ type: 'uno_state' }, snapshot())); }
  function pushHands() {
    for (const p of state.players) {
      if (p.id !== Net.myId()) Net.sendTo(p.id, { type: 'uno_hand', hand: state.hands[p.id] });
    }
  }

  // ---------- 消息处理 ----------
  function handleMessage(from, data) {
    if (!ctx || !data || !data.type) return;
    if (ctx.isHost) {
      if (data.type === 'uno_play') hostPlay(from, data.index);
      else if (data.type === 'uno_draw') hostDraw(from);
      else if (data.type === 'uno_pass') hostPass(from);
      else if (data.type === 'uno_color') hostColor(from, data.color);
    } else {
      if (data.type === 'uno_state') { mirror = data; render(); }
      else if (data.type === 'uno_hand') { myHand = data.hand || []; render(); }
    }
  }

  // ---------- 视图 ----------
  function view() {
    if (ctx.isHost) return snapshot();
    return mirror;
  }
  function myCards() {
    if (ctx.isHost) return state.hands[Net.myId()];
    return myHand;
  }

  function doPlay(index) { if (ctx.isHost) hostPlay(Net.myId(), index); else Net.sendToHost({ type: 'uno_play', index }); }
  function doDraw() { if (ctx.isHost) hostDraw(Net.myId()); else Net.sendToHost({ type: 'uno_draw' }); }
  function doPass() { if (ctx.isHost) hostPass(Net.myId()); else Net.sendToHost({ type: 'uno_pass' }); }
  function doColor(color) { if (ctx.isHost) hostColor(Net.myId(), color); else Net.sendToHost({ type: 'uno_color', color }); }

  // 卡牌元素（UNO 彩色卡）
  function unoCardEl(card, opts = {}) {
    const { selectable = false, dimmed = false, faceDown = false } = opts;
    const el = document.createElement('div');
    let cls = 'uno-card';
    if (selectable) cls += ' uno-selectable';
    if (dimmed) cls += ' uno-disabled';
    el.className = cls;
    if (faceDown) { el.classList.add('uno-back'); return el; }
    if (card.color === 'wild') el.classList.add('wild-card');
    else {
      const c = COLORS[card.color];
      if (c) el.style.background = c.bg;
      if (card.color === 'yellow') el.classList.add('uno-yellow');
    }
    const label = cardLabel(card);
    el.innerHTML =
      '<span class="uno-corner tl">' + label + '</span>' +
      '<span class="uno-oval">' + label + '</span>' +
      '<span class="uno-corner br">' + label + '</span>';
    return el;
  }

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
    title.textContent = '🌈 UNO';
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
    pill.className = 'phase-pill' + (v && v.phase === 'ended' ? ' ok' : (v && v.phase === 'color' ? ' warn' : ''));
    pill.textContent = v ? (v.phase === 'ended' ? '已结束' : v.phase === 'color' ? '选择颜色' : '进行中') : '准备中';
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

    frame.appendChild(UI.banner(v.phase === 'ended' ? 'ok' : '', v.action || '准备中'));

    // 牌桌中心：抽牌堆 / 弃牌堆 / 方向
    const table = document.createElement('div');
    table.className = 'uno-table';
    const drawPile = document.createElement('div');
    drawPile.className = 'uno-pile';
    drawPile.appendChild(unoCardEl(null, { faceDown: true }));
    const dbLabel = document.createElement('div');
    dbLabel.className = 'uno-pile-label';
    dbLabel.textContent = '抽牌堆 · ' + v.drawPileCount + ' 张';
    drawPile.appendChild(dbLabel);
    table.appendChild(drawPile);

    const discardPile = document.createElement('div');
    discardPile.className = 'uno-pile';
    if (v.top) discardPile.appendChild(unoCardEl(v.top));
    const dpLabel = document.createElement('div');
    dpLabel.className = 'uno-pile-label';
    dpLabel.textContent = '当前：' + (v.top ? cardName(v.top) : '—');
    discardPile.appendChild(dpLabel);
    table.appendChild(discardPile);

    const dir = document.createElement('div');
    dir.className = 'uno-dir';
    dir.textContent = v.direction === 1 ? '顺时针 ↻' : '逆时针 ↺';
    table.appendChild(dir);
    frame.appendChild(table);

    // 各玩家座位
    const seats = document.createElement('div');
    seats.className = 'seats';
    v.players.forEach(p => {
      const seat = document.createElement('div');
      seat.className = 'seat' + (v.phase !== 'ended' && v.currentId === p.id ? ' active' : '');
      seat.appendChild(UI.avatarEl(p.id, p.name));
      const meta = document.createElement('div');
      meta.className = 'meta';
      const nm = document.createElement('div');
      nm.className = 'sname';
      nm.textContent = (p.isBot ? '🤖 ' : '') + p.name + (p.id === myId ? '（你）' : '') + (p.isHost ? ' · 房主' : '');
      meta.appendChild(nm);
      const st = document.createElement('div');
      st.className = 'stag';
      let tag = '剩 ' + p.count + ' 张';
      if (v.phase === 'ended') tag = p.id === v.winner ? '🏆 获胜' : '—';
      else if (v.currentId === p.id) tag += ' · 出牌中';
      else if (p.count === 1) tag += ' · UNO！';
      st.textContent = tag;
      meta.appendChild(st);
      seat.appendChild(meta);
      if (v.phase !== 'ended' && p.count === 1) {
        const uno = document.createElement('span');
        uno.className = 'uno-badge';
        uno.textContent = 'UNO!';
        seat.appendChild(uno);
      }
      seats.appendChild(seat);
    });
    frame.appendChild(seats);

    // 我的手牌
    const isMyTurn = v.phase === 'playing' && v.currentId === myId;
    const needColor = v.phase === 'color' && v.currentId === myId;

    const handTitle = document.createElement('div');
    handTitle.style.cssText = 'font-weight:700;margin:16px 0 8px;font-size:14px;';
    handTitle.textContent = '我的手牌 · ' + myCards().length + ' 张';
    frame.appendChild(handTitle);
    const handWrap = document.createElement('div');
    handWrap.className = 'hand-cards';
    const my = myCards() || [];
    my.forEach((cd, i) => {
      const playable = isPlayable(cd);
      const el = unoCardEl(cd, { selectable: isMyTurn && playable, dimmed: isMyTurn && !playable });
      if (isMyTurn && playable) el.addEventListener('click', () => doPlay(i));
      handWrap.appendChild(el);
    });
    if (my.length === 0) {
      const empty = document.createElement('span');
      empty.textContent = '（没有牌）';
      empty.style.cssText = 'color:var(--ink-2);';
      handWrap.appendChild(empty);
    }
    frame.appendChild(handWrap);

    // 操作条
    const bar = document.createElement('div');
    bar.className = 'actionbar';
    if (needColor) {
      const colorTitle = document.createElement('div');
      colorTitle.style.cssText = 'width:100%;text-align:center;font-size:13px;color:var(--ink-2);margin-bottom:4px;';
      colorTitle.textContent = '为万能牌选择颜色';
      bar.appendChild(colorTitle);
      COLOR_ORDER.forEach(color => {
        const b = document.createElement('button');
        b.className = 'uno-color-btn';
        b.style.background = COLORS[color].bg;
        if (color === 'yellow') b.style.color = '#3b2d00';
        b.textContent = COLORS[color].emoji + ' ' + COLORS[color].name;
        b.addEventListener('click', () => doColor(color));
        bar.appendChild(b);
      });
    } else if (v.phase === 'ended') {
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
    } else if (isMyTurn) {
      if (!v.hasDrawn) {
        const drawBtn = document.createElement('button');
        drawBtn.className = 'btn btn-ghost';
        drawBtn.textContent = '抽一张牌';
        drawBtn.addEventListener('click', () => doDraw());
        bar.appendChild(drawBtn);
      } else {
        const passBtn = document.createElement('button');
        passBtn.className = 'btn btn-ghost';
        passBtn.textContent = '结束回合';
        passBtn.addEventListener('click', () => doPass());
        bar.appendChild(passBtn);
      }
      const hint = document.createElement('div');
      hint.style.cssText = 'width:100%;text-align:center;font-size:12px;color:var(--ink-2);';
      hint.textContent = v.hasDrawn ? '点击可出的牌打出，或结束回合' : '点击可出的牌打出，或抽一张';
      bar.appendChild(hint);
    }
    frame.appendChild(bar);

    c.appendChild(frame);
  }

  return { init, handleMessage };
})();
