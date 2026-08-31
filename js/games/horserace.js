// 赛马（Horse Race）—— 主机权威 · 4 花色 · 纯竞速不下注
// 规则：4 匹花色马（♠♥♦♣）沿 A~K 共 13 格赛道竞速。
// 开局每人认领一匹看好的马（可重复认领）；主机洗牌后逐张翻牌，
// 翻到哪个花色那匹马就前进一步；最先翻完自己 13 张（跑到终点）的花色夺冠，
// 认领该花色的玩家获胜。
const HorseRace = (() => {
  const SUITS = ['♠', '♥', '♦', '♣'];
  const FINISH = 13;

  let ctx = null;
  let state = null;      // 主机状态
  let mirror = null;     // 客机：公开状态镜像
  let raceTimer = null;
  let speed = 300;       // 翻牌间隔 ms
  let myPick = null;     // 本地已选（用于高亮）

  function init(c) {
    ctx = c;
    state = null; mirror = null;
    raceTimer = null; speed = 300; myPick = null;
    if (ctx.isHost) hostStart();
    else render();
  }

  // ---------- 主机逻辑 ----------
  function hostStart() {
    const players = ctx.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost, isBot: p.isBot, pick: null }));
    state = {
      players,
      stage: 'picking',
      deck: Deck.shuffle(Deck.makeDeck()),
      index: 0,
      lastCard: null,
      progress: { '♠': 0, '♥': 0, '♦': 0, '♣': 0 },
      finished: [],      // 花色冲线顺序
      turnIndex: 0,      // 联机：当前轮到第几位玩家翻牌
      turnId: null,      // 联机：当前轮到哪位玩家翻牌
      action: '比赛即将开始，请每人认领一匹看好的马',
    };
    pushState(); render();
  }

  function hostPick(fromId, suit) {
    if (!state || state.stage !== 'picking') return;
    if (!SUITS.includes(suit)) return;
    const p = state.players.find(x => x.id === fromId);
    if (!p) return;
    if (p.pick) return;               // 已选过，忽略
    p.pick = suit;
    state.action = p.name + ' 认领了 ' + suit + ' 号马';
    if (state.players.every(x => x.pick)) {
      state.action = '全员认领完毕，比赛开始！';
      pushState(); render();
      setTimeout(startRace, 900);
      return;
    }
    pushState(); render();
  }

  function soloMode() { return !!(ctx && ctx.solo); }

  function justFinished(suit) {
    return state.finished.length > 0 && state.finished[state.finished.length - 1] === suit;
  }

  // 翻出牌堆顶下一张牌，推进对应花色；返回翻出的牌对象（牌堆空则返回 null）
  function flipCard() {
    if (state.index >= state.deck.length) return null;
    const card = state.deck[state.index];
    state.index++;
    state.lastCard = card;
    state.progress[card.suit]++;
    if (state.progress[card.suit] >= FINISH && !state.finished.includes(card.suit)) {
      state.finished.push(card.suit);
    }
    return card;
  }

  function advanceTurn() {
    state.turnIndex = (state.turnIndex + 1) % state.players.length;
    state.turnId = state.players[state.turnIndex].id;
  }

  function startRace() {
    if (!state) return;
    state.stage = 'racing';
    if (soloMode()) {
      // 人机：房主自动翻牌，观看式竞速
      state.action = '比赛进行中…';
      pushState(); render();
      step();
    } else {
      // 联机：玩家轮流手动翻牌，增加参与感
      state.turnIndex = 0;
      state.turnId = state.players[0].id;
      state.action = '比赛开始！轮到 ' + state.players[0].name + ' 翻牌';
      pushState(); render();
    }
  }

  function step() {
    if (!state || state.stage !== 'racing') return;
    if (state.finished.length >= SUITS.length) { finishRace(); return; }
    const card = flipCard();
    if (!card) { finishRace(); return; }
    state.action = justFinished(card.suit)
      ? card.suit + ' 号马冲线！'
      : '翻到 ' + card.suit + card.rank + '，' + card.suit + ' 号马前进一格';
    pushState(); render();
    if (state.finished.length >= SUITS.length) { finishRace(); return; }
    raceTimer = setTimeout(step, speed);
  }

  // 联机：轮到某位玩家时由他主动翻牌
  function hostFlip(fromId) {
    if (!state || state.stage !== 'racing') return;
    if (soloMode()) return;
    if (!state.turnId || fromId !== state.turnId) return;
    const p = state.players.find(x => x.id === fromId);
    const who = p ? p.name : '玩家';
    const card = flipCard();
    if (!card) { finishRace(); return; }
    state.action = justFinished(card.suit)
      ? who + ' 翻到 ' + card.suit + card.rank + '，' + card.suit + ' 号马冲线！'
      : who + ' 翻到 ' + card.suit + card.rank + '，' + card.suit + ' 号马前进一格';
    if (state.finished.length >= SUITS.length) { finishRace(); return; }
    advanceTurn();
    state.action += ' · 轮到 ' + state.players[state.turnIndex].name + ' 翻牌';
    pushState(); render();
  }

  function finishRace() {
    if (!state) return;
    clearTimeout(raceTimer);
    state.stage = 'ended';
    const winner = state.finished[0] || null;
    state.action = winner ? (winner + ' 号马夺冠！') : '比赛结束';
    pushState(); render();
  }

  function speedUp() {
    if (speed > 100) speed = Math.max(100, speed - 80);
  }

  function skipRace() {
    if (!state || state.stage !== 'racing') return;
    clearTimeout(raceTimer);
    while (state.index < state.deck.length && state.finished.length < SUITS.length) {
      const card = state.deck[state.index++];
      state.progress[card.suit]++;
      if (state.progress[card.suit] >= FINISH && !state.finished.includes(card.suit)) {
        state.finished.push(card.suit);
      }
    }
    state.lastCard = state.index > 0 ? state.deck[state.index - 1] : null;
    finishRace();
  }

  function buildPub() {
    return {
      players: state.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost, isBot: p.isBot, pick: p.pick })),
      stage: state.stage,
      progress: { '♠': state.progress['♠'], '♥': state.progress['♥'], '♦': state.progress['♦'], '♣': state.progress['♣'] },
      finished: state.finished.slice(),
      lastCard: state.lastCard,
      action: state.action,
      index: state.index,
      turnId: state.turnId || null,
    };
  }

  function pushState() {
    Net.broadcast({ type: 'hr_state', ...buildPub() });
  }

  // ---------- 消息 ----------
  function handleMessage(from, data) {
    if (!ctx || !data || !data.type) return;
    if (ctx.isHost) {
      if (data.type === 'hr_pick') hostPick(from, data.suit);
      else if (data.type === 'hr_flip') hostFlip(from);
    } else {
      if (data.type === 'hr_state') { mirror = data; render(); }
    }
  }

  // ---------- 本地动作 ----------
  function doPick(suit) {
    myPick = suit;
    if (ctx.isHost) hostPick(Net.myId(), suit);
    else Net.sendToHost({ type: 'hr_pick', suit });
  }

  function doFlip() {
    if (ctx.isHost) hostFlip(Net.myId());
    else Net.sendToHost({ type: 'hr_flip' });
  }

  function view() {
    if (ctx.isHost) return buildPub();
    return mirror;
  }

  function suitColor(suit) { return (suit === '♥' || suit === '♦') ? 'var(--red)' : 'var(--ink)'; }
  function suitBg(suit) { return (suit === '♥' || suit === '♦') ? '#fdecec' : '#eef0f6'; }

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
    title.textContent = '🏇 赛马';
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
    pill.className = 'phase-pill' + (v && v.stage === 'ended' ? ' ok' : '');
    pill.textContent = !v ? '准备中' : (v.stage === 'picking' ? '认领中' : (v.stage === 'racing' ? (soloMode() ? '比赛进行中' : '轮流翻牌中') : '已结束'));
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

    frame.appendChild(UI.banner(v.stage === 'ended' ? 'ok' : '', v.action || ''));

    // 赛道
    const tracks = document.createElement('div');
    tracks.className = 'horse-tracks';
    SUITS.forEach(s => {
      const track = document.createElement('div');
      track.className = 'horse-track';

      const label = document.createElement('div');
      label.className = 'horse-track-label';
      const horse = document.createElement('span');
      horse.className = 'horse-track-horse';
      horse.textContent = v.finished.includes(s) ? '🏆' : '🐴';
      label.appendChild(horse);
      const suitEl = document.createElement('span');
      suitEl.className = 'horse-track-suit';
      suitEl.style.color = suitColor(s);
      suitEl.textContent = s;
      label.appendChild(suitEl);
      track.appendChild(label);

      const cells = document.createElement('div');
      cells.className = 'horse-track-cells';
      const prog = v.progress[s] || 0;
      for (let i = 0; i < FINISH; i++) {
        const cell = document.createElement('div');
        cell.className = 'horse-cell';
        if (i === FINISH - 1) cell.classList.add('finish');
        if (i < prog) {
          cell.classList.add('passed');
          cell.style.background = suitBg(s);
          cell.style.borderColor = suitBg(s);
          cell.textContent = (i === prog - 1 && v.stage !== 'ended') ? '🐴' : '';
          if (i === FINISH - 1 && v.finished.includes(s)) cell.textContent = '🏆';
        } else if (i === FINISH - 1) {
          cell.textContent = '🏁';
        }
        cells.appendChild(cell);
      }
      track.appendChild(cells);
      tracks.appendChild(track);
    });
    frame.appendChild(tracks);

    // 已翻出的牌
    if (v.lastCard) {
      const fl = document.createElement('div');
      fl.className = 'horse-flipped';
      const lab = document.createElement('span');
      lab.className = 'horse-picked';
      lab.textContent = '翻到第 ' + v.index + ' 张：';
      fl.appendChild(lab);
      fl.appendChild(UI.cardEl(v.lastCard, { small: true }));
      frame.appendChild(fl);
    }

    // 玩家认领状态
    const picked = document.createElement('div');
    picked.className = 'horse-pick';
    const rows = document.createElement('div');
    rows.className = 'horse-pick-row';
    v.players.forEach(p => {
      const chip = document.createElement('span');
      chip.className = 'score-chip';
      const me = p.id === myId;
      const nm = (p.isBot ? '🤖 ' : '') + (me ? p.name + '（你）' : p.name);
      chip.appendChild(document.createTextNode(nm));
      if (p.pick) {
        const b = document.createElement('b');
        b.style.color = suitColor(p.pick);
        b.textContent = p.pick;
        chip.appendChild(document.createTextNode(' · '));
        chip.appendChild(b);
      } else {
        chip.appendChild(document.createTextNode(' · 未选'));
      }
      rows.appendChild(chip);
    });
    picked.appendChild(rows);
    frame.appendChild(picked);

    // 结算：结果 + 领奖台
    if (v.stage === 'ended') {
      const winner = v.finished[0];
      const winners = winner ? v.players.filter(p => p.pick === winner) : [];
      const res = document.createElement('div');
      res.className = 'banner ok';
      res.textContent = winner
        ? ('🏆 ' + winner + ' 号马夺冠！赢家：' + (winners.length ? winners.map(p => p.name).join('、') : '（无人认领）'))
        : '比赛结束';
      frame.appendChild(res);

      const podium = document.createElement('div');
      podium.className = 'horse-podium';
      const medals = ['🥇', '🥈', '🥉'];
      v.finished.forEach((s, i) => {
        const m = document.createElement('div');
        m.className = 'horse-medal' + (i === 0 ? ' g1' : i === 1 ? ' g2' : ' g3');
        m.textContent = (medals[i] || '') + ' ' + s + ' 号马';
        podium.appendChild(m);
      });
      frame.appendChild(podium);
    }

    // 操作条
    const bar = document.createElement('div');
    bar.className = 'actionbar';
    if (v.stage === 'picking') {
      const myP = v.players.find(p => p.id === myId);
      const needPick = myP && !myP.pick;
      if (needPick) {
        SUITS.forEach(s => {
          const b = document.createElement('button');
          b.className = 'horse-pick-btn' + (myPick === s ? ' selected' : '');
          const suitSpan = document.createElement('span');
          suitSpan.className = 'suit';
          suitSpan.style.color = suitColor(s);
          suitSpan.textContent = s;
          const hint = document.createElement('span');
          hint.style.cssText = 'font-size:11px;color:var(--ink-2);';
          hint.textContent = '押它赢';
          b.appendChild(suitSpan);
          b.appendChild(hint);
          b.addEventListener('click', () => doPick(s));
          bar.appendChild(b);
        });
      } else {
        const wait = document.createElement('span');
        wait.className = 'horse-picked';
        wait.textContent = '你已认领' + (myP && myP.pick ? ' ' + myP.pick : '') + ' 号马，等待其他玩家…';
        bar.appendChild(wait);
      }
    } else if (v.stage === 'racing') {
      if (soloMode()) {
        // 人机：房主自动翻牌，可加速 / 直接揭晓
        if (ctx.isHost) {
          const sp = document.createElement('button');
          sp.className = 'btn btn-ghost';
          sp.textContent = '加速';
          sp.addEventListener('click', () => { speedUp(); });
          bar.appendChild(sp);
          const skip = document.createElement('button');
          skip.className = 'btn btn-ghost';
          skip.textContent = '直接揭晓';
          skip.addEventListener('click', skipRace);
          bar.appendChild(skip);
        } else {
          const wait = document.createElement('span');
          wait.className = 'horse-picked';
          wait.textContent = '比赛进行中，观看赛况…';
          bar.appendChild(wait);
        }
      } else {
        // 联机：轮到谁谁翻牌
        if (v.turnId === myId) {
          const flip = document.createElement('button');
          flip.className = 'btn btn-primary';
          flip.textContent = '🂠 翻牌';
          flip.addEventListener('click', doFlip);
          bar.appendChild(flip);
        } else {
          const tp = v.players.find(p => p.id === v.turnId);
          const wait = document.createElement('span');
          wait.className = 'horse-picked';
          wait.textContent = '轮到 ' + (tp ? tp.name : '') + ' 翻牌…';
          bar.appendChild(wait);
        }
      }
    } else if (v.stage === 'ended') {
      const back = document.createElement('button');
      back.className = 'btn btn-primary';
      back.textContent = '再来一局 / 返回';
      back.addEventListener('click', () => ctx.leave());
      bar.appendChild(back);
    }
    frame.appendChild(bar);

    c.appendChild(frame);
  }

  return { init, handleMessage };
})();
