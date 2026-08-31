// 抽鬼牌（Old Maid）—— 主机权威
// 规则：去掉黑桃Q，51张牌发完，各人先出掉手里的对子；轮流从下家抽一张，
// 抽到能凑对就打出。最后手里剩下鬼牌（一张Q）的人输。
const OldMaid = (() => {
  let ctx = null;
  let state = null;      // 主机状态
  let myHand = [];       // 客机：我的手牌
  let mirror = null;     // 客机：公开状态镜像

  function init(c) {
    ctx = c;
    state = null;
    myHand = [];
    mirror = null;
    if (ctx.isHost) hostStart();
    else render();
  }

  // ---------- 主机逻辑 ----------
  function hostStart() {
    let ok = false, attempt = 0;
    let hands = {}, players = null;
    while (!ok && attempt < 20) {
      attempt++;
      const deck = Deck.makeDeck().filter(c => !(c.suit === '♠' && c.rank === 'Q'));
      const shuffled = Deck.shuffle(deck);
      players = ctx.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost, out: false }));
      hands = {};
      players.forEach(p => hands[p.id] = []);
      shuffled.forEach((c, i) => hands[players[i % players.length].id].push(c));
      players.forEach(p => hands[p.id] = removePairs(hands[p.id]));
      ok = players.filter(p => hands[p.id].length > 0).length >= 2;
    }
    const firstActive = players.findIndex(p => hands[p.id].length > 0);
    state = { players, hands, turn: firstActive, phase: 'playing', loser: null, action: '游戏开始，大家先把手里的对子出掉' };
    pushState();
    pushHands();
    render();
  }

  // 只保留每种点数中凑不成对的那一张
  function removePairs(cards) {
    const counts = {};
    cards.forEach(c => counts[c.rank] = (counts[c.rank] || 0) + 1);
    const keep = {};
    Object.keys(counts).forEach(r => keep[r] = counts[r] % 2);
    return cards.filter(c => { if (keep[c.rank] > 0) { keep[c.rank]--; return true; } return false; });
  }

  function nextActive(fromIdx) {
    const n = state.players.length;
    for (let k = 1; k <= n; k++) {
      const i = (fromIdx + k) % n;
      if (state.hands[state.players[i].id].length > 0) return i;
    }
    return -1;
  }

  function hostHandleDraw(fromId) {
    if (!state || state.phase !== 'playing') return;
    const idx = state.players.findIndex(p => p.id === fromId);
    if (idx !== state.turn) return;
    const targetIdx = nextActive(idx);
    if (targetIdx === -1) return;
    const drawer = state.players[idx];
    const target = state.players[targetIdx];
    const th = state.hands[target.id];
    const card = th.splice(Math.floor(Math.random() * th.length), 1)[0];
    state.hands[fromId].push(card);
    let action = drawer.name + ' 从 ' + target.name + ' 手中抽走一张牌';
    const before = state.hands[fromId].length;
    state.hands[fromId] = removePairs(state.hands[fromId]);
    if (state.hands[fromId].length < before) action += '，凑成一对打出去了！';
    state.players.forEach(p => p.out = state.hands[p.id].length === 0);
    const active = state.players.filter(p => !p.out);
    if (active.length === 1) {
      state.loser = active[0].id;
      state.phase = 'ended';
      state.turn = -1;
      action += '。' + active[0].name + ' 手里剩下了鬼牌！';
    } else {
      state.turn = nextActive(idx);
      if (state.players[idx].out) action += '。' + drawer.name + ' 手牌出完，安全离场！';
    }
    state.action = action;
    pushState();
    pushHands();
    render();
  }

  function pushState() {
    const pub = state.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost, count: state.hands[p.id].length, out: p.out }));
    const msg = {
      type: 'om_state',
      players: pub,
      turnId: state.turn >= 0 ? state.players[state.turn].id : null,
      phase: state.phase,
      loser: state.loser,
      loserCard: state.loser ? state.hands[state.loser][0] : null,
      action: state.action,
    };
    Net.broadcast(msg);
  }

  function pushHands() {
    for (const p of state.players) {
      if (p.id !== Net.myId()) Net.sendTo(p.id, { type: 'om_hand', hand: state.hands[p.id] });
    }
  }

  // ---------- 消息处理 ----------
  function handleMessage(from, data) {
    if (!ctx || !data || !data.type) return;
    if (ctx.isHost) {
      if (data.type === 'om_draw') hostHandleDraw(from);
    } else {
      if (data.type === 'om_state') { mirror = data; render(); }
      else if (data.type === 'om_hand') { myHand = data.hand; render(); }
    }
  }

  // ---------- 视图 ----------
  function sortCards(cards) {
    return cards.slice().sort((a, b) => {
      const d = Deck.rankValue(a.rank) - Deck.rankValue(b.rank);
      if (d) return d;
      return Deck.suits.indexOf(a.suit) - Deck.suits.indexOf(b.suit);
    });
  }

  function view() {
    if (ctx.isHost) {
      const players = state.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost, count: state.hands[p.id].length, out: p.out }));
      return { players, turnId: state.turn >= 0 ? state.players[state.turn].id : null, phase: state.phase, loser: state.loser, loserCard: state.loser ? state.hands[state.loser][0] : null };
    }
    if (!mirror) return null;
    return mirror;
  }

  function myHandCards() {
    if (ctx.isHost) return state.hands[Net.myId()];
    return myHand;
  }

  function myDrawTarget() {
    const v = view();
    if (!v) return null;
    const myId = Net.myId();
    const idx = v.players.findIndex(p => p.id === myId);
    for (let k = 1; k <= v.players.length; k++) {
      const p = v.players[(idx + k) % v.players.length];
      if (p.count > 0) return p;
    }
    return null;
  }

  function doDraw() {
    if (ctx.isHost) hostHandleDraw(Net.myId());
    else Net.sendToHost({ type: 'om_draw' });
  }

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
    title.textContent = '👻 抽鬼牌';
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
    const v = view();
    pill.className = 'phase-pill' + (v && v.phase === 'ended' ? ' warn' : '');
    pill.textContent = (v && v.phase === 'ended') ? '已结束' : '进行中';
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
    let bannerText = '', bannerCls = '';
    if (v.phase === 'ended') {
      const loser = v.players.find(p => p.id === v.loser);
      bannerText = '💀 游戏结束！' + (loser ? loser.name : '') + ' 拿到了鬼牌，输了！';
      bannerCls = 'danger';
    } else if (v.turnId === myId) {
      const t = myDrawTarget();
      bannerText = '轮到你啦，从 ' + (t ? t.name : '?') + ' 手中抽一张牌';
    } else {
      const cur = v.players.find(p => p.id === v.turnId);
      bannerText = '等待 ' + (cur ? cur.name : '') + ' 抽牌…';
    }
    frame.appendChild(UI.banner(bannerCls, bannerText));

    const seats = document.createElement('div');
    seats.className = 'seats';
    v.players.forEach(p => {
      const seat = document.createElement('div');
      seat.className = 'seat' + (v.phase === 'playing' && v.turnId === p.id ? ' active' : '');
      seat.appendChild(UI.avatarEl(p.id, p.name));
      const meta = document.createElement('div');
      meta.className = 'meta';
      const nm = document.createElement('div');
      nm.className = 'sname';
      nm.textContent = (p.isBot ? '🤖 ' : '') + p.name + (p.id === myId ? '（你）' : '') + (p.isHost ? ' · 房主' : '');
      meta.appendChild(nm);
      const st = document.createElement('div');
      st.className = 'stag';
      if (v.phase === 'ended') {
        st.textContent = p.id === v.loser ? '👻 拿着鬼牌' : (p.count === 0 ? '✅ 安全' : '');
      } else if (p.out) {
        st.textContent = '✅ 安全出局';
      } else {
        st.textContent = '剩 ' + p.count + ' 张' + (v.turnId === p.id ? ' · 抽牌中' : '');
      }
      meta.appendChild(st);
      seat.appendChild(meta);

      const backs = document.createElement('div');
      backs.className = 'cards';
      if (p.id !== myId && !p.out && p.count > 0) {
        const show = Math.min(p.count, 12);
        for (let i = 0; i < show; i++) backs.appendChild(UI.cardBackEl(true));
        if (p.count > show) {
          const more = document.createElement('span');
          more.textContent = '…';
          more.style.cssText = 'align-self:center;color:var(--ink-2);';
          backs.appendChild(more);
        }
      }
      seat.appendChild(backs);
      seats.appendChild(seat);
    });
    frame.appendChild(seats);

    const handTitle = document.createElement('div');
    handTitle.style.cssText = 'font-weight:700;margin:16px 0 8px;font-size:14px;';
    handTitle.textContent = '我的手牌';
    frame.appendChild(handTitle);
    const handWrap = document.createElement('div');
    handWrap.className = 'cards';
    const myCards = sortCards(myHandCards() || []);
    myCards.forEach(cd => handWrap.appendChild(UI.cardEl(cd)));
    if (myCards.length === 0) {
      const empty = document.createElement('span');
      empty.textContent = '（没有牌）';
      empty.style.cssText = 'color:var(--ink-2);';
      handWrap.appendChild(empty);
    }
    frame.appendChild(handWrap);

    const bar = document.createElement('div');
    bar.className = 'actionbar';
    if (v.phase === 'playing' && v.turnId === myId) {
      const t = myDrawTarget();
      const btn = document.createElement('button');
      btn.className = 'btn btn-primary';
      btn.textContent = '从 ' + (t ? t.name : '') + ' 手中抽一张';
      btn.addEventListener('click', doDraw);
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
