// 狼人杀（Werewolf）—— 主机权威
// 规则（简化版，经典四身份）：
//   天黑：狼人袭击（所有存活狼人投票）→ 预言家查验一名玩家 → 女巫决定是否用解药救受害者、是否用毒药毒人；
//   天亮：公布昨夜死亡（死亡玩家身份公开）→ 全员投票放逐（平票则无人出局）；
//   胜负：狼人全灭 → 好人获胜；狼人数量 ≥ 好人数量 → 狼人获胜。
// 身份分配（按人数）：5:1狼 6:2狼 7:2狼 8:3狼，均含预言家、女巫，其余为平民。
const Werewolf = (() => {
  let ctx = null;
  let state = null;      // 主机状态
  let mirror = null;     // 客机：公开状态镜像
  let myRole = null;     // 我的身份
  let myTeam = [];       // 狼人：队友 id
  let myChecks = [];     // 预言家：查验记录 [{name,isWolf}]
  let myAction = null;   // 当前需要我执行的动作 {kind, candidates, ...}
  let witchSaveChoice = false;     // 女巫 UI 本地选择
  let witchPoisonChoice = null;    // 女巫 UI 本地选择
  let witchAntidoteUsed = false;   // 女巫：解药是否已用（本地显示）
  let witchPoisonUsed = false;     // 女巫：毒药是否已用（本地显示）

  const ROLE = {
    wolf: { name: '狼人', icon: '🐺' },
    seer: { name: '预言家', icon: '🔮' },
    witch: { name: '女巫', icon: '🧪' },
    villager: { name: '平民', icon: '🌾' },
  };

  function roleColor(role) {
    return { wolf: '#e5484d', seer: '#8b5cf6', witch: '#0e7490', villager: '#18a058' }[role] || '#6b7280';
  }

  function assignRoles(n) {
    const configs = {
      5: ['wolf', 'seer', 'witch', 'villager', 'villager'],
      6: ['wolf', 'wolf', 'seer', 'witch', 'villager', 'villager'],
      7: ['wolf', 'wolf', 'seer', 'witch', 'villager', 'villager', 'villager'],
      8: ['wolf', 'wolf', 'wolf', 'seer', 'witch', 'villager', 'villager', 'villager'],
    };
    if (configs[n]) return Deck.shuffle(configs[n]);
    const wolves = Math.max(1, Math.round(n / 3));
    const roles = [];
    for (let i = 0; i < wolves; i++) roles.push('wolf');
    roles.push('seer'); roles.push('witch');
    while (roles.length < n) roles.push('villager');
    return Deck.shuffle(roles);
  }

  function init(c) {
    ctx = c;
    state = null; mirror = null; myRole = null; myTeam = []; myChecks = [];
    myAction = null; witchSaveChoice = false; witchPoisonChoice = null;
    witchAntidoteUsed = false; witchPoisonUsed = false;
    if (ctx.isHost) hostStart();
    else render();
  }

  // ---------- 主机逻辑 ----------
  function hostStart() {
    const roles = assignRoles(ctx.players.length);
    state = {
      players: ctx.players.map((p, i) => ({ id: p.id, name: p.name, isHost: p.isHost, isBot: p.isBot, role: roles[i], alive: true })),
      phase: 'night', step: 'wolf', night: 0,
      victimId: null, wolfVotes: {}, seerTarget: null,
      witchSave: false, witchPoison: null, witchUsedAntidote: false, witchUsedPoison: false,
      votes: {}, deadToday: [], winner: null, action: '游戏开始，天黑请闭眼',
    };
    state.players.forEach(p => {
      const team = p.role === 'wolf' ? state.players.filter(x => x.role === 'wolf').map(x => x.id) : [];
      if (p.id === Net.myId()) { myRole = p.role; myTeam = team; }
      else Net.sendTo(p.id, { type: 'ww_role', role: p.role, team });
    });
    render();
    startNight();
  }

  function aliveOf(role) { return state.players.filter(p => p.alive && p.role === role); }
  function candList(fn) { return state.players.filter(p => p.alive && fn(p)).map(p => ({ id: p.id, name: p.name })); }

  function startNight() {
    if (!state || state.winner) return;
    state.night++;
    state.phase = 'night';
    state.deadToday = [];
    state.victimId = null;
    state.wolfVotes = {};
    state.seerTarget = null;
    state.witchSave = false;
    state.witchPoison = null;
    state.action = '第 ' + state.night + ' 夜 · 天黑请闭眼';
    wolfStep();
  }

  function wolfStep() {
    state.step = 'wolf';
    const wolves = aliveOf('wolf');
    if (wolves.length === 0) { seerStep(); return; }
    const cands = candList(p => p.role !== 'wolf');
    if (cands.length === 0) { seerStep(); return; }
    state.action = '狼人睁眼，正在选择袭击目标…';
    wolves.forEach(w => {
      const msg = { type: 'ww_wolf_prompt', candidates: cands, night: state.night };
      if (w.id === Net.myId()) myAction = { kind: 'wolf', candidates: cands };
      Net.sendTo(w.id, msg);
    });
    pushState();
    render();
  }

  function maybeResolveWolfVotes() {
    if (!state || state.step !== 'wolf') return;
    const wolves = aliveOf('wolf');
    if (wolves.length === 0) { seerStep(); return; }
    if (Object.keys(state.wolfVotes).length >= wolves.length) {
      const tally = {};
      Object.values(state.wolfVotes).forEach(t => { tally[t] = (tally[t] || 0) + 1; });
      const max = Math.max.apply(null, Object.values(tally));
      const top = Object.keys(tally).filter(t => tally[t] === max);
      state.victimId = top[Math.floor(Math.random() * top.length)];
      seerStep();
    } else {
      render();
    }
  }

  function hostWolfKill(fromId, targetId) {
    if (!state || state.step !== 'wolf') return;
    const wolves = aliveOf('wolf');
    if (!wolves.some(w => w.id === fromId)) return;
    const t = state.players.find(p => p.id === targetId && p.alive && p.role !== 'wolf');
    if (!t) return;
    state.wolfVotes[fromId] = targetId;
    maybeResolveWolfVotes();
  }

  function seerStep() {
    state.step = 'seer';
    const seer = aliveOf('seer')[0];
    if (!seer) { witchStep(); return; }
    const cands = candList(p => p.id !== seer.id);
    state.action = '预言家睁眼，选择要查验的玩家…';
    const msg = { type: 'ww_seer_prompt', candidates: cands, night: state.night };
    if (seer.id === Net.myId()) myAction = { kind: 'seer', candidates: cands };
    Net.sendTo(seer.id, msg);
    pushState();
    render();
  }

  function hostSeerCheck(fromId, targetId) {
    if (!state || state.step !== 'seer') return;
    const seer = aliveOf('seer')[0];
    if (!seer || seer.id !== fromId) return;
    const t = state.players.find(p => p.id === targetId && p.alive);
    if (!t) return;
    const isWolf = t.role === 'wolf';
    if (fromId === Net.myId()) myChecks.push({ name: t.name, isWolf });
    else Net.sendTo(fromId, { type: 'ww_seer_result', name: t.name, isWolf, night: state.night });
    state.action = '预言家完成了查验';
    witchStep();
  }

  function witchStep() {
    state.step = 'witch';
    const witch = aliveOf('witch')[0];
    if (!witch) { resolveNight(); return; }
    const victim = state.victimId ? state.players.find(p => p.id === state.victimId) : null;
    const cands = candList(p => p.id !== witch.id);
    const canSave = !state.witchUsedAntidote && !!state.victimId;
    const canPoison = !state.witchUsedPoison;
    state.action = '女巫睁眼…';
    const msg = {
      type: 'ww_witch_prompt', candidates: cands,
      victimId: state.victimId, victimName: victim ? victim.name : null,
      canSave, canPoison, night: state.night,
    };
    if (witch.id === Net.myId()) {
      myAction = { kind: 'witch', candidates: cands, victimId: state.victimId, victimName: victim ? victim.name : null, canSave, canPoison };
      witchSaveChoice = false;
      witchPoisonChoice = null;
    }
    Net.sendTo(witch.id, msg);
    pushState();
    render();
  }

  function hostWitchAct(fromId, act) {
    if (!state || state.step !== 'witch') return;
    const witch = aliveOf('witch')[0];
    if (!witch || witch.id !== fromId) return;
    act = act || {};
    if (act.save && !state.witchUsedAntidote && state.victimId) {
      state.witchSave = true;
      state.witchUsedAntidote = true;
      if (fromId === Net.myId()) witchAntidoteUsed = true;
    }
    if (act.poisonId && !state.witchUsedPoison) {
      const t = state.players.find(p => p.id === act.poisonId && p.alive);
      if (t) {
        state.witchPoison = act.poisonId;
        state.witchUsedPoison = true;
        if (fromId === Net.myId()) witchPoisonUsed = true;
      }
    }
    resolveNight();
  }

  function resolveNight() {
    state.step = 'night_resolve';
    const deaths = [];
    if (state.witchPoison) deaths.push(state.witchPoison);
    if (state.victimId && !state.witchSave) deaths.push(state.victimId);
    deaths.forEach(id => { const p = state.players.find(x => x.id === id); if (p && p.alive) p.alive = false; });
    state.deadToday = [...new Set(deaths)].map(id => state.players.find(x => x.id === id)).filter(Boolean);
    state.action = '天亮了…';
    pushState();
    render();
    setTimeout(() => { if (state && !state.winner) dayAnnounce(); }, 900);
  }

  function dayAnnounce() {
    if (!state || state.winner) return;
    state.phase = 'day';
    state.step = 'day_announce';
    const died = state.deadToday;
    state.action = died.length ? ('昨夜 ' + died.map(d => d.name).join('、') + ' 死亡') : '昨夜是平安夜';
    if (checkWin()) return;
    pushState();
    render();
    setTimeout(() => {
      if (state && state.phase === 'day' && state.step === 'day_announce' && !state.winner) startVote();
    }, 6000);
  }

  function startVote() {
    if (!state || state.phase !== 'day' || state.step !== 'day_announce') return;
    state.step = 'day_vote';
    state.votes = {};
    state.action = '请投票选出要放逐的玩家';
    state.players.filter(p => p.alive).forEach(p => {
      const cands = candList(q => q.id !== p.id);
      const msg = { type: 'ww_day_vote_prompt', candidates: cands };
      if (p.id === Net.myId()) myAction = { kind: 'vote', candidates: cands };
      Net.sendTo(p.id, msg);
    });
    pushState();
    render();
  }

  function hostDayVote(fromId, targetId) {
    if (!state || state.step !== 'day_vote') return;
    const voter = state.players.find(p => p.id === fromId && p.alive);
    if (!voter) return;
    if (state.votes[fromId] !== undefined) return;
    if (targetId === null || targetId === undefined) {
      state.votes[fromId] = null;
    } else {
      const t = state.players.find(p => p.id === targetId && p.alive);
      if (!t) return;
      state.votes[fromId] = targetId;
    }
    const alive = state.players.filter(p => p.alive);
    if (alive.every(p => state.votes[p.id] !== undefined)) resolveVote();
    else render();
  }

  function resolveVote() {
    const tally = {};
    Object.values(state.votes).forEach(t => { if (t) tally[t] = (tally[t] || 0) + 1; });
    const entries = Object.entries(tally);
    let eliminated = null;
    if (entries.length) {
      const max = Math.max.apply(null, entries.map(e => e[1]));
      const top = entries.filter(e => e[1] === max).map(e => e[0]);
      if (top.length === 1) eliminated = top[0];
    }
    state.step = 'day_reveal';
    if (eliminated) {
      const p = state.players.find(x => x.id === eliminated);
      if (p) p.alive = false;
      state.deadToday = p ? [p] : [];
      state.action = p ? (p.name + ' 被放逐') : '平票，没有人被放逐';
    } else {
      state.deadToday = [];
      state.action = '平票，没有人被放逐';
    }
    pushState();
    render();
    if (checkWin()) return;
    setTimeout(() => { if (state && state.phase === 'day' && !state.winner) startNight(); }, 1800);
  }

  function checkWin() {
    const aliveWolves = state.players.filter(p => p.alive && p.role === 'wolf').length;
    const aliveGood = state.players.filter(p => p.alive && p.role !== 'wolf').length;
    if (aliveWolves === 0) { endGame('good'); return true; }
    if (aliveWolves >= aliveGood) { endGame('wolf'); return true; }
    return false;
  }

  function endGame(side) {
    state.winner = side;
    state.phase = 'ended';
    state.step = 'ended';
    state.action = side === 'good' ? '🎉 好人阵营获胜！' : '🐺 狼人阵营获胜！';
    pushState();
    render();
  }

  function pushState() {
    const msg = {
      type: 'ww_state',
      players: state.players.map(p => ({
        id: p.id, name: p.name, isHost: p.isHost, isBot: p.isBot,
        alive: p.alive,
        role: (!p.alive || state.phase === 'ended') ? p.role : null,
      })),
      phase: state.phase,
      step: state.step,
      night: state.night,
      deadToday: state.deadToday.map(d => d.name),
      action: state.action,
      winner: state.winner,
      aliveCount: state.players.filter(p => p.alive).length,
      totalCount: state.players.length,
    };
    Net.broadcast(msg);
  }

  // ---------- 消息处理 ----------
  function handleMessage(from, data) {
    if (!ctx || !data || !data.type) return;
    if (ctx.isHost) {
      if (data.type === 'ww_wolf_kill') hostWolfKill(from, data.targetId);
      else if (data.type === 'ww_seer_check') hostSeerCheck(from, data.targetId);
      else if (data.type === 'ww_witch_act') hostWitchAct(from, data.act);
      else if (data.type === 'ww_day_vote') hostDayVote(from, data.targetId);
    } else {
      if (data.type === 'ww_state') { mirror = data; render(); }
      else if (data.type === 'ww_role') { myRole = data.role; myTeam = data.team || []; render(); }
      else if (data.type === 'ww_seer_result') { myChecks.push({ name: data.name, isWolf: data.isWolf }); render(); }
      else if (data.type === 'ww_wolf_prompt') { myAction = { kind: 'wolf', candidates: data.candidates || [] }; render(); }
      else if (data.type === 'ww_seer_prompt') { myAction = { kind: 'seer', candidates: data.candidates || [] }; render(); }
      else if (data.type === 'ww_witch_prompt') {
        myAction = { kind: 'witch', candidates: data.candidates || [], victimId: data.victimId, victimName: data.victimName, canSave: data.canSave, canPoison: data.canPoison };
        witchSaveChoice = false; witchPoisonChoice = null;
        render();
      }
      else if (data.type === 'ww_day_vote_prompt') { myAction = { kind: 'vote', candidates: data.candidates || [] }; render(); }
    }
  }

  function submitWolfKill(targetId) { myAction = null; if (ctx.isHost) hostWolfKill(Net.myId(), targetId); else Net.sendToHost({ type: 'ww_wolf_kill', targetId }); }
  function submitSeerCheck(targetId) { myAction = null; if (ctx.isHost) hostSeerCheck(Net.myId(), targetId); else Net.sendToHost({ type: 'ww_seer_check', targetId }); }
  function submitDayVote(targetId) { myAction = null; if (ctx.isHost) hostDayVote(Net.myId(), targetId); else Net.sendToHost({ type: 'ww_day_vote', targetId }); }
  function submitWitch(save, poisonId) {
    myAction = null;
    if (save) witchAntidoteUsed = true;
    if (poisonId) witchPoisonUsed = true;
    if (ctx.isHost) hostWitchAct(Net.myId(), { save, poisonId });
    else Net.sendToHost({ type: 'ww_witch_act', act: { save, poisonId } });
  }

  // ---------- 视图 ----------
  function view() {
    if (ctx.isHost) {
      return {
        players: state.players.map(p => ({
          id: p.id, name: p.name, isHost: p.isHost, isBot: p.isBot,
          alive: p.alive,
          role: (!p.alive || state.phase === 'ended') ? p.role : null,
        })),
        phase: state.phase, step: state.step, night: state.night,
        deadToday: state.deadToday.map(d => d.name),
        action: state.action, winner: state.winner,
      };
    }
    return mirror;
  }

  function phaseText(v) {
    if (v.phase === 'ended') return '已结束';
    if (v.phase === 'night') return '🌙 第 ' + v.night + ' 夜';
    return '☀️ 第 ' + v.night + ' 天';
  }

  function bannerFor(v) {
    if (v.phase === 'ended') return { cls: v.winner === 'good' ? 'ok' : 'danger', text: v.action };
    if (v.phase === 'day') return { cls: 'ok', text: v.action };
    return { cls: '', text: v.action || '' };
  }

  function waitingText(v) {
    if (v.phase === 'night') {
      if (v.step === 'wolf') return '🌙 等待狼人行动…';
      if (v.step === 'seer') return '🌙 等待预言家行动…';
      if (v.step === 'witch') return '🌙 等待女巫行动…';
      return '🌙 夜晚中…';
    }
    if (v.phase === 'day') {
      if (v.step === 'day_announce') return '☀️ 等待进入投票…';
      if (v.step === 'day_vote') return '☀️ 等待大家投票…';
    }
    return '…';
  }

  function roleCard(v) {
    const box = document.createElement('div');
    box.className = 'ww-role-card';
    const r = ROLE[myRole];
    const head = document.createElement('div');
    head.className = 'ww-role-head';
    const icon = document.createElement('span');
    icon.className = 'ww-role-icon';
    icon.textContent = r.icon;
    head.appendChild(icon);
    const nm = document.createElement('span');
    nm.className = 'ww-role-name';
    nm.style.color = roleColor(myRole);
    nm.textContent = '你的身份：' + r.name;
    head.appendChild(nm);
    box.appendChild(head);

    if (myRole === 'wolf' && myTeam.length > 1) {
      const names = v.players.filter(p => myTeam.includes(p.id)).map(p => p.name).join('、');
      const line = document.createElement('div');
      line.className = 'ww-role-sub';
      line.textContent = '🐺 你的狼队友：' + names;
      box.appendChild(line);
    }
    if (myRole === 'witch') {
      const line = document.createElement('div');
      line.className = 'ww-role-sub';
      line.textContent = '🧪 解药：' + (witchAntidoteUsed ? '已用' : '可用') + ' · 💀 毒药：' + (witchPoisonUsed ? '已用' : '可用');
      box.appendChild(line);
    }
    if (myRole === 'seer' && myChecks.length) {
      const line = document.createElement('div');
      line.className = 'ww-role-sub';
      line.textContent = myChecks.map(k => k.name + '：' + (k.isWolf ? '🐺 狼人' : '😇 好人')).join(' · ');
      box.appendChild(line);
    }
    return box;
  }

  function playersGrid(v) {
    const grid = document.createElement('div');
    grid.className = 'ww-grid';
    const myId = Net.myId();
    v.players.forEach(p => {
      const item = document.createElement('div');
      item.className = 'ww-player' + (p.alive ? '' : ' dead');
      item.appendChild(UI.avatarEl(p.id, p.name));
      const nm = document.createElement('div');
      nm.className = 'ww-pname';
      nm.textContent = (p.isBot ? '🤖 ' : '') + p.name + (p.id === myId ? '（你）' : '');
      item.appendChild(nm);
      const st = document.createElement('div');
      st.className = 'ww-pstatus';
      const role = p.id === myId ? myRole : p.role;
      if (!p.alive) {
        const dead = document.createElement('span');
        dead.className = 'ww-dead';
        dead.textContent = '💀 ' + (ROLE[role] ? ROLE[role].name : '死亡');
        st.appendChild(dead);
      } else if (role) {
        const tag = document.createElement('span');
        tag.className = 'ww-role-tag';
        tag.style.background = roleColor(role);
        tag.textContent = ROLE[role].icon + ' ' + ROLE[role].name;
        st.appendChild(tag);
      } else {
        st.textContent = '身份未知';
      }
      item.appendChild(st);
      grid.appendChild(item);
    });
    return grid;
  }

  function candidateGrid(candidates, onClick) {
    const grid = document.createElement('div');
    grid.className = 'ww-cand-grid';
    candidates.forEach(cd => {
      const b = document.createElement('button');
      b.className = 'ww-cand';
      b.appendChild(UI.avatarEl(cd.id, cd.name));
      const sp = document.createElement('span');
      sp.textContent = cd.name + (cd.id === Net.myId() ? '（你）' : '');
      b.appendChild(sp);
      b.addEventListener('click', () => onClick(cd.id));
      grid.appendChild(b);
    });
    return grid;
  }

  function witchAction() {
    const wrap = document.createElement('div');
    wrap.className = 'ww-action';
    const info = document.createElement('div');
    info.className = 'ww-witch-info';
    info.textContent = myAction.victimId
      ? ('🧪 今晚狼人袭击了 ' + myAction.victimName + '。要救吗？')
      : '🧪 今晚是平安夜（狼人没有行动）。';
    wrap.appendChild(info);

    const saveRow = document.createElement('div');
    saveRow.className = 'actionbar';
    if (myAction.canSave) {
      const save = document.createElement('button');
      save.className = 'btn ' + (witchSaveChoice ? 'btn-primary' : 'btn-ghost');
      save.textContent = '💊 使用解药';
      save.addEventListener('click', () => { witchSaveChoice = !witchSaveChoice; render(); });
      saveRow.appendChild(save);
      const nosave = document.createElement('button');
      nosave.className = 'btn ' + (witchSaveChoice ? 'btn-ghost' : 'btn-primary');
      nosave.textContent = '不救';
      nosave.addEventListener('click', () => { witchSaveChoice = false; render(); });
      saveRow.appendChild(nosave);
    } else {
      const used = document.createElement('span');
      used.className = 'ww-witch-used';
      used.textContent = '解药已用';
      saveRow.appendChild(used);
    }
    wrap.appendChild(saveRow);

    const poisonLabel = document.createElement('div');
    poisonLabel.className = 'ww-action-label';
    poisonLabel.textContent = '💀 使用毒药（可选，毒死一名玩家）：';
    wrap.appendChild(poisonLabel);

    if (myAction.canPoison) {
      const grid = document.createElement('div');
      grid.className = 'ww-cand-grid';
      myAction.candidates.forEach(cd => {
        const b = document.createElement('button');
        b.className = 'ww-cand' + (witchPoisonChoice === cd.id ? ' selected' : '');
        b.appendChild(UI.avatarEl(cd.id, cd.name));
        const sp = document.createElement('span');
        sp.textContent = cd.name + (cd.id === Net.myId() ? '（你）' : '');
        b.appendChild(sp);
        b.addEventListener('click', () => { witchPoisonChoice = (witchPoisonChoice === cd.id ? null : cd.id); render(); });
        grid.appendChild(b);
      });
      wrap.appendChild(grid);
      const skip = document.createElement('button');
      skip.className = 'btn btn-ghost';
      skip.textContent = '不使用毒药';
      skip.addEventListener('click', () => { witchPoisonChoice = null; render(); });
      skip.style.cssText = 'margin-top:10px;';
      wrap.appendChild(skip);
    } else {
      const used = document.createElement('span');
      used.className = 'ww-witch-used';
      used.textContent = '毒药已用';
      wrap.appendChild(used);
    }

    const confirmBar = document.createElement('div');
    confirmBar.className = 'actionbar';
    const confirm = document.createElement('button');
    confirm.className = 'btn btn-primary';
    confirm.textContent = '确认';
    confirm.addEventListener('click', () => submitWitch(witchSaveChoice, witchPoisonChoice));
    confirmBar.appendChild(confirm);
    wrap.appendChild(confirmBar);

    return wrap;
  }

  function actionArea(v) {
    const wrap = document.createElement('div');
    wrap.className = 'ww-action';

    if (ctx.isHost && v.phase === 'day' && v.step === 'day_announce' && !v.winner) {
      const bar = document.createElement('div');
      bar.className = 'actionbar';
      const btn = document.createElement('button');
      btn.className = 'btn btn-primary';
      btn.textContent = '进入投票';
      btn.addEventListener('click', startVote);
      bar.appendChild(btn);
      wrap.appendChild(bar);
      return wrap;
    }

    if (v.phase === 'ended') {
      const bar = document.createElement('div');
      bar.className = 'actionbar';
      const back = document.createElement('button');
      back.className = 'btn btn-primary';
      back.textContent = '返回房间';
      back.addEventListener('click', () => ctx.leave());
      bar.appendChild(back);
      wrap.appendChild(bar);
      return wrap;
    }

    if (!myAction) {
      const wait = document.createElement('div');
      wait.className = 'ww-waiting';
      wait.textContent = waitingText(v);
      wrap.appendChild(wait);
      return wrap;
    }

    if (myAction.kind === 'wolf') {
      const label = document.createElement('div');
      label.className = 'ww-action-label';
      label.textContent = '🐺 请选择今晚要袭击的玩家：';
      wrap.appendChild(label);
      wrap.appendChild(candidateGrid(myAction.candidates, submitWolfKill));
      return wrap;
    }
    if (myAction.kind === 'seer') {
      const label = document.createElement('div');
      label.className = 'ww-action-label';
      label.textContent = '🔮 请选择要查验的玩家：';
      wrap.appendChild(label);
      wrap.appendChild(candidateGrid(myAction.candidates, submitSeerCheck));
      return wrap;
    }
    if (myAction.kind === 'vote') {
      const label = document.createElement('div');
      label.className = 'ww-action-label';
      label.textContent = '🗳️ 请投票放逐一名玩家：';
      wrap.appendChild(label);
      wrap.appendChild(candidateGrid(myAction.candidates, submitDayVote));
      const bar = document.createElement('div');
      bar.className = 'actionbar';
      const abstain = document.createElement('button');
      abstain.className = 'btn btn-ghost';
      abstain.textContent = '弃票';
      abstain.addEventListener('click', () => submitDayVote(null));
      bar.appendChild(abstain);
      wrap.appendChild(bar);
      return wrap;
    }
    if (myAction.kind === 'witch') {
      return witchAction();
    }
    return wrap;
  }

  function showRules() {
    const body =
      '<div class="ww-rules">' +
      '<p class="ww-rules-lead">天黑请闭眼，狼人出来杀人；天亮后大家投票，找出隐藏的狼人。</p>' +
      '<div class="ww-rules-sec"><div class="ww-rules-h">🎭 阵营</div>' +
      '<p><b style="color:#e5484d">🐺 狼人阵营</b>：夜晚袭击一名玩家，白天伪装成好人，目标是让狼人数 ≥ 好人数。</p>' +
      '<p><b style="color:#18a058">😇 好人阵营</b>：找出并放逐所有狼人。</p></div>' +
      '<div class="ww-rules-sec"><div class="ww-rules-h">🃏 角色技能</div>' +
      '<p><b>🐺 狼人</b>：每个夜晚与队友商议，共同选择一名玩家袭击。</p>' +
      '<p><b>🔮 预言家</b>：每个夜晚可以查验一名玩家，得知其是否为狼人。</p>' +
      '<p><b>🧪 女巫</b>：拥有一瓶<b>解药</b>（救活当晚被袭击者）和一瓶<b>毒药</b>（毒死一名玩家），各只能用一次，且同一晚不能同时使用。</p>' +
      '<p><b>🌾 平民</b>：没有特殊技能，靠发言和投票找出狼人。</p></div>' +
      '<div class="ww-rules-sec"><div class="ww-rules-h">🌗 游戏流程</div>' +
      '<p><b>夜晚</b>：狼人袭击 → 预言家查验 → 女巫决定是否用药。</p>' +
      '<p><b>白天</b>：公布昨夜死亡（死亡者身份公开）→ 全员投票放逐一名玩家，平票则无人出局。</p>' +
      '<p>日夜交替进行，直到一方获胜。</p></div>' +
      '<div class="ww-rules-sec"><div class="ww-rules-h">🏆 胜负判定</div>' +
      '<p>狼人全部死亡 → <b style="color:#18a058">好人阵营获胜</b>。</p>' +
      '<p>存活狼人数 ≥ 存活好人数 → <b style="color:#e5484d">狼人阵营获胜</b>。</p></div>' +
      '<div class="ww-rules-sec"><div class="ww-rules-h">👥 人数与身份</div>' +
      '<p>6 人：2 狼 · 7 人：2 狼 · 8 人：3 狼（均含预言家、女巫，其余平民）。</p></div>' +
      '</div>';
    UI.modal('🐺 狼人杀 · 规则', body, [{ label: '知道了' }]);
  }

  function render() {
    if (!ctx) return;
    const c = ctx.container;
    UI.clear(c);
    const v = view();
    const frame = document.createElement('div');
    frame.className = 'game-frame';

    const tb = document.createElement('div');
    tb.className = 'game-topbar';
    const left = document.createElement('div');
    left.style.cssText = 'display:flex;gap:8px;align-items:center;';
    const title = document.createElement('span');
    title.className = 'game-title';
    title.textContent = '🐺 狼人杀';
    left.appendChild(title);
    const rulesBtn = document.createElement('button');
    rulesBtn.className = 'btn btn-ghost btn-sm';
    rulesBtn.textContent = '📖 规则';
    rulesBtn.title = '查看规则';
    rulesBtn.addEventListener('click', showRules);
    left.appendChild(rulesBtn);
    tb.appendChild(left);
    const right = document.createElement('div');
    right.style.cssText = 'display:flex;gap:8px;align-items:center;';
    if (ctx.solo) {
      const sp = document.createElement('span');
      sp.className = 'phase-pill solo';
      sp.textContent = '🤖 人机';
      right.appendChild(sp);
    }
    const pill = document.createElement('span');
    pill.className = 'phase-pill' + (v && v.phase === 'ended' ? ' warn' : (v && v.phase === 'day' ? ' ok' : ''));
    pill.textContent = v ? phaseText(v) : '准备中';
    right.appendChild(pill);
    const leaveBtn = document.createElement('button');
    leaveBtn.className = 'btn btn-ghost btn-sm';
    leaveBtn.textContent = '离开';
    leaveBtn.addEventListener('click', () => ctx.leave());
    right.appendChild(leaveBtn);
    tb.appendChild(right);
    frame.appendChild(tb);

    if (!v || !myRole) {
      frame.appendChild(UI.banner('', ctx.isHost ? '正在分配身份…' : '正在等待房主分配身份…'));
      c.appendChild(frame);
      return;
    }

    const bn = bannerFor(v);
    frame.appendChild(UI.banner(bn.cls, bn.text));
    frame.appendChild(roleCard(v));
    frame.appendChild(playersGrid(v));
    frame.appendChild(actionArea(v));

    c.appendChild(frame);
  }

  return { init, handleMessage };
})();
