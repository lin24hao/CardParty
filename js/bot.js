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

  const GAME_BRAINS = {
    oldmaid: oldMaidBrain,
    blackjack: blackjackBrain,
    uno: unoBrain,
    poison: poisonBrain,
    werewolf: werewolfBrain,
    cabo: caboBrain,
    horserace: horseRaceBrain,
  };

  return { create, nameFor, avatarFor };
})();
