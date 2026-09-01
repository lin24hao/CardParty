// 情书 Love Letter —— 主机权威
// 规则（本项目变体）：16 张角色牌（守卫×5、牧师×2、男爵×2、侍女×2、王子×2、国王×1、伯爵夫人×1、公主×1）。
// 每轮暗置移除 1 张后每人发 1 张手牌；轮流抽 1 张、打出 1 张并发动角色效果淘汰对手；
// 牌堆耗尽或仅剩 1 人存活时，存活者比手牌点数决定本轮胜者。
// 先达到目标分（2人5分 / 3-4人4分 / 5-6人3分）的玩家赢得整局。
const LoveLetter = (() => {
  let ctx = null;
  let state = null;      // 主机状态
  let mirror = null;     // 客机：公开状态镜像
  let myHand = [];       // 客机：我的手牌
  let epoch = 0;         // 局次，用于作废上一局遗留的定时器
  let localCardIdx = null;
  let localTarget = null;
  let localGuess = null;

  const CARD_DEFS = [
    { rank: 1, name: '守卫',     icon: '🛡️', count: 5, desc: '猜一名玩家手牌点数（2~8），猜中对方出局' },
    { rank: 2, name: '牧师',     icon: '👁️', count: 2, desc: '偷看一名玩家的一张手牌' },
    { rank: 3, name: '男爵',     icon: '🤴', count: 2, desc: '与一名玩家比点数，点数低者出局' },
    { rank: 4, name: '侍女',     icon: '🛁', count: 2, desc: '打出后你免疫其他牌的效果，直到下个回合' },
    { rank: 5, name: '王子',     icon: '👑', count: 2, desc: '选一名玩家弃掉手牌重新抽一张（弃到公主出局）' },
    { rank: 6, name: '国王',     icon: '🫅', count: 1, desc: '与一名玩家交换手牌' },
    { rank: 7, name: '伯爵夫人', icon: '💃', count: 1, desc: '无效果；若手牌同时有国王或王子，必须打出她' },
    { rank: 8, name: '公主',     icon: '👸', count: 1, desc: '被打出或被迫弃掉时立即出局' },
  ];

  function buildDeck() {
    const deck = [];
    CARD_DEFS.forEach(d => { for (let i = 0; i < d.count; i++) deck.push({ rank: d.rank, name: d.name, icon: d.icon, desc: d.desc }); });
    return deck; // 16 张
  }
  function rankName(r) { const d = CARD_DEFS.find(x => x.rank === r); return d ? d.name : '?'; }
  function rankIcon(r) { const d = CARD_DEFS.find(x => x.rank === r); return d ? d.icon : '❓'; }
  function targetScoreFor(n) { return n <= 2 ? 5 : n <= 4 ? 4 : 3; }

  function init(c) {
    ctx = c;
    state = null;
    mirror = null;
    myHand = [];
    localCardIdx = null; localTarget = null; localGuess = null;
    if (ctx.isHost) hostStart();
    else render();
  }

  // ---------- 主机逻辑 ----------
  function hostStart() {
    epoch++;
    const players = ctx.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost, isBot: p.isBot, alive: true, immune: false, hand: [], score: 0, elimRound: 0 }));
    state = {
      players, round: 0, deck: [], removed: null, current: 0,
      phase: 'playing', action: '', lastPlay: [], eliminations: [],
      roundWinnerId: null, totalWinnerId: null, targetScore: targetScoreFor(players.length),
    };
    beginRound();
  }

  function beginRound() {
    if (!state) return;
    state.round++;
    state.deck = Deck.shuffle(buildDeck());
    state.removed = state.deck.pop();
    state.players.forEach(p => { p.alive = true; p.immune = false; p.hand = []; p.elimRound = 0; });
    state.players.forEach(p => p.hand.push(state.deck.pop()));
    state.current = Math.floor(Math.random() * state.players.length);
    state.phase = 'playing';
    state.lastPlay = [];
    state.eliminations = [];
    state.roundWinnerId = null;
    state.action = '第 ' + state.round + ' 轮开始，每人已发 1 张手牌';
    pushAll();
    beginTurn();
  }

  function beginTurn() {
    if (!state || state.phase !== 'playing') return;
    const p = state.players[state.current];
    if (p.immune) p.immune = false; // 回合开始时清除侍女免疫
    if (state.deck.length > 0) {
      p.hand.push(state.deck.pop());
      state.action = '轮到 ' + p.name + '：抽到 1 张牌，请打出一张';
    } else {
      finishRound();
      return;
    }
    pushAll();
    render();
  }

  function alivePlayers() { return state.players.filter(p => p.alive); }

  // 目标校验：存活、非自己、未免疫
  function targetOf(p, targetId) {
    const t = state.players.find(x => x.id === targetId);
    return (t && t.alive && t.id !== p.id && !t.immune) ? t : null;
  }

  function eliminate(p) {
    if (!p.alive) return;
    p.alive = false;
    p.elimRound = state.round;
    const card = p.hand[0];
    state.eliminations.push({ id: p.id, name: p.name, card: card ? { rank: card.rank, name: card.name, icon: card.icon } : null });
  }

  function nextAlive(fromIdx) {
    const n = state.players.length;
    for (let k = 1; k <= n; k++) {
      const i = (fromIdx + k) % n;
      if (state.players[i].alive) return i;
    }
    return -1;
  }

  function hostPlay(fromId, play) {
    if (!state || state.phase !== 'playing') return;
    const idx = state.players.findIndex(p => p.id === fromId);
    if (idx !== state.current) return;
    const p = state.players[idx];
    if (!play || typeof play.cardIndex !== 'number' || play.cardIndex < 0 || play.cardIndex >= p.hand.length) return;
    // 伯爵夫人强制：手牌同时有 7 与 (6 或 5) 时必须打 7
    const has7 = p.hand.some(c => c.rank === 7);
    const hasKQ = p.hand.some(c => c.rank === 6 || c.rank === 5);
    const card = p.hand[play.cardIndex];
    if (has7 && hasKQ && card.rank !== 7) { pushHands(); render(); return; }
    p.hand.splice(play.cardIndex, 1);
    resolvePlay(p, card, play.targetId, play.guess);
  }

  function resolvePlay(p, card, targetId, guess) {
    const entry = { id: p.id, name: p.name, rank: card.rank, icon: card.icon, cardName: card.name, effect: '' };
    state.lastPlay = [entry];
    const rank = card.rank;

    if (rank === 8) {
      // 公主：打出即出局
      eliminate(p);
      entry.effect = '公主被打出，立即出局';
    } else if (rank === 7) {
      entry.effect = '伯爵夫人，无效果';
    } else if (rank === 4) {
      p.immune = true;
      entry.effect = '侍女生效，' + p.name + ' 免疫到下次回合';
    } else if (rank === 1) {
      const t = targetOf(p, targetId);
      const g = (typeof guess === 'number' && guess >= 2 && guess <= 8) ? guess : 0;
      if (t && g > 0) {
        const tc = t.hand[0];
        if (tc && tc.rank === g) {
          eliminate(t);
          entry.effect = '猜中 ' + t.name + ' 的手牌是「' + rankName(g) + '」，' + t.name + ' 出局';
        } else {
          entry.effect = '守卫猜错了（' + t.name + ' 的手牌不是 ' + g + '）';
        }
      } else if (!t) {
        entry.effect = '目标无效或免疫，守卫落空';
      } else {
        entry.effect = '守卫未指定猜测数字';
      }
    } else if (rank === 2) {
      const t = targetOf(p, targetId);
      if (t && t.hand[0]) {
        Net.sendTo(p.id, { type: 'll_peek', targetId: t.id, card: { rank: t.hand[0].rank, name: t.hand[0].name, icon: t.hand[0].icon } });
        entry.effect = '偷看了 ' + t.name + ' 的手牌';
      } else {
        entry.effect = '目标无效或免疫，无法偷看';
      }
    } else if (rank === 3) {
      const t = targetOf(p, targetId);
      if (t) {
        const a = p.hand[0] ? p.hand[0].rank : 0;
        const b = t.hand[0] ? t.hand[0].rank : 0;
        if (a > b) { eliminate(t); entry.effect = t.name + ' 点数更低，出局'; }
        else if (b > a) { eliminate(p); entry.effect = p.name + ' 点数更低，出局'; }
        else entry.effect = '双方点数相同，平局';
      } else {
        entry.effect = '目标无效或免疫，男爵落空';
      }
    } else if (rank === 5) {
      const t = state.players.find(x => x.id === targetId);
      const canT = t && t.alive && (t.id === p.id || !t.immune);
      if (canT) {
        const discarded = t.hand.splice(0, 1)[0];
        if (discarded && discarded.rank === 8) {
          eliminate(t);
          entry.effect = t.name + ' 被王子要求弃牌，弃掉的是公主，出局';
        } else if (t.alive) {
          if (state.deck.length > 0) {
            t.hand.push(state.deck.pop());
            entry.effect = t.name + ' 弃掉「' + (discarded ? discarded.name : '空') + '」并重抽 1 张';
          } else {
            eliminate(t);
            entry.effect = t.name + ' 弃牌后牌堆已空，出局';
          }
        }
      } else {
        entry.effect = '目标无效或免疫，王子落空';
      }
    } else if (rank === 6) {
      const t = targetOf(p, targetId);
      if (t) {
        const tmp = p.hand[0]; p.hand[0] = t.hand[0]; t.hand[0] = tmp;
        entry.effect = '与 ' + t.name + ' 交换了手牌';
      } else {
        entry.effect = '目标无效或免疫，无法交换';
      }
    }

    // 检查本轮是否结束
    const alive = alivePlayers();
    if (alive.length <= 1) { finishRound(); return; }
    const next = nextAlive(state.current);
    if (next < 0) { finishRound(); return; }
    state.current = next;
    state.action = entry.effect;
    pushAll();
    render();
    beginTurn();
  }

  function finishRound() {
    const alive = alivePlayers();
    let winnerId = null;
    if (alive.length === 1) {
      winnerId = alive[0].id;
      state.action = '仅剩 ' + alive[0].name + ' 存活，赢得本轮';
    } else if (alive.length > 1) {
      let best = -1;
      alive.forEach(p => { if (p.hand[0] && p.hand[0].rank > best) best = p.hand[0].rank; });
      const winners = alive.filter(p => p.hand[0] && p.hand[0].rank === best);
      if (winners.length === 1) {
        winnerId = winners[0].id;
        state.action = winners[0].name + ' 手牌点数最高，赢得本轮';
      } else {
        state.action = '最高点数并列，本轮无人得分';
      }
    } else {
      state.action = '本轮无人得分';
    }
    state.roundWinnerId = winnerId;
    if (winnerId) {
      const w = state.players.find(p => p.id === winnerId);
      w.score++;
      if (w.score >= state.targetScore) {
        state.totalWinnerId = w.id;
        state.phase = 'ended';
        state.action = '🏆 ' + w.name + ' 率先达到 ' + state.targetScore + ' 分，赢得整局！';
      } else {
        state.phase = 'round_end';
        state.action += '（' + w.name + ' +1 分，当前 ' + w.score + '/' + state.targetScore + ' 分）';
      }
    } else {
      state.phase = 'round_end';
    }
    state.current = -1;
    pushAll();
    render();
  }

  function pushState() {
    const pub = state.players.map(p => ({
      id: p.id, name: p.name, isHost: p.isHost, isBot: p.isBot,
      alive: p.alive, immune: p.immune, handCount: p.hand.length, score: p.score, elimRound: p.elimRound,
    }));
    Net.broadcast({
      type: 'll_state',
      round: state.round, players: pub, deckCount: state.deck.length,
      currentId: state.current >= 0 ? state.players[state.current].id : null,
      phase: state.phase, action: state.action, lastPlay: state.lastPlay,
      eliminations: state.eliminations, roundWinnerId: state.roundWinnerId,
      totalWinnerId: state.totalWinnerId, targetScore: state.targetScore,
    });
  }

  function pushHands() {
    for (const p of state.players) {
      if (p.id !== Net.myId()) Net.sendTo(p.id, { type: 'll_hand', hand: p.hand });
    }
  }

  function pushAll() { pushState(); pushHands(); }

  // ---------- 消息处理 ----------
  function handleMessage(from, data) {
    if (!ctx || !data || !data.type) return;
    if (ctx.isHost) {
      if (data.type === 'll_play') hostPlay(from, data);
    } else {
      if (data.type === 'll_state') { mirror = data; localCardIdx = null; localTarget = null; localGuess = null; render(); }
      else if (data.type === 'll_hand') { myHand = data.hand || []; render(); }
      else if (data.type === 'll_peek') { UI.toast('🔍 你偷看到 ' + (mirror && mirror.players ? mirror.players.find(p => p.id === data.targetId) : {}).name + ' 的手牌是「' + data.card.name + ' ' + data.card.icon + '」', 3200); }
    }
  }

  // ---------- 视图 ----------
  function view() {
    if (ctx.isHost) {
      const pub = state.players.map(p => ({
        id: p.id, name: p.name, isHost: p.isHost, isBot: p.isBot,
        alive: p.alive, immune: p.immune, handCount: p.hand.length, score: p.score, elimRound: p.elimRound,
      }));
      return {
        round: state.round, players: pub, deckCount: state.deck.length,
        currentId: state.current >= 0 ? state.players[state.current].id : null,
        phase: state.phase, action: state.action, lastPlay: state.lastPlay,
        eliminations: state.eliminations, roundWinnerId: state.roundWinnerId,
        totalWinnerId: state.totalWinnerId, targetScore: state.targetScore,
      };
    }
    return mirror;
  }

  function myHandCards() {
    if (ctx.isHost) return state.players.find(p => p.id === Net.myId()).hand;
    return myHand;
  }

  function isMyTurn(v) { return v.phase === 'playing' && v.currentId === Net.myId(); }

  // 该牌是否需要目标 / 是否需要猜测
  function needTarget(rank) { return rank === 1 || rank === 2 || rank === 3 || rank === 5 || rank === 6; }
  function needGuess(rank) { return rank === 1; }

  function doPlay() {
    const hand = myHandCards();
    if (localCardIdx == null || !hand || localCardIdx < 0 || localCardIdx >= hand.length) return;
    const card = hand[localCardIdx];
    if (needTarget(card.rank) && localTarget == null) { UI.toast('请先选择一个目标'); return; }
    if (needGuess(card.rank) && localGuess == null) { UI.toast('请先猜测一个点数'); return; }
    const msg = { type: 'll_play', cardIndex: localCardIdx, targetId: localTarget, guess: localGuess };
    if (ctx.isHost) hostPlay(Net.myId(), msg);
    else Net.sendToHost(msg);
    localCardIdx = null; localTarget = null; localGuess = null;
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
    title.textContent = '💌 情书 Love Letter';
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
    pill.textContent = v ? ('第 ' + v.round + ' 轮') : '准备中';
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

    // 座位
    const seats = document.createElement('div');
    seats.className = 'seats';
    v.players.forEach(p => {
      const seat = document.createElement('div');
      seat.className = 'seat seat-stacked' + (v.phase === 'playing' && v.currentId === p.id && p.alive ? ' active' : '');
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
      if (!p.alive) {
        const elim = v.eliminations.find(e => e.id === p.id);
        st.textContent = '💀 出局' + (elim && elim.card ? '（' + elim.card.icon + ' ' + elim.card.name + '）' : '');
      } else {
        st.textContent = '手牌 ' + p.handCount + ' 张' + (p.immune ? ' · 🛁 免疫' : '');
      }
      meta.appendChild(st);
      head.appendChild(meta);
      // 分数
      const sc = document.createElement('div');
      sc.className = 'stag';
      sc.style.cssText = 'font-size:13px;font-weight:700;color:var(--brand);';
      sc.textContent = '❤️ ' + p.score + '/' + v.targetScore;
      head.appendChild(sc);
      seat.appendChild(head);
      seats.appendChild(seat);
    });
    frame.appendChild(seats);

    // 目标选择区（我的回合，需要目标）
    if (isMyTurn(v) && localCardIdx != null) {
      const selCard = myHandCards()[localCardIdx];
      if (selCard && needTarget(selCard.rank)) {
        const canSelf = selCard.rank === 5;
        const targets = document.createElement('div');
        targets.className = 'll-target';
        v.players.forEach(p => {
          if (!p.alive) return;
          if (p.id === myId && !canSelf) return;
          const chip = document.createElement('button');
          chip.className = 'chip' + (localTarget === p.id ? ' selected' : '') + (p.immune ? ' disabled' : '');
          chip.textContent = p.name + (p.immune ? '（免疫）' : '');
          chip.disabled = !!p.immune;
          chip.addEventListener('click', () => { localTarget = p.id; render(); });
          targets.appendChild(chip);
        });
        const hint = document.createElement('div');
        hint.style.cssText = 'font-size:12px;color:var(--ink-2);margin:2px 0 6px;';
        hint.textContent = '选择 ' + selCard.name + ' 的目标：';
        frame.appendChild(hint);
        frame.appendChild(targets);
      }
    }

    // 猜测数字区（守卫）
    if (isMyTurn(v) && localCardIdx != null) {
      const selCard = myHandCards()[localCardIdx];
      if (selCard && needGuess(selCard.rank)) {
        const guessRow = document.createElement('div');
        guessRow.className = 'll-guess';
        const hint = document.createElement('div');
        hint.style.cssText = 'font-size:12px;color:var(--ink-2);width:100%;';
        hint.textContent = '猜测目标手牌的点数（不能猜 1）：';
        guessRow.appendChild(hint);
        for (let g = 2; g <= 8; g++) {
          const chip = document.createElement('button');
          chip.className = 'chip' + (localGuess === g ? ' selected' : '');
          chip.textContent = rankName(g);
          chip.addEventListener('click', () => { localGuess = g; render(); });
          guessRow.appendChild(chip);
        }
        frame.appendChild(guessRow);
      }
    }

    // 我的手牌
    const handTitle = document.createElement('div');
    handTitle.style.cssText = 'font-weight:700;margin:16px 0 8px;font-size:14px;';
    handTitle.textContent = '我的手牌' + (isMyTurn(v) ? ' · 点击选择要打出的牌' : '');
    frame.appendChild(handTitle);
    const handWrap = document.createElement('div');
    handWrap.className = 'hand-cards';
    const myCards = myHandCards() || [];
    myCards.forEach((cd, i) => {
      const el = document.createElement('div');
      const canPick = isMyTurn(v);
      el.className = 'll-card' + (localCardIdx === i ? ' selected' : '') + (canPick ? '' : ' disabled');
      el.innerHTML = '<span class="ll-rank">' + cd.rank + '</span><span class="ll-icon">' + cd.icon + '</span><span class="ll-name">' + cd.name + '</span>';
      if (canPick) el.addEventListener('click', () => { localCardIdx = (localCardIdx === i) ? null : i; localTarget = null; localGuess = null; render(); });
      handWrap.appendChild(el);
    });
    if (myCards.length === 0) {
      const empty = document.createElement('span');
      empty.textContent = '（没有牌）';
      empty.style.cssText = 'color:var(--ink-2);';
      handWrap.appendChild(empty);
    }
    frame.appendChild(handWrap);

    // 选中的牌效果说明
    if (localCardIdx != null && myCards[localCardIdx]) {
      const note = document.createElement('div');
      note.className = 'll-rule';
      note.textContent = myCards[localCardIdx].icon + ' ' + myCards[localCardIdx].name + '：' + myCards[localCardIdx].desc;
      frame.appendChild(note);
    }

    // 本轮出牌记录
    if (v.lastPlay && v.lastPlay.length) {
      const lp = v.lastPlay[v.lastPlay.length - 1];
      const log = document.createElement('div');
      log.className = 'll-rule';
      log.textContent = '🃏 ' + lp.name + ' 打出「' + lp.icon + ' ' + lp.cardName + '」' + (lp.effect ? ' — ' + lp.effect : '');
      frame.appendChild(log);
    }

    // 角色表
    const rule = document.createElement('div');
    rule.className = 'll-rule';
    rule.innerHTML = '牌堆 ' + v.deckCount + ' 张 · 目标 ' + v.targetScore + ' 分。<br>' +
      CARD_DEFS.map(d => d.icon + ' ' + d.rank + ' ' + d.name + '×' + d.count).join('　');
    frame.appendChild(rule);

    // 操作条
    const bar = document.createElement('div');
    bar.className = 'actionbar';
    if (isMyTurn(v)) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-primary';
      btn.textContent = '出牌';
      btn.disabled = localCardIdx == null;
      btn.addEventListener('click', doPlay);
      bar.appendChild(btn);
    } else if (v.phase === 'round_end') {
      if (ctx.isHost) {
        const nextBtn = document.createElement('button');
        nextBtn.className = 'btn btn-primary';
        nextBtn.textContent = '开始下一轮';
        nextBtn.addEventListener('click', beginRound);
        bar.appendChild(nextBtn);
      } else {
        const wait = document.createElement('span');
        wait.textContent = '等待房主开始下一轮…';
        wait.style.cssText = 'color:var(--ink-2);font-size:13px;';
        bar.appendChild(wait);
      }
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
