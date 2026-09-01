// 深海小队 The Crew —— 主机权威 · 合作吃墩
// 规则：40 张海豚牌（5 色 × 数字 1-9）。每局生成一张任务目标卡：指定某玩家必须吃到
// 某色某数字的牌。全队按吃墩规则（跟色、同色最大者吃墩）出牌，若任务牌被指定玩家吃到
// 则本局成功，否则本局失败需重试。共 9 局全部成功即全队胜利。
// 消息：cr_state（公开）/ cr_hand（私有手牌）/ cr_play（出牌）/ cr_retry（失败重试）
const Crew = (() => {
  let ctx = null;
  let state = null;      // 主机状态
  let mirror = null;     // 客机：公开状态镜像
  let myHand = [];       // 客机：我的手牌
  let epoch = 0;
  let localCard = null;  // 本地选中的手牌索引

  const COLORS = [
    { key: 'red',    name: '红', dot: '🔴' },
    { key: 'blue',   name: '蓝', dot: '🔵' },
    { key: 'green',  name: '绿', dot: '🟢' },
    { key: 'yellow', name: '黄', dot: '🟡' },
    { key: 'purple', name: '紫', dot: '🟣' },
  ];
  const CARD_NUMS = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  const MAX_MISSIONS = 9;

  function colorOf(key) { return COLORS.find(c => c.key === key) || COLORS[0]; }
  function cardLabel(c) { const co = colorOf(c.color); return co.dot + co.name + c.number; }

  function makeDeck() {
    const d = [];
    COLORS.forEach(c => CARD_NUMS.forEach(n => d.push({ color: c.key, number: n })));
    return d;
  }

  function init(c) {
    ctx = c;
    state = null;
    mirror = null;
    myHand = [];
    localCard = null;
    if (ctx.isHost) hostStart();
    else render();
  }

  // ---------- 主机逻辑 ----------
  function hostStart() {
    epoch++;
    const players = ctx.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost, isBot: p.isBot, hand: [] }));
    state = {
      players, mission: 0, phase: 'playing', task: null, leaderId: null,
      trick: [], currentIdx: 0, action: '', log: [], winnerIds: [], missionWon: false, missionFailed: false,
    };
    startMission(1);
  }

  function startMission(m) {
    epoch++;
    const n = state.players.length;
    const deck = Deck.shuffle(makeDeck());
    const players = state.players.map(p => ({ ...p, hand: [] }));
    const per = Math.floor(40 / n);
    players.forEach(p => { for (let i = 0; i < per; i++) p.hand.push(deck.pop()); });
    // 选任务目标：目标玩家不能是自己持任务牌的人
    const target = players[Math.floor(Math.random() * players.length)];
    const others = players.filter(p => p.id !== target.id);
    const holder = others[Math.floor(Math.random() * others.length)];
    const taskCard = holder.hand[Math.floor(Math.random() * holder.hand.length)];
    state.players = players;
    state.mission = m;
    state.task = { targetId: target.id, color: taskCard.color, number: taskCard.number };
    state.leaderId = players[0].id;
    state.trick = [];
    state.currentIdx = 0;
    state.phase = 'playing';
    state.missionWon = false;
    state.missionFailed = false;
    state.log = [];
    state.action = '第 ' + m + '/' + MAX_MISSIONS + ' 局任务：' + target.name + ' 必须吃到 ' + cardLabel(taskCard) + '。' + players[0].name + ' 先出牌';
    pushState();
    pushHands();
    render();
  }

  function receivePlay(fromId, cardIndex) {
    if (!state || state.phase !== 'playing') return;
    const p = state.players.find(x => x.id === fromId);
    if (!p) return;
    if (state.players[state.currentIdx].id !== fromId) return; // 不是当前出牌者
    if (typeof cardIndex !== 'number' || cardIndex < 0 || cardIndex >= p.hand.length) return;
    const card = p.hand[cardIndex];
    // 跟色规则：已有人出牌且手中有同色时必须跟同色
    const lead = state.trick.length > 0 ? state.trick[0].card.color : null;
    if (lead && card.color !== lead) {
      const hasLead = p.hand.some(c => c.color === lead);
      if (hasLead) return; // 有同色必须出同色
    }
    p.hand.splice(cardIndex, 1);
    state.trick.push({ id: p.id, name: p.name, card });
    state.currentIdx = (state.currentIdx + 1) % state.players.length;
    if (state.trick.length === state.players.length) {
      resolveTrick();
    } else {
      const next = state.players[state.currentIdx];
      state.action = next.name + ' 请出牌' + (lead ? '（首牌 ' + cardLabel(state.trick[0].card) + '，有同色须跟同色）' : '（首牌定色）');
      pushState();
      render();
    }
  }

  function resolveTrick() {
    if (!state || state.trick.length === 0) return;
    const leadColor = state.trick[0].card.color;
    let winner = state.trick[0];
    state.trick.forEach(t => {
      if (t.card.color === leadColor && t.card.number > winner.card.number) winner = t;
    });
    const winnerPlayer = state.players.find(p => p.id === winner.id);
    const desc = state.trick.map(t => t.name + ' ' + cardLabel(t.card)).join('，');
    state.log.push('墩 ' + (state.log.length + 1) + '：' + desc + ' → ' + winner.name + ' 吃墩');
    // 任务判定
    const hasTask = state.trick.some(t => t.card.color === state.task.color && t.card.number === state.task.number);
    if (hasTask) {
      if (winner.id === state.task.targetId) state.missionWon = true;
      else state.missionFailed = true;
    }
    state.trick = [];
    state.leaderId = winner.id;
    state.currentIdx = state.players.findIndex(p => p.id === winner.id);
    const allOut = state.players.every(p => p.hand.length === 0);
    if (state.missionFailed) {
      state.phase = 'ended';
      state.winnerIds = [];
      state.action = '💥 任务失败：' + cardLabel(state.task) + ' 被 ' + winner.name + ' 吃走，目标应是 ' + state.players.find(p => p.id === state.task.targetId).name + '。点击「重试本局」再来一次！';
    } else if (allOut) {
      if (state.missionWon) {
        if (state.mission >= MAX_MISSIONS) {
          state.phase = 'ended';
          state.winnerIds = state.players.map(p => p.id);
          state.action = '🎉 全队完成全部 ' + MAX_MISSIONS + ' 局任务，深海小队胜利！';
        } else {
          startMission(state.mission + 1);
          return;
        }
      } else {
        state.phase = 'ended';
        state.winnerIds = [];
        state.action = '💥 本局任务未能完成，点击「重试本局」再来一次！';
      }
    } else {
      state.phase = 'playing';
      state.action = '任务牌未出或已安全吃到。' + winner.name + ' 吃墩，请出下一墩的首牌';
    }
    pushState();
    pushHands();
    render();
  }

  function hostRetry() {
    if (!state || state.phase !== 'ended') return;
    if (state.winnerIds && state.winnerIds.length) return; // 全队胜利不可重试
    startMission(state.mission);
  }

  function pushState() {
    const pub = state.players.map(p => ({
      id: p.id, name: p.name, isHost: p.isHost, isBot: p.isBot, handCount: p.hand.length,
    }));
    Net.broadcast({
      type: 'cr_state',
      mission: state.mission, maxMissions: MAX_MISSIONS, phase: state.phase,
      players: pub, task: state.task, leaderId: state.leaderId,
      trick: state.trick.map(t => ({ id: t.id, name: t.name, card: t.card })),
      currentId: state.players[state.currentIdx].id,
      action: state.action, log: state.log.slice(-8), winnerIds: state.winnerIds,
    });
  }

  function pushHands() {
    for (const p of state.players) {
      if (p.id !== Net.myId()) Net.sendTo(p.id, { type: 'cr_hand', hand: p.hand });
    }
  }

  // ---------- 消息处理 ----------
  function handleMessage(from, data) {
    if (!ctx || !data || !data.type) return;
    if (ctx.isHost) {
      if (data.type === 'cr_play') receivePlay(from, data.cardIndex);
      else if (data.type === 'cr_retry') hostRetry();
    } else {
      if (data.type === 'cr_state') { mirror = data; localCard = null; render(); }
      else if (data.type === 'cr_hand') { myHand = data.hand || []; render(); }
    }
  }

  // ---------- 视图 ----------
  function view() {
    if (ctx.isHost) {
      const pub = state.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost, isBot: p.isBot, handCount: p.hand.length }));
      return {
        mission: state.mission, maxMissions: MAX_MISSIONS, phase: state.phase,
        players: pub, task: state.task, leaderId: state.leaderId,
        trick: state.trick.map(t => ({ id: t.id, name: t.name, card: t.card })),
        currentId: state.players[state.currentIdx].id,
        action: state.action, log: state.log.slice(-8), winnerIds: state.winnerIds,
      };
    }
    return mirror;
  }

  function myCards() { return ctx.isHost ? state.players.find(p => p.id === Net.myId()).hand : myHand; }
  function myIsTurn(v) { return v.currentId === Net.myId(); }
  function leadColor(v) { return v.trick && v.trick.length > 0 ? v.trick[0].card.color : null; }

  function doPlay() {
    if (localCard == null) return;
    const msg = { type: 'cr_play', cardIndex: localCard };
    if (ctx.isHost) receivePlay(Net.myId(), localCard);
    else Net.sendToHost(msg);
    localCard = null;
    render();
  }

  function doRetry() {
    const msg = { type: 'cr_retry' };
    if (ctx.isHost) hostRetry();
    else Net.sendToHost(msg);
    localCard = null;
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
    title.textContent = '🐬 深海小队 The Crew';
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
    pill.textContent = v ? ('第 ' + v.mission + '/' + v.maxMissions + ' 局') : '准备中';
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

    // 任务目标卡
    if (v.task) {
      const taskEl = document.createElement('div');
      taskEl.className = 'cr-task';
      const target = (v.players || []).find(p => p.id === v.task.targetId);
      const label = cardLabel(v.task);
      taskEl.innerHTML = '🎯 本局任务：<b>' + UI.esc(target ? target.name : '') + '</b> 必须吃到 <span class="cr-task-card">' + label + '</span>';
      frame.appendChild(taskEl);
    }

    // 公共区：玩家手牌数 + 本墩
    const row = document.createElement('div');
    row.className = 'cr-score-row';
    (v.players || []).forEach(p => {
      const chip = document.createElement('div');
      chip.className = 'cr-score' + (p.id === v.leaderId ? ' leader' : '');
      chip.innerHTML = (p.id === v.currentId ? '👉 ' : '') + UI.esc(p.name) + (p.id === myId ? '（你）' : '') + '：<b>' + p.handCount + '</b> 张' + (p.id === v.leaderId ? ' 🏴' : '');
      row.appendChild(chip);
    });
    frame.appendChild(row);

    // 本墩已出牌
    const trickTitle = document.createElement('div');
    trickTitle.style.cssText = 'font-weight:700;margin:12px 0 6px;font-size:14px;';
    trickTitle.textContent = '本墩';
    frame.appendChild(trickTitle);
    const trickRow = document.createElement('div');
    trickRow.className = 'cr-trick';
    if (v.trick && v.trick.length) {
      v.trick.forEach(t => {
        const el = document.createElement('div');
        el.className = 'cr-trick-card';
        el.innerHTML = UI.esc(t.name) + '<br>' + cardLabel(t.card);
        trickRow.appendChild(el);
      });
    } else {
      const empty = document.createElement('span');
      empty.textContent = '（等待首牌）';
      empty.style.cssText = 'color:var(--ink-2);';
      trickRow.appendChild(empty);
    }
    frame.appendChild(trickRow);

    // 出牌记录
    if (v.log && v.log.length) {
      const log = document.createElement('div');
      log.className = 'cr-log';
      log.textContent = '📋 ' + v.log.slice(-5).join('；');
      frame.appendChild(log);
    }

    // 我的手牌
    const handTitle = document.createElement('div');
    handTitle.style.cssText = 'font-weight:700;margin:16px 0 8px;font-size:14px;';
    handTitle.textContent = '我的手牌';
    frame.appendChild(handTitle);
    const handWrap = document.createElement('div');
    handWrap.className = 'cr-hand';
    const cards = myCards() || [];
    const lead = leadColor(v);
    const canPick = v.phase === 'playing' && myIsTurn(v);
    const mustLead = lead != null && cards.some(c => c.color === lead);
    cards.forEach((card, i) => {
      const el = document.createElement('div');
      let cls = 'cr-card';
      if (lead && card.color === lead) cls += ' lead';
      if (canPick && (!mustLead || card.color === lead)) {
        cls += (localCard === i ? ' selected' : '');
        el.addEventListener('click', () => { localCard = (localCard === i) ? null : i; render(); });
      } else {
        cls += ' disabled';
      }
      el.className = cls;
      el.innerHTML = '<span class="cr-dot">' + colorOf(card.color).dot + '</span><span class="cr-num">' + card.number + '</span><span class="cr-color">' + colorOf(card.color).name + '</span>';
      handWrap.appendChild(el);
    });
    if (cards.length === 0) {
      const empty = document.createElement('span');
      empty.textContent = '（没有牌）';
      empty.style.cssText = 'color:var(--ink-2);';
      handWrap.appendChild(empty);
    }
    frame.appendChild(handWrap);

    if (canPick && mustLead) {
      const hint = document.createElement('div');
      hint.style.cssText = 'font-size:12px;color:var(--ink-2);margin:2px 0 6px;';
      hint.textContent = '首牌为 ' + cardLabel(v.trick[0].card) + '，你必须跟同色（高亮牌）';
      frame.appendChild(hint);
    }

    // 操作条
    const bar = document.createElement('div');
    bar.className = 'actionbar';
    if (v.phase === 'playing' && myIsTurn(v)) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-primary';
      btn.textContent = '出牌';
      btn.disabled = localCard == null;
      btn.addEventListener('click', doPlay);
      bar.appendChild(btn);
    } else if (v.phase === 'ended' && !(v.winnerIds && v.winnerIds.length)) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-primary';
      btn.textContent = '重试本局';
      btn.addEventListener('click', doRetry);
      bar.appendChild(btn);
      const back = document.createElement('button');
      back.className = 'btn btn-ghost';
      back.textContent = '返回房间';
      back.addEventListener('click', () => ctx.leave());
      bar.appendChild(back);
    } else if (v.phase === 'ended') {
      const btn = document.createElement('button');
      btn.className = 'btn btn-primary';
      btn.textContent = '返回房间';
      btn.addEventListener('click', () => ctx.leave());
      bar.appendChild(btn);
    } else {
      const wait = document.createElement('span');
      wait.textContent = v.phase === 'playing' ? '等待其他玩家出牌…' : '';
      wait.style.cssText = 'color:var(--ink-2);';
      bar.appendChild(wait);
    }
    frame.appendChild(bar);

    c.appendChild(frame);
  }

  return { init, handleMessage };
})();
