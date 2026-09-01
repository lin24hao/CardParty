// 花火 Hanabi —— 主机权威 · 合作烟花
// 规则：25 张牌（5 色 × 数字 1-5）。玩家看不到自己的手牌，只能看到他人的手牌，
// 通过「提示颜色 / 提示数字」（消耗提示 token，初始 8 个）获知自己手牌的信息；
// 按每色 1→5 顺序打出 5 束烟花，全部完成即胜利；打错牌扣失误 token（初始 3 个），
// 扣完失败。牌堆抽空且手牌打完则按已完成烟花数计分结束。
// 消息模型（隐藏手牌核心）：hn_state 广播公开信息（烟花堆/提示标记/行动者等，不含任何牌面）；
// hn_view 逐玩家私发「他人手牌牌面 + 我的手牌提示标记」；hn_cheat 仅发 bot 真实手牌用于 AI 决策。
// 行动：hn_play / hn_discard / hn_hint。
const Hanabi = (() => {
  let ctx = null;
  let state = null;      // 主机状态（含全部真实牌面）
  let mirror = null;     // 客机：公开状态
  let myView = null;     // 客机：我的可见视图（他人牌面 + 自己的标记）
  let myCheat = null;    // bot：真实手牌（作弊视角）
  let epoch = 0;
  let localCard = null;  // 本地选中的手牌索引
  let hintTarget = null; // 提示目标玩家 id
  let hintKind = 'color';
  let hintValue = 'red';

  const COLORS = [
    { key: 'red',    name: '红', dot: '🔴' },
    { key: 'blue',   name: '蓝', dot: '🔵' },
    { key: 'green',  name: '绿', dot: '🟢' },
    { key: 'yellow', name: '黄', dot: '🟡' },
    { key: 'purple', name: '紫', dot: '🟣' },
  ];
  const NUMBERS = [1, 2, 3, 4, 5];
  const MAX_HINTS = 8;
  const MAX_FUSES = 3;
  const PERFECT = 25;

  function colorOf(key) { return COLORS.find(c => c.key === key) || COLORS[0]; }
  function cardLabel(c) { const co = colorOf(c.color); return co.dot + co.name + c.number; }

  function makeDeck() {
    const d = [];
    COLORS.forEach(c => NUMBERS.forEach(n => d.push({ color: c.key, number: n })));
    return d;
  }

  function init(c) {
    ctx = c;
    state = null;
    mirror = null;
    myView = null;
    myCheat = null;
    localCard = null;
    hintTarget = null;
    hintKind = 'color';
    hintValue = 'red';
    if (ctx.isHost) hostStart();
    else render();
  }

  // ---------- 主机逻辑 ----------
  function hostStart() {
    epoch++;
    const n = ctx.players.length;
    const handSize = n <= 3 ? 5 : 4;
    const deck = Deck.shuffle(makeDeck());
    const players = ctx.players.map(p => ({
      id: p.id, name: p.name, isHost: p.isHost, isBot: p.isBot, hand: [], hints: [],
    }));
    players.forEach(p => {
      for (let i = 0; i < handSize; i++) { p.hand.push(deck.pop()); p.hints.push({ color: null, number: null }); }
    });
    const piles = {};
    COLORS.forEach(c => { piles[c.key] = 0; });
    state = {
      players, piles, hints: MAX_HINTS, fuses: MAX_FUSES, deck,
      discard: [], deckCount: deck.length, currentIdx: 0,
      phase: 'playing', action: '游戏开始！' + players[0].name + ' 先行动',
      log: [], winnerIds: [], endedReason: '',
    };
    pushState();
    pushViews();
    render();
  }

  function currentPlayer() { return state.players[state.currentIdx]; }

  function drawCard(p) {
    if (state.deck.length === 0) return false;
    p.hand.push(state.deck.pop());
    p.hints.push({ color: null, number: null });
    return true;
  }

  function finishIfPossible(reason) {
    const allPerfect = COLORS.every(c => state.piles[c.key] === 5);
    if (allPerfect) {
      state.phase = 'ended';
      state.winnerIds = state.players.map(p => p.id);
      state.endedReason = '🎉 五色烟花全部完成（25/25），全队胜利！';
      state.action = state.endedReason;
      return true;
    }
    if (state.fuses <= 0) {
      state.phase = 'ended';
      state.winnerIds = [];
      state.endedReason = '💥 失误次数用尽，烟花熄灭，游戏失败。';
      state.action = state.endedReason;
      return true;
    }
    // 牌堆抽空且所有手牌打/弃完 → 计分终局
    const totalHand = state.players.reduce((s, p) => s + p.hand.length, 0);
    if (state.deck.length === 0 && totalHand === 0) {
      const score = COLORS.reduce((s, c) => s + state.piles[c.key], 0);
      state.phase = 'ended';
      state.winnerIds = score >= PERFECT ? state.players.map(p => p.id) : [];
      state.endedReason = '牌堆耗尽，终局计分：' + score + '/' + PERFECT + '。' + (score >= PERFECT ? '全队胜利！' : '未完成。');
      state.action = state.endedReason;
      return true;
    }
    return false;
  }

  function nextTurn() {
    if (finishIfPossible('')) return;
    state.currentIdx = (state.currentIdx + 1) % state.players.length;
    state.action = currentPlayer().name + ' 的回合：打牌 / 弃牌 / 提示';
    pushState();
    pushViews();
    render();
  }

  function hostPlay(fromId, cardIndex) {
    if (!state || state.phase !== 'playing') return;
    const p = state.players.find(x => x.id === fromId);
    if (!p || currentPlayer().id !== fromId) return;
    if (typeof cardIndex !== 'number' || cardIndex < 0 || cardIndex >= p.hand.length) return;
    const card = p.hand[cardIndex];
    const expected = state.piles[card.color] + 1;
    p.hand.splice(cardIndex, 1);
    p.hints.splice(cardIndex, 1);
    const mover = p.name;
    if (card.number === expected) {
      state.piles[card.color] = expected;
      state.log.push(mover + ' 打出 ' + cardLabel(card) + '，' + colorOf(card.color).name + '色烟花到 ' + expected);
      state.action = mover + ' 成功打出 ' + cardLabel(card) + '！';
    } else {
      state.fuses--;
      state.discard.push(card);
      state.log.push(mover + ' 打出 ' + cardLabel(card) + ' 失误（' + colorOf(card.color).name + '色应在 ' + expected + '），失误剩 ' + state.fuses);
      state.action = '💥 ' + mover + ' 打错牌，失误 token -1（剩 ' + state.fuses + '）';
    }
    drawCard(p);
    state.deckCount = state.deck.length;
    nextTurn();
  }

  function hostDiscard(fromId, cardIndex) {
    if (!state || state.phase !== 'playing') return;
    const p = state.players.find(x => x.id === fromId);
    if (!p || currentPlayer().id !== fromId) return;
    if (typeof cardIndex !== 'number' || cardIndex < 0 || cardIndex >= p.hand.length) return;
    const card = p.hand[cardIndex];
    p.hand.splice(cardIndex, 1);
    p.hints.splice(cardIndex, 1);
    state.discard.push(card);
    state.hints = Math.min(MAX_HINTS, state.hints + 1);
    state.log.push(p.name + ' 弃掉 ' + cardLabel(card) + '，提示 token +1（' + state.hints + '）');
    state.action = p.name + ' 弃掉 ' + cardLabel(card) + '，提示 token 恢复至 ' + state.hints;
    drawCard(p);
    state.deckCount = state.deck.length;
    nextTurn();
  }

  function hostHint(fromId, data) {
    if (!state || state.phase !== 'playing') return;
    const p = state.players.find(x => x.id === fromId);
    if (!p || currentPlayer().id !== fromId) return;
    if (state.hints <= 0) return;
    const target = state.players.find(x => x.id === data.targetId);
    if (!target || target.id === fromId) return;
    const kind = data.kind === 'number' ? 'number' : 'color';
    const value = data.value;
    let matched = 0;
    target.hints.forEach((h, i) => {
      const card = target.hand[i];
      if (!card) return;
      if (kind === 'color' && card.color === value) { h.color = value; matched++; }
      if (kind === 'number' && card.number === value) { h.number = value; matched++; }
    });
    if (matched === 0) return; // 无匹配则本次提示无效
    state.hints--;
    const what = kind === 'color' ? colorOf(value).dot + colorOf(value).name : '数字 ' + value;
    state.log.push(p.name + ' 提示 ' + target.name + '：' + what + '（' + matched + ' 张）');
    state.action = p.name + ' 提示 ' + target.name + '：' + what;
    nextTurn();
  }

  function pushState() {
    Net.broadcast({
      type: 'hn_state',
      piles: state.piles,
      hints: state.hints, maxHints: MAX_HINTS,
      fuses: state.fuses, maxFuses: MAX_FUSES,
      deckCount: state.deckCount,
      currentId: currentPlayer().id,
      players: state.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost, isBot: p.isBot, handCount: p.hand.length })),
      hintsFor: state.players.map(p => ({ id: p.id, hints: p.hints })),
      discardCount: state.discard.length,
      phase: state.phase, action: state.action,
      log: state.log.slice(-8), winnerIds: state.winnerIds, endedReason: state.endedReason,
    });
  }

  function pushViews() {
    for (const p of state.players) {
      if (p.id === Net.myId()) continue;
      const others = state.players.filter(o => o.id !== p.id).map(o => ({ id: o.id, hand: o.hand }));
      Net.sendTo(p.id, { type: 'hn_view', others, myCount: p.hand.length });
      if (p.isBot) {
        Net.sendTo(p.id, { type: 'hn_cheat', hand: p.hand });
      }
    }
  }

  // ---------- 消息处理 ----------
  function handleMessage(from, data) {
    if (!ctx || !data || !data.type) return;
    if (ctx.isHost) {
      if (data.type === 'hn_play') hostPlay(from, data.cardIndex);
      else if (data.type === 'hn_discard') hostDiscard(from, data.cardIndex);
      else if (data.type === 'hn_hint') hostHint(from, data);
    } else {
      if (data.type === 'hn_state') { mirror = data; localCard = null; render(); }
      else if (data.type === 'hn_view') { myView = data; render(); }
      else if (data.type === 'hn_cheat') { myCheat = data.hand || []; render(); }
    }
  }

  // ---------- 视图 ----------
  function view() {
    if (ctx.isHost) {
      return {
        piles: state.piles,
        hints: state.hints, maxHints: MAX_HINTS,
        fuses: state.fuses, maxFuses: MAX_FUSES,
        deckCount: state.deckCount,
        currentId: currentPlayer().id,
        players: state.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost, isBot: p.isBot, handCount: p.hand.length })),
        hintsFor: state.players.map(p => ({ id: p.id, hints: p.hints })),
        discardCount: state.discard.length,
        phase: state.phase, action: state.action,
        log: state.log.slice(-8), winnerIds: state.winnerIds, endedReason: state.endedReason,
      };
    }
    return mirror;
  }

  // 其他人手牌牌面（不含自己）
  function othersHands(v) {
    const out = {};
    if (ctx.isHost) {
      state.players.forEach(p => { if (p.id !== Net.myId()) out[p.id] = p.hand; });
    } else if (myView) {
      myView.others.forEach(o => { out[o.id] = o.hand; });
    }
    return out;
  }

  // 我的手牌展示：主机/bot 有真实牌面则显示牌面背面样式；真人客机只显示标记
  function myHandInfo(v) {
    const myId = Net.myId();
    const hints = (v.hintsFor || []).find(h => h.id === myId);
    const hintArr = hints ? hints.hints : [];
    const myCount = (v.players || []).find(p => p.id === myId);
    const count = myCount ? myCount.handCount : (myView ? myView.myCount : 0);
    let realHand = null;
    if (ctx.isHost) realHand = state.players.find(p => p.id === myId).hand;
    else if (myCheat) realHand = myCheat;
    return { count, hintArr, realHand };
  }

  function myIsTurn(v) { return v.currentId === Net.myId(); }

  function doPlay() {
    if (localCard == null) return;
    const msg = { type: 'hn_play', cardIndex: localCard };
    if (ctx.isHost) hostPlay(Net.myId(), localCard);
    else Net.sendToHost(msg);
    localCard = null;
    render();
  }

  function doDiscard() {
    if (localCard == null) return;
    const msg = { type: 'hn_discard', cardIndex: localCard };
    if (ctx.isHost) hostDiscard(Net.myId(), localCard);
    else Net.sendToHost(msg);
    localCard = null;
    render();
  }

  function doHint() {
    if (!hintTarget || hintTarget === Net.myId()) return;
    const msg = { type: 'hn_hint', targetId: hintTarget, kind: hintKind, value: hintValue };
    if (ctx.isHost) hostHint(Net.myId(), msg);
    else Net.sendToHost(msg);
    hintTarget = null;
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
    title.textContent = '🎆 花火 Hanabi';
    tb.appendChild(title);
    const right = document.createElement('div');
    right.style.cssText = 'display:flex;gap:8px;align-items:center;';
    if (ctx.solo) {
      const soloPill = document.createElement('span');
      soloPill.className = 'phase-pill solo';
      soloPill.textContent = '🤖 人机';
      right.appendChild(soloPill);
    }
    const turnPill = document.createElement('span');
    turnPill.className = 'phase-pill';
    turnPill.textContent = v ? ('行动：' + ((v.players || []).find(p => p.id === v.currentId) || {}).name) : '准备中';
    right.appendChild(turnPill);
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

    frame.appendChild(UI.banner(v.phase === 'ended' ? 'danger' : '', v.action || ''));

    // token 行：提示 / 失误 / 牌堆
    const tokRow = document.createElement('div');
    tokRow.className = 'hn-tokens';
    const hintTok = document.createElement('div');
    hintTok.className = 'hn-token' + (v.hints <= 0 ? ' zero' : '');
    hintTok.textContent = '💡 提示 ' + v.hints + '/' + v.maxHints;
    const fuseTok = document.createElement('div');
    fuseTok.className = 'hn-token' + (v.fuses <= 1 ? ' zero' : '');
    fuseTok.textContent = '💣 失误 ' + v.fuses + '/' + v.maxFuses;
    const deckTok = document.createElement('div');
    deckTok.className = 'hn-token';
    deckTok.textContent = '🂠 牌堆 ' + v.deckCount;
    tokRow.appendChild(hintTok);
    tokRow.appendChild(fuseTok);
    tokRow.appendChild(deckTok);
    frame.appendChild(tokRow);

    // 五色烟花堆
    const pileRow = document.createElement('div');
    pileRow.className = 'hn-piles';
    COLORS.forEach(col => {
      const el = document.createElement('div');
      el.className = 'hn-pile' + (v.piles[col.key] === 5 ? ' done' : '');
      const n = v.piles[col.key] || 0;
      el.innerHTML = '<span class="hn-pile-dot">' + col.dot + '</span><span class="hn-pile-name">' + col.name + '</span><span class="hn-pile-num">' + n + '/5</span>';
      pileRow.appendChild(el);
    });
    frame.appendChild(pileRow);

    // 玩家区：自己的牌背面 + 标记；他人牌面
    const playerZone = document.createElement('div');
    playerZone.className = 'hn-players';
    const hands = othersHands(v);
    const myInfo = myHandInfo(v);
    (v.players || []).forEach(p => {
      const sec = document.createElement('div');
      sec.className = 'hn-player' + (p.id === v.currentId ? ' active' : '');
      const nameEl = document.createElement('div');
      nameEl.className = 'hn-player-name';
      nameEl.textContent = p.name + (p.id === myId ? '（你）' : '') + (p.id === v.currentId ? ' 👉' : '');
      sec.appendChild(nameEl);
      const handRow = document.createElement('div');
      handRow.className = 'hn-hand';
      if (p.id === myId) {
        // 自己的牌：背面 + 提示标记
        for (let i = 0; i < myInfo.count; i++) {
          const el = document.createElement('div');
          el.className = 'hn-mycard' + (localCard === i && v.phase === 'playing' && myIsTurn(v) ? ' selected' : '');
          const hint = myInfo.hintArr[i] || {};
          let tags = '';
          if (hint.color) tags += '<span class="hn-tag color" style="background:' + colorOf(hint.color).dot + '">' + colorOf(hint.color).name + '</span>';
          if (hint.number) tags += '<span class="hn-tag num">' + hint.number + '</span>';
          el.innerHTML = '<span class="hn-back">🂠</span>' + tags;
          if (v.phase === 'playing' && myIsTurn(v)) {
            el.addEventListener('click', () => { localCard = (localCard === i) ? null : i; render(); });
          }
          handRow.appendChild(el);
        }
        if (myInfo.count === 0) {
          const empty = document.createElement('span');
          empty.textContent = '（无手牌）';
          empty.style.cssText = 'color:var(--ink-2);font-size:12px;';
          handRow.appendChild(empty);
        }
      } else {
        const cards = hands[p.id] || [];
        cards.forEach(card => {
          const el = document.createElement('div');
          el.className = 'hn-card';
          el.innerHTML = '<span class="hn-card-dot">' + colorOf(card.color).dot + '</span><span class="hn-card-num">' + card.number + '</span>';
          handRow.appendChild(el);
        });
        if (cards.length === 0) {
          const empty = document.createElement('span');
          empty.textContent = '（无手牌）';
          empty.style.cssText = 'color:var(--ink-2);font-size:12px;';
          handRow.appendChild(empty);
        }
      }
      sec.appendChild(handRow);
      frame.appendChild(sec);
    });
    frame.appendChild(playerZone);

    // 提示操作区（仅当前玩家回合且非结束）
    if (v.phase === 'playing' && myIsTurn(v)) {
      const hintArea = document.createElement('div');
      hintArea.className = 'hn-hint-area';
      const hTitle = document.createElement('div');
      hTitle.style.cssText = 'font-weight:700;font-size:13px;margin-bottom:6px;';
      hTitle.textContent = '💡 提示（消耗 1 个提示 token）';
      hintArea.appendChild(hTitle);
      const targetRow = document.createElement('div');
      targetRow.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:6px;';
      const tLabel = document.createElement('span');
      tLabel.textContent = '目标：';
      tLabel.style.cssText = 'font-size:12px;color:var(--ink-2);';
      targetRow.appendChild(tLabel);
      (v.players || []).forEach(p => {
        if (p.id === myId) return;
        const b = document.createElement('button');
        b.className = 'btn btn-xs ' + (hintTarget === p.id ? 'btn-primary' : 'btn-ghost');
        b.textContent = p.name;
        b.addEventListener('click', () => { hintTarget = p.id; render(); });
        targetRow.appendChild(b);
      });
      hintArea.appendChild(targetRow);
      const kindRow = document.createElement('div');
      kindRow.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:6px;';
      const kLabel = document.createElement('span');
      kLabel.textContent = '内容：';
      kLabel.style.cssText = 'font-size:12px;color:var(--ink-2);';
      kindRow.appendChild(kLabel);
      COLORS.forEach(col => {
        const b = document.createElement('button');
        b.className = 'btn btn-xs ' + (hintKind === 'color' && hintValue === col.key ? 'btn-primary' : 'btn-ghost');
        b.textContent = col.dot + col.name;
        b.addEventListener('click', () => { hintKind = 'color'; hintValue = col.key; render(); });
        kindRow.appendChild(b);
      });
      NUMBERS.forEach(num => {
        const b = document.createElement('button');
        b.className = 'btn btn-xs ' + (hintKind === 'number' && hintValue === num ? 'btn-primary' : 'btn-ghost');
        b.textContent = '' + num;
        b.addEventListener('click', () => { hintKind = 'number'; hintValue = num; render(); });
        kindRow.appendChild(b);
      });
      hintArea.appendChild(kindRow);
      const go = document.createElement('button');
      go.className = 'btn btn-secondary btn-sm';
      go.textContent = '执行提示';
      go.disabled = !hintTarget || hintTarget === myId;
      go.addEventListener('click', doHint);
      hintArea.appendChild(go);
      frame.appendChild(hintArea);
    }

    // 行动记录
    if (v.log && v.log.length) {
      const log = document.createElement('div');
      log.className = 'hn-log';
      log.textContent = '📋 ' + v.log.slice(-5).join('；');
      frame.appendChild(log);
    }

    // 操作条
    const bar = document.createElement('div');
    bar.className = 'actionbar';
    if (v.phase === 'playing' && myIsTurn(v)) {
      const playBtn = document.createElement('button');
      playBtn.className = 'btn btn-primary';
      playBtn.textContent = '打出';
      playBtn.disabled = localCard == null;
      playBtn.addEventListener('click', doPlay);
      bar.appendChild(playBtn);
      const disBtn = document.createElement('button');
      disBtn.className = 'btn btn-ghost';
      disBtn.textContent = '弃牌';
      disBtn.disabled = localCard == null;
      disBtn.addEventListener('click', doDiscard);
      bar.appendChild(disBtn);
      const tip = document.createElement('span');
      tip.textContent = '（点选自己的牌再打出/弃牌；你只能看到别人手里的牌）';
      tip.style.cssText = 'color:var(--ink-2);font-size:12px;';
      bar.appendChild(tip);
    } else if (v.phase === 'ended') {
      const btn = document.createElement('button');
      btn.className = 'btn btn-primary';
      btn.textContent = '返回房间';
      btn.addEventListener('click', () => ctx.leave());
      bar.appendChild(btn);
    } else {
      const wait = document.createElement('span');
      wait.textContent = '等待其他玩家行动…';
      wait.style.cssText = 'color:var(--ink-2);';
      bar.appendChild(wait);
    }
    frame.appendChild(bar);

    c.appendChild(frame);
  }

  return { init, handleMessage };
})();
