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

  const GAME_BRAINS = {
    oldmaid: oldMaidBrain,
    blackjack: blackjackBrain,
  };

  return { create, nameFor, avatarFor };
})();
