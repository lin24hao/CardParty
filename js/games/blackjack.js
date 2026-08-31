// 21点（黑杰克）—— 主机权威
// 规则：所有玩家与庄家比点，越接近 21 不爆为胜；A 可作 1 或 11。
// 玩家轮流要牌/停牌，随后庄家自动补到 ≥17，比大小计分。
const Blackjack = (() => {
  let ctx = null;
  let state = null;
  let mirror = null;

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function init(c) {
    ctx = c;
    state = null;
    mirror = null;
    if (ctx.isHost) {
      state = {
        players: ctx.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost })),
        hands: {}, stood: {}, bust: {}, results: {}, scores: {},
        dealerHand: [], deck: [], phase: 'idle', current: -1, round: 0, action: '等待发牌',
      };
      state.players.forEach(p => state.scores[p.id] = 0);
      render();
    } else {
      render();
    }
  }

  // ---------- 主机逻辑 ----------
  function deal() {
    state.deck = Deck.shuffle(Deck.makeDeck());
    state.players.forEach(p => {
      state.hands[p.id] = [];
      state.stood[p.id] = false;
      state.bust[p.id] = false;
      state.results[p.id] = null;
    });
    state.dealerHand = [];
    state.round++;
    for (let k = 0; k < 2; k++) {
      state.players.forEach(p => state.hands[p.id].push(state.deck.pop()));
      state.dealerHand.push(state.deck.pop());
    }
    state.phase = 'playing';
    state.action = '第 ' + state.round + ' 局开始，发牌';
    startTurns();
    push();
  }

  function startTurns() {
    const n = state.players.length;
    for (let k = 0; k < n; k++) {
      if (!state.stood[state.players[k].id]) { state.current = k; return; }
    }
    state.current = -1;
    dealerPhase();
  }

  function advance() {
    const n = state.players.length;
    const start = state.current;
    for (let k = 1; k <= n; k++) {
      const i = (start + k) % n;
      if (!state.stood[state.players[i].id]) { state.current = i; return; }
    }
    state.current = -1;
    dealerPhase();
  }

  function hostAction(fromId, act) {
    if (state.phase !== 'playing') return;
    const idx = state.players.findIndex(p => p.id === fromId);
    if (idx !== state.current) return;
    const p = state.players[idx];
    if (act === 'hit') {
      state.hands[fromId].push(state.deck.pop());
      state.action = p.name + ' 要牌';
      if (Deck.blackjackValue(state.hands[fromId]) > 21) {
        state.bust[fromId] = true;
        state.stood[fromId] = true;
        state.action = p.name + ' 爆牌了！';
        advance();
      }
    } else if (act === 'stand') {
      state.stood[fromId] = true;
      state.action = p.name + ' 停牌';
      advance();
    }
    push();
  }

  async function dealerPhase() {
    state.phase = 'dealer';
    state.action = '庄家开牌';
    push();
    await sleep(800);
    while (Deck.blackjackValue(state.dealerHand) < 17) {
      state.dealerHand.push(state.deck.pop());
      state.action = '庄家补牌';
      push();
      await sleep(750);
    }
    settle();
    push();
  }

  function settle() {
    const dv = Deck.blackjackValue(state.dealerHand);
    const dealerBust = dv > 21;
    const dealerNatural = state.dealerHand.length === 2 && dv === 21;
    state.phase = 'ended';
    state.players.forEach(p => {
      const hand = state.hands[p.id];
      const pv = Deck.blackjackValue(hand);
      const natural = hand.length === 2 && pv === 21;
      let r;
      if (state.bust[p.id]) r = 'lose';
      else if (dealerBust) r = 'win';
      else if (natural && dealerNatural) r = 'push';
      else if (natural) r = 'win';
      else if (dealerNatural) r = 'lose';
      else if (pv > dv) r = 'win';
      else if (pv === dv) r = 'push';
      else r = 'lose';
      state.results[p.id] = r;
      if (r === 'win') state.scores[p.id] = (state.scores[p.id] || 0) + 1;
    });
    state.action = '本局结束';
  }

  function push() {
    const revealed = state.phase === 'dealer' || state.phase === 'ended';
    const msg = {
      type: 'bj_state',
      players: state.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost })),
      hands: state.hands,
      stood: state.stood,
      bust: state.bust,
      dealerUp: state.dealerHand.slice(0, revealed ? state.dealerHand.length : 1),
      dealerRevealed: revealed,
      dealerTotal: revealed ? Deck.blackjackValue(state.dealerHand) : null,
      currentId: state.current >= 0 ? state.players[state.current].id : null,
      phase: state.phase,
      scores: state.scores,
      results: state.results,
      action: state.action,
    };
    Net.broadcast(msg);
    render();   // 主机自身也要刷新（客机在收到 bj_state 时刷新）
  }

  // ---------- 消息处理 ----------
  function handleMessage(from, data) {
    if (!ctx || !data || !data.type) return;
    if (ctx.isHost) {
      if (data.type === 'bj_action') hostAction(from, data.action);
    } else {
      if (data.type === 'bj_state') { mirror = data; render(); }
    }
  }

  // ---------- 视图 ----------
  function view() {
    if (ctx.isHost) {
      const revealed = state.phase === 'dealer' || state.phase === 'ended';
      return {
        players: state.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost })),
        hands: state.hands, stood: state.stood, bust: state.bust,
        dealerUp: state.dealerHand.slice(0, revealed ? state.dealerHand.length : 1),
        dealerRevealed: revealed,
        dealerTotal: revealed ? Deck.blackjackValue(state.dealerHand) : null,
        currentId: state.current >= 0 ? state.players[state.current].id : null,
        phase: state.phase, scores: state.scores, results: state.results, action: state.action,
      };
    }
    return mirror;
  }

  function doAction(act) {
    if (ctx.isHost) hostAction(Net.myId(), act);
    else Net.sendToHost({ type: 'bj_action', action: act });
  }

  const RESULT_TEXT = { win: '🏆 胜', lose: '✖ 负', push: '🤝 平' };

  function render() {
    if (!ctx) return;
    const c = ctx.container;
    UI.clear(c);
    const frame = document.createElement('div');
    frame.className = 'game-frame';

    const tb = document.createElement('div');
    tb.className = 'game-topbar';
    const title = document.createElement('span');
    title.className = 'game-title';
    title.textContent = '🃏 21点';
    tb.appendChild(title);
    const right = document.createElement('div');
    right.style.cssText = 'display:flex;gap:8px;align-items:center;';
    const v = view();
    const phaseText = { idle: '等待发牌', playing: '玩家要牌', dealer: '庄家阶段', ended: '本局结束' };
    if (ctx.solo) {
      const soloPill = document.createElement('span');
      soloPill.className = 'phase-pill solo';
      soloPill.textContent = '🤖 人机';
      right.appendChild(soloPill);
    }
    const pill = document.createElement('span');
    pill.className = 'phase-pill' + (v && v.phase === 'ended' ? ' ok' : (v && v.phase === 'dealer' ? ' warn' : ''));
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

    const myId = Net.myId();

    // 计分板
    const sb = document.createElement('div');
    sb.className = 'scoreboard';
    v.players.forEach(p => {
      const chip = document.createElement('span');
      chip.className = 'score-chip';
      chip.innerHTML = UI.esc(p.name) + ' <b>' + (v.scores[p.id] || 0) + '</b>';
      sb.appendChild(chip);
    });
    frame.appendChild(sb);

    // 庄家
    const dSeat = document.createElement('div');
    dSeat.className = 'seat';
    const dav = UI.avatarEl('dealer', '庄');
    dav.textContent = '庄';
    dav.style.background = '#334155';
    dSeat.appendChild(dav);
    const dmeta = document.createElement('div');
    dmeta.className = 'meta';
    const dnm = document.createElement('div');
    dnm.className = 'sname';
    dnm.textContent = '庄家';
    dmeta.appendChild(dnm);
    const dst = document.createElement('div');
    dst.className = 'stag';
    dst.textContent = v.dealerRevealed ? (v.dealerTotal + ' 点') : '一张暗牌';
    dmeta.appendChild(dst);
    dSeat.appendChild(dmeta);
    const dcards = document.createElement('div');
    dcards.className = 'cards';
    v.dealerUp.forEach(cd => dcards.appendChild(UI.cardEl(cd)));
    if (!v.dealerRevealed) dcards.appendChild(UI.cardBackEl(false));
    dSeat.appendChild(dcards);
    frame.appendChild(dSeat);

    // 玩家
    const seats = document.createElement('div');
    seats.className = 'seats';
    v.players.forEach(p => {
      const hand = v.hands[p.id] || [];
      const total = Deck.blackjackValue(hand);
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
      let status = v.phase === 'idle' ? '等待发牌' : total + ' 点';
      if (v.phase === 'ended' && v.results[p.id]) status += ' · ' + RESULT_TEXT[v.results[p.id]];
      else if (v.bust[p.id]) status += ' · 爆牌';
      else if (v.stood[p.id]) status += ' · 停牌';
      else if (v.phase === 'playing' && v.currentId === p.id) status += ' · 要牌中';
      st.textContent = status;
      meta.appendChild(st);
      seat.appendChild(meta);
      const cards = document.createElement('div');
      cards.className = 'cards';
      hand.forEach(cd => cards.appendChild(UI.cardEl(cd)));
      seat.appendChild(cards);
      seats.appendChild(seat);
    });
    frame.appendChild(seats);

    // 操作条
    const bar = document.createElement('div');
    bar.className = 'actionbar';
    if (ctx.isHost && v.phase === 'idle') {
      const btn = document.createElement('button');
      btn.className = 'btn btn-primary';
      btn.textContent = '发牌';
      btn.addEventListener('click', () => { deal(); });
      bar.appendChild(btn);
    } else if (v.phase === 'playing' && v.currentId === myId) {
      const hit = document.createElement('button');
      hit.className = 'btn btn-primary';
      hit.textContent = '要牌';
      hit.addEventListener('click', () => doAction('hit'));
      bar.appendChild(hit);
      const stand = document.createElement('button');
      stand.className = 'btn btn-ghost';
      stand.textContent = '停牌';
      stand.addEventListener('click', () => doAction('stand'));
      bar.appendChild(stand);
    } else if (v.phase === 'ended') {
      if (ctx.isHost) {
        const again = document.createElement('button');
        again.className = 'btn btn-primary';
        again.textContent = '下一局';
        again.addEventListener('click', () => { deal(); });
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
