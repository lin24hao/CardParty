// 秘密希特勒 Secret Hitler —— 主机权威 · 阵营隐藏 · 总统链与政策牌
// 规则：5-10 人。法西斯（含希特勒）vs 自由两大阵营。
// 随机总统链：总统提名首相 → 全员投票 → 通过后总统抽 3 张政策牌，
// 秘密弃 1 张、给首相 2 张，首相选 1 张执行、弃 1 张；被否决则换下一任总统。
// 连续 3 次选举失败 → 强制启用牌堆顶政策。
// 法西斯政策执行 3 张后总统获得暗杀权：暗杀希特勒（指对法西斯胜，指错自由胜）；
// 执行 6 张法西斯政策法西斯胜；执行 3 张自由政策自由胜；牌堆耗尽时按自由政策数判定。
// 消息：sh_state（公开）/ sh_role（角色与同伙私发）/ sh_nominate（提名）/
// sh_vote（选举投票）/ sh_president（总统弃牌）/ sh_chancellor（首相执行）/
// sh_pick（指定下任总统）/ sh_assassinate（暗杀）。
const SecretHitler = (() => {
  let ctx = null;
  let state = null;
  let mirror = null;
  let myRole = null;      // 'liberal' | 'fascist' | 'hitler'
  let myFascists = [];    // 法西斯同伙（希特勒与普通法西斯互相认识，自由不知）
  let localChoice = null; // 本地选择
  let epoch = 0;

  const FASCIST_COUNT = { 5: 2, 6: 3, 7: 3, 8: 4, 9: 4, 10: 5 };
  const ROLE_INFO = {
    liberal: { name: '自由派', team: 'liberal', icon: '🕊️', desc: '好人，目标通过 3 张自由政策' },
    fascist: { name: '法西斯', team: 'fascist', icon: '⚫', desc: '坏人，目标通过 6 张法西斯政策' },
    hitler:  { name: '希特勒', team: 'fascist', icon: '☠️', desc: '法西斯首领，被暗杀则法西斯失败' },
  };

  function roleName(r) { return ROLE_INFO[r] ? ROLE_INFO[r].name : r; }

  function assignRoles(n) {
    const fas = FASCIST_COUNT[n] || 3;
    const roles = [];
    roles.push('hitler');
    while (roles.length < fas) roles.push('fascist');
    while (roles.length < n) roles.push('liberal');
    return Deck.shuffle(roles);
  }

  function hostStart() {
    epoch++;
    const n = ctx.players.length;
    const roles = assignRoles(n);
    const players = ctx.players.map((p, i) => ({
      id: p.id, name: p.name, isHost: p.isHost, isBot: p.isBot, role: roles[i],
      team: ROLE_INFO[roles[i]].team,
    }));
    const deck = Deck.shuffle(['lib','lib','lib','lib','lib','lib','fas','fas','fas','fas','fas','fas','fas','fas','fas','fas','fas']);
    state = {
      players, deck, discard: [],
      liberalPolicies: 0, fascistPolicies: 0,
      presidentIdx: 0,
      phase: 'nominate', president: players[0].id, chancellor: null,
      electionFails: 0, votes: {}, voteCount: 0,
      hand3: null, hand2: null, // 总统抽的3张/给首相的2张
      track: [], // 已执行政策
      action: '', log: [], winnerIds: [], hitlerDead: false, revealRoles: false,
    };
    pushRoles();
    state.action = '游戏开始！总统 ' + players[0].name + ' 提名首相';
    pushState();
    render();
  }

  function pushRoles() {
    const fascists = state.players.filter(p => p.team === 'fascist').map(p => p.id);
    for (const p of state.players) {
      const info = { type: 'sh_role', role: p.role, roleName: roleName(p.role), team: p.team, fascists: [] };
      if (p.team === 'fascist' && p.role !== 'hitler') {
        info.fascists = fascists.filter(id => id !== p.id);
      } else if (p.role === 'hitler') {
        info.fascists = fascists.filter(id => id !== p.id);
      }
      if (p.id === Net.myId()) { myRole = p.role; myFascists = info.fascists; }
      else Net.sendTo(p.id, info);
    }
  }

  function currentPresident() { return state.players[state.presidentIdx]; }

  function advancePresident() {
    state.presidentIdx = (state.presidentIdx + 1) % state.players.length;
    state.electionFails++;
  }

  function submitNominate(fromId, targetId) {
    if (!state || state.phase !== 'nominate') return;
    if (fromId !== state.president) return;
    if (targetId === fromId) { UI.toast('不能提名自己'); return; }
    const t = state.players.find(p => p.id === targetId);
    if (!t) return;
    state.chancellor = targetId;
    state.phase = 'vote';
    state.votes = {}; state.voteCount = 0;
    state.action = '总统 ' + currentPresident().name + ' 提名 ' + t.name + ' 为首相，全员投票';
    pushState();
    render();
  }

  function submitVote(fromId, ja) {
    if (!state || state.phase !== 'vote') return;
    if (state.votes[fromId] !== undefined) return;
    state.votes[fromId] = !!ja;
    state.voteCount++;
    if (state.voteCount >= state.players.length) {
      const yes = Object.values(state.votes).filter(v => v).length;
      state.log.push('选举投票：' + yes + ' 赞成 / ' + (state.players.length - yes) + ' 反对');
      if (yes > state.players.length / 2) {
        state.electionFails = 0;
        state.phase = 'president';
        state.hand3 = state.deck.splice(0, 3);
        state.action = '选举通过！总统 ' + currentPresident().name + ' 从 3 张政策牌中秘密弃 1 张';
        pushState();
        render();
      } else {
        state.chancellor = null;
        state.action = '选举被否决！';
        advancePresident();
        if (state.electionFails >= 3) {
          state.phase = 'forced';
          const card = state.deck.pop();
          state.log.push('连续 3 次选举失败，强制执行牌堆顶政策');
          applyPolicy(card, true);
          return;
        }
        state.phase = 'nominate';
        state.action = '新总统 ' + currentPresident().name + ' 提名首相（连续否决 ' + state.electionFails + '/3）';
        pushState();
        render();
      }
    }
    pushState();
    render();
  }

  // 总统选弃牌：从 hand3 弃一张
  function submitPresident(fromId, idx) {
    if (!state || state.phase !== 'president') return;
    if (fromId !== state.president) return;
    if (!state.hand3 || idx < 0 || idx >= state.hand3.length) return;
    const card = state.hand3.splice(idx, 1)[0];
    state.discard.push(card);
    state.hand2 = state.hand3.slice();
    state.hand3 = null;
    state.phase = 'chancellor';
    state.action = '首相 ' + (state.players.find(p => p.id === state.chancellor)?.name || '') + ' 从 2 张政策牌中选择 1 张执行';
    pushState();
    render();
  }

  // 首相选执行牌
  function submitChancellor(fromId, idx) {
    if (!state || state.phase !== 'chancellor') return;
    if (fromId !== state.chancellor) return;
    if (!state.hand2 || idx < 0 || idx >= state.hand2.length) return;
    const card = state.hand2.splice(idx, 1)[0];
    const rest = state.hand2[0];
    state.discard.push(rest);
    state.hand2 = null;
    applyPolicy(card, false);
  }

  function applyPolicy(card, forced) {
    if (card === 'lib') {
      state.liberalPolicies++;
      state.track.push('lib');
      state.log.push('执行自由政策！自由政策 ' + state.liberalPolicies + '/3' + (forced ? '（强制）' : ''));
      if (state.liberalPolicies >= 3) {
        state.phase = 'ended';
        state.winnerIds = state.players.filter(p => p.team === 'liberal').map(p => p.id);
        state.action = '🕊️ 自由阵营通过 3 张自由政策，自由派获胜！';
        pushState(); render(); return;
      }
    } else {
      state.fascistPolicies++;
      state.track.push('fas');
      state.log.push('执行法西斯政策！法西斯政策 ' + state.fascistPolicies + '/6' + (forced ? '（强制）' : ''));
      if (state.fascistPolicies >= 6) {
        state.phase = 'ended';
        state.winnerIds = state.players.filter(p => p.team === 'fascist').map(p => p.id);
        state.action = '⚫ 法西斯阵营通过 6 张法西斯政策，法西斯获胜！';
        pushState(); render(); return;
      }
      // 总统权力
      if (state.fascistPolicies === 1) {
        state.phase = 'investigate';
        state.action = '⚫ 总统获得权力：查看一位玩家阵营（可选择跳过）';
        pushState(); render(); return;
      }
      if (state.fascistPolicies === 2) {
        state.phase = 'pick';
        state.action = '⚫ 总统获得权力：指定下任总统';
        pushState(); render(); return;
      }
      if (state.fascistPolicies === 3) {
        state.phase = 'assassinate';
        state.action = '⚫ 总统获得权力：暗杀一位玩家（选中国希特勒则法西斯失败）';
        pushState(); render(); return;
      }
    }
    nextRound();
  }

  function submitInvestigate(fromId, targetId) {
    if (!state || state.phase !== 'investigate') return;
    if (fromId !== state.president) return;
    const t = state.players.find(p => p.id === targetId);
    if (!t) return;
    state.investigateResult = t.id;
    state.log.push('总统调查了 ' + t.name + '（' + (t.team === 'liberal' ? '自由派' : '法西斯') + '）');
    if (t.id === Net.myId()) {
      Net.sendTo(t.id, { type: 'sh_peek', team: t.team });
    }
    state.phase = 'nominate';
    state.action = '总统调查完成，' + t.name + ' 阵营已私密告知总统。下一位总统提名';
    advancePresident();
    pushState(); render();
  }

  function submitPick(fromId, targetId) {
    if (!state || state.phase !== 'pick') return;
    if (fromId !== state.president) return;
    const t = state.players.find(p => p.id === targetId);
    if (!t) return;
    state.log.push('总统指定 ' + t.name + ' 为下任总统');
    state.presidentIdx = state.players.findIndex(p => p.id === targetId);
    state.phase = 'nominate';
    state.action = t.name + ' 成为新总统，提名首相';
    pushState(); render();
  }

  function submitAssassinate(fromId, targetId) {
    if (!state || state.phase !== 'assassinate') return;
    if (fromId !== state.president) return;
    const t = state.players.find(p => p.id === targetId);
    if (!t) return;
    state.phase = 'ended';
    if (t.role === 'hitler') {
      state.winnerIds = state.players.filter(p => p.team === 'liberal').map(p => p.id);
      state.action = '☠️ 总统暗杀了 ' + t.name + ' —— 正是希特勒！自由派获胜！';
      state.hitlerDead = true;
    } else {
      state.winnerIds = state.players.filter(p => p.team === 'fascist').map(p => p.id);
      state.action = '⚫ 总统暗杀了 ' + t.name + '，但 TA 不是希特勒！法西斯获胜！';
    }
    state.revealRoles = true;
    pushState(); render();
  }

  function nextRound() {
    if (state.deck.length === 0) {
      // 牌堆耗尽：按自由政策数判定
      state.phase = 'ended';
      if (state.liberalPolicies >= 3) {
        state.winnerIds = state.players.filter(p => p.team === 'liberal').map(p => p.id);
        state.action = '🕊️ 政策牌耗尽，自由政策 ' + state.liberalPolicies + '/3，自由派获胜！';
      } else {
        state.winnerIds = state.players.filter(p => p.team === 'fascist').map(p => p.id);
        state.action = '⚫ 政策牌耗尽，自由政策不足 3 张，法西斯获胜！';
      }
      state.revealRoles = true;
      pushState(); render(); return;
    }
    // 新总统
    advancePresident();
    state.chancellor = null;
    state.phase = 'nominate';
    state.action = '新总统 ' + currentPresident().name + ' 提名首相';
    pushState(); render();
  }

  function pushState() {
    const base = {
      type: 'sh_state',
      phase: state.phase, president: state.president, chancellor: state.chancellor,
      players: state.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost, isBot: p.isBot })),
      liberalPolicies: state.liberalPolicies, fascistPolicies: state.fascistPolicies,
      electionFails: state.electionFails, deckCount: state.deck.length,
      investigateResult: state.investigateResult || null,
      action: state.action, log: state.log.slice(-8), winnerIds: state.winnerIds,
      track: state.track, hitlerDead: state.hitlerDead, revealRoles: state.revealRoles,
    };
    Net.broadcast(base);
    // 私发当前总统/首相手中的政策牌（仅当事人可见）
    if (state.phase === 'president' && state.hand3) {
      const p = state.players.find(x => x.id === state.president);
      if (p && p.id !== Net.myId()) Net.sendTo(p.id, { type: 'sh_hand', cards: state.hand3.slice() });
    }
    if (state.phase === 'chancellor' && state.hand2) {
      const p = state.players.find(x => x.id === state.chancellor);
      if (p && p.id !== Net.myId()) Net.sendTo(p.id, { type: 'sh_hand', cards: state.hand2.slice() });
    }
  }

  function view() {
    if (ctx.isHost) {
      return {
        type: 'sh_state',
        phase: state.phase, president: state.president, chancellor: state.chancellor,
        players: state.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost, isBot: p.isBot })),
        liberalPolicies: state.liberalPolicies, fascistPolicies: state.fascistPolicies,
        electionFails: state.electionFails, deckCount: state.deck.length,
        investigateResult: state.investigateResult || null,
        action: state.action, log: state.log.slice(-8), winnerIds: state.winnerIds,
        track: state.track, hitlerDead: state.hitlerDead, revealRoles: state.revealRoles,
      };
    }
    return mirror;
  }

  function handleMessage(from, data) {
    if (!data || !data.type) return;
    if (ctx.isHost) {
      if (data.type === 'sh_nominate') submitNominate(from, data.targetId);
      else if (data.type === 'sh_vote') submitVote(from, data.ja);
      else if (data.type === 'sh_president') submitPresident(from, data.idx);
      else if (data.type === 'sh_chancellor') submitChancellor(from, data.idx);
      else if (data.type === 'sh_investigate') submitInvestigate(from, data.targetId);
      else if (data.type === 'sh_pick') submitPick(from, data.targetId);
      else if (data.type === 'sh_assassinate') submitAssassinate(from, data.targetId);
      return;
    }
    if (data.type === 'sh_role') { myRole = data.role; myFascists = data.fascists || []; render(); return; }
    if (data.type === 'sh_hand') { state = state || {}; state.myCards = data.cards || []; render(); return; }
    if (data.type === 'sh_peek') { state = state || {}; state.peeked = data.team; render(); return; }
    if (data.type === 'sh_state') { mirror = data; render(); }
  }

  // ---------- 视图 ----------
  function render() {
    if (!ctx) return;
    const c = ctx.container;
    UI.clear(c);
    const v = view();
    if (ctx.isHost && state) v.players = state.players;
    // 身份条
    const roleBar = document.createElement('div');
    roleBar.className = 'sh-rolebar';
    roleBar.textContent = '我的身份：' + roleName(myRole) + '（' + (myRole === 'liberal' ? '自由派' : '法西斯阵营') + '）';
    c.appendChild(roleBar);
    if (myFascists && myFascists.length) {
      const see = document.createElement('div');
      see.className = 'sh-see';
      see.textContent = '法西斯同伙：' + myFascists.map(id => (v.players || []).find(p => p.id === id)?.name || id).join('、');
      c.appendChild(see);
    }
    if (state && state.peeked) {
      const peek = document.createElement('div');
      peek.className = 'sh-peek';
      peek.textContent = '调查结果：' + (v.players || []).find(p => p.id === state.peeked)?.name + ' 是 ' + (state.peeked === 'liberal' ? '自由派' : '法西斯');
      c.appendChild(peek);
    }
    // 政策轨道
    const track = document.createElement('div');
    track.className = 'sh-track';
    const lib = document.createElement('span');
    lib.className = 'sh-lib';
    lib.textContent = '自由 ' + (v.liberalPolicies || 0) + '/3';
    const fas = document.createElement('span');
    fas.className = 'sh-fas';
    fas.textContent = '法西斯 ' + (v.fascistPolicies || 0) + '/6';
    track.appendChild(lib); track.appendChild(fas);
    if (v.track && v.track.length) {
      const chips = document.createElement('span');
      chips.className = 'sh-chips';
      v.track.forEach(t => { const s = document.createElement('i'); s.className = 'sh-chip ' + (t === 'lib' ? 'lib' : 'fas'); chips.appendChild(s); });
      track.appendChild(chips);
    }
    c.appendChild(track);
    // 牌堆/选举
    const meta = document.createElement('div');
    meta.className = 'sh-meta';
    meta.textContent = '政策牌堆剩余 ' + (v.deckCount || 0) + ' 张 · 连续否决 ' + (v.electionFails || 0) + '/3';
    c.appendChild(meta);
    // 玩家列表
    const list = document.createElement('div');
    list.className = 'sh-players';
    (v.players || []).forEach(p => {
      const el = UI.avatarEl(p.id, p.name);
      el.className = 'sh-p' + (p.id === v.president ? ' sh-president' : '') + (p.id === v.chancellor ? ' sh-chancellor' : '');
      list.appendChild(el);
    });
    c.appendChild(list);
    // 行动提示
    const action = document.createElement('div');
    action.className = 'sh-action';
    action.textContent = UI.esc(v.action || '');
    c.appendChild(action);
    const myId = Net.myId();
    // 提名
    if (v.phase === 'nominate' && v.president === myId) {
      const box = document.createElement('div');
      box.className = 'sh-panel';
      box.textContent = '你是总统：提名一位首相';
      const sel = document.createElement('div');
      sel.className = 'sh-choose';
      (v.players || []).forEach(p => {
        if (p.id === myId) return;
        const b = document.createElement('button');
        b.className = 'sh-opt';
        b.textContent = p.name;
        b.onclick = () => { if (ctx.isHost) submitNominate(myId, p.id); else Net.sendToHost({ type: 'sh_nominate', targetId: p.id }); };
        sel.appendChild(b);
      });
      box.appendChild(sel);
      c.appendChild(box);
    }
    // 投票
    if (v.phase === 'vote') {
      const box = document.createElement('div');
      box.className = 'sh-panel';
      box.textContent = '是否通过总统提名？';
      const yes = document.createElement('button');
      yes.className = 'sh-btn';
      yes.textContent = '赞成';
      yes.onclick = () => { if (ctx.isHost) submitVote(myId, true); else Net.sendToHost({ type: 'sh_vote', ja: true }); };
      const no = document.createElement('button');
      no.className = 'sh-btn sh-btn-no';
      no.textContent = '反对';
      no.onclick = () => { if (ctx.isHost) submitVote(myId, false); else Net.sendToHost({ type: 'sh_vote', ja: false }); };
      box.appendChild(yes); box.appendChild(no);
      c.appendChild(box);
    }
    // 总统弃牌（3张选1弃）
    if (v.phase === 'president' && v.president === myId) {
      const myCards = ctx.isHost ? (state && state.hand3) : (state && state.myCards);
      const box = document.createElement('div');
      box.className = 'sh-panel';
      box.textContent = '你是总统：弃掉 1 张政策牌';
      const cards = document.createElement('div');
      cards.className = 'sh-cards';
      (myCards || []).forEach((card, i) => {
        const b = document.createElement('button');
        b.className = 'sh-card ' + (card === 'lib' ? 'lib' : 'fas');
        b.textContent = card === 'lib' ? '自由' : '法西斯';
        b.onclick = () => { if (ctx.isHost) submitPresident(myId, i); else Net.sendToHost({ type: 'sh_president', idx: i }); };
        cards.appendChild(b);
      });
      box.appendChild(cards);
      c.appendChild(box);
    }
    // 首相选执行（2张选1）
    if (v.phase === 'chancellor' && v.chancellor === myId) {
      const myCards = ctx.isHost ? (state && state.hand2) : (state && state.myCards);
      const box = document.createElement('div');
      box.className = 'sh-panel';
      box.textContent = '你是首相：选择执行的 1 张政策牌';
      const cards = document.createElement('div');
      cards.className = 'sh-cards';
      (myCards || []).forEach((card, i) => {
        const b = document.createElement('button');
        b.className = 'sh-card ' + (card === 'lib' ? 'lib' : 'fas');
        b.textContent = card === 'lib' ? '自由' : '法西斯';
        b.onclick = () => { if (ctx.isHost) submitChancellor(myId, i); else Net.sendToHost({ type: 'sh_chancellor', idx: i }); };
        cards.appendChild(b);
      });
      box.appendChild(cards);
      c.appendChild(box);
    }
    // 调查
    if (v.phase === 'investigate' && v.president === myId) {
      const box = document.createElement('div');
      box.className = 'sh-panel';
      box.textContent = '总统权力：查看一位玩家阵营';
      const sel = document.createElement('div');
      sel.className = 'sh-choose';
      (v.players || []).forEach(p => {
        const b = document.createElement('button');
        b.className = 'sh-opt';
        b.textContent = p.name;
        b.onclick = () => { if (ctx.isHost) submitInvestigate(myId, p.id); else Net.sendToHost({ type: 'sh_investigate', targetId: p.id }); };
        sel.appendChild(b);
      });
      const skip = document.createElement('button');
      skip.className = 'sh-btn';
      skip.textContent = '跳过（不调查）';
      skip.onclick = () => {
        if (ctx.isHost) { state.phase = 'nominate'; state.action = '总统放弃调查。下一位总统提名'; advancePresident(); pushState(); render(); }
        else Net.sendToHost({ type: 'sh_investigate', targetId: null });
      };
      box.appendChild(sel); box.appendChild(skip);
      c.appendChild(box);
    }
    // 指定下任总统
    if (v.phase === 'pick' && v.president === myId) {
      const box = document.createElement('div');
      box.className = 'sh-panel';
      box.textContent = '总统权力：指定下任总统';
      const sel = document.createElement('div');
      sel.className = 'sh-choose';
      (v.players || []).forEach(p => {
        const b = document.createElement('button');
        b.className = 'sh-opt';
        b.textContent = p.name;
        b.onclick = () => { if (ctx.isHost) submitPick(myId, p.id); else Net.sendToHost({ type: 'sh_pick', targetId: p.id }); };
        sel.appendChild(b);
      });
      box.appendChild(sel);
      c.appendChild(box);
    }
    // 暗杀
    if (v.phase === 'assassinate' && v.president === myId) {
      const box = document.createElement('div');
      box.className = 'sh-panel sh-danger';
      box.textContent = '总统权力：暗杀一位玩家';
      const sel = document.createElement('div');
      sel.className = 'sh-choose';
      (v.players || []).forEach(p => {
        const b = document.createElement('button');
        b.className = 'sh-opt';
        b.textContent = p.name;
        b.onclick = () => { if (ctx.isHost) submitAssassinate(myId, p.id); else Net.sendToHost({ type: 'sh_assassinate', targetId: p.id }); };
        sel.appendChild(b);
      });
      box.appendChild(sel);
      c.appendChild(box);
    }
    // 日志
    if (v.log && v.log.length) {
      const lg = document.createElement('div');
      lg.className = 'sh-log';
      v.log.forEach(l => { const d = document.createElement('div'); d.textContent = l; lg.appendChild(d); });
      c.appendChild(lg);
    }
    // 终局
    if (v.phase === 'ended' && v.winnerIds && v.winnerIds.length) {
      const w = document.createElement('div');
      w.className = 'sh-end';
      const evilWin = v.winnerIds.some(id => (v.players || []).find(p => p.id === id) && state && state.players.find(p => p.id === id)?.team === 'fascist');
      w.textContent = '🏆 ' + (evilWin ? '法西斯阵营' : '自由派') + '获胜！';
      c.appendChild(w);
      if (v.revealRoles && ctx.isHost && state) {
        const reveal = document.createElement('div');
        reveal.className = 'sh-see';
        reveal.textContent = '身份揭晓：' + state.players.map(p => p.name + '(' + roleName(p.role) + ')').join('、');
        c.appendChild(reveal);
      }
    }
  }

  return { init: function(c) {
      ctx = c;
      state = null; mirror = null; myRole = null; myFascists = []; localChoice = null;
      if (ctx.isHost) hostStart();
      else render();
    }, handleMessage };
})();
