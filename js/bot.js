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
  function oldMaidBrain(botId, send) {
    let last = null;      // 最近一次公开状态
    let pending = false;  // 是否已经在“思考”中，避免同一回合重复出牌

    return function onData(msg) {
      if (!msg || !msg.type) return;
      if (msg.type === 'om_state') last = msg;
      if (msg.type !== 'om_state') return;
      if (!last || last.phase !== 'playing' || last.turnId !== botId) return;
      if (pending) return;
      pending = true;
      setTimeout(() => {
        pending = false;
        if (!last || last.phase !== 'playing' || last.turnId !== botId) return;
        send({ type: 'om_draw' });
      }, thinkDelay(1000));
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
