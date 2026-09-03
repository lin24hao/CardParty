// 抽鬼牌（Old Maid）—— 主机权威
// 规则：52 张标准牌 + 1 张小王（鬼牌）共 53 张，各人先出掉手里的对子；轮流从下家抽一张，抽到能凑对就打出。最后手里剩下小王的人输。
// 每回合分为两个阶段，增加代入感与博弈：
//   arrange（整理）—— 被抽牌的人调整手牌顺序（点两张牌交换位置），然后点「亮牌」；
//   draw（抽牌）—— 抽牌的人点击对方一张背面牌，抽取该位置（而非随机按钮）。
const OldMaid = (() => {
  let ctx = null;
  let state = null;      // 主机状态
  let myHand = [];       // 客机：我的手牌
  let mirror = null;     // 客机：公开状态镜像
  let sel = null;        // 整理阶段：当前选中的牌下标（用于交换）

  function init(c) {
    ctx = c;
    state = null;
    myHand = [];
    mirror = null;
    sel = null;
    if (ctx.isHost) hostStart();
    else render();
  }

  // ---------- 主机逻辑 ----------
  function hostStart() {
    let ok = false, attempt = 0;
    let hands = {}, players = null;
    while (!ok && attempt < 20) {
      attempt++;
      const deck = Deck.makeDeck().concat([Deck.JOKER]); // 52 张 + 1 张小王
      const shuffled = Deck.shuffle(deck);
      players = ctx.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost, isBot: p.isBot, out: false }));
      hands = {};
      players.forEach(p => hands[p.id] = []);
      shuffled.forEach((c, i) => hands[players[i % players.length].id].push(c));
      players.forEach(p => hands[p.id] = removePairs(hands[p.id]));
      ok = players.filter(p => hands[p.id].length > 0).length >= 2;
    }
    const firstActive = players.findIndex(p => hands[p.id].length > 0);
    state = { players, hands, turn: -1, target: -1, stage: 'arrange', loser: null, action: '游戏开始，大家先把手里的对子出掉' };
    beginTurn(firstActive);
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

  // 开始某个玩家的回合：设定抽牌方 turn 与目标 target，进入整理阶段
  function beginTurn(idx) {
    if (!state || state.stage === 'ended') return;
    state.turn = idx;
    state.target = nextActive(idx);
    if (state.target < 0) return;
    state.stage = 'arrange';
    const drawer = state.players[idx];
    const target = state.players[state.target];
    state.action = '轮到 ' + drawer.name + ' 抽牌：' + target.name + ' 正在整理手牌';
    pushState();
    pushHands();
    render();
  }

  // 被抽牌方整理完成 → 进入抽牌阶段
  function hostArrangeDone(fromId, order) {
    if (!state || state.stage !== 'arrange') return;
    const tIdx = state.target;
    if (tIdx < 0 || state.players[tIdx].id !== fromId) return;
    if (order && Array.isArray(order) && order.length === state.hands[fromId].length) {
      state.hands[fromId] = order.slice();
    }
    state.stage = 'draw';
    state.action = state.players[state.turn].name + '，点击 ' + state.players[state.target].name + ' 的牌来抽';
    pushState();
    pushHands();
    render();
  }

  function hostHandleDraw(fromId, index) {
    if (!state || state.stage !== 'draw') return;
    const idx = state.players.findIndex(p => p.id === fromId);
    if (idx !== state.turn) return;
    const target = state.players[state.target];
    const th = state.hands[target.id];
    if (typeof index !== 'number' || index < 0 || index >= th.length) return;
    const card = th.splice(index, 1)[0];
    const drawer = state.players[idx];
    // 抽牌方手牌在每轮结算后都是「无对」状态，故最多只会新增一对；partner 即与其凑对的那张
    const partner = state.hands[fromId].find(c => c.rank === card.rank);
    state.hands[fromId].push(card);
    const action = drawer.name + ' 抽走了 ' + target.name + ' 的一张牌';

    if (partner) {
      // 凑成一对：先把抽到的牌加入手牌并一起发光，短暂停留后移除对子 + 上移动画
      const pair = { a: card, b: partner };
      state.pendingPair = { playerId: fromId, cards: [card, partner] };
      state.stage = 'feedback';
      state.action = action + '，凑成一对打出去了！';
      pushState();
      pushHands();
      render();
      setTimeout(() => {
        state.hands[fromId] = removePairs(state.hands[fromId]);
        state.pendingPair = null;
        Net.broadcast({ type: 'om_pair', playerId: fromId, name: drawer.name, cards: [pair.a, pair.b] });
        if (ctx.isHost) showPairFly(drawer.name, [pair.a, pair.b]);
        finishDraw(idx, state.action);
      }, 950);
    } else {
      finishDraw(idx, action);
    }
  }

  // 抽牌结算：更新出局状态、判定胜负并推进下一回合
  function finishDraw(idx, action) {
    state.players.forEach(p => p.out = state.hands[p.id].length === 0);
    const active = state.players.filter(p => !p.out);
    if (active.length === 1) {
      state.loser = active[0].id;
      state.stage = 'ended';
      state.turn = -1;
      state.target = -1;
      state.action = action + '。' + active[0].name + ' 手里剩下了鬼牌！';
      pushState();
      pushHands();
      render();
    } else {
      state.action = action;
      state.stage = 'feedback';
      pushState();
      pushHands();
      render();
      const next = nextActive(idx);
      setTimeout(() => beginTurn(next), 1100);
    }
  }

  function pushState() {
    const pub = state.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost, isBot: p.isBot, count: state.hands[p.id].length, out: p.out }));
    const msg = {
      type: 'om_state',
      players: pub,
      turnId: state.turn >= 0 ? state.players[state.turn].id : null,
      targetId: state.target >= 0 ? state.players[state.target].id : null,
      stage: state.stage,
      loser: state.loser,
      loserCard: state.loser ? state.hands[state.loser][0] : null,
      pendingPair: state.pendingPair ? { playerId: state.pendingPair.playerId, cards: state.pendingPair.cards } : null,
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
      if (data.type === 'om_arranged') hostArrangeDone(from, data.order);
      else if (data.type === 'om_draw') hostHandleDraw(from, data.index);
    } else {
      if (data.type === 'om_state') { mirror = data; render(); }
      else if (data.type === 'om_hand') { myHand = data.hand || []; render(); }
      else if (data.type === 'om_pair') { showPairFly(data.name, data.cards || []); }
    }
  }

  // ---------- 视图 ----------
  function view() {
    if (ctx.isHost) {
      const players = state.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost, isBot: p.isBot, count: state.hands[p.id].length, out: p.out }));
      return {
        players,
        turnId: state.turn >= 0 ? state.players[state.turn].id : null,
        targetId: state.target >= 0 ? state.players[state.target].id : null,
        stage: state.stage,
        loser: state.loser,
        loserCard: state.loser ? state.hands[state.loser][0] : null,
        pendingPair: state.pendingPair ? { playerId: state.pendingPair.playerId, cards: state.pendingPair.cards } : null,
        action: state.action,
      };
    }
    if (!mirror) return null;
    return mirror;
  }

  function myHandCards() {
    if (ctx.isHost) return state.hands[Net.myId()];
    return myHand;
  }

  // 整理阶段：点一张选中，再点另一张交换位置
  function clickHandCard(i) {
    const hand = myHandCards();
    if (!hand || i < 0 || i >= hand.length) return;
    if (sel === null) { sel = i; render(); return; }
    if (sel === i) { sel = null; render(); return; }
    const tmp = hand[sel];
    hand[sel] = hand[i];
    hand[i] = tmp;
    sel = null;
    render();
  }

  function doArrangeDone() {
    if (ctx.isHost) hostArrangeDone(Net.myId(), state.hands[Net.myId()].slice());
    else Net.sendToHost({ type: 'om_arranged', order: myHand.slice() });
  }

  function doDraw(index) {
    if (ctx.isHost) hostHandleDraw(Net.myId(), index);
    else Net.sendToHost({ type: 'om_draw', index });
  }

  function bannerFor(v) {
    const myId = Net.myId();
    if (v.stage === 'ended') {
      const loser = v.players.find(p => p.id === v.loser);
      return { cls: 'danger', text: '💀 游戏结束！' + (loser ? loser.name : '') + ' 拿到了鬼牌，输了！' };
    }
    if (v.stage === 'feedback') {
      const paired = !!v.action && v.action.indexOf('凑成一对') >= 0;
      return { cls: paired ? 'ok' : '', text: v.action, pop: paired };
    }
    if (v.stage === 'arrange') {
      if (v.targetId === myId) {
        const drawer = v.players.find(p => p.id === v.turnId);
        return { cls: 'warn', text: (drawer ? drawer.name : '') + ' 要抽你的牌，请调整位置后点「亮牌」' };
      }
      if (v.turnId === myId) {
        const target = v.players.find(p => p.id === v.targetId);
        return { cls: '', text: '请稍候，' + (target ? target.name : '') + ' 正在整理手牌…' };
      }
      return { cls: '', text: v.action };
    }
    if (v.stage === 'draw') {
      if (v.turnId === myId) {
        const target = v.players.find(p => p.id === v.targetId);
        return { cls: 'ok', text: '轮到你啦！点击 ' + (target ? target.name : '') + ' 的一张牌来抽' };
      }
      if (v.targetId === myId) {
        const drawer = v.players.find(p => p.id === v.turnId);
        return { cls: '', text: (drawer ? drawer.name : '') + ' 正在选择你的牌…' };
      }
      return { cls: '', text: v.action };
    }
    return { cls: '', text: v.action || '' };
  }

  // 凑成一对的全局特效：居中浮现两张牌，发光 → 上移 → 消失
  function showPairFly(name, cards) {
    if (!cards || cards.length === 0) return;
    const host = document.createElement('div');
    host.className = 'pair-fly';
    const label = document.createElement('div');
    label.className = 'pair-fly-label';
    label.textContent = '🤝 ' + (name || '') + ' 凑成一对！';
    host.appendChild(label);
    const row = document.createElement('div');
    row.className = 'pair-fly-cards';
    cards.forEach(cd => {
      const el = UI.cardEl(cd);
      el.classList.add('pair-fly-card');
      row.appendChild(el);
    });
    host.appendChild(row);
    document.body.appendChild(host);
    setTimeout(() => { if (host.parentNode) host.parentNode.removeChild(host); }, 1450);
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
    pill.className = 'phase-pill' + (v && v.stage === 'ended' ? ' warn' : '');
    pill.textContent = (v && v.stage === 'ended') ? '已结束' : (v ? '进行中' : '准备中');
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

    const amArrangeTarget = v.stage === 'arrange' && v.targetId === myId;
    const amDrawer = v.stage === 'draw' && v.turnId === myId;
    if (!amArrangeTarget) sel = null;

    const b = bannerFor(v);
    const ban = UI.banner(b.cls, b.text);
    if (b.pop) ban.classList.add('pop');
    frame.appendChild(ban);

    // 各玩家座位（上下布局：上面名字/状态，下面一行背面牌）
    const seats = document.createElement('div');
    seats.className = 'seats';
    v.players.forEach(p => {
      const seat = document.createElement('div');
      let seatCls = 'seat seat-stacked';
      if (v.stage !== 'ended' && v.turnId === p.id) seatCls += ' active';
      if (v.stage === 'ended' && p.id === v.loser) seatCls += ' lose';
      seat.className = seatCls;

      const head = document.createElement('div');
      head.className = 'seat-head';
      head.appendChild(UI.avatarEl(p.id, p.name));
      const meta = document.createElement('div');
      meta.className = 'meta';
      const nm = document.createElement('div');
      nm.className = 'sname';
      nm.textContent = (p.isBot ? '🤖 ' : '') + p.name + (p.id === myId ? '（你）' : '') + (p.isHost ? ' · 房主' : '');
      meta.appendChild(nm);
      const st = document.createElement('div');
      st.className = 'stag';
      if (v.stage === 'ended') {
        st.textContent = p.id === v.loser ? '👻 拿着鬼牌' : (p.count === 0 ? '✅ 安全' : '');
      } else if (p.out) {
        st.textContent = '✅ 安全出局';
      } else {
        let tag = '';
        if (v.stage === 'draw' && v.targetId === p.id) tag = ' · 被抽中';
        else if (v.stage === 'arrange' && v.targetId === p.id) tag = ' · 整理中';
        st.textContent = '剩 ' + p.count + ' 张' + tag;
      }
      meta.appendChild(st);
      head.appendChild(meta);
      seat.appendChild(head);

      if (p.id !== myId && !p.out && p.count > 0) {
        const row = document.createElement('div');
        row.className = 'seat-cards';
        const clickable = amDrawer && v.targetId === p.id;
        const show = clickable ? p.count : Math.min(p.count, 12);
        for (let i = 0; i < show; i++) {
          const back = UI.cardBackEl(true);
          if (clickable) {
            back.classList.add('selectable');
            const idx = i;
            back.addEventListener('click', () => doDraw(idx));
          }
          row.appendChild(back);
        }
        if (!clickable && p.count > 12) {
          const more = document.createElement('span');
          more.textContent = '…';
          more.style.cssText = 'align-self:center;color:var(--ink-2);';
          row.appendChild(more);
        }
        seat.appendChild(row);
      }
      seats.appendChild(seat);
    });
    frame.appendChild(seats);

    // 我的手牌
    const handTitle = document.createElement('div');
    handTitle.style.cssText = 'font-weight:700;margin:16px 0 8px;font-size:14px;';
    handTitle.textContent = amArrangeTarget ? '我的手牌 · 点两张牌交换位置' : '我的手牌';
    frame.appendChild(handTitle);
    const handWrap = document.createElement('div');
    handWrap.className = 'hand-cards';
    const myCards = myHandCards() || [];
    myCards.forEach((cd, i) => {
      const el = UI.cardEl(cd);
      if (amArrangeTarget) {
        el.classList.add('selectable');
        if (sel === i) el.classList.add('selected');
        el.addEventListener('click', () => clickHandCard(i));
      }
      // 我刚刚抽牌凑成一对：两张同点数的牌一起发光
      if (v.pendingPair && v.pendingPair.playerId === myId && v.pendingPair.cards && v.pendingPair.cards.some(pc => pc.rank === cd.rank)) {
        el.classList.add('pair-glow');
      }
      handWrap.appendChild(el);
    });
    if (myCards.length === 0) {
      const empty = document.createElement('span');
      empty.textContent = '（没有牌）';
      empty.style.cssText = 'color:var(--ink-2);';
      handWrap.appendChild(empty);
    }
    frame.appendChild(handWrap);

    // 操作条
    const bar = document.createElement('div');
    bar.className = 'actionbar';
    if (amArrangeTarget) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-primary';
      btn.textContent = '亮牌（整理完成）';
      btn.addEventListener('click', doArrangeDone);
      bar.appendChild(btn);
    } else if (v.stage === 'ended') {
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
