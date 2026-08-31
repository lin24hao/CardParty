// 牌堆工具
const Deck = (() => {
  const suits = ['♠', '♥', '♦', '♣'];
  const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const isRed = (suit) => suit === '♥' || suit === '♦';

  function makeDeck() {
    const cards = [];
    for (const suit of suits) {
      for (const rank of ranks) {
        cards.push({ suit, rank });
      }
    }
    return cards;
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // 点数：A=1 ... K=13
  function rankValue(rank) { return ranks.indexOf(rank) + 1; }

  function cardId(c) { return c.suit + c.rank; }

  // 21 点牌值：返回最佳(最大且不爆)的点数
  function blackjackValue(cards) {
    let total = 0, aces = 0;
    for (const c of cards) {
      const rv = rankValue(c.rank);
      if (rv === 1) { aces++; total += 11; }
      else if (rv >= 10) total += 10;
      else total += rv;
    }
    while (total > 21 && aces > 0) { total -= 10; aces--; }
    return total;
  }

  return { suits, ranks, isRed, makeDeck, shuffle, rankValue, cardId, blackjackValue };
})();
