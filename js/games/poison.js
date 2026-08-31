// 女巫的毒药（Poison）—— 主机权威
//
// 规则（Reiner Knizia《Poison / 毒药》）：
//   3 种药水色（红 / 蓝 / 紫），每色 14 张：1×3、2×3、4×2、5×3、7×3；
//   另有 8 张绿色「毒药」牌，每张值 4。
//   桌面中央有 3 口锅（对应 3 色）。轮到你时必须打 1 张牌：
//     · 药水牌：只能放进同色的锅（空锅由第一张药水牌决定颜色）；
//     · 毒药牌：可放进任意一口锅。
//   放牌后若该锅总点数 > 13（达到 14 及以上），则你必须收走锅中除刚打出的那张外的
//   所有牌（进入你的罚分堆），刚打出的那张牌成为新锅的起点。
//   所有人手牌打完后计分：每种药水色，收得该色最多者（且是唯一最多）可把该色牌全部
//   丢弃、不计罚分；并列最多则无人免罚。计分：每张剩余药水牌 1 罚分、每张毒药牌 2 罚分。
//   共进行「玩家人数」局，累计罚分最少者获胜。
const Poison = (() => {
  const COLORS = ['red', 'blue', 'purple'];
  const COLOR_NAME = { red: '红色', blue: '蓝色', purple: '紫色', poison: '毒药' };
  // 每色牌的数量分布：value -> 张数
  const POTION_DIST = { 1: 3, 2: 3, 4: 2, 5: 3, 7: 3 };
  const POISON_COUNT = 8;

  let ctx = null;
  let state = null;        // 主机状态
  let mirror = null;       // 客机：公开状态镜像
  let myHand = [];         // 客机：我的手牌
  let selId = null;        // 当前选中的手牌 id

  function init(c) {
    ctx = c;
    state = null;
    mirror = null;
    myHand = [];
    selId = null;
    if (ctx.isHost) {
      state = {
        players: ctx.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost, isBot: p.isBot })),
        hand: {}, captured: {}, cauldrons: { red: [], blue: [], purple: [] },
        scores: {}, roundScores: null, roundProtected: null,
        current: -1, phase: 'idle', round: 0, totalRounds: ctx.players.length,
        winner: null, action: '等待发牌',
      };
      state.players.forEach(p => { state.hand[p.id] = []; state.captured[p.id] = []; state.scores[p.id] = 0; });
      render();
    } else {
      render();
    }
  }

  // ---------- 主机逻辑 ----------
  function buildDeck() {
    const deck = [];
    let id = 0;
    for (const color of COLORS) {
      for (const v of Object.keys(POTION_DIST)) {
        for (let i = 0; i < POTION_DIST[v]; i++) {
          deck.push({ id: 'c' + (id++), color, value: +v, poison: false });
        }
      }
    }
    for (let i = 0; i < POISON_COUNT; i++) {
      deck.push({ id: 'c' + (id++), color: 'poison', value: 4, poison: true });
    }
    return deck;
  }

  function deal() {
    const deck = Deck.shuffle(buildDeck());
    state.hand = {}; state.captured = {};
    state.cauldrons = { red: [], blue: [], purple: [] };
    state.players.forEach(p => { state.hand[p.id] = []; state.captured[p.id] = []; });
    let i = 0;
    for (const c of deck) {
      state.hand[state.players[i % state.players.length].id].push(c);
      i++;
    }
    state.round++;
    state.phase = 'playing';
    state.current = (state.round - 1) % state.players.length;
    state.roundScores = null;
    state.roundProtected = null;
    state.action = '第 ' + state.round + ' 局开始：' + state.players[state.current].name + ' 先出牌';
    push();
    pushHands();
  }

  function sum(pot) { return pot.reduce((s, c) => s + c.value, 0); }

  function describeCard(card) {
    return card.poison ? '毒药' : (COLOR_NAME[card.color] + card.value);
  }

  function hostPlay(fromId, cardId, cauldron) {
    if (!state || state.phase !== 'playing') return;
    const idx = state.players.findIndex(p => p.id === fromId);
    if (idx !== state.current) return;
    if (!COLORS.includes(cauldron)) return;
    const hand = state.hand[fromId];
    const ci = hand.findIndex(c => c.id === cardId);
    if (ci < 0) return;
    const card = hand[ci];
    if (!card.poison && card.color !== cauldron) return;   // 药水只能进同色锅

    hand.splice(ci, 1);
    const pot = state.cauldrons[cauldron];
    const before = sum(pot);
    pot.push(card);
    const after = before + card.value;
    const p = state.players[idx];

    if (after > 13) {
      const taken = pot.slice(0, pot.length - 1);
      state.captured[fromId] = state.captured[fromId].concat(taken);
      state.cauldrons[cauldron] = [card];
      state.action = p.name + ' 打出 ' + describeCard(card) + '，' + COLOR_NAME[cauldron] + '锅溢出（' + after + '）！收走 ' + taken.length + ' 张牌';
    } else {
      state.action = p.name + ' 打出 ' + describeCard(card) + '，' + COLOR_NAME[cauldron] + '锅值 ' + after;
    }
    advanceTurn();
    push();
    pushHands();
  }

  function advanceTurn() {
    const n = state.players.length;
    if (!state.players.some(p => state.hand[p.id].length > 0)) { endRound(); return; }
    for (let k = 1; k <= n; k++) {
      const i = (state.current + k) % n;
      if (state.hand[state.players[i].id].length > 0) { state.current = i; return; }
    }
    endRound();
  }

  function endRound() {
    // 每种药水色：统计每人收了多少张
    const counts = {};
    COLORS.forEach(col => { counts[col] = {}; state.players.forEach(p => counts[col][p.id] = 0); });
    state.players.forEach(p => {
      state.captured[p.id].forEach(c => { if (!c.poison) counts[c.color][p.id]++; });
    });

    // 唯一最多者免罚
    const protectedByColor = {};
    COLORS.forEach(col => {
      const vals = state.players.map(p => counts[col][p.id]);
      const max = Math.max(...vals);
      const holders = state.players.filter(p => counts[col][p.id] === max).map(p => p.id);
      protectedByColor[col] = (max > 0 && holders.length === 1) ? holders[0] : null;
    });
    state.roundProtected = protectedByColor;

    // 计算本局罚分
    state.roundScores = {};
    state.players.forEach(p => {
      let penalty = 0;
      state.captured[p.id].forEach(c => {
        if (c.poison) penalty += 2;
        else if (protectedByColor[c.color] !== p.id) penalty += 1;
      });
      state.roundScores[p.id] = penalty;
      state.scores[p.id] = (state.scores[p.id] || 0) + penalty;
    });

    if (state.round >= state.totalRounds) {
      const min = Math.min(...state.players.map(p => state.scores[p.id]));
      state.winner = state.players.filter(p => state.scores[p.id] === min).map(p => p.id);
      state.phase = 'ended';
      state.action = '游戏结束！' + state.players.filter(p => state.winner.includes(p.id)).map(p => p.name).join('、') + ' 罚分最少，获胜！';
    } else {
      state.phase = 'scoring';
      state.action = '第 ' + state.round + ' 局结束，结算中';
    }
    push();
  }

  function restart() {
    state.scores = {};
    state.players.forEach(p => { state.scores[p.id] = 0; });
    state.round = 0;
    state.winner = null;
    state.roundScores = null;
    state.roundProtected = null;
    deal();
  }

  function capturedDetail(p) {
    const d = { red: 0, blue: 0, purple: 0, poison: 0, protected: [] };
    state.captured[p.id].forEach(c => { if (c.poison) d.poison++; else d[c.color]++; });
    COLORS.forEach(col => { if (state.roundProtected && state.roundProtected[col] === p.id) d.protected.push(col); });
    return d;
  }

  // 公开状态（同时用于广播与主机自身视图）
  function pub() {
    const reveal = state.phase === 'scoring' || state.phase === 'ended';
    return {
      type: 'ps_state',
      players: state.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost, isBot: p.isBot })),
      cauldrons: { red: state.cauldrons.red.slice(), blue: state.cauldrons.blue.slice(), purple: state.cauldrons.purple.slice() },
      handCounts: Object.fromEntries(state.players.map(p => [p.id, state.hand[p.id].length])),
      capturedCounts: Object.fromEntries(state.players.map(p => [p.id, state.captured[p.id].length])),
      capturedDetail: reveal ? Object.fromEntries(state.players.map(p => [p.id, capturedDetail(p)])) : null,
      currentId: state.phase === 'playing' && state.current >= 0 ? state.players[state.current].id : null,
      phase: state.phase,
      round: state.round,
      totalRounds: state.totalRounds,
      scores: state.scores,
      roundScores: reveal ? state.roundScores : null,
      winner: state.phase === 'ended' ? state.winner : null,
      action: state.action,
    };
  }

  function push() {
    Net.broadcast(pub());
    render();
  }

  function pushHands() {
    for (const p of state.players) {
      if (p.id !== Net.myId()) Net.sendTo(p.id, { type: 'ps_hand', hand: state.hand[p.id].slice() });
    }
  }

  // ---------- 消息处理 ----------
  function handleMessage(from, data) {
    if (!ctx || !data || !data.type) return;
    if (ctx.isHost) {
      if (data.type === 'ps_play') hostPlay(from, data.cardId, data.cauldron);
    } else {
      if (data.type === 'ps_state') { mirror = data; render(); }
      else if (data.type === 'ps_hand') { myHand = data.hand || []; render(); }
    }
  }

  // ---------- 视图 ----------
  function view() { return ctx.isHost ? pub() : mirror; }

  function myHandCards() { return ctx.isHost ? (state ? state.hand[Net.myId()] : []) : myHand; }

  function doPlay(cardId, cauldron) {
    selId = null;
    if (ctx.isHost) hostPlay(Net.myId(), cardId, cauldron);
    else Net.sendToHost({ type: 'ps_play', cardId, cauldron });
  }

  function bannerFor(v) {
    const myId = Net.myId();
    if (v.phase === 'ended') {
      const names = v.players.filter(p => v.winner.includes(p.id)).map(p => p.name).join('、');
      return { cls: 'ok', text: '🏆 ' + names + ' 毒药最少，获胜！' };
    }
    if (v.phase === 'scoring') return { cls: 'warn', text: v.action };
    if (v.phase === 'idle') {
      return ctx.isHost
        ? { cls: '', text: '点击下方「开始发牌」开始第 1 局' }
        : { cls: '', text: '等待房主开始…' };
    }
    // playing
    if (v.currentId === myId) {
      return { cls: 'ok', text: selId ? '已选牌，点击要放入的锅（超过 13 会溢出收锅）' : '轮到你出牌：先点一张手牌，再点要放入的锅' };
    }
    const cur = v.players.find(p => p.id === v.currentId);
    return { cls: '', text: (cur ? cur.name : '') + ' 正在出牌… · ' + v.action };
  }

  function potionEl(card, opts = {}) {
    const { small = false, selectable = false } = opts;
    const el = document.createElement('div');
    let cls = 'potion ' + (card.poison ? 'poison' : card.color);
    if (small) cls += ' small';
    if (selectable) cls += ' selectable';
    el.className = cls;
    if (card.poison) el.innerHTML = '☠<span class="pv">4</span>';
    else el.innerHTML = String(card.value);
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

    // 顶栏
    const tb = document.createElement('div');
    tb.className = 'game-topbar';
    const title = document.createElement('span');
    title.className = 'game-title';
    title.textContent = '🧪 女巫的毒药';
    tb.appendChild(title);
    const right = document.createElement('div');
    right.style.cssText = 'display:flex;gap:8px;align-items:center;';
    if (ctx.solo) {
      const soloPill = document.createElement('span');
      soloPill.className = 'phase-pill solo';
      soloPill.textContent = '🤖 人机';
      right.appendChild(soloPill);
    }
    const phaseText = { idle: '准备', playing: '出牌中', scoring: '计分', ended: '已结束' };
    const pill = document.createElement('span');
    pill.className = 'phase-pill' + (v && v.phase === 'ended' ? ' ok' : (v && v.phase === 'scoring' ? ' warn' : ''));
    pill.textContent = v ? (phaseText[v.phase] || v.phase) : '…';
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

    // 局数 / 计分板
    const rl = document.createElement('div');
    rl.className = 'round-label';
    rl.textContent = '第 ' + v.round + ' / ' + v.totalRounds + ' 局 · 累计罚分（越少越好）';
    frame.appendChild(rl);

    const sb = document.createElement('div');
    sb.className = 'scoreboard';
    v.players.forEach(p => {
      const chip = document.createElement('span');
      chip.className = 'score-chip' + (v.phase === 'ended' && v.winner.includes(p.id) ? ' win' : '');
      chip.innerHTML = UI.esc(p.name) + ' <b>' + (v.scores[p.id] || 0) + '</b>';
      sb.appendChild(chip);
    });
    frame.appendChild(sb);

    frame.appendChild(UI.banner(bannerFor(v).cls, bannerFor(v).text));

    // 3 口锅
    const myTurn = v.phase === 'playing' && v.currentId === myId;
    const selCard = myTurn && selId ? myHandCards().find(x => x.id === selId) : null;
    const cauldrons = document.createElement('div');
    cauldrons.className = 'cauldrons';
    COLORS.forEach(col => {
      const pot = v.cauldrons[col] || [];
      const total = pot.reduce((s, x) => s + x.value, 0);
      const el = document.createElement('div');
      el.className = 'cauldron ' + col;
      // 选中了某张牌后，合法锅可点击
      const legal = selCard ? (selCard.poison ? true : selCard.color === col) : false;
      if (myTurn && selCard && legal) {
        el.classList.add('selectable');
        el.addEventListener('click', () => doPlay(selCard.id, col));
      }
      const name = document.createElement('div');
      name.className = 'cname';
      name.innerHTML = '<span class="cdot"></span>' + COLOR_NAME[col] + '锅';
      el.appendChild(name);
      const sum = document.createElement('div');
      sum.className = 'ctotal';
      sum.textContent = pot.length ? String(total) : '—';
      el.appendChild(sum);
      const sub = document.createElement('div');
      sub.className = 'csum';
      sub.textContent = pot.length ? (total <= 13 ? '离溢出还差 ' + (13 - total) : '已溢出') : '空锅';
      el.appendChild(sub);
      const cards = document.createElement('div');
      cards.className = 'ccards';
      pot.forEach(x => cards.appendChild(potionEl(x, { small: true })));
      if (!pot.length) {
        const empty = document.createElement('span');
        empty.className = 'cempty';
        empty.textContent = '（空）';
        cards.appendChild(empty);
      }
      el.appendChild(cards);
      cauldrons.appendChild(el);
    });
    frame.appendChild(cauldrons);

    // 玩家（手牌数 + 已收牌数；计分时显示明细）
    const seats = document.createElement('div');
    seats.className = 'seats';
    v.players.forEach(p => {
      const seat = document.createElement('div');
      seat.className = 'seat' + (v.phase === 'playing' && v.currentId === p.id ? ' active' : '');
      seat.appendChild(UI.avatarEl(p.id, p.name));
      const meta = document.createElement('div');
      meta.className = 'meta';
      const nm = document.createElement('div');
      nm.className = 'sname';
      nm.textContent = (p.isBot ? '🤖 ' : '') + p.name + (p.id === myId ? '（你）' : '') + (p.isHost ? ' · 房主' : '');
      meta.appendChild(nm);
      const st = document.createElement('div');
      st.className = 'stag';
      st.textContent = '手牌 ' + (v.handCounts[p.id] || 0) + ' · 已收 ' + (v.capturedCounts[p.id] || 0);
      meta.appendChild(st);
      seat.appendChild(meta);

      // 计分 / 结束：显示收牌明细与本局罚分
      if (v.capturedDetail && v.capturedDetail[p.id]) {
        const det = v.capturedDetail[p.id];
        const parts = [];
        COLORS.forEach(col => {
          if (det[col] > 0) parts.push((det.protected.includes(col) ? '✓' : '') + COLOR_NAME[col] + '×' + det[col]);
        });
        if (det.poison > 0) parts.push('☠毒药×' + det.poison);
        const detail = document.createElement('div');
        detail.className = 'stag';
        detail.style.color = 'var(--ink)';
        detail.textContent = (parts.length ? parts.join('  ') : '未收牌') +
          (v.roundScores ? '  →  罚 ' + (v.roundScores[p.id] || 0) + ' 分' : '');
        seat.appendChild(detail);
      }
      seats.appendChild(seat);
    });
    frame.appendChild(seats);

    // 我的手牌
    const handTitle = document.createElement('div');
    handTitle.style.cssText = 'font-weight:700;margin:16px 0 8px;font-size:14px;';
    handTitle.textContent = '我的手牌';
    frame.appendChild(handTitle);
    const handWrap = document.createElement('div');
    handWrap.className = 'hand-cards';
    const myCards = myHandCards() || [];
    if (myCards.length === 0) {
      const empty = document.createElement('span');
      empty.textContent = '（没有牌）';
      empty.style.cssText = 'color:var(--ink-2);';
      handWrap.appendChild(empty);
    }
    myCards.forEach(cd => {
      const el = potionEl(cd, { selectable: myTurn });
      if (myTurn && selId === cd.id) el.classList.add('selected');
      if (myTurn) {
        el.addEventListener('click', () => {
          selId = (selId === cd.id) ? null : cd.id;
          render();
        });
      }
      handWrap.appendChild(el);
    });
    frame.appendChild(handWrap);

    // 操作条
    const bar = document.createElement('div');
    bar.className = 'actionbar';
    if (v.phase === 'idle') {
      if (ctx.isHost) {
        const btn = document.createElement('button');
        btn.className = 'btn btn-primary';
        btn.textContent = '开始发牌';
        btn.addEventListener('click', () => deal());
        bar.appendChild(btn);
      }
    } else if (v.phase === 'scoring' && ctx.isHost) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-primary';
      btn.textContent = '下一局';
      btn.addEventListener('click', () => deal());
      bar.appendChild(btn);
    } else if (v.phase === 'ended') {
      if (ctx.isHost) {
        const again = document.createElement('button');
        again.className = 'btn btn-primary';
        again.textContent = '再来一局';
        again.addEventListener('click', () => restart());
        bar.appendChild(again);
      }
      const back = document.createElement('button');
      back.className = 'btn btn-ghost';
      back.textContent = '返回房间';
      back.addEventListener('click', () => ctx.leave());
      bar.appendChild(back);
    }
    frame.appendChild(bar);

    c.appendChild(frame);
  }

  return { init, handleMessage };
})();
