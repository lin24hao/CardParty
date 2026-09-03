// 机器人（人机对战）
//
// 运行方式：单机模式下本机即主机，游戏逻辑完全复用联机代码。
// 主机广播的消息通过 Net.broadcast/sendTo 分发给注册的机器人；
// 机器人思考后调用 send(msg) 把动作回传给主机（等价于客机 sendToHost）。
const Bot = (() => {
  const BOT_NAMES = ['小蓝', '小绿', '小红', '小紫', '小青', '小橙', '小粉'];
  const BOT_AVATARS = ['🤖', '👾', '🐱', '🐼', '🦊', '🐸', '🐧'];

  function nameFor(i) { return BOT_NAMES[i % BOT_NAMES.length]; }
  function avatarFor(i) { return BOT_AVATARS[i % BOT_AVATARS.length]; }

  // 思考时间：随机区间，避免所有机器人同时动作、显得机械
  function thinkDelay(base = 1200) {
    return base + Math.floor(Math.random() * 1200);
  }

  // 创建一个机器人。send(msg) 用于把动作回传给主机。
  function create(gameKey, botId, send) {
    const brain = GAME_BRAINS[gameKey];
    if (!brain) return () => {};
    return brain(botId, send);
  }

  // ---------- 抽鬼牌 ----------
  // 两阶段：arrange（被抽牌方整理并亮牌）→ draw（抽牌方点击选牌）
  function oldMaidBrain(botId, send) {
    let last = null;      // 最近一次公开状态
    let hand = [];        // 自己的手牌（来自 om_hand）
    let busy = false;     // 是否正在“思考”中，避免同一阶段重复动作

    return function onData(msg) {
      if (!msg || !msg.type) return;
      if (msg.type === 'om_hand') { hand = msg.hand || []; return; }
      if (msg.type !== 'om_state') return;
      last = msg;
      if (busy) return;
      if (!last || last.stage === 'ended') return;

      // 我是被抽牌方：整理（随机打乱）后亮牌
      if (last.stage === 'arrange' && last.targetId === botId) {
        busy = true;
        setTimeout(() => {
          busy = false;
          if (!last || last.stage !== 'arrange' || last.targetId !== botId) return;
          send({ type: 'om_arranged', order: Deck.shuffle(hand.slice()) });
        }, thinkDelay(1000));
        return;
      }

      // 我是抽牌方：随机点一张
      if (last.stage === 'draw' && last.turnId === botId) {
        busy = true;
        const target = (last.players || []).find(p => p.id === last.targetId);
        const n = target ? target.count : 0;
        setTimeout(() => {
          busy = false;
          if (!last || last.stage !== 'draw' || last.turnId !== botId) return;
          if (n <= 0) return;
          send({ type: 'om_draw', index: Math.floor(Math.random() * n) });
        }, thinkDelay(1100));
      }
    };
  }

  // ---------- 21点 ----------
  // 简化基本策略：硬牌 <17 要牌；软牌（A 算 11 仍不爆）<18 要牌；否则停牌。
  function blackjackDecision(hand) {
    const total = Deck.blackjackValue(hand);
    const hasAce = hand.some(c => c.rank === 'A');
    const soft = hasAce && total + 10 <= 21;
    if (total < 17) return 'hit';
    if (soft && total < 18) return 'hit';
    return 'stand';
  }

  function blackjackBrain(botId, send) {
    let last = null;
    let pending = false;

    return function onData(msg) {
      if (!msg || msg.type !== 'bj_state') return;
      last = msg;
      if (last.phase !== 'playing' || last.currentId !== botId) return;
      if (pending) return;
      pending = true;
      setTimeout(() => {
        pending = false;
        if (!last || last.phase !== 'playing' || last.currentId !== botId) return;
        const hand = last.hands[botId] || [];
        if (!hand.length) return;
        send({ type: 'bj_action', action: blackjackDecision(hand) });
      }, thinkDelay(1100));
    };
  }

  // ---------- UNO ----------
  // 简单策略：有可出的牌就出（优先非万能牌，万能牌留后手）；没牌可出就抽一张；
  // 出万能牌后选手里数量最多的颜色。
  function unoBrain(botId, send) {
    let last = null;
    let hand = [];
    let busy = false;

    function playable(c) {
      if (c.color === 'wild') return true;
      if (last.currentColor && c.color === last.currentColor) return true;
      if (last.currentValue && c.value === last.currentValue) return true;
      return false;
    }

    function act() {
      if (!last) return;
      if (last.phase === 'color' && last.currentId === botId) {
        const count = { red: 0, yellow: 0, green: 0, blue: 0 };
        hand.forEach(c => { if (c.color !== 'wild') count[c.color] = (count[c.color] || 0) + 1; });
        let best = 'red', bestN = -1;
        for (const col of ['red', 'yellow', 'green', 'blue']) {
          if (count[col] > bestN) { bestN = count[col]; best = col; }
        }
        send({ type: 'uno_color', color: best });
        return;
      }
      if (last.phase !== 'playing' || last.currentId !== botId) return;
      const playableIdx = hand.findIndex(playable);
      if (playableIdx >= 0) {
        let chosen = playableIdx;
        for (let i = 0; i < hand.length; i++) {
          if (playable(hand[i]) && hand[i].color !== 'wild') { chosen = i; break; }
        }
        send({ type: 'uno_play', index: chosen });
      } else if (last.hasDrawn) {
        send({ type: 'uno_pass' });
      } else {
        send({ type: 'uno_draw' });
      }
    }

    return function onData(msg) {
      if (!msg || !msg.type) return;
      if (msg.type === 'uno_hand') { hand = msg.hand || []; return; }
      if (msg.type !== 'uno_state') return;
      last = msg;
      if (busy) return;
      if (last.phase === 'ended') return;
      const mine = (last.phase === 'playing' || last.phase === 'color') && last.currentId === botId;
      if (!mine) return;
      busy = true;
      setTimeout(() => {
        busy = false;
        if (!last || last.currentId !== botId) return;
        if (last.phase !== 'playing' && last.phase !== 'color') return;
        act();
      }, thinkDelay(950));
    };
  }

  // ---------- 女巫的毒药 ----------
  // 简单策略：优先出不溢出的牌（安全）；安全牌中优先甩掉毒药牌；
  // 若所有出法都会溢出，则选收牌最少、且毒药最少的锅。
  const POISON_COLORS = ['red', 'blue', 'purple'];

  function poisonChoose(hand, cauldrons) {
    const totalOf = (col) => (cauldrons[col] || []).reduce((s, c) => s + c.value, 0);
    let bestSafe = null, bestOverflow = null;
    for (const card of hand) {
      const targets = card.poison ? POISON_COLORS : [card.color];
      for (const col of targets) {
        const nxt = totalOf(col) + card.value;
        if (nxt <= 13) {
          let pref = 0;
          if (card.poison) pref += 2;                 // 安全时优先甩毒药
          else pref += (7 - card.value) * 0.01;        // 小牌先出
          if (!bestSafe || pref > bestSafe.pref) bestSafe = { card, cauldron: col, pref };
        } else {
          const pile = cauldrons[col] || [];
          const penalty = pile.length + pile.filter(c => c.poison).length; // 毒药双倍
          if (!bestOverflow || penalty < bestOverflow.penalty) bestOverflow = { card, cauldron: col, penalty };
        }
      }
    }
    return bestSafe || bestOverflow;
  }

  function poisonBrain(botId, send) {
    let last = null;
    let hand = [];
    let busy = false;

    function tryPlay() {
      if (busy) return;
      if (!last || last.phase !== 'playing' || last.currentId !== botId) return;
      if (!hand.length) return;
      const move = poisonChoose(hand, last.cauldrons || {});
      if (!move) return;
      busy = true;
      setTimeout(() => {
        busy = false;
        if (!last || last.phase !== 'playing' || last.currentId !== botId) return;
        if (hand.findIndex(c => c.id === move.card.id) < 0) return;
        hand = hand.filter(c => c.id !== move.card.id);
        send({ type: 'ps_play', cardId: move.card.id, cauldron: move.cauldron });
      }, thinkDelay(1000));
    }

    return function onData(msg) {
      if (!msg || !msg.type) return;
      if (msg.type === 'ps_hand') { hand = msg.hand || []; tryPlay(); return; }
      if (msg.type !== 'ps_state') return;
      last = msg;
      if (last.phase === 'ended' || last.phase === 'scoring') return;
      tryPlay();
    };
  }

  // ---------- 狼人杀 ----------
  // 简单策略：狼人选非队友目标；预言家随机查验；女巫概率性救/毒；白天随机投票（狼人不投队友）。
  function werewolfBrain(botId, send) {
    let role = null;
    let team = [];
    let busy = false;

    function pick(pool) {
      if (!pool.length) return null;
      return pool[Math.floor(Math.random() * pool.length)].id;
    }

    return function onData(msg) {
      if (!msg || !msg.type) return;
      if (msg.type === 'ww_role') { role = msg.role; team = msg.team || []; return; }
      if (msg.type === 'ww_state') return;
      if (busy) return;
      const candidates = msg.candidates || [];

      const schedule = (base, fn) => {
        busy = true;
        setTimeout(() => { busy = false; fn(); }, thinkDelay(base));
      };

      if (msg.type === 'ww_wolf_prompt') {
        schedule(1400, () => {
          const pool = candidates.filter(c => !team.includes(c.id));
          const id = pick(pool.length ? pool : candidates);
          if (id) send({ type: 'ww_wolf_kill', targetId: id });
        });
        return;
      }
      if (msg.type === 'ww_seer_prompt') {
        schedule(1300, () => {
          const id = pick(candidates);
          if (id) send({ type: 'ww_seer_check', targetId: id });
        });
        return;
      }
      if (msg.type === 'ww_witch_prompt') {
        schedule(1600, () => {
          const save = !!msg.canSave && Math.random() < 0.5;
          const poison = msg.canPoison && Math.random() < 0.25 && candidates.length
            ? pick(candidates)
            : null;
          send({ type: 'ww_witch_act', act: { save, poisonId: poison } });
        });
        return;
      }
      if (msg.type === 'ww_day_vote_prompt') {
        schedule(1500, () => {
          const pool = candidates.filter(c => !team.includes(c.id));
          const id = pick(pool.length ? pool : candidates);
          send({ type: 'ww_day_vote', targetId: id || null });
        });
        return;
      }
    };
  }

  // ---------- 卡波 ----------
  // 策略：偷看2张；已见牌越多越敢喊卡波；抽牌/拿弃牌都换掉手里已知最大的牌；
  // 特殊牌尽量发动能力（偷看未知暗牌 / 窥探别人 / 换掉自己最大的牌）。
  const CABO_ABIL = { 7: 'peek', 8: 'peek', 9: 'spy', 10: 'spy', 11: 'swap', 12: 'swap' };

  function caboBrain(botId, send) {
    let hand = [];       // 私有手牌 [{v, faceUp, seen}]
    let last = null;     // cabo_state
    let pending = null;  // 抽到的牌 {from, v}
    let peeked = false;  // 主机确认的本轮偷看状态
    let peekSent = false;// 本轮是否已发出偷看请求（本地锁，防止重复偷看）
    let busy = false;

    function pickOpponent() {
      const others = (last && last.players ? last.players : []).filter(p => p.id !== botId);
      if (!others.length) return null;
      return others[Math.floor(Math.random() * others.length)].id;
    }

    function randomSlot(targetId, preferDown) {
      const h = (last && last.hands && last.hands[targetId]) || [];
      if (!h.length) return 0;
      if (preferDown) {
        const down = [];
        h.forEach((s, i) => { if (!s.faceUp) down.push(i); });
        if (down.length) return down[Math.floor(Math.random() * down.length)];
      }
      return Math.floor(Math.random() * h.length);
    }

    function maxKnownSlot() {
      let idx = -1, max = -1;
      hand.forEach((s, i) => { if (s.v != null && s.v > max) { max = s.v; idx = i; } });
      return idx;
    }

    function schedule(fn, base) {
      busy = true;
      setTimeout(() => { busy = false; fn(); }, thinkDelay(base));
    }

    function decideChoose() {
      if (!last) return;
      const known = hand.filter(s => s.v != null);
      const allKnown = hand.length > 0 && known.length === hand.length;
      const knownSum = known.reduce((s, c) => s + c.v, 0);
      // 自信较低时喊卡波
      if (last.phase === 'playing' && allKnown && knownSum <= 1 && Math.random() < 0.6) {
        send({ type: 'cabo_act', action: 'call' });
        return;
      }
      const maxKnown = known.length ? Math.max(...known.map(c => c.v)) : 13;
      if (last.discardTop != null && last.discardTop < maxKnown && Math.random() < 0.7) {
        send({ type: 'cabo_act', action: 'draw_discard' });
      } else {
        send({ type: 'cabo_act', action: 'draw_deck' });
      }
    }

    function decideDeck() {
      if (!last) return;
      const v = pending ? pending.v : null;
      if (v == null) { send({ type: 'cabo_deck_discard' }); return; }
      const maxIdx = maxKnownSlot();
      if (v < (maxIdx >= 0 ? hand[maxIdx].v : 13)) {
        send({ type: 'cabo_deck_keep', slots: [maxIdx >= 0 ? maxIdx : 0] });
        return;
      }
      const ab = CABO_ABIL[v];
      if (ab === 'peek') {
        const uIdx = hand.findIndex(s => !s.faceUp && s.v == null);
        if (uIdx >= 0) send({ type: 'cabo_ability', kind: 'peek', slot: uIdx });
        else send({ type: 'cabo_deck_discard' });
      } else if (ab === 'spy') {
        const t = pickOpponent();
        if (t) send({ type: 'cabo_ability', kind: 'spy', targetId: t, slot: randomSlot(t, true) });
        else send({ type: 'cabo_deck_discard' });
      } else if (ab === 'swap') {
        const t = pickOpponent();
        if (t && maxIdx >= 0) send({ type: 'cabo_ability', kind: 'swap', targetId: t, mySlot: maxIdx, theirSlot: randomSlot(t, false) });
        else send({ type: 'cabo_deck_discard' });
      } else {
        send({ type: 'cabo_deck_discard' });
      }
    }

    function decideDiscard() {
      const maxIdx = maxKnownSlot();
      send({ type: 'cabo_discard_keep', slots: [maxIdx >= 0 ? maxIdx : 0] });
    }

    function maybeAct() {
      if (!last || busy) return;
      if (last.phase === 'peek') { if (!peekSent) schedule(doPeekNow, 600); return; }
      const myTurn = (last.phase === 'playing' || last.phase === 'endgame') && last.currentId === botId;
      if (!myTurn) return;
      if (last.stage === 'choose') schedule(decideChoose, 900);
      else if (last.stage === 'deck') schedule(decideDeck, 900);
      else if (last.stage === 'discard') schedule(decideDiscard, 900);
    }

    function doPeekNow() {
      if (peekSent) return;
      peekSent = true;
      const idxs = [0, 1, 2, 3].sort(() => Math.random() - 0.5).slice(0, 2);
      send({ type: 'cabo_peek', slots: idxs });
    }

    return function onData(msg) {
      if (!msg || !msg.type) return;
      if (msg.type === 'cabo_priv') {
        hand = msg.myHand || [];
        pending = msg.pending || null;
        peeked = !!msg.peeked;
        if (!msg.peeked) peekSent = false; // 新一轮开始，重置偷看锁
        maybeAct();
        return;
      }
      if (msg.type !== 'cabo_state') return;
      last = msg;
      maybeAct();
    };
  }

  // ---------- 赛马 ----------
  // 简单策略：认领阶段随机认领一匹马。
  function horseRaceBrain(botId, send) {
    let picked = false;
    return function onData(msg) {
      if (!msg || msg.type !== 'hr_state') return;
      if (msg.stage !== 'picking' || picked) return;
      const me = (msg.players || []).find(p => p.id === botId);
      if (!me || me.pick) return;
      picked = true;
      const suits = ['♠', '♥', '♦', '♣'];
      setTimeout(() => {
        send({ type: 'hr_pick', suit: suits[Math.floor(Math.random() * suits.length)] });
      }, thinkDelay(400));
    };
  }

  // ---------- 飞行棋 ----------
  // 简单策略：轮到掷骰就掷；选择阶段按「优先起飞 > 能踩则踩 > 前进最多（to 最大）」决策。
  function ludoBrain(botId, send) {
    let last = null;
    let busy = false;

    return function onData(msg) {
      if (!msg || msg.type !== 'ludo_state') return;
      last = msg;
      if (!last || last.phase === 'ended') return;
      if (last.currentId !== botId) return;
      if (busy) return;
      busy = true;
      setTimeout(() => {
        busy = false;
        if (!last || last.currentId !== botId || last.phase === 'ended') return;
        if (last.phase === 'roll') {
          send({ type: 'ludo_roll' });
          return;
        }
        if (last.phase === 'choose') {
          const moves = last.moves || [];
          if (!moves.length) return;
          const takeoff = moves.find(m => m.from < 0);
          const take = moves.find(m => m.take);
          let mv = takeoff || take;
          if (!mv) {
            mv = moves.slice().sort((a, b) => (b.to || -99) - (a.to || -99))[0];
          }
          send({ type: 'ludo_move', fromPos: mv.from });
        }
      }, thinkDelay(1000));
    };
  }

  // ---------- 泡泡龙合作 ----------
  // 自由发射节奏：收到共享场地下一次状态后，冷却结束就发射；
  // 评估角度时优先打向己方炮台附近同色密度高/近竖直的区域。
  function bubbleCoopBrain(botId, send) {
    let last = null;
    // 初始冷却：开局给一段“思考”时间，避免人机在发牌瞬间抢射
    let cooldownUntil = Date.now() + 900 + Math.random() * 800;

    // 逐个候选角度模拟弹道（flyTrail 不修改 grid），挑落点同色邻居最多、且尽量靠上的角度
    function pickAngle() {
      const BC = window.BubbleCore;
      if (!BC || !last || !last.board) return -30;
      const grid = last.board;
      const q = last.queue || [];
      const color = q[0] || 'r';
      const sx = last.launcherX != null ? last.launcherX : BC.COLS * BC.CELL_W / 3;
      // 与玩家一致的角度范围：左右都覆盖
      const angles = [-72, -54, -36, -18, 0, 18, 36, 54, 72];
      let best = 0, bestScore = -Infinity;
      for (const a of angles) {
        let ft = null;
        try { ft = BC.flyTrail(grid, sx, BC.LAUNCH_Y, a); } catch (e) { ft = null; }
        if (!ft || !ft.cell) continue;
        let same = 0;
        for (const nb of BC.neighbors(ft.cell.r, ft.cell.c)) {
          if (grid[nb[0]][nb[1]] === color) same++;
        }
        // 同色邻居越多越好；落点越靠上越安全；略偏好竖直；再加一点随机避免呆板
        const s = same * 3 + (BC.ROWS - ft.cell.r) * 0.25 - Math.abs(a) / 90 + Math.random() * 0.6;
        if (s > bestScore) { bestScore = s; best = a; }
      }
      return bestScore === -Infinity ? 0 : best;
    }

    function tryAct() {
      const now = Date.now();
      if (!last || last.over || last.failed) return;
      if (now < cooldownUntil) return;
      cooldownUntil = now + 1200 + Math.random() * 700;
      send({ type: 'bubble_coop_shot', angle: pickAngle() });
    }

    return function onData(msg) {
      if (!msg || msg.type !== 'bubble_coop_state') return;
      last = msg;
      tryAct();
    };
  }

  // ---------- 情书 ----------
  // 简单策略：强制情况下打伯爵夫人；否则打出点数较小的牌（保留大牌用于终局比较）；
  // 目标随机选存活且非免疫玩家；守卫随机猜 2~8。
  function loveLetterBrain(botId, send) {
    let hand = [];
    let last = null;
    let busy = false;
    let handDirty = false;

    function pickTarget() {
      const others = (last && last.players ? last.players : []).filter(p => p.alive && p.id !== botId && !p.immune);
      if (!others.length) return null;
      return others[Math.floor(Math.random() * others.length)].id;
    }

    function act() {
      if (busy) return;
      if (!last || last.phase !== 'playing' || last.currentId !== botId) return;
      if (handDirty) return; // 等 ll_hand 更新手牌后再决策
      if (!hand.length) return;
      const has7 = hand.some(c => c.rank === 7);
      const hasKQ = hand.some(c => c.rank === 6 || c.rank === 5);
      let idx = 0, targetId = null, guess = null;
      if (has7 && hasKQ) {
        idx = hand.findIndex(c => c.rank === 7); // 强制打伯爵夫人
      } else {
        for (let i = 1; i < hand.length; i++) if (hand[i].rank < hand[idx].rank) idx = i;
      }
      const card = hand[idx];
      if (card.rank === 1) { targetId = pickTarget(); guess = 2 + Math.floor(Math.random() * 7); }
      else if (card.rank === 2) { targetId = pickTarget(); }
      else if (card.rank === 3) { targetId = pickTarget(); }
      else if (card.rank === 5) {
        const others = (last.players || []).filter(p => p.alive && p.id !== botId && !p.immune);
        targetId = others.length ? others[Math.floor(Math.random() * others.length)].id : botId;
      }
      else if (card.rank === 6) { targetId = pickTarget(); }
      busy = true;
      setTimeout(() => {
        busy = false;
        if (!last || last.phase !== 'playing' || last.currentId !== botId) return;
        send({ type: 'll_play', cardIndex: idx, targetId, guess });
      }, thinkDelay(1100));
    }

    return function onData(msg) {
      if (!msg || !msg.type) return;
      if (msg.type === 'll_hand') { hand = msg.hand || []; handDirty = false; act(); return; }
      if (msg.type !== 'll_state') return;
      last = msg;
      handDirty = true;
      act();
    };
  }

  // ---------- 谁是牛头王 ----------
  // 简单策略：有安全牌（小于某行行尾）就随机出一张；全不安全则出最大牌；
  // 需要吃行时选牛头总数最少的一行。
  function takeT6Brain(botId, send) {
    let hand = [];
    let last = null;
    let busy = false;
    let handDirty = false;

    function hornsOf(n) {
      let h = 1;
      if (n % 10 === 5) h += 1;
      if (n % 10 === 0) h += 2;
      if (n % 11 === 0) h += 4;
      if (n === 55) h += 1;
      return h;
    }
    function chooseCard() {
      const tails = (last.rows || []).map(r => r[r.length - 1]);
      if (!tails.length) return hand[0];
      const maxTail = Math.max(...tails);
      const safe = hand.filter(c => c < maxTail);
      if (safe.length) return safe[Math.floor(Math.random() * safe.length)];
      return Math.max(...hand);
    }
    function chooseRow() {
      let bi = 0, bh = Infinity;
      (last.rows || []).forEach((row, i) => {
        const h = row.reduce((s, n) => s + hornsOf(n), 0);
        if (h < bh) { bh = h; bi = i; }
      });
      return bi;
    }

    function tryAct() {
      if (!last || busy) return;
      if (last.phase === 'eat' && last.eatPromptFor === botId) {
        const rowIndex = chooseRow();
        busy = true;
        setTimeout(() => {
          busy = false;
          if (!last || last.phase !== 'eat' || last.eatPromptFor !== botId) return;
          send({ type: 't6_eat', rowIndex });
        }, thinkDelay(900));
        return;
      }
      if (last.phase !== 'playing') return;
      if ((last.chosenIds || []).includes(botId)) return;
      if (handDirty) return; // 等 t6_hand 更新手牌
      if (!hand.length) return;
      const card = chooseCard();
      busy = true;
      setTimeout(() => {
        busy = false;
        if (!last || last.phase !== 'playing') return;
        if ((last.chosenIds || []).includes(botId)) return;
        send({ type: 't6_play', card });
      }, thinkDelay(900));
    }

    return function onData(msg) {
      if (!msg || !msg.type) return;
      if (msg.type === 't6_hand') { hand = msg.hand || []; handDirty = false; tryAct(); return; }
      if (msg.type !== 't6_state') return;
      last = msg;
      handDirty = true;
      tryAct();
    };
  }

  // ---------- 炸弹猫 ----------
  // 简单策略：出牌阶段优先打出攻击/洗牌/跳过效果牌（攻击 > 洗牌 > 跳过），
  // 没有可打的效果牌就抽牌；拆弹保留在手里不主动打出。
  function explodingKittensBrain(botId, send) {
    let hand = [];
    let last = null;
    let busy = false;
    let handDirty = false;

    function tryAct() {
      if (!last || busy) return;
      if (last.phase !== 'playing' || last.currentId !== botId) return;
      if (handDirty) return; // 等 ek_hand 更新手牌
      if (!hand.length) return;
      const findIdx = (types) => hand.findIndex(c => types.includes(c.type));
      const idx = findIdx(['attack']) >= 0 ? findIdx(['attack'])
        : findIdx(['shuffle']) >= 0 ? findIdx(['shuffle'])
        : findIdx(['skip']);
      busy = true;
      setTimeout(() => {
        busy = false;
        if (!last || last.phase !== 'playing' || last.currentId !== botId) return;
        if (idx >= 0 && hand[idx] && hand[idx].type !== 'defuse') {
          send({ type: 'ek_play', cardIndex: idx });
        } else {
          send({ type: 'ek_draw' });
        }
      }, thinkDelay(1000));
    }

    return function onData(msg) {
      if (!msg || !msg.type) return;
      if (msg.type === 'ek_hand') { hand = msg.hand || []; handDirty = false; tryAct(); return; }
      if (msg.type !== 'ek_state') return;
      last = msg;
      handDirty = true;
      tryAct();
    };
  }

  // ---------- 海盐与纸 ----------
  // 简单策略：粗略估算手牌组合得分，>=5 或手牌较多时收分，否则继续抽牌。
  function spEstimate(hand) {
    const byNum = {}, byColor = {};
    hand.forEach(c => {
      byNum[c.num] = (byNum[c.num] || 0) + 1;
      byColor[c.color] = (byColor[c.color] || 0) + 1;
    });
    let s = 0;
    for (const k in byNum) {
      const n = byNum[k];
      if (n >= 3) s += 10; else if (n === 2) s += 3;
    }
    for (const k in byColor) {
      const n = byColor[k];
      if (n >= 3) s += 3 + (n - 3); else if (n === 2) s += 2;
    }
    return s;
  }

  function seaSaltPaperBrain(botId, send) {
    let hand = [];
    let last = null;
    let busy = false;
    let handDirty = false;

    function tryAct() {
      if (!last || busy) return;
      if (last.phase === 'collect' && last.forcedCollectFor === botId) {
        busy = true;
        setTimeout(() => { busy = false; send({ type: 'sp_collect' }); }, thinkDelay(900));
        return;
      }
      if (last.phase !== 'choose' || last.currentId !== botId) return;
      if (handDirty) return;
      if (!hand.length) return;
      const score = spEstimate(hand);
      const shouldCollect = score >= 5 || hand.length >= 6;
      busy = true;
      setTimeout(() => {
        busy = false;
        if (!last || last.phase !== 'choose' || last.currentId !== botId) return;
        send({ type: shouldCollect ? 'sp_collect' : 'sp_pass' });
      }, thinkDelay(1000));
    }

    return function onData(msg) {
      if (!msg || !msg.type) return;
      if (msg.type === 'sp_hand') { hand = msg.hand || []; handDirty = false; tryAct(); return; }
      if (msg.type !== 'sp_state') return;
      last = msg;
      handDirty = true;
      tryAct();
    };
  }

  // ---------- 翻牌7 ----------
  // 简单策略：累计越高越倾向停止（>=16 必停，>=12 有六成概率停，否则继续翻）。
  function flip7Brain(botId, send) {
    let last = null;
    let busy = false;

    function tryAct() {
      if (!last || busy) return;
      if (last.phase !== 'flipping' || last.currentId !== botId) return;
      const sum = last.sum || 0;
      const stop = sum >= 16 || (sum >= 12 && Math.random() < 0.6);
      busy = true;
      setTimeout(() => {
        busy = false;
        if (!last || last.phase !== 'flipping' || last.currentId !== botId) return;
        send({ type: stop ? 'f7_stop' : 'f7_flip' });
      }, thinkDelay(900));
    }

    return function onData(msg) {
      if (!msg || msg.type !== 'f7_state') return;
      last = msg;
      tryAct();
    };
  }

  // ---------- 深海小队 The Crew ----------
  // 合作吃墩简单策略：任务目标尽量吃墩（跟色出最大、无跟色出任务牌），
  // 非目标避免吃墩且避免打出任务牌（跟色出最小、无跟色出非任务的最小牌）。
  function crewBrain(botId, send) {
    let last = null;
    let hand = [];
    let busy = false;

    function cardLabel(c) {
      const names = { red: '红', blue: '蓝', green: '绿', yellow: '黄', purple: '紫' };
      return (names[c.color] || c.color) + c.number;
    }

    function tryAct() {
      if (!last || busy) return;
      if (last.phase !== 'playing' || last.currentId !== botId) return;
      if (!hand.length) return;
      const lead = last.trick && last.trick.length ? last.trick[0].card.color : null;
      const isTarget = last.task && last.task.targetId === botId;
      const taskCard = last.task ? { color: last.task.color, number: last.task.number } : null;
      const hasTask = hand.some(c => c.color === taskCard.color && c.number === taskCard.number);
      let pick = null;
      const leadCards = lead ? hand.map((c, i) => ({ c, i })).filter(x => x.c.color === lead) : [];
      if (lead) {
        if (leadCards.length) {
          if (isTarget) {
            // 目标：出最大的同色（若手里有任务牌且同色，优先出任务牌争取吃墩）
            const taskIdx = leadCards.find(x => x.c.color === taskCard.color && x.c.number === taskCard.number);
            pick = taskIdx ? taskIdx.i : leadCards.reduce((a, b) => (a.c.number >= b.c.number ? a : b)).i;
          } else {
            // 非目标：出最小同色，避免打出任务牌
            const nonTask = leadCards.filter(x => !(x.c.color === taskCard.color && x.c.number === taskCard.number));
            const pool = nonTask.length ? nonTask : leadCards;
            pick = pool.reduce((a, b) => (a.c.number <= b.c.number ? a : b)).i;
          }
        }
      } else if (isTarget && hasTask) {
        // 首墩且目标手里有任务牌：直接打出任务牌搏吃墩
        pick = hand.findIndex(c => c.color === taskCard.color && c.number === taskCard.number);
      }
      if (pick == null) {
        if (!isTarget) {
          // 非目标：避免任务牌，出数字最小的牌（让队友赢）
          const nonTask = hand.map((c, i) => ({ c, i })).filter(x => !(x.c.color === taskCard.color && x.c.number === taskCard.number));
          const pool = nonTask.length ? nonTask : hand.map((c, i) => ({ c, i }));
          pick = pool.reduce((a, b) => (a.c.number <= b.c.number ? a : b)).i;
        } else {
          // 目标且无任务牌：出最大牌争取赢墩
          pick = hand.reduce((a, b, i, arr) => (arr[a].number >= b.number ? a : i), 0);
        }
      }
      busy = true;
      setTimeout(() => {
        busy = false;
        if (!last || last.phase !== 'playing' || last.currentId !== botId) return;
        send({ type: 'cr_play', cardIndex: pick });
      }, thinkDelay(900));
    }

    return function onData(msg) {
      if (!msg || !msg.type) return;
      if (msg.type === 'cr_hand') { hand = msg.hand || []; tryAct(); return; }
      if (msg.type !== 'cr_state') return;
      last = msg;
      tryAct();
    };
  }

  // ---------- 阿瓦隆 Avalon ----------
  // 简单策略：队长优先提名同伙（坏人），队伍投票随机偏赞成，
  // 任务投票按阵营（好人必成功，坏人 70% 失败），刺客随机指认。
  function avalonBrain(botId, send) {
    let last = null;
    let role = null;
    let evils = [];
    let busy = false;
    function act() {
      if (!last || busy || !role) return;
      const my = (last.players || []).find(p => p.id === botId);
      if (!my) return;
      if (last.phase === 'propose' && last.proposer === botId) {
        const pool = (last.players || []).filter(p => p.id !== botId);
        const size = last.needSize || 1;
        const pick = [];
        for (const p of pool) { if (evils.includes(p.id) && pick.length < size) pick.push(p.id); }
        for (const p of pool) { if (!pick.includes(p.id) && pick.length < size) pick.push(p.id); }
        busy = true;
        setTimeout(() => { busy = false; send({ type: 'av_choose', ids: pick.slice(0, size) }); }, thinkDelay(500));
        return;
      }
      if (last.phase === 'vote') {
        busy = true;
        setTimeout(() => { busy = false; send({ type: 'av_vote', ok: Math.random() < 0.65 }); }, thinkDelay(400));
        return;
      }
      if (last.phase === 'mission' && (last.missionOrder || []).includes(botId)) {
        const isEvil = role === 'assassin' || role === 'morgana' || role === 'mordred' || role === 'oberon';
        const ok = isEvil ? Math.random() > 0.3 : true;
        busy = true;
        setTimeout(() => { busy = false; send({ type: 'av_mission', ok }); }, thinkDelay(500));
        return;
      }
      if (last.phase === 'assassinate' && role === 'assassin') {
        const others = (last.players || []).filter(p => p.id !== botId);
        const t = others[Math.floor(Math.random() * others.length)];
        busy = true;
        setTimeout(() => { busy = false; send({ type: 'av_assassinate', targetId: t.id }); }, thinkDelay(600));
      }
    }
    return function onData(msg) {
      if (!msg || !msg.type) return;
      if (msg.type === 'av_role') { role = msg.role; evils = msg.evils || []; act(); return; }
      if (msg.type !== 'av_state') return;
      last = msg;
      act();
    };
  }

  // ---------- 秘密希特勒 Secret Hitler ----------
  // 简单策略：随机提名；自由偏赞成 / 法西斯偏反对；
  // 总统弃掉不利牌、首相执行有利牌（通过私发 sh_hand 拿到政策牌）。
  function secretHitlerBrain(botId, send) {
    let last = null;
    let role = null;
    let hand = null;
    let busy = false;
    function isFascist() { return role === 'fascist' || role === 'hitler'; }
    function act() {
      if (!last || busy || !role) return;
      if (last.phase === 'nominate' && last.president === botId) {
        const others = (last.players || []).filter(p => p.id !== botId);
        const t = others[Math.floor(Math.random() * others.length)];
        busy = true;
        setTimeout(() => { busy = false; send({ type: 'sh_nominate', targetId: t.id }); }, thinkDelay(500));
        return;
      }
      if (last.phase === 'vote') {
        const ja = isFascist() ? Math.random() > 0.65 : Math.random() < 0.75;
        busy = true;
        setTimeout(() => { busy = false; send({ type: 'sh_vote', ja }); }, thinkDelay(400));
        return;
      }
      if (last.phase === 'president' && last.president === botId && hand && hand.length === 3) {
        const mine = isFascist() ? 'fas' : 'lib';
        let idx = hand.findIndex(c => c !== mine);
        if (idx < 0) idx = 0;
        busy = true;
        setTimeout(() => { busy = false; send({ type: 'sh_president', idx }); }, thinkDelay(500));
        return;
      }
      if (last.phase === 'chancellor' && last.chancellor === botId && hand && hand.length === 2) {
        const mine = isFascist() ? 'fas' : 'lib';
        const idx = hand.indexOf(mine);
        busy = true;
        setTimeout(() => { busy = false; send({ type: 'sh_chancellor', idx: idx >= 0 ? idx : 0 }); }, thinkDelay(500));
        return;
      }
      if (last.phase === 'investigate' && last.president === botId) {
        const others = (last.players || []).filter(p => p.id !== botId);
        const t = others[Math.floor(Math.random() * others.length)];
        busy = true;
        setTimeout(() => { busy = false; send({ type: 'sh_investigate', targetId: t.id }); }, thinkDelay(500));
        return;
      }
      if (last.phase === 'pick' && last.president === botId) {
        const others = (last.players || []).filter(p => p.id !== botId);
        const t = others[Math.floor(Math.random() * others.length)];
        busy = true;
        setTimeout(() => { busy = false; send({ type: 'sh_pick', targetId: t.id }); }, thinkDelay(500));
        return;
      }
      if (last.phase === 'assassinate' && last.president === botId) {
        const others = (last.players || []).filter(p => p.id !== botId);
        const t = others[Math.floor(Math.random() * others.length)];
        busy = true;
        setTimeout(() => { busy = false; send({ type: 'sh_assassinate', targetId: t.id }); }, thinkDelay(600));
      }
    }
    return function onData(msg) {
      if (!msg || !msg.type) return;
      if (msg.type === 'sh_role') { role = msg.role; act(); return; }
      if (msg.type === 'sh_hand') { hand = msg.cards || []; act(); return; }
      if (msg.type !== 'sh_state') return;
      last = msg;
      act();
    };
  }

  // ---------- 矮人矿坑 Saboteur ----------
  // 简单策略：坏矮人优先用破坏工具；否则尝试放第一张能放的路径牌；
  // 放不下就修理自己/看地图，最后弃牌。接口计算与服务端保持一致。
  function saboteurBrain(botId, send) {
    const PATH_BASE = {
      'I': '1010', 'I2': '0101', 'L1': '1100', 'L2': '0110', 'L3': '0011', 'L4': '1001',
      'T1': '1110', 'T2': '0111', 'T3': '1011', 'T4': '1101', 'X': '1111',
      'D1': '1000', 'D2': '0100', 'D3': '0010', 'D4': '0001',
    };
    function rotate(s, n) {
      n = ((n % 4) + 4) % 4;
      return n === 0 ? s : s.slice(n) + s.slice(0, n);
    }
    function cardInter(card, rot) { return rotate(PATH_BASE[card.type] || '0000', rot); }
    function canPlace(inter, x, y, boardMap) {
      if (x < 0 || x >= 7 || y < 0 || y >= 6) return false;
      if (boardMap[x + ',' + y]) return false;
      const dirs = [[0,-1,0],[1,0,1],[0,1,2],[-1,0,3]];
      let hasNeighbor = false;
      for (const [dx, dy, d] of dirs) {
        const nb = boardMap[(x + dx) + ',' + (y + dy)];
        if (!nb) continue;
        hasNeighbor = true;
        const nInter = nb.kind === 'start' ? '1000' : nb.kind === 'gold' ? '0010' : cardInter(nb, nb.rot || 0);
        if (inter[d] !== nInter[(d + 2) % 4]) return false;
      }
      return hasNeighbor;
    }
    let last = null;
    let team = null;
    let hand = [];
    let busy = false;
    function act() {
      if (!last || busy || !team) return;
      if (last.phase !== 'playing') return;
      const cur = (last.players || [])[last.currentIdx];
      if (!cur || cur.id !== botId) return;
      if (cur.broken) { busy = true; setTimeout(() => { busy = false; send({ type: 'sb_discard', cardIdx: -1 }); }, thinkDelay(400)); return; }
      const boardMap = {};
      (last.board || []).forEach(c => { boardMap[c.x + ',' + c.y] = c; });
      // 坏矮人：优先破坏好矮人
      if (team === 'bad') {
        const ti = hand.findIndex(c => c.type === 'broken');
        if (ti >= 0) {
          const targets = (last.players || []).filter(p => p.id !== botId && !p.broken);
          if (targets.length) {
            busy = true;
            setTimeout(() => { busy = false; send({ type: 'sb_tool', toolIdx: ti, targetId: targets[0].id }); }, thinkDelay(500));
            return;
          }
        }
      }
      // 尝试放路径牌：遍历手牌、空位、旋转，找第一个合法放置
      const emptyCells = [];
      for (let y = 0; y < 6; y++) for (let x = 0; x < 7; x++) if (!boardMap[x + ',' + y]) emptyCells.push({ x, y });
      for (let i = 0; i < hand.length; i++) {
        const card = hand[i];
        if (!PATH_BASE[card.type]) continue;
        for (const cell of emptyCells) {
          for (let r = 0; r < 4; r++) {
            const inter = cardInter(card, r);
            if (canPlace(inter, cell.x, cell.y, boardMap)) {
              busy = true;
              const rr = r, cc = { ...cell }, ii = i;
              setTimeout(() => { busy = false; send({ type: 'sb_play', cardIdx: ii, x: cc.x, y: cc.y, rot: rr }); }, thinkDelay(500));
              return;
            }
          }
        }
      }
      // 修理自己 / 地图
      const ri = hand.findIndex(c => c.type === 'repair');
      if (ri >= 0) { busy = true; setTimeout(() => { busy = false; send({ type: 'sb_tool', toolIdx: ri, targetId: botId }); }, thinkDelay(500)); return; }
      const mi = hand.findIndex(c => c.type === 'map');
      if (mi >= 0) { busy = true; setTimeout(() => { busy = false; send({ type: 'sb_tool', toolIdx: mi, targetId: null }); }, thinkDelay(500)); return; }
      // 弃牌
      busy = true;
      setTimeout(() => { busy = false; send({ type: 'sb_discard', cardIdx: 0 }); }, thinkDelay(400));
    }
    return function onData(msg) {
      if (!msg || !msg.type) return;
      if (msg.type === 'sb_role') { team = msg.team; act(); return; }
      if (msg.type === 'sb_hand') { hand = msg.hand || []; act(); return; }
      if (msg.type === 'sb_state') { last = msg; act(); }
    };
  }

  // ---------- 花火 Hanabi ----------
  // 简单策略（作弊视角，通过 hn_cheat 拿到自己的真实手牌）：
  // 优先打出可上堆的牌 → 否则弃掉已不可能再打的安全牌 → 否则提示一位队友关键数字。
  function hanabiBrain(botId, send) {
    let last = null;
    let cheat = null; // [{color, number}]
    let busy = false;

    function tryAct() {
      if (!last || busy) return;
      if (last.phase !== 'playing' || last.currentId !== botId) return;
      if (!cheat || !cheat.length) return;
      // 1) 可打的牌：number === 对应色堆顶 + 1
      for (let i = 0; i < cheat.length; i++) {
        const c = cheat[i];
        if (c.number === (last.piles[c.color] || 0) + 1) {
          busy = true;
          setTimeout(() => { busy = false; send({ type: 'hn_play', cardIndex: i }); }, thinkDelay(800));
          return;
        }
      }
      // 2) 安全弃牌：该色堆已 >= 该数字（不可能再打）→ 弃；优先弃数字小的
      let discardIdx = -1;
      for (let i = 0; i < cheat.length; i++) {
        const c = cheat[i];
        if ((last.piles[c.color] || 0) >= c.number) {
          if (discardIdx < 0 || cheat[i].number < cheat[discardIdx].number) discardIdx = i;
        }
      }
      if (discardIdx >= 0 && last.hints < last.maxHints) {
        busy = true;
        setTimeout(() => { busy = false; send({ type: 'hn_discard', cardIndex: discardIdx }); }, thinkDelay(900));
        return;
      }
      // 3) 提示：选一位队友，提示其手里可上堆牌的数字（找不到则提示第一张牌的数字）
      if (last.hints <= 0) return;
      const others = (last.players || []).filter(p => p.id !== botId);
      if (!others.length) return;
      const target = others[0];
      const othersHands = (last.othersHands || {})[target.id] || [];
      let hintNum = null;
      for (const c of othersHands) {
        if (c.number === (last.piles[c.color] || 0) + 1) { hintNum = c.number; break; }
      }
      if (hintNum == null && othersHands.length) hintNum = othersHands[0].number;
      if (hintNum == null) return;
      busy = true;
      setTimeout(() => {
        busy = false;
        send({ type: 'hn_hint', targetId: target.id, kind: 'number', value: hintNum });
      }, thinkDelay(1000));
    }

    return function onData(msg) {
      if (!msg || !msg.type) return;
      if (msg.type === 'hn_cheat') { cheat = msg.hand || []; tryAct(); return; }
      if (msg.type === 'hn_view') {
        if (!last) last = {};
        last.othersHands = {};
        (msg.others || []).forEach(o => { last.othersHands[o.id] = o.hand; });
        tryAct();
        return;
      }
      if (msg.type !== 'hn_state') return;
      last = msg;
      tryAct();
    };
  }

  // ---------- 雷霆战机 Thunder ----------
  // AI 队友：朝最近的敌机/Boss 靠近，躲避敌弹与激光预警红线，自动开火（主机处理射击）。
  function thunderBrain(botId, send) {
    let last = null;
    let myShip = null;
    let interval = null;

    function decide() {
      if (!last || last.phase !== 'playing' || !myShip) return;
      const ship = last.ships[myShip];
      if (!ship || !ship.alive) return;
      const x = ship.x, y = ship.y;

      // 目标点：默认屏幕中下方；有敌机则瞄向最近的敌机，有 Boss 则瞄 Boss
      let tx = x, ty = H_DEFAULT;
      let nearestE = null, bestD = Infinity;
      for (const e of (last.enemies || [])) {
        const d = Math.hypot(e.x - x, e.y - y);
        if (d < bestD) { bestD = d; nearestE = e; }
      }
      if (nearestE) { tx = nearestE.x; ty = y; }
      if (last.boss) { tx = last.boss.x; ty = y; }

      let evadeX = 0, evadeY = 0;

      // 躲避敌弹
      let nearestB = null; bestD = Infinity;
      for (const b of (last.enemyBullets || [])) {
        if (b.y < y && y - b.y < 220) {
          const d = Math.hypot(b.x - x, b.y - y);
          if (d < bestD) { bestD = d; nearestB = b; }
        }
      }
      if (nearestB && bestD < 140) {
        evadeX = nearestB.x > x ? -1 : 1;
        evadeY = nearestB.y > y ? -0.4 : 0.3;
      }

      // 躲避 Boss 激光预警红线：激光从 Boss 指向战机，横向避开射线
      for (const L of (last.lasers || [])) {
        if (L.state !== 'warn') continue;
        // 射线角度，计算战机到射线的垂直距离
        const dx = x - L.x, dy = y - L.y;
        const perp = Math.abs(-dx * Math.sin(L.angle) + dy * Math.cos(L.angle));
        if (perp < L.width + 40) {
          // 在射线附近，横向逃离
          const side = -dx * Math.sin(L.angle) + dy * Math.cos(L.angle);
          evadeX = side >= 0 ? 1 : -1;
          evadeY = -0.3;
        }
      }

      let dirX = 0, dirY = 0;
      if (evadeX || evadeY) { dirX = evadeX; dirY = evadeY; }
      else if (Math.abs(tx - x) > 24) dirX = tx > x ? 1 : -1;

      // 归一化（主机也会归一化，这里保持简洁）
      const dir = { x: dirX, y: dirY };
      send({ type: 'th_input', dir });
    }

    return function onData(msg) {
      if (!msg || !msg.type) return;
      if (msg.type === 'th_assign') { myShip = msg.ship; return; }
      if (msg.type === 'th_state') {
        last = msg;
        if (!interval) interval = setInterval(decide, 120);
        return;
      }
    };
  }

  const H_DEFAULT = 600; // AI 默认悬停高度（约屏幕中下）

  // ---------- 染·钟楼谜团 BotC ----------
  // 简单 AI：夜晚按夜警选择随机目标；白天随机发言、随机提名、随机投票。
  function botcBrain(botId, send) {
    let role = null;
    let busy = false;
    function think(payload, ms) {
      busy = true;
      setTimeout(() => { busy = false; send(payload); }, thinkDelay(ms));
    }
    function randOf(a) { return a[Math.floor(Math.random() * a.length)]; }
    return function onData(msg) {
      if (!msg || !msg.type) return;
      if (msg.type === 'botc_role') { role = msg.role; return; }
      if (msg.type === 'botc_night' && !busy) {
        const step = msg.step || {};
        const opts = step.options || [];
        if (!opts.length) return;
        if (step.action === 'fortune') {
          const a = randOf(opts), b = randOf(opts);
          think({ type: 'botc_action', action: 'fortune', a: a.id, b: b.id }, 700);
        } else if (step.action === 'poison' || step.action === 'kill') {
          const t = randOf(opts);
          think({ type: 'botc_action', action: step.action, target: t.id }, 600);
        }
        return;
      }
      if (msg.type === 'botc_state' && msg.phase === 'day' && !msg.winner) {
        const me = (msg.players || []).find(p => p.id === botId);
        if (!me || !me.alive) return;
        if (msg.currentNom) {
          if (!me.voted && !busy) think({ type: 'botc_vote', yes: Math.random() < 0.5 }, 500);
        } else if (!busy) {
          const r = Math.random();
          if (r < 0.12) {
            const lines = ['我觉得可疑。', '有线索吗？', '我没什么信息。', '先观察看看。', '有人说说夜晚情况吗？'];
            think({ type: 'botc_chat', text: randOf(lines) }, 800);
          } else if (r < 0.4) {
            const others = (msg.players || []).filter(p => p.id !== botId && p.alive);
            if (others.length) think({ type: 'botc_nominate', target: randOf(others).id }, 700);
          }
        }
      }
    };
  }

  const GAME_BRAINS = {
    oldmaid: oldMaidBrain,
    blackjack: blackjackBrain,
    uno: unoBrain,
    poison: poisonBrain,
    werewolf: werewolfBrain,
    cabo: caboBrain,
    horserace: horseRaceBrain,
    ludo: ludoBrain,
    loveletter: loveLetterBrain,
    taket6: takeT6Brain,
    bubble_coop: bubbleCoopBrain,
    // 注意：这里登记的每个 brain 必须在本文件里有对应实现，
    // 否则引用未定义标识符会让整个 Bot 模块初始化失败（所有人机玩法一起失效）。
    explodingkittens: explodingKittensBrain,
    seasaltpaper: seaSaltPaperBrain,
    flip7: flip7Brain,
    thecrew: crewBrain,
    hanabi: hanabiBrain,
    thunder: thunderBrain,
    avalon: avalonBrain,
    secrethitler: secretHitlerBrain,
    saboteur: saboteurBrain,
    botc: botcBrain,
  };

  return { create, nameFor, avatarFor };
})();
window.Bot = Bot;
