// 卡波（CaBo / Cabo）—— 主机权威
//
// 规则（Bezier Games 第二版，2-4 人）：
//   52 张牌：0 点×2、13 点×2、1-12 点各 4 张。
//   每人 4 张牌背面朝上排成一行，开局先偷看其中 2 张（之后基本靠记忆）。
//   回合三选一：抽牌堆 / 拿弃牌堆 / 喊「卡波」。
//   特殊牌（只有从牌堆抽出并弃掉时才能发动能力）：
//     7 / 8   → Peek 偷看自己一张牌
//     9 / 10  → Spy  偷看别人一张牌
//     11 / 12 → Swap 与别人交换一张牌（双方都不看）
//   换牌固定 1 换 1，手牌始终 4 张且位置不变；换入牌堆抽的牌保持背面，换入弃牌的牌保持正面。
//   喊「卡波」结束本轮：其余玩家各还有最后一回合。喊牌者点数最低记 0 分，否则手牌点数 +10 惩罚。
//   Kamikaze（神风）：凑齐 12、12、13、13 四张 → 本局 0 分，其余人各 +50。
//   总分恰好 100 重置为 50（每人每局限一次）；有人总分 >100 时游戏结束，总分最低者胜。
const Cabo = (() => {
  const ABIL = { 7: 'peek', 8: 'peek', 9: 'spy', 10: 'spy', 11: 'swap', 12: 'swap' };
  const ABIL_LABEL = { peek: '偷看自己', spy: '偷看别人', swap: '交换' };
  const PHASE_TEXT = { peek: '准备', playing: '进行中', endgame: '终局', scoring: '结算', ended: '已结束' };
  const REVEAL_MS = 2200; // 偷看后短暂翻开显示的时长（之后自动盖住）
  const LOOK_MS = 2400;   // 「查看中」标记持续时长（略长于翻牌，让动作可感知）
  const FLY_MS = 480;     // 换牌飞行动画时长

  let ctx = null;
  let state = null;        // 主机状态
  let mirror = null;       // 客机：公开状态镜像
  let myHand = [];         // 客机：我的手牌（私有视图）
  let spied = {};          // 客机：我偷看到别人的牌 { ownerId: { slotIndex: value } }
  let pending = null;      // 客机：我抽到待处理的牌 { from, v }
  let peeked = false;      // 客机：本轮是否已完成偷看
  let flashReveals = {};   // 偷看短暂翻开 { "pid:slot": { value, seq } }
  let revealSeq = 0;

  // 交互选择（本地临时状态）
  let selMode = null;      // 当前交互模式，用于切换时清空选择
  let peekSel = [];        // 偷看阶段选中的牌下标
  let subMode = null;      // 'keep' | 'peek' | 'spy' | 'swap'
  let keepSel = [];        // 「换掉手牌」选中的下标
  let swapMy = null;       // swap 能力：第一步选中的自己牌下标

  function init(c) {
    ctx = c;
    state = null; mirror = null; myHand = []; spied = {}; pending = null; peeked = false;
    flashReveals = {}; revealSeq = 0;
    selMode = null; peekSel = []; subMode = null; keepSel = []; swapMy = null;
    if (ctx.isHost) hostStart();
    else render();
  }

  // ---------- 工具 ----------
  function pidOf(i) { return state.players[i].id; }
  function idxOf(pid) { return state.players.findIndex(p => p.id === pid); }
  function nameOf(pid) { const p = state.players.find(x => x.id === pid); return p ? p.name : '?'; }

  // ---------- 主机逻辑 ----------
  function buildDeck() {
    const deck = [{ v: 0 }, { v: 0 }, { v: 13 }, { v: 13 }];
    for (let v = 1; v <= 12; v++) for (let i = 0; i < 4; i++) deck.push({ v });
    return deck; // 52 张
  }

  function hostStart() {
    state = {
      players: ctx.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost, isBot: p.isBot })),
      round: 0,
      phase: 'peek', stage: 'peek',
      draw: [], discard: [], hands: {},
      current: 0, caller: null, finalDone: [], pending: null, peeked: {},
      looks: [],
      total: {}, resetUsed: {}, winner: null, lastRound: null,
      action: '准备发牌',
    };
    state.players.forEach(p => { state.total[p.id] = 0; state.resetUsed[p.id] = false; });
    deal();
  }

  function deal() {
    state.round++;
    const deck = Deck.shuffle(buildDeck());
    state.draw = deck;
    state.discard = [];
    state.hands = {};
    state.players.forEach(p => { state.hands[p.id] = []; state.peeked[p.id] = false; });
    for (let i = 0; i < 4; i++) {
      state.players.forEach(p => {
        const c = state.draw.pop();
        state.hands[p.id].push({ v: c.v, faceUp: false, seenBy: [] });
      });
    }
    state.phase = 'peek';
    state.stage = 'peek';
    state.current = 0;
    state.caller = null;
    state.finalDone = [];
    state.pending = null;
    state.lastRound = null;
    state.winner = null;
    state.looks = [];
    state.action = '第 ' + state.round + ' 局：每人偷看自己 2 张牌';
    pushAll();
  }

  // 翻一张牌堆顶牌作为弃牌堆起点，进入出牌阶段
  function startRound() {
    if (state.draw.length) state.discard.push(state.draw.pop());
    state.phase = 'playing';
    state.stage = 'choose';
    state.current = 0;
    state.pending = null;
    state.action = '轮到 ' + nameOf(pidOf(0)) + ' 行动';
    pushAll();
  }

  function handSum(pid) {
    return (state.hands[pid] || []).reduce((s, c) => s + c.v, 0);
  }

  function isKamikaze(pid) {
    const vals = (state.hands[pid] || []).map(c => c.v);
    if (vals.length !== 4) return false;
    let c12 = 0, c13 = 0;
    vals.forEach(v => { if (v === 12) c12++; if (v === 13) c13++; });
    return c12 === 2 && c13 === 2;
  }

  function advanceTurn() {
    state.pending = null;
    state.stage = 'choose';
    if (state.phase === 'endgame') {
      // 当前玩家已完成其终局回合
      state.finalDone.push(pidOf(state.current));
      const n = state.players.length;
      for (let k = 1; k <= n; k++) {
        const i = (state.current + k) % n;
        const pid = pidOf(i);
        if (pid === state.caller) continue;
        if (state.finalDone.includes(pid)) continue;
        state.current = i;
        state.action = nameOf(state.caller) + ' 已喊卡波 · 终局轮到 ' + nameOf(pid);
        return;
      }
      endRound();
      return;
    }
    state.current = (state.current + 1) % state.players.length;
    state.action = '轮到 ' + nameOf(pidOf(state.current)) + ' 行动';
  }

  // 抽牌堆空了：保留弃牌堆顶一张，其余洗回牌堆
  function reshuffleDraw() {
    if (state.discard.length <= 1) return;
    const top = state.discard.pop();
    state.draw = Deck.shuffle(state.discard.splice(0));
    state.discard = [top];
  }

  // ---------- 主机动作 ----------
  function hostPeek(fromId, slots) {
    if (!state || state.phase !== 'peek') return;
    if (state.peeked[fromId]) return; // 防止重复偷看
    const hand = state.hands[fromId];
    if (!hand) return;
    const chosen = (Array.isArray(slots) ? slots : []).filter(i => i >= 0 && i < hand.length);
    const reveal = chosen.slice(0, 2);
    reveal.forEach(i => {
      if (!hand[i].seenBy.includes(fromId)) hand[i].seenBy.push(fromId);
    });
    state.peeked[fromId] = true;
    // 向偷看者短暂揭示牌值（之后盖住，靠记忆），并广播「查看中」表现
    reveal.forEach(i => emitLook(fromId, fromId, i, hand[i].v));
    if (state.players.every(p => state.peeked[p.id])) startRound();
    else pushAll();
  }

  function hostAct(fromId, action) {
    if (!state || (state.phase !== 'playing' && state.phase !== 'endgame')) return;
    if (pidOf(state.current) !== fromId || state.stage !== 'choose') return;
    if (action === 'call') {
      if (state.phase !== 'playing') return;
      state.phase = 'endgame';
      state.caller = fromId;
      state.finalDone = [];
      // 找到喊牌者之后的第一位非喊牌玩家，作为终局回合起点
      const n = state.players.length;
      const ci = idxOf(fromId);
      for (let k = 1; k <= n; k++) {
        const i = (ci + k) % n;
        if (pidOf(i) !== fromId) { state.current = i; break; }
      }
      state.stage = 'choose';
      state.pending = null;
      state.action = nameOf(fromId) + ' 喊了「卡波」！终局轮到 ' + nameOf(pidOf(state.current));
      pushAll();
      return;
    }
    if (action === 'draw_deck') {
      if (!state.draw.length) reshuffleDraw();
      if (!state.draw.length) { endRound(); return; }
      const c = state.draw.pop();
      state.pending = { from: 'deck', v: c.v };
      state.stage = 'deck';
      state.action = nameOf(fromId) + ' 从牌堆抽了一张牌';
      pushAll();
      return;
    }
    if (action === 'draw_discard') {
      if (!state.discard.length) {
        state.action = '弃牌堆为空，请从牌堆抽牌';
        pushAll();
        return;
      }
      const c = state.discard.pop();
      state.pending = { from: 'discard', v: c.v };
      state.stage = 'discard';
      state.action = nameOf(fromId) + ' 拿了弃牌堆顶的牌（需换进手牌）';
      pushAll();
      return;
    }
  }

  // 换牌固定 1 换 1，手牌始终 4 张、位置不变
  function validateSwap(hand, slots) {
    if (!Array.isArray(slots) || slots.length !== 1) return null;
    const i = slots[0];
    if (typeof i !== 'number' || i < 0 || i >= hand.length) return null;
    return i;
  }

  function hostDeckKeep(fromId, slots) {
    if (!state || state.stage !== 'deck' || !state.pending || state.pending.from !== 'deck') return;
    if (pidOf(state.current) !== fromId) return;
    const hand = state.hands[fromId];
    const i = validateSwap(hand, slots);
    if (i == null) { state.action = '请选择 1 张要换掉的牌'; pushAll(); return; }
    state.discard.push({ v: hand[i].v });
    hand[i] = { v: state.pending.v, faceUp: false, seenBy: [fromId] };
    state.pending = null;
    state.action = nameOf(fromId) + ' 换掉了 1 张牌';
    advanceTurn(); pushAll();
  }

  function hostDeckDiscard(fromId) {
    if (!state || state.stage !== 'deck' || !state.pending || state.pending.from !== 'deck') return;
    if (pidOf(state.current) !== fromId) return;
    state.discard.push({ v: state.pending.v });
    state.pending = null;
    state.action = nameOf(fromId) + ' 弃掉了抽到的牌';
    advanceTurn(); pushAll();
  }

  function hostDiscardKeep(fromId, slots) {
    if (!state || state.stage !== 'discard' || !state.pending || state.pending.from !== 'discard') return;
    if (pidOf(state.current) !== fromId) return;
    const hand = state.hands[fromId];
    const i = validateSwap(hand, slots);
    if (i == null) { state.action = '请选择 1 张要换掉的牌'; pushAll(); return; }
    state.discard.push({ v: hand[i].v });
    hand[i] = { v: state.pending.v, faceUp: true, seenBy: [] };
    state.pending = null;
    state.action = nameOf(fromId) + ' 换掉了 1 张牌';
    advanceTurn(); pushAll();
  }

  function hostAbility(fromId, data) {
    if (!state || state.stage !== 'deck' || !state.pending || state.pending.from !== 'deck') return;
    if (pidOf(state.current) !== fromId) return;
    const ab = ABIL[state.pending.v];
    if (!ab || data.kind !== ab) return;
    state.discard.push({ v: state.pending.v });
    state.pending = null;

    if (ab === 'peek') {
      const hand = state.hands[fromId];
      const i = data.slot;
      if (typeof i !== 'number' || i < 0 || i >= hand.length) { advanceTurn(); pushAll(); return; }
      if (!hand[i].seenBy.includes(fromId)) hand[i].seenBy.push(fromId);
      emitLook(fromId, fromId, i, hand[i].v);
      state.action = nameOf(fromId) + ' 偷看了自己的一张牌';
    } else if (ab === 'spy') {
      const target = state.hands[data.targetId];
      const i = data.slot;
      if (!target || data.targetId === fromId || typeof i !== 'number' || i < 0 || i >= target.length) { advanceTurn(); pushAll(); return; }
      if (!target[i].seenBy.includes(fromId)) target[i].seenBy.push(fromId);
      emitLook(fromId, data.targetId, i, target[i].v);
      state.action = nameOf(fromId) + ' 偷看了 ' + nameOf(data.targetId) + ' 的一张牌';
    } else if (ab === 'swap') {
      const my = state.hands[fromId];
      const their = state.hands[data.targetId];
      if (!their || data.targetId === fromId) { advanceTurn(); pushAll(); return; }
      const a = data.mySlot, b = data.theirSlot;
      if (typeof a !== 'number' || typeof b !== 'number' || a < 0 || a >= my.length || b < 0 || b >= their.length) { advanceTurn(); pushAll(); return; }
      const tmp = my[a]; my[a] = their[b]; their[b] = tmp;
      state.action = nameOf(fromId) + ' 与 ' + nameOf(data.targetId) + ' 交换了一张牌（都没看）';
    }
    advanceTurn(); pushAll();
  }

  function endRound() {
    state.phase = 'scoring';
    state.pending = null;
    const sums = {};
    state.players.forEach(p => { sums[p.id] = handSum(p.id); });

    const kamikaze = state.players.find(p => isKamikaze(p.id));
    let roundPts = {};
    if (kamikaze) {
      state.players.forEach(p => { roundPts[p.id] = p.id === kamikaze.id ? 0 : 50; });
    } else {
      const min = Math.min(...state.players.map(p => sums[p.id]));
      const lowest = state.players.filter(p => sums[p.id] === min).map(p => p.id);
      state.players.forEach(p => {
        if (lowest.includes(p.id)) roundPts[p.id] = 0;
        else roundPts[p.id] = sums[p.id] + (p.id === state.caller ? 10 : 0);
      });
    }

    state.lastRound = { sums, roundPts, kamikazeId: kamikaze ? kamikaze.id : null };

    let notes = '';
    state.players.forEach(p => {
      state.total[p.id] = (state.total[p.id] || 0) + roundPts[p.id];
      if (state.total[p.id] === 100 && !state.resetUsed[p.id]) {
        state.total[p.id] = 50;
        state.resetUsed[p.id] = true;
        notes += ' · ' + p.name + ' 恰好 100 分，重置为 50！';
      }
    });

    if (state.players.some(p => state.total[p.id] > 100)) {
      state.phase = 'ended';
      const min = Math.min(...state.players.map(p => state.total[p.id]));
      state.winner = state.players.filter(p => state.total[p.id] === min).map(p => p.id);
      state.action = '游戏结束！' + state.players.filter(p => state.winner.includes(p.id)).map(p => p.name).join('、') + ' 总分最低，获胜！';
    } else {
      state.action = '第 ' + state.round + ' 局结束，结算中' + notes;
    }
    pushAll();
  }

  function restart() {
    state.players.forEach(p => { state.total[p.id] = 0; state.resetUsed[p.id] = false; });
    state.round = 0;
    deal();
  }

  // ---------- 公开 / 私有状态 ----------
  function pub() {
    const reveal = state.phase === 'scoring' || state.phase === 'ended';
    const hands = {};
    state.players.forEach(p => {
      hands[p.id] = state.hands[p.id].map(s =>
        (reveal || s.faceUp) ? { faceUp: true, v: s.v } : { faceUp: false, v: null });
    });
    return {
      type: 'cabo_state',
      players: state.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost, isBot: p.isBot })),
      phase: state.phase,
      round: state.round,
      stage: state.stage,
      currentId: (state.phase === 'playing' || state.phase === 'endgame') && state.current >= 0 ? pidOf(state.current) : null,
      callerId: state.caller,
      hands,
      discardTop: state.discard.length ? state.discard[state.discard.length - 1].v : null,
      discardCount: state.discard.length,
      drawCount: state.draw.length,
      total: state.total,
      lastRound: state.phase === 'scoring' || state.phase === 'ended' ? state.lastRound : null,
      winner: state.phase === 'ended' ? state.winner : null,
      looks: (state.looks || []).map(l => ({ viewer: l.viewer, owner: l.owner, slot: l.slot })),
      action: state.action,
    };
  }

  function privFor(pid) {
    const hand = state.hands[pid] || [];
    const myHand = hand.map(s => {
      const seen = s.faceUp || s.seenBy.includes(pid);
      return { faceUp: s.faceUp, seen: !s.faceUp && s.seenBy.includes(pid), v: seen ? s.v : null };
    });
    const spied = {};
    state.players.forEach(q => {
      if (q.id === pid) return;
      const h = state.hands[q.id] || [];
      h.forEach((s, i) => {
        if (!s.faceUp && s.seenBy.includes(pid)) (spied[q.id] = spied[q.id] || {})[i] = s.v;
      });
    });
    const pendingView = (state.pending && pidOf(state.current) === pid)
      ? { from: state.pending.from, v: state.pending.v } : null;
    return { type: 'cabo_priv', myHand, spied, pending: pendingView, peeked: !!state.peeked[pid] };
  }

  function pushAll() {
    Net.broadcast(pub());
    for (const p of state.players) {
      if (p.id !== Net.myId()) Net.sendTo(p.id, privFor(p.id));
    }
    render();
  }

  // 偷看揭示：把某张牌的值短暂发给某位玩家，让其短暂翻开后自动盖住
  function emitReveal(pid, ownerId, slot, value) {
    const msg = { type: 'cabo_reveal', ownerId, slot, value };
    if (pid === Net.myId()) handleReveal(msg);
    else Net.sendTo(pid, msg);
  }

  // 查看中：某人在看某张牌——所有人可见的「查看中」表现，并把牌值单独发给查看者本人
  function emitLook(viewerPid, ownerPid, slot, value) {
    state.looks = state.looks || [];
    state.looks.push({ viewer: viewerPid, owner: ownerPid, slot });
    emitReveal(viewerPid, ownerPid, slot, value);
    pushAll();
    setTimeout(() => {
      if (!state) return;
      state.looks = (state.looks || []).filter(l => !(l.viewer === viewerPid && l.owner === ownerPid && l.slot === slot));
      pushAll();
    }, LOOK_MS);
  }

  function handleReveal(data) {
    if (!data || data.ownerId == null || data.slot == null) return;
    const key = data.ownerId + ':' + data.slot;
    revealSeq++;
    flashReveals[key] = { value: data.value, seq: revealSeq };
    render();
    const mySeq = revealSeq;
    setTimeout(() => {
      if (flashReveals[key] && flashReveals[key].seq === mySeq) {
        delete flashReveals[key];
        render();
      }
    }, REVEAL_MS);
  }

  // ---------- 消息处理 ----------
  function handleMessage(from, data) {
    if (!ctx || !data || !data.type) return;
    if (ctx.isHost) {
      if (data.type === 'cabo_peek') hostPeek(from, data.slots);
      else if (data.type === 'cabo_act') hostAct(from, data.action);
      else if (data.type === 'cabo_deck_keep') hostDeckKeep(from, data.slots);
      else if (data.type === 'cabo_deck_discard') hostDeckDiscard(from);
      else if (data.type === 'cabo_discard_keep') hostDiscardKeep(from, data.slots);
      else if (data.type === 'cabo_ability') hostAbility(from, data);
    } else {
      if (data.type === 'cabo_state') { mirror = data; render(); }
      else if (data.type === 'cabo_priv') {
        myHand = data.myHand || [];
        spied = data.spied || {};
        pending = data.pending || null;
        peeked = !!data.peeked;
        render();
      }
      else if (data.type === 'cabo_reveal') handleReveal(data);
    }
  }

  // ---------- 视图 ----------
  function view() { return ctx.isHost ? pub() : mirror; }
  function myView() {
    if (ctx.isHost) return privFor(Net.myId());
    return { myHand, spied, pending, peeked };
  }

  // ---------- 动作封装 ----------
  function doPeek(slots) {
    if (ctx.isHost) hostPeek(Net.myId(), slots);
    else Net.sendToHost({ type: 'cabo_peek', slots });
  }
  function doAct(action) {
    if (ctx.isHost) hostAct(Net.myId(), action);
    else Net.sendToHost({ type: 'cabo_act', action });
  }
  function doDeckKeep(slots) {
    if (Array.isArray(slots) && slots.length) playSwapAnim(slots[0]);
    if (ctx.isHost) hostDeckKeep(Net.myId(), slots);
    else Net.sendToHost({ type: 'cabo_deck_keep', slots });
  }
  function doDeckDiscard() {
    if (ctx.isHost) hostDeckDiscard(Net.myId());
    else Net.sendToHost({ type: 'cabo_deck_discard' });
  }
  function doDiscardKeep(slots) {
    if (Array.isArray(slots) && slots.length) playSwapAnim(slots[0]);
    if (ctx.isHost) hostDiscardKeep(Net.myId(), slots);
    else Net.sendToHost({ type: 'cabo_discard_keep', slots });
  }
  function doAbility(data) {
    if (data && data.kind === 'swap' && data.targetId && data.mySlot != null && data.theirSlot != null) {
      playSwapAbilityAnim(data.targetId, data.mySlot, data.theirSlot);
    }
    if (ctx.isHost) hostAbility(Net.myId(), data);
    else Net.sendToHost({ type: 'cabo_ability', kind: data.kind, slot: data.slot, targetId: data.targetId, mySlot: data.mySlot, theirSlot: data.theirSlot });
  }

  // ---------- 渲染 ----------
  // 按「归属 + 位置」在容器中查找牌元素（动画与「查看中」标记需要定位）
  function qCard(owner, slot) {
    if (!ctx || !ctx.container || !ctx.container.querySelector) return null;
    return ctx.container.querySelector('.numcard[data-owner="' + owner + '"][data-slot="' + slot + '"]');
  }
  function qPending() {
    if (!ctx || !ctx.container || !ctx.container.querySelector) return null;
    return ctx.container.querySelector('.numcard[data-role="pending"]');
  }
  function qDiscardTop() {
    if (!ctx || !ctx.container || !ctx.container.querySelector) return null;
    return ctx.container.querySelector('.numcard[data-role="discard-top"]');
  }

  // 让一张牌的克隆从 fromEl 位置飞向 toEl 位置（固定定位 + transform 过渡）
  function flyCard(fromEl, toEl) {
    if (!fromEl || !toEl) return;
    if (!document || !document.body || typeof fromEl.getBoundingClientRect !== 'function') return;
    if (typeof requestAnimationFrame !== 'function') return;
    const fr = fromEl.getBoundingClientRect();
    const to = toEl.getBoundingClientRect();
    if (!fr.width || !fr.height) return;
    const clone = fromEl.cloneNode(true);
    clone.classList.remove('selectable', 'selected');
    clone.style.cssText = 'position:fixed;left:0;top:0;margin:0;z-index:9999;pointer-events:none;'
      + 'width:' + fr.width + 'px;height:' + fr.height + 'px;'
      + 'transform:translate(' + fr.left + 'px,' + fr.top + 'px);'
      + 'transition:transform ' + FLY_MS + 'ms cubic-bezier(.2,.7,.3,1);';
    document.body.appendChild(clone);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      clone.style.transform = 'translate(' + to.left + 'px,' + to.top + 'px)';
    }));
    setTimeout(() => { if (clone.parentNode) clone.parentNode.removeChild(clone); }, FLY_MS + 40);
  }

  // 换牌动画：抽到/拿到的新牌飞入手牌位置，被换掉的旧牌飞向弃牌堆
  function playSwapAnim(slot) {
    const myId = Net.myId();
    const handEl = qCard(myId, slot);
    const pendingEl = qPending();
    const discardEl = qDiscardTop();
    if (handEl && pendingEl) flyCard(pendingEl, handEl);
    if (handEl && discardEl) flyCard(handEl, discardEl);
  }

  // Swap 能力动画：自己与对方的两张牌互换位置
  function playSwapAbilityAnim(targetId, mySlot, theirSlot) {
    const myId = Net.myId();
    const myEl = qCard(myId, mySlot);
    const theirEl = qCard(targetId, theirSlot);
    if (myEl && theirEl) {
      flyCard(myEl, theirEl);
      flyCard(theirEl, myEl);
    }
  }

  function numCardEl(v, opts = {}) {
    const { faceUp = true, selectable = false, selected = false, small = false } = opts;
    const el = document.createElement('div');
    let cls = 'numcard ' + (faceUp ? 'faceup' : 'facedown');
    if (small) cls += ' small';
    if (selectable) cls += ' selectable';
    if (selected) cls += ' selected';
    el.className = cls;
    if (faceUp) {
      el.textContent = String(v);
      if (v === 0) el.classList.add('zero');
      else if (v === 13) el.classList.add('red');
      const ab = ABIL[v];
      if (ab) {
        const tag = document.createElement('span');
        tag.className = 'abil';
        tag.textContent = ab === 'peek' ? '👁' : (ab === 'spy' ? '👀' : '🔄');
        el.appendChild(tag);
      }
    }
    return el;
  }

  function topbarEl(v) {
    const tb = document.createElement('div');
    tb.className = 'game-topbar';
    const title = document.createElement('span');
    title.className = 'game-title';
    title.textContent = '🦄 卡波';
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
    pill.className = 'phase-pill' + (v && v.phase === 'ended' ? ' ok' : (v && v.phase === 'scoring' ? ' warn' : ''));
    pill.textContent = v ? (PHASE_TEXT[v.phase] || v.phase) : '…';
    right.appendChild(pill);
    const leaveBtn = document.createElement('button');
    leaveBtn.className = 'btn btn-ghost btn-sm';
    leaveBtn.textContent = '离开';
    leaveBtn.addEventListener('click', () => ctx.leave());
    right.appendChild(leaveBtn);
    tb.appendChild(right);
    return tb;
  }

  function scoreboardEl(v) {
    const rl = document.createElement('div');
    rl.className = 'round-label';
    rl.textContent = '第 ' + v.round + ' 局 · 累计分数（越少越好）';
    const sb = document.createElement('div');
    sb.className = 'scoreboard';
    v.players.forEach(p => {
      const chip = document.createElement('span');
      chip.className = 'score-chip' + (v.phase === 'ended' && v.winner.includes(p.id) ? ' win' : '');
      chip.innerHTML = UI.esc(p.name) + ' <b>' + (v.total[p.id] || 0) + '</b>';
      sb.appendChild(chip);
    });
    const wrap = document.createElement('div');
    wrap.appendChild(rl);
    wrap.appendChild(sb);
    return wrap;
  }

  function pilesEl(v, mv) {
    const table = document.createElement('div');
    table.className = 'cabo-table';

    const drawPile = document.createElement('div');
    drawPile.className = 'cabo-pile';
    const drawCard = numCardEl(0, { faceUp: false });
    const dl = document.createElement('div');
    dl.className = 'cabo-pile-label';
    dl.textContent = '牌堆（剩 ' + v.drawCount + '）';
    drawPile.appendChild(drawCard);
    drawPile.appendChild(dl);

    const discardPile = document.createElement('div');
    discardPile.className = 'cabo-pile';
    const dTop = v.discardTop != null ? numCardEl(v.discardTop) : numCardEl(0, { faceUp: false });
    dTop.dataset.role = 'discard-top';
    if (v.discardTop == null) dTop.style.visibility = 'hidden';
    const dl2 = document.createElement('div');
    dl2.className = 'cabo-pile-label';
    dl2.textContent = '弃牌堆（' + v.discardCount + '）';
    discardPile.appendChild(dTop);
    discardPile.appendChild(dl2);

    table.appendChild(drawPile);
    table.appendChild(discardPile);
    return table;
  }

  // 给某张牌附加「查看中」表现标记（所有人都能看到谁在看哪张牌）
  function attachLookBadge(el, ownerId, slot, v) {
    const looks = (v && v.looks) || [];
    const hit = looks.find(l => l.owner === ownerId && l.slot === slot);
    if (!hit) return;
    const badge = document.createElement('span');
    badge.className = 'look-badge';
    badge.textContent = hit.viewer === ownerId ? '👁 查看中' : '👀 被查看';
    el.appendChild(badge);
  }

  function playerCardsRow(v, p, mv, opts = {}) {
    // opts.clickable(pid, slotIndex) 决定该张牌是否可点；opts.selected(slotIndex) 是否选中
    const hand = v.hands[p.id] || [];
    const row = document.createElement('div');
    row.className = 'cabo-row';
    hand.forEach((s, i) => {
      const flashed = flashReveals[p.id + ':' + i];
      const shown = s.faceUp || flashed != null;
      const shownV = s.faceUp ? s.v : (flashed ? flashed.value : null);
      const clickable = opts.clickable && opts.clickable(p.id, i);
      const selected = opts.selected && opts.selected(i);
      const el = numCardEl(shownV, {
        faceUp: shown, small: true,
        selectable: !!clickable, selected: !!selected,
      });
      el.dataset.owner = p.id;
      el.dataset.slot = i;
      attachLookBadge(el, p.id, i, v);
      if (clickable) {
        el.addEventListener('click', () => opts.onClick(p.id, i));
      }
      row.appendChild(el);
    });
    if (!hand.length) {
      const empty = document.createElement('span');
      empty.textContent = '（无牌）';
      empty.style.cssText = 'color:var(--ink-2);font-size:12px;align-self:center;';
      row.appendChild(empty);
    }
    return row;
  }

  function opponentsEl(v, mv) {
    const seats = document.createElement('div');
    seats.className = 'seats';
    const myId = Net.myId();
    const myTurn = (v.phase === 'playing' || v.phase === 'endgame') && v.currentId === myId;
    const spying = myTurn && v.stage === 'deck' && subMode === 'spy';
    const swapping2 = myTurn && v.stage === 'deck' && subMode === 'swap' && swapMy != null;

    v.players.forEach(p => {
      if (p.id === myId) return;
      const seat = document.createElement('div');
      seat.className = 'seat seat-stacked' + ((v.phase === 'playing' || v.phase === 'endgame') && v.currentId === p.id ? ' active' : '');
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
      const n = (v.hands[p.id] || []).length;
      st.textContent = n + ' 张牌' + (v.callerId === p.id ? ' · 已喊卡波' : '');
      meta.appendChild(st);
      head.appendChild(meta);
      seat.appendChild(head);

      const clickable = (pid, i) => {
        if (!spying && !swapping2) return false;
        const s = v.hands[pid][i];
        return !!s && !s.faceUp;
      };
      seat.appendChild(playerCardsRow(v, p, mv, {
        clickable,
        selected: () => false,
        onClick: (pid, i) => {
          if (spying) doAbility({ kind: 'spy', targetId: pid, slot: i });
          else if (swapping2) { doAbility({ kind: 'swap', targetId: pid, mySlot: swapMy, theirSlot: i }); swapMy = null; }
        },
      }));
      seats.appendChild(seat);
    });
    return seats;
  }

  function myHandEl(v, mv) {
    const myId = Net.myId();
    const wrap = document.createElement('div');
    wrap.className = 'cabo-mine';
    const title = document.createElement('div');
    title.style.cssText = 'font-weight:700;margin:16px 0 8px;font-size:14px;';
    title.textContent = '我的手牌';
    wrap.appendChild(title);

    const myTurn = (v.phase === 'playing' || v.phase === 'endgame') && v.currentId === myId;
    const peekPhase = v.phase === 'peek' && !mv.peeked;

    let clickable = () => false;
    let selected = () => false;
    let onClick = () => {};

    if (peekPhase) {
      clickable = () => true;
      selected = (i) => peekSel.includes(i);
      onClick = (pid, i) => {
        if (peekSel.includes(i)) peekSel = peekSel.filter(x => x !== i);
        else if (peekSel.length < 2) peekSel.push(i);
        render();
      };
    } else if (myTurn && v.stage === 'deck' && subMode === 'keep') {
      clickable = () => true;
      selected = (i) => keepSel.includes(i);
      onClick = (pid, i) => { keepSel = keepSel.includes(i) ? [] : [i]; render(); };
    } else if (myTurn && v.stage === 'discard') {
      clickable = () => true;
      selected = (i) => keepSel.includes(i);
      onClick = (pid, i) => { keepSel = keepSel.includes(i) ? [] : [i]; render(); };
    } else if (myTurn && v.stage === 'deck' && subMode === 'peek') {
      clickable = (pid, i) => { const s = (v.hands[myId] || [])[i]; return !!s && !s.faceUp; };
      selected = () => false;
      onClick = (pid, i) => { doAbility({ kind: 'peek', slot: i }); };
    } else if (myTurn && v.stage === 'deck' && subMode === 'swap') {
      clickable = () => true;
      selected = (i) => swapMy === i;
      onClick = (pid, i) => { swapMy = (swapMy === i ? null : i); render(); };
    }

    const hand = v.hands[myId] || [];
    const row = document.createElement('div');
    row.className = 'cabo-row mine';
    hand.forEach((s, i) => {
      const flashed = flashReveals[myId + ':' + i];
      const shown = s.faceUp || flashed != null;
      const shownV = s.faceUp ? s.v : (flashed ? flashed.value : null);
      const el = numCardEl(shownV, {
        faceUp: shown,
        selectable: clickable(null, i), selected: selected(i),
      });
      el.dataset.owner = myId;
      el.dataset.slot = i;
      attachLookBadge(el, myId, i, v);
      if (clickable(null, i)) el.addEventListener('click', () => onClick(null, i));
      row.appendChild(el);
    });
    wrap.appendChild(row);
    return wrap;
  }

  function actionPanelEl(v, mv) {
    const myId = Net.myId();
    const bar = document.createElement('div');
    bar.className = 'actionbar';
    const myTurn = (v.phase === 'playing' || v.phase === 'endgame') && v.currentId === myId;

    // 偷看阶段
    if (v.phase === 'peek' && !mv.peeked) {
      const hint = document.createElement('div');
      hint.style.cssText = 'width:100%;text-align:center;color:var(--ink-2);font-size:12px;margin-bottom:6px;';
      hint.textContent = '请偷看自己 2 张牌（点牌选择，再点一次取消）';
      bar.appendChild(hint);
      const btn = document.createElement('button');
      btn.className = 'btn btn-primary';
      btn.textContent = '确认偷看（' + peekSel.length + '/2）';
      btn.disabled = peekSel.length !== 2;
      btn.addEventListener('click', () => doPeek(peekSel));
      bar.appendChild(btn);
      return bar;
    }

    // 选择行动
    if (myTurn && v.stage === 'choose') {
      const d = document.createElement('button');
      d.className = 'btn btn-primary';
      d.textContent = '🎴 抽牌堆';
      d.addEventListener('click', () => doAct('draw_deck'));
      bar.appendChild(d);
      const c = document.createElement('button');
      c.className = 'btn btn-ghost';
      c.textContent = '🗑 拿弃牌堆';
      c.disabled = v.discardTop == null;
      c.addEventListener('click', () => doAct('draw_discard'));
      bar.appendChild(c);
      if (v.phase === 'playing') {
        const call = document.createElement('button');
        call.className = 'btn btn-ghost';
        call.textContent = '📣 喊卡波';
        call.addEventListener('click', () => doAct('call'));
        bar.appendChild(call);
      }
      return bar;
    }

    // 抽到牌堆的牌：决定保留 / 弃掉 / 发动能力
    if (myTurn && v.stage === 'deck') {
      const pv = mv.pending ? mv.pending.v : null;
      if (subMode === 'keep') {
        const btn = document.createElement('button');
        btn.className = 'btn btn-primary';
        btn.textContent = '确认换掉这张牌';
        btn.disabled = keepSel.length === 0;
        btn.addEventListener('click', () => { doDeckKeep(keepSel); });
        bar.appendChild(btn);
        const back = document.createElement('button');
        back.className = 'btn btn-ghost';
        back.textContent = '返回';
        back.addEventListener('click', () => { subMode = null; keepSel = []; render(); });
        bar.appendChild(back);
        return bar;
      }
      if (subMode === 'peek') {
        const t = document.createElement('div');
        t.style.cssText = 'width:100%;text-align:center;color:var(--ink-2);font-size:12px;';
        t.textContent = '点击一张自己的暗牌来偷看';
        bar.appendChild(t);
        return bar;
      }
      if (subMode === 'spy') {
        const t = document.createElement('div');
        t.style.cssText = 'width:100%;text-align:center;color:var(--ink-2);font-size:12px;';
        t.textContent = '点击一张别人的暗牌来偷看';
        bar.appendChild(t);
        return bar;
      }
      if (subMode === 'swap') {
        const t = document.createElement('div');
        t.style.cssText = 'width:100%;text-align:center;color:var(--ink-2);font-size:12px;';
        t.textContent = swapMy == null ? '先点一张自己的牌，再点一张别人的牌来交换' : '已选自己的牌，请点一张别人的牌';
        bar.appendChild(t);
        if (swapMy != null) {
          const cancel = document.createElement('button');
          cancel.className = 'btn btn-ghost';
          cancel.textContent = '取消';
          cancel.addEventListener('click', () => { swapMy = null; render(); });
          bar.appendChild(cancel);
        }
        return bar;
      }

      // 默认决策
      const keep = document.createElement('button');
      keep.className = 'btn btn-primary';
      keep.textContent = '🔁 换掉手牌';
      keep.addEventListener('click', () => { subMode = 'keep'; keepSel = []; render(); });
      bar.appendChild(keep);
      const dis = document.createElement('button');
      dis.className = 'btn btn-ghost';
      dis.textContent = '❌ 弃掉这张牌';
      dis.addEventListener('click', () => doDeckDiscard());
      bar.appendChild(dis);
      if (pv != null && ABIL[pv]) {
        const ab = ABIL[pv];
        const use = document.createElement('button');
        use.className = 'btn btn-ghost';
        use.textContent = '✨ 发动能力（' + ABIL_LABEL[ab] + '）';
        use.addEventListener('click', () => { subMode = ab; swapMy = null; render(); });
        bar.appendChild(use);
      }
      return bar;
    }

    // 拿了弃牌堆的牌：必须换进手牌
    if (myTurn && v.stage === 'discard') {
      const btn = document.createElement('button');
      btn.className = 'btn btn-primary';
      btn.textContent = '确认换掉（' + keepSel.length + ' 张）';
      btn.disabled = keepSel.length === 0;
      btn.addEventListener('click', () => { doDiscardKeep(keepSel); });
      bar.appendChild(btn);
      return bar;
    }

    // 结束阶段按钮
    if (v.phase === 'scoring') {
      if (ctx.isHost) {
        const btn = document.createElement('button');
        btn.className = 'btn btn-primary';
        btn.textContent = '下一局';
        btn.addEventListener('click', () => deal());
        bar.appendChild(btn);
      }
      return bar;
    }
    if (v.phase === 'ended') {
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
      return bar;
    }

    return bar;
  }

  function resultsEl(v) {
    if (!v.lastRound) return null;
    const myId = Net.myId();
    const lr = v.lastRound;
    const box = document.createElement('div');
    box.className = 'cabo-results';
    if (lr.kamikazeId) {
      const km = document.createElement('div');
      km.className = 'cabo-kamikaze';
      km.textContent = '💥 神风！' + nameFromPlayers(v, lr.kamikazeId) + ' 凑齐 12、12、13、13，本局 0 分，其余人各 +50！';
      box.appendChild(km);
    }
    v.players.forEach(p => {
      const row = document.createElement('div');
      row.className = 'cabo-result-row';
      const nm = document.createElement('span');
      nm.textContent = (p.isBot ? '🤖 ' : '') + p.name + (p.id === myId ? '（你）' : '');
      row.appendChild(nm);
      const detail = document.createElement('span');
      detail.className = 'cabo-result-detail';
      detail.textContent = '手牌 ' + lr.sums[p.id] + ' 分 → 本局 ' + lr.roundPts[p.id] + ' 分';
      row.appendChild(detail);
      box.appendChild(row);
    });
    return box;
  }

  function nameFromPlayers(v, pid) {
    const p = v.players.find(x => x.id === pid);
    return p ? p.name : '?';
  }

  function bannerFor(v) {
    const myId = Net.myId();
    if (v.phase === 'ended') {
      const names = v.players.filter(p => v.winner.includes(p.id)).map(p => p.name).join('、');
      return { cls: 'ok', text: '🏆 ' + names + ' 总分最低，获胜！' };
    }
    if (v.phase === 'scoring') return { cls: 'warn', text: v.action };
    if (v.phase === 'peek') {
      return { cls: '', text: v.action };
    }
    if (v.currentId === myId) {
      if (v.stage === 'choose') {
        return { cls: 'ok', text: v.phase === 'endgame' ? '终局回合：轮到你，选择行动' : '轮到你：抽牌、拿弃牌或喊卡波' };
      }
      return { cls: 'ok', text: v.action };
    }
    const cur = v.players.find(p => p.id === v.currentId);
    return { cls: '', text: (cur ? cur.name : '') + ' 正在行动 · ' + v.action };
  }

  function render() {
    if (!ctx) return;
    const c = ctx.container;
    UI.clear(c);
    const v = view();
    const frame = document.createElement('div');
    frame.className = 'game-frame';
    frame.appendChild(topbarEl(v));
    if (!v) {
      frame.appendChild(UI.banner('', '正在等待房主发牌…'));
      c.appendChild(frame);
      return;
    }

    // 切换交互模式时清空选择
    const myId = Net.myId();
    const myTurn = (v.phase === 'playing' || v.phase === 'endgame') && v.currentId === myId;
    let mode = null;
    if (v.phase === 'peek' && !mvPeeked()) mode = 'peek';
    else if (myTurn && v.stage === 'choose') mode = 'choose';
    else if (myTurn && v.stage === 'deck') mode = 'deck';
    else if (myTurn && v.stage === 'discard') mode = 'discard';
    if (mode !== selMode) {
      selMode = mode;
      peekSel = []; subMode = null; keepSel = []; swapMy = null;
    }

    const mv = myView();
    frame.appendChild(scoreboardEl(v));
    frame.appendChild(UI.banner(bannerFor(v).cls, bannerFor(v).text));
    frame.appendChild(pilesEl(v, mv));
    frame.appendChild(opponentsEl(v, mv));
    frame.appendChild(myHandEl(v, mv));

    // 抽到的牌展示
    if (myTurn && v.stage === 'deck' && mv.pending) {
      const pv = document.createElement('div');
      pv.className = 'cabo-pending';
      const lbl = document.createElement('span');
      lbl.textContent = '你抽到了：';
      pv.appendChild(lbl);
      const pc = numCardEl(mv.pending.v);
      pc.dataset.role = 'pending';
      pv.appendChild(pc);
      const ab = ABIL[mv.pending.v];
      if (ab) {
        const t = document.createElement('span');
        t.className = 'cabo-pending-ab';
        t.textContent = '特殊牌 · ' + ABIL_LABEL[ab];
        pv.appendChild(t);
      }
      frame.appendChild(pv);
    }

    const res = resultsEl(v);
    if (res) frame.appendChild(res);

    frame.appendChild(actionPanelEl(v, mv));
    c.appendChild(frame);
  }

  function mvPeeked() {
    if (ctx.isHost) return !!state.peeked[Net.myId()];
    return peeked;
  }

  return { init, handleMessage, deal, restart };
})();
