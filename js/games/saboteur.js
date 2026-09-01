// 矮人矿坑 Saboteur —— 主机权威 · 路径铺设 · 好矮人挖金 vs 坏矮人破坏
// 规则：3-10 人。随机分配好矮人（挖金者）与坏矮人（破坏者，互相认识）。
// 棋盘 7x6：底部 3 个起点，顶部 3 张金矿牌（1 真 2 假，面朝下）。
// 轮流抽 1 张牌 → 放 1 张路径牌（直/弯/三通/十字/死路，可旋转，须与邻牌接口连通）
// 或用工具牌（破坏/修理/地图）干扰，或弃牌。
// 好矮人将起点路径连通到真金矿 → 好人各 +2 金块；牌堆耗尽仍未连通 → 坏人各 +4 金块。
// 消息：sb_state（公开棋盘）/ sb_hand（私有手牌）/ sb_play（放牌）/
// sb_tool（工具）/ sb_discard（弃牌）/ sb_peek（私发地图结果）。
const Saboteur = (() => {
  let ctx = null;
  let state = null;
  let mirror = null;
  let myHand = [];     // 私有手牌 [{type, base}] base 为基准接口字符串
  let myTeam = null;   // 'good' | 'bad'
  let myBads = [];     // 坏矮人同伙
  let localPos = null; // 本地选中的落点 {x,y,rot,cardIdx}
  let epoch = 0;

  const W = 7, H = 6;
  // 基准牌型：接口顺序 N,E,S,W
  const PATH_BASE = {
    'I':  '1010', // 直通（上下）
    'I2': '0101', // 直通（左右）
    'L1': '1100', // 弯 N-E
    'L2': '0110', // 弯 E-S
    'L3': '0011', // 弯 S-W
    'L4': '1001', // 弯 W-N
    'T1': '1110', // 三通 N-E-S
    'T2': '0111', // 三通 E-S-W
    'T3': '1011', // 三通 S-W-N
    'T4': '1101', // 三通 W-N-E
    'X':  '1111', // 十字
    'D1': '1000', // 死路 N
    'D2': '0100', // 死路 E
    'D3': '0010', // 死路 S
    'D4': '0001', // 死路 W
  };
  // 牌组：简化 40 张
  function makeDeck() {
    const d = [];
    for (let i = 0; i < 3; i++) d.push({ type: 'I' });
    for (let i = 0; i < 3; i++) d.push({ type: 'I2' });
    for (let i = 0; i < 3; i++) { d.push({ type: 'L1' }); d.push({ type: 'L2' }); d.push({ type: 'L3' }); d.push({ type: 'L4' }); }
    for (let i = 0; i < 2; i++) { d.push({ type: 'T1' }); d.push({ type: 'T2' }); d.push({ type: 'T3' }); d.push({ type: 'T4' }); }
    for (let i = 0; i < 2; i++) d.push({ type: 'X' });
    d.push({ type: 'D1' }); d.push({ type: 'D2' }); d.push({ type: 'D3' }); d.push({ type: 'D4' });
    // 工具牌
    d.push({ type: 'broken' }); d.push({ type: 'broken' });
    d.push({ type: 'repair' }); d.push({ type: 'repair' });
    d.push({ type: 'map' }); d.push({ type: 'map' });
    return Deck.shuffle(d);
  }
  function rotate(inter, n) {
    n = ((n % 4) + 4) % 4;
    if (n === 0) return inter;
    return inter.slice(n) + inter.slice(0, n);
  }
  function cardInter(card, rot) { return rotate(PATH_BASE[card.type] || '0000', rot); }

  function badCount(n) { return n <= 4 ? 1 : n <= 7 ? 2 : 3; }

  function hostStart() {
    epoch++;
    const n = ctx.players.length;
    const bad = badCount(n);
    const teams = [];
    for (let i = 0; i < bad; i++) teams.push('bad');
    while (teams.length < n) teams.push('good');
    Deck.shuffle(teams);
    const deck = makeDeck();
    const players = ctx.players.map((p, i) => ({
      id: p.id, name: p.name, isHost: p.isHost, isBot: p.isBot, team: teams[i], broken: false,
    }));
    // 起点（y=0, x=2,3,4）与金矿（y=5, x=2,3,4）
    const board = {};
    board['2,0'] = { x: 2, y: 0, kind: 'start', rot: 0 };
    board['3,0'] = { x: 3, y: 0, kind: 'start', rot: 0 };
    board['4,0'] = { x: 4, y: 0, kind: 'start', rot: 0 };
    const golds = Deck.shuffle([true, false, false]);
    board['2,5'] = { x: 2, y: 5, kind: 'gold', rot: 0, gold: golds[0], revealed: false };
    board['3,5'] = { x: 3, y: 5, kind: 'gold', rot: 0, gold: golds[1], revealed: false };
    board['4,5'] = { x: 4, y: 5, kind: 'gold', rot: 0, gold: golds[2], revealed: false };
    state = {
      players, deck, board, currentIdx: 0, phase: 'playing',
      action: '', log: [], winnerIds: [], goldsFound: null, bads: bad,
    };
    // 每人发 6 张手牌
    state.hands = {};
    players.forEach(p => {
      const h = [];
      for (let i = 0; i < 6; i++) h.push(deck.pop());
      state.hands[p.id] = h;
    });
    // 私发身份与手牌
    for (const p of players) {
      const bads = players.filter(q => q.team === 'bad').map(q => q.id);
      if (p.id === Net.myId()) { myTeam = p.team; myBads = p.team === 'bad' ? bads.filter(id => id !== p.id) : []; }
      else Net.sendTo(p.id, { type: 'sb_role', team: p.team, bads: p.team === 'bad' ? bads.filter(id => id !== p.id) : [] });
    }
    state.action = '游戏开始！' + players[0].name + ' 先行动（抽牌后放路径/用工具/弃牌）';
    pushState();
    pushHands();
    render();
  }

  function currentPlayer() { return state.players[state.currentIdx]; }

  function drawFor(p) {
    if (state.deck.length > 0) state.hands[p.id].push(state.deck.pop());
  }

  function key(x, y) { return x + ',' + y; }

  // 检查某格放牌后是否与所有已有邻居接口匹配
  function canPlace(inter, x, y) {
    if (x < 0 || x >= W || y < 0 || y >= H) return false;
    if (state.board[key(x, y)]) return false;
    const dirs = [[0,-1,0],[1,0,1],[0,1,2],[-1,0,3]]; // dx,dy,myDir
    let hasNeighbor = false;
    for (const [dx, dy, d] of dirs) {
      const nb = state.board[key(x + dx, y + dy)];
      if (!nb) continue;
      hasNeighbor = true;
      const myBit = inter[d] === '1';
      let nInter;
      if (nb.kind === 'start') nInter = '0010'; // 起点在顶部(y=0)，朝下连通棋盘（S）
      else if (nb.kind === 'gold') nInter = '1000'; // 金矿在底部(y=H-1)，朝上连通棋盘（N）
      else nInter = cardInter(nb, nb.rot || 0);
      // 邻居朝本格方向 = 相对邻居的反方向
      const oppDir = (d + 2) % 4;
      const nbBit = nInter[oppDir] === '1';
      if (myBit !== nbBit) return false;
    }
    return hasNeighbor;
  }

  // BFS 从起点寻找连通
  function findConnected() {
    const visited = {};
    const queue = [];
    for (const k of Object.keys(state.board)) {
      const cell = state.board[k];
      if (cell.kind === 'start') { visited[k] = true; queue.push(k); }
    }
    while (queue.length) {
      const k = queue.shift();
      const cell = state.board[k];
      const inter = cell.kind === 'start' ? '0010' : cell.kind === 'gold' ? '1000' : cardInter(cell, cell.rot || 0);
      const dirs = [[0,-1,0],[1,0,1],[0,1,2],[-1,0,3]];
      for (const [dx, dy, d] of dirs) {
        if (inter[d] !== '1') continue;
        const nk = key(cell.x + dx, cell.y + dy);
        if (!state.board[nk] || visited[nk]) continue;
        const nb = state.board[nk];
        const nInter = nb.kind === 'start' ? '0010' : nb.kind === 'gold' ? '1000' : cardInter(nb, nb.rot || 0);
        if (nInter[(d + 2) % 4] === '1') { visited[nk] = true; queue.push(nk); }
      }
    }
    return Object.keys(visited).filter(k => state.board[k].kind === 'gold');
  }

  function tryWinFromGold(goldCell) {
    const connected = findConnected();
    const reached = connected.find(k => state.board[k] === goldCell);
    if (!reached) return false;
    // 揭示金矿
    goldCell.revealed = true;
    if (goldCell.gold) {
      state.phase = 'ended';
      state.goldsFound = goldCell;
      state.winnerIds = state.players.filter(p => p.team === 'good').map(p => p.id);
      state.action = '💰 好矮人挖到金矿！好矮人阵营获胜（每人 +2 金块）';
    } else {
      state.log.push('金矿是假的！继续挖掘');
      goldCell.revealed = false;
    }
    return goldCell.gold;
  }

  function submitPlay(fromId, cardIdx, x, y, rot) {
    if (!state || state.phase !== 'playing') return;
    if (fromId !== currentPlayer().id) return;
    const p = currentPlayer();
    if (p.broken) { UI.toast('你的工具被破坏了，本回合无法行动'); return; }
    const hand = state.hands[fromId];
    if (!hand || cardIdx < 0 || cardIdx >= hand.length) return;
    const card = hand[cardIdx];
    if (!PATH_BASE[card.type]) { UI.toast('这不是路径牌'); return; }
    const inter = cardInter(card, rot);
    if (!canPlace(inter, x, y)) { UI.toast('无法在此放置路径牌（接口不匹配）'); return; }
    hand.splice(cardIdx, 1);
    state.board[key(x, y)] = { x, y, kind: 'path', type: card.type, rot };
    state.log.push(p.name + ' 在 (' + x + ',' + (H - 1 - y) + ') 放置了路径牌');
    // 检查是否连通金矿
    const connected = findConnected();
    const goldReached = connected.map(k => state.board[k]).find(c => c.kind === 'gold');
    if (goldReached) {
      goldReached.revealed = true;
      if (goldReached.gold) {
        state.phase = 'ended';
        state.goldsFound = goldReached;
        state.winnerIds = state.players.filter(q => q.team === 'good').map(q => q.id);
        state.action = '💰 ' + p.name + ' 打通矿道，好矮人挖到金矿！好人阵营获胜';
        pushState(); pushHands(); render(); return;
      }
      state.log.push('到达金矿，可惜是假的！');
      goldReached.revealed = false;
    }
    nextTurn(p);
  }

  function submitTool(fromId, toolIdx, targetId) {
    if (!state || state.phase !== 'playing') return;
    if (fromId !== currentPlayer().id) return;
    const p = currentPlayer();
    if (p.broken) { UI.toast('你的工具被破坏了，本回合无法行动'); return; }
    const hand = state.hands[fromId];
    if (!hand || toolIdx < 0 || toolIdx >= hand.length) return;
    const card = hand[toolIdx];
    if (card.type === 'broken') {
      const t = state.players.find(q => q.id === targetId);
      if (!t) return;
      t.broken = true;
      hand.splice(toolIdx, 1);
      state.log.push(p.name + ' 使用破坏工具，' + t.name + ' 下回合无法行动');
      nextTurn(p);
      return;
    }
    if (card.type === 'repair') {
      const t = state.players.find(q => q.id === targetId);
      if (!t) { UI.toast('请选择目标'); return; }
      if (!t.broken) { UI.toast('目标未被破坏'); return; }
      t.broken = false;
      hand.splice(toolIdx, 1);
      state.log.push(p.name + ' 修理了 ' + t.name + ' 的工具');
      nextTurn(p);
      return;
    }
    if (card.type === 'map') {
      const golds = Object.values(state.board).filter(c => c.kind === 'gold');
      const pick = golds[Math.floor(Math.random() * golds.length)];
      pick.revealed = true;
      hand.splice(toolIdx, 1);
      state.log.push(p.name + ' 使用地图查看了金矿');
      if (fromId === Net.myId()) { /* 本地直接展示 */ }
      else Net.sendTo(fromId, { type: 'sb_peek', gold: pick.gold, x: pick.x, y: pick.y });
      state.log.push('（地图结果私密告知' + p.name + '）');
      nextTurn(p);
      return;
    }
    UI.toast('这不是工具牌');
  }

  function submitDiscard(fromId, cardIdx) {
    if (!state || state.phase !== 'playing') return;
    if (fromId !== currentPlayer().id) return;
    // cardIdx === -1 表示被破坏的玩家跳过回合
    if (cardIdx === -1) {
      if (!currentPlayer().broken) return;
      state.log.push(currentPlayer().name + ' 工具被破坏，跳过本回合');
      nextTurn(currentPlayer());
      return;
    }
    const hand = state.hands[fromId];
    if (!hand || cardIdx < 0 || cardIdx >= hand.length) return;
    hand.splice(cardIdx, 1);
    state.log.push(currentPlayer().name + ' 弃掉了一张牌');
    nextTurn(currentPlayer());
  }

  function nextTurn(p) {
    const broken = p.broken;
    p.broken = false; // 破坏只影响一个行动回合
    const nextIdx = (state.currentIdx + 1) % state.players.length;
    const np = state.players[nextIdx];
    state.currentIdx = nextIdx;
    drawFor(np);
    if (state.deck.length === 0) {
      // 牌堆耗尽：好人无法再推进 → 坏矮人胜（若尚未连通真金矿）
      const connected = findConnected();
      const goldReached = connected.map(k => state.board[k]).find(c => c.kind === 'gold' && c.gold);
      if (!goldReached) {
        state.phase = 'ended';
        state.winnerIds = state.players.filter(q => q.team === 'bad').map(q => q.id);
        state.action = '⛏️ 牌堆耗尽仍未挖到金矿，坏矮人获胜（每人 +4 金块）';
        pushState(); pushHands(); render(); return;
      }
    }
    state.action = '轮到 ' + np.name + ' 行动' + (np.broken ? '（工具被破坏，本回合无法行动）' : '');
    pushState(); pushHands(); render();
  }

  function pushState() {
    // 广播公开状态
    Net.broadcast({
      type: 'sb_state',
      board: Object.values(state.board).map(c => ({ x: c.x, y: c.y, kind: c.kind, type: c.type || null, rot: c.rot || 0, revealed: !!c.revealed, gold: c.revealed ? !!c.gold : null })),
      players: state.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost, isBot: p.isBot, broken: p.broken })),
      currentIdx: state.currentIdx, phase: state.phase, deckCount: state.deck.length,
      bads: state.bads, action: state.action, log: state.log.slice(-8),
      winnerIds: state.winnerIds, goldsFound: state.goldsFound ? { x: state.goldsFound.x, y: state.goldsFound.y } : null,
    });
  }

  function pushHands() {
    for (const p of state.players) {
      const hand = state.hands[p.id];
      if (p.id === Net.myId()) { myHand = hand.slice(); }
      else Net.sendTo(p.id, { type: 'sb_hand', hand });
    }
  }

  function handleMessage(from, data) {
    if (!data || !data.type) return;
    if (ctx.isHost) {
      if (data.type === 'sb_play') submitPlay(from, data.cardIdx, data.x, data.y, data.rot);
      else if (data.type === 'sb_tool') submitTool(from, data.toolIdx, data.targetId);
      else if (data.type === 'sb_discard') submitDiscard(from, data.cardIdx);
      return;
    }
    if (data.type === 'sb_role') { myTeam = data.team; myBads = data.bads || []; render(); return; }
    if (data.type === 'sb_hand') { myHand = data.hand || []; render(); return; }
    if (data.type === 'sb_peek') { state = state || {}; state.peekedGold = data; render(); return; }
    if (data.type === 'sb_state') { mirror = data; render(); }
  }

  // ---------- 视图 ----------
  function render() {
    if (!ctx) return;
    const c = ctx.container;
    UI.clear(c);
    const v = view();
    if (ctx.isHost && state) v.players = state.players;
    // 身份条
    const bar = document.createElement('div');
    bar.className = 'sb-rolebar';
    bar.textContent = myTeam === 'bad' ? '我是坏矮人（破坏者）' : '我是好矮人（挖金者）';
    c.appendChild(bar);
    if (myBads && myBads.length) {
      const see = document.createElement('div');
      see.className = 'sb-see';
      see.textContent = '坏矮人同伙：' + myBads.map(id => (v.players || []).find(p => p.id === id)?.name || id).join('、');
      c.appendChild(see);
    }
    // 地图私发结果
    if (state && state.peekedGold && !ctx.isHost) {
      const pk = document.createElement('div');
      pk.className = 'sb-peek';
      const g = state.peekedGold;
      pk.textContent = '地图查看：金矿(' + g.x + ',' + (H - 1 - g.y) + ') 是' + (g.gold ? '真金矿💰' : '假金矿');
      c.appendChild(pk);
    }
    // 信息栏
    const meta = document.createElement('div');
    meta.className = 'sb-meta';
    meta.textContent = '牌堆剩余 ' + (v.deckCount || 0) + ' 张 · 坏矮人 ' + (v.bads || 0) + ' 人';
    c.appendChild(meta);
    // 棋盘
    const board = document.createElement('div');
    board.className = 'sb-board';
    const cells = {};
    (v.board || []).forEach(cell => { cells[cell.x + ',' + cell.y] = cell; });
    for (let y = 0; y < H; y++) {
      const row = document.createElement('div');
      row.className = 'sb-row';
      for (let x = 0; x < W; x++) {
        const cell = cells[x + ',' + y];
        const el = document.createElement('div');
        el.className = 'sb-cell' + (cell ? ' sb-has' : '');
        if (cell) {
          if (cell.kind === 'start') { el.textContent = '🚪'; el.classList.add('sb-start'); }
          else if (cell.kind === 'gold') {
            el.classList.add('sb-gold');
            el.textContent = cell.revealed ? (cell.gold ? '💰' : '❌') : '🪙';
          } else if (cell.kind === 'path') {
            el.textContent = pathGlyph(cell.type);
            el.classList.add('sb-path');
          }
        } else if (v.phase === 'playing') {
          el.classList.add('sb-empty');
          el.onclick = () => { localPos = { x, y }; render(); };
        }
        row.appendChild(el);
      }
      board.appendChild(row);
    }
    c.appendChild(board);
    // 行动提示
    const action = document.createElement('div');
    action.className = 'sb-action';
    action.textContent = UI.esc(v.action || '');
    c.appendChild(action);
    const myId = Net.myId();
    const me = (v.players || []).find(p => p.id === myId);
    const isTurn = v.phase === 'playing' && (v.currentIdx !== undefined) && (v.players || [])[v.currentIdx] && (v.players || [])[v.currentIdx].id === myId;
    if (isTurn && me && !me.broken) {
      // 手牌
      const handBox = document.createElement('div');
      handBox.className = 'sb-hand';
      const title = document.createElement('div');
      title.textContent = '我的手牌（点击路径牌选择，再点空格放置；工具牌直接点击使用）';
      handBox.appendChild(title);
      const row = document.createElement('div');
      row.className = 'sb-handrow';
      (myHand || []).forEach((card, i) => {
        const b = document.createElement('button');
        b.className = 'sb-card' + (localPos && localPos.cardIdx === i ? ' on' : '');
        if (PATH_BASE[card.type]) b.textContent = pathGlyph(card.type);
        else if (card.type === 'broken') b.textContent = '🔨破坏';
        else if (card.type === 'repair') b.textContent = '🔧修理';
        else if (card.type === 'map') b.textContent = '🗺️地图';
        b.onclick = () => {
          if (PATH_BASE[card.type]) {
            if (localPos && localPos.cardIdx === i) { localPos = null; render(); return; }
            localPos = { cardIdx: i, x: -1, y: -1 };
            render();
          } else {
            // 工具：选择目标
            if (card.type === 'broken' || card.type === 'repair') {
              const targets = (v.players || []).filter(p => p.id !== myId);
              const tid = targets.length ? targets[0].id : null;
              if (tid) { if (ctx.isHost) submitTool(myId, i, tid); else Net.sendToHost({ type: 'sb_tool', toolIdx: i, targetId: tid }); }
            } else if (card.type === 'map') {
              if (ctx.isHost) submitTool(myId, i, null); else Net.sendToHost({ type: 'sb_tool', toolIdx: i, targetId: null });
            }
          }
        };
        row.appendChild(b);
      });
      handBox.appendChild(row);
      // 旋转与放置
      if (localPos && localPos.cardIdx !== undefined && localPos.x >= 0) {
        const bar2 = document.createElement('div');
        bar2.className = 'sb-rotbar';
        bar2.textContent = '放置到 (' + localPos.x + ',' + (H - 1 - localPos.y) + ')';
        const rotBtn = document.createElement('button');
        rotBtn.className = 'sb-btn';
        rotBtn.textContent = '旋转';
        rotBtn.onclick = () => {
          const cur = localPos;
          const card = myHand[cur.cardIdx];
          let rot = (cur.rot || 0) + 1;
          // 找下一个合法旋转
          for (let k = 0; k < 4; k++) {
            const inter = cardInter(card, (cur.rot || 0) + 1 + k);
            if (canPlace(inter, cur.x, cur.y)) { rot = (cur.rot || 0) + 1 + k; break; }
          }
          localPos = { ...cur, rot };
          render();
        };
        const ok = document.createElement('button');
        ok.className = 'sb-btn sb-btn-ok';
        ok.textContent = '放置';
        ok.onclick = () => {
          const cur = localPos;
          if (ctx.isHost) submitPlay(myId, cur.cardIdx, cur.x, cur.y, cur.rot || 0);
          else Net.sendToHost({ type: 'sb_play', cardIdx: cur.cardIdx, x: cur.x, y: cur.y, rot: cur.rot || 0 });
          localPos = null;
        };
        const cancel = document.createElement('button');
        cancel.className = 'sb-btn';
        cancel.textContent = '取消';
        cancel.onclick = () => { localPos = null; render(); };
        bar2.appendChild(rotBtn); bar2.appendChild(ok); bar2.appendChild(cancel);
        c.appendChild(bar2);
      } else if (localPos && localPos.cardIdx !== undefined) {
        const tip = document.createElement('div');
        tip.className = 'sb-tip';
        tip.textContent = '请在棋盘上点击一个空格放置路径牌';
        c.appendChild(tip);
      }
      // 弃牌
      const discardBtn = document.createElement('button');
      discardBtn.className = 'sb-btn sb-discard';
      discardBtn.textContent = '弃掉一张牌';
      discardBtn.onclick = () => {
        if (!myHand.length) return;
        if (ctx.isHost) submitDiscard(myId, 0);
        else Net.sendToHost({ type: 'sb_discard', cardIdx: 0 });
        localPos = null;
      };
      handBox.appendChild(discardBtn);
      c.appendChild(handBox);
    } else if (isTurn && me && me.broken) {
      const tip = document.createElement('div');
      tip.className = 'sb-tip';
      tip.textContent = '你的工具被破坏，本回合自动跳过（点击跳过）';
      const skip = document.createElement('button');
      skip.className = 'sb-btn';
      skip.textContent = '跳过回合';
      skip.onclick = () => { if (ctx.isHost) nextTurn(me); else Net.sendToHost({ type: 'sb_discard', cardIdx: -1 }); };
      c.appendChild(tip); c.appendChild(skip);
    }
    // 日志
    if (v.log && v.log.length) {
      const lg = document.createElement('div');
      lg.className = 'sb-log';
      v.log.forEach(l => { const d = document.createElement('div'); d.textContent = l; lg.appendChild(d); });
      c.appendChild(lg);
    }
    // 终局
    if (v.phase === 'ended' && v.winnerIds && v.winnerIds.length) {
      const w = document.createElement('div');
      w.className = 'sb-end';
      const goodWin = v.winnerIds.some(id => (v.players || []).find(p => p.id === id) && state && state.players.find(p => p.id === id)?.team === 'good');
      w.textContent = '🏆 ' + (goodWin ? '好矮人' : '坏矮人') + '获胜！';
      c.appendChild(w);
      if (ctx.isHost && state) {
        const reveal = document.createElement('div');
        reveal.className = 'sb-see';
        reveal.textContent = '身份揭晓：' + state.players.map(p => p.name + (p.team === 'bad' ? '(坏)' : '(好)')).join('、');
        c.appendChild(reveal);
      }
    }
  }

  function pathGlyph(type) {
    const m = {
      'I': '│', 'I2': '─', 'L1': '└', 'L2': '┌', 'L3': '┐', 'L4': '┘',
      'T1': '├', 'T2': '┬', 'T3': '┤', 'T4': '┴', 'X': '┼',
      'D1': '╵', 'D2': '╴', 'D3': '╷', 'D4': '╶',
    };
    return m[type] || '·';
  }

  function view() {
    if (ctx.isHost) {
      return {
        type: 'sb_state',
        board: Object.values(state.board).map(c => ({ x: c.x, y: c.y, kind: c.kind, type: c.type || null, rot: c.rot || 0, revealed: !!c.revealed, gold: c.revealed ? !!c.gold : null })),
        players: state.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost, isBot: p.isBot, broken: p.broken })),
        currentIdx: state.currentIdx, phase: state.phase, deckCount: state.deck.length,
        bads: state.bads, action: state.action, log: state.log.slice(-8),
        winnerIds: state.winnerIds, goldsFound: state.goldsFound ? { x: state.goldsFound.x, y: state.goldsFound.y } : null,
      };
    }
    return mirror;
  }

  return { init: function(c) {
      ctx = c;
      state = null; mirror = null; myHand = []; myTeam = null; myBads = []; localPos = null;
      if (ctx.isHost) hostStart();
      else render();
    }, handleMessage };
})();
