// 21点（黑杰克）—— 主机权威
// 规则：无庄家。所有玩家各自要牌/停牌，越接近 21 且不爆为胜；
// 全员停牌或爆牌后开牌比点，点数最高者胜（并列皆胜）。A 可作 1 或 11。
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
        deck: [], phase: 'idle', current: -1, round: 0, action: '等待发牌',
        flashDeal: false,
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
    state.round++;
    for (let k = 0; k < 2; k++) state.players.forEach(p => state.hands[p.id].push(state.deck.pop()));
    state.phase = 'playing';
    state.action = '第 ' + state.round + ' 局开始，发牌';
    state.flashDeal = true;
    startTurns();
    push();
    state.flashDeal = false;
  }

  function startTurns() {
    const n = state.players.length;
    for (let k = 0; k < n; k++) {
      const p = state.players[k];
      if (!state.stood[p.id]) { state.current = k; return; }
    }
    state.current = -1;
    revealAndSettle();
  }

  function advance() {
    const n = state.players.length;
    const start = state.current;
    for (let k = 1; k <= n; k++) {
      const i = (start + k) % n;
      const p = state.players[i];
      if (!state.stood[p.id]) { state.current = i; return; }
    }
    state.current = -1;
    revealAndSettle();
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

  async function revealAndSettle() {
    state.phase = 'reveal';
    state.action = '开牌结算…';
    push();
    await sleep(700);
    settle();
    push();
  }

  function settle() {
    state.phase = 'ended';
    // 计算每位玩家点数，找出未爆牌中的最高点
    const totals = {};
    let best = -1;
    state.players.forEach(p => {
      const v = Deck.blackjackValue(state.hands[p.id]);
      totals[p.id] = v;
      if (!state.bust[p.id] && v > best) best = v;
    });
    // 最高点（含并列）判胜
    let winners = 0;
    state.players.forEach(p => {
      let r;
      if (state.bust[p.id]) r = 'lose';
      else if (totals[p.id] === best) r = 'win';
      else r = 'lose';
      state.results[p.id] = r;
      if (r === 'win') { winners++; state.scores[p.id] = (state.scores[p.id] || 0) + 1; }
    });
    if (winners === 0) {
      state.action = '全员爆牌，本局无胜者';
    } else {
      const names = state.players.filter(p => state.results[p.id] === 'win').map(p => p.name).join('、');
      state.action = names + ' 以 ' + best + ' 点获胜！';
    }
  }

  function push() {
    const msg = {
      type: 'bj_state',
      players: state.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost })),
      hands: state.hands,
      stood: state.stood, bust: state.bust,
      currentId: state.current >= 0 ? state.players[state.current].id : null,
      phase: state.phase, scores: state.scores, results: state.results, action: state.action,
      flashDeal: !!state.flashDeal,
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
      return {
        players: state.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost })),
        hands: state.hands, stood: state.stood, bust: state.bust,
        currentId: state.current >= 0 ? state.players[state.current].id : null,
        phase: state.phase, scores: state.scores, results: state.results, action: state.action,
        flashDeal: !!state.flashDeal,
      };
    }
    return mirror;
  }

  function doAction(act) {
    if (ctx.isHost) hostAction(Net.myId(), act);
    else Net.sendToHost({ type: 'bj_action', action: act });
  }

  const RESULT_TEXT = { win: '🏆 胜', lose: '✖ 负' };

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
    const phaseText = { idle: '等待发牌', playing: '比点进行中', reveal: '开牌结算', ended: '本局结束' };
    if (ctx.solo) {
      const soloPill = document.createElement('span');
      soloPill.className = 'phase-pill solo';
      soloPill.textContent = '🤖 人机';
      right.appendChild(soloPill);
    }
    const pill = document.createElement('span');
    pill.className = 'phase-pill' + (v && v.phase === 'ended' ? ' ok' : (v && v.phase === 'reveal' ? ' warn' : ''));
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

    // 所有玩家（无庄家）
    const seats = document.createElement('div');
    seats.className = 'seats';
    v.players.forEach(p => {
      const hand = v.hands[p.id] || [];
      const total = Deck.blackjackValue(hand);
      const natural = hand.length === 2 && total === 21;

      let seatCls = 'seat';
      if (v.phase === 'playing' && v.currentId === p.id) seatCls += ' active';
      if (v.bust[p.id]) seatCls += ' bust';
      if (natural && v.phase !== 'ended') seatCls += ' blackjack';
      if (v.phase === 'ended') {
        if (v.results[p.id] === 'win') seatCls += ' win';
        else if (v.results[p.id] === 'lose') seatCls += ' lose';
      }

      const seat = document.createElement('div');
      seat.className = seatCls;
      seat.appendChild(UI.avatarEl(p.id, p.name));
      const meta = document.createElement('div');
      meta.className = 'meta';
      const nm = document.createElement('div');
      nm.className = 'sname';
      nm.textContent = (p.isBot ? '🤖 ' : '') + p.name + (p.id === myId ? '（你）' : '');
      meta.appendChild(nm);
      const st = document.createElement('div');
      st.className = 'stag';
      let status = v.phase === 'idle' ? '等待发牌' : total + ' 点';
      if (natural) status += ' · Blackjack!';
      if (v.phase === 'ended' && v.results[p.id]) status += ' · ' + RESULT_TEXT[v.results[p.id]];
      else if (v.bust[p.id]) status += ' · 爆牌';
      else if (v.stood[p.id]) status += ' · 停牌';
      else if (v.phase === 'playing' && v.currentId === p.id) status += ' · 要牌中';
      st.textContent = status;
      meta.appendChild(st);
      seat.appendChild(meta);
      const cards = document.createElement('div');
      cards.className = 'cards';
      hand.forEach((cd, i) => {
        const el = UI.cardEl(cd);
        if (v.flashDeal) el.classList.add('deal-in');
        else if (i === hand.length - 1 && hand.length > 2) el.classList.add('new-pop');
        cards.appendChild(el);
      });
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
