// 阿瓦隆 The Resistance: Avalon —— 主机权威 · 阵营隐藏 · 组队投票
// 规则：5-10 人。好人（蓝方）与坏人（红方）阵营隐藏；
// 梅林知道所有坏人（莫德雷德除外），珀西瓦尔知道梅林与莫甘娜两个候选，
// 坏人互相认识（奥伯伦除外），刺客可在好人完成 3 局后指认梅林翻盘。
// 每局：队长提名队伍 → 全员投票是否通过 → 通过后队员依次任务投票（成败）；
// 5 局 3 胜。好人 3 胜后刺客刺杀梅林：指中坏人胜，否则好人胜；坏人 3 胜直接获胜。
// 消息：av_state（公开）/ av_role（角色与视野私发）/ av_choose（提名队伍）/
// av_vote（队伍投票）/ av_mission（任务投票）/ av_assassinate（刺客刺杀）。
const Avalon = (() => {
  let ctx = null;
  let state = null;    // 主机状态
  let mirror = null;   // 客机公开状态
  let myRole = null;   // 我的角色
  let myEvils = [];    // 我看到的坏人（梅林视野/坏人互认）
  let myCandidates = []; // 珀西瓦尔看到的两个候选
  let localChoose = [];  // 本地选中的队伍
  let localVote = null;  // 本地投票
  let localMission = null; // 本地任务投票
  let localTarget = null;  // 本地刺杀目标
  let epoch = 0;

  const EVIL_ROLES = ['assassin', 'morgana', 'mordred', 'oberon'];
  const ROLE_INFO = {
    merlin:    { name: '梅林',     team: 'good', icon: '🧙', desc: '开局看到所有坏人（莫德雷德除外）' },
    percival:  { name: '珀西瓦尔', team: 'good', icon: '🛡️', desc: '开局看到梅林与莫甘娜两个候选' },
    assassin:  { name: '刺客',     team: 'evil', icon: '🗡️', desc: '坏人；好人3胜后可指认梅林翻盘' },
    morgana:   { name: '莫甘娜',   team: 'evil', icon: '🌙', desc: '坏人；会被珀西瓦尔误认为梅林' },
    mordred:   { name: '莫德雷德', team: 'evil', icon: '🐍', desc: '坏人；梅林看不到你' },
    oberon:    { name: '奥伯伦',   team: 'evil', icon: '🦉', desc: '坏人；其他坏人也看不到你' },
    loyal:     { name: '亚瑟忠臣', team: 'good', icon: '🛡️', desc: '好人，无特殊能力' },
  };
  const MISSION_SIZES = { 5: [2,3,2,3,3], 6: [2,3,4,3,4], 7: [2,3,3,4,4], 8: [3,3,3,5,4], 9: [3,4,4,5,5], 10: [3,4,4,5,5] };

  function roleName(r) { return ROLE_INFO[r] ? ROLE_INFO[r].name : r; }

  function assignRoles(n) {
    // 坏人数：5-6 人 2 个；7-9 人 3 个；10 人 4 个
    const evils = n >= 10 ? 4 : n >= 7 ? 3 : 2;
    const roles = [];
    roles.push('assassin');
    if (evils >= 3) { roles.push('morgana'); roles.push('mordred'); }
    else if (evils === 2) { roles.push('mordred'); }
    if (evils >= 4) roles.push('oberon');
    roles.push('merlin');
    if (n >= 6) roles.push('percival');
    while (roles.length < n) roles.push('loyal');
    return Deck.shuffle(roles);
  }

  function missionNeedFail(mission) {
    // 5-6 人第 4 局需要 2 个 fail 才失败
    if (state.players.length <= 6 && mission === 4) return 2;
    return 1;
  }

  function evilList() { return state.players.filter(p => ROLE_INFO[p.role] && ROLE_INFO[p.role].team === 'evil').map(p => p.id); }

  function startMission(m) {
    const size = MISSION_SIZES[state.players.length][m - 1];
    state.mission = m;
    state.needSize = size;
    state.leaderIdx = (m === 1) ? 0 : (state.leaderIdx + 1) % state.players.length;
    state.phase = 'propose';
    state.proposed = [];
    state.proposer = state.players[state.leaderIdx].id;
    state.voteCount = 0;
    state.missionVotes = [];
    state.action = '第 ' + m + ' 局（需 ' + size + ' 人）：' + state.players[state.leaderIdx].name + ' 是队长，请提名队伍';
    state.roundInfo = '任务失败判定：需要 ' + missionNeedFail(m) + ' 个失败票';
    state.log.push('—— 第 ' + m + ' 局开始，队长 ' + state.players[state.leaderIdx].name + ' ——');
    pushState();
    render();
  }

  function hostStart() {
    epoch++;
    const n = ctx.players.length;
    const roles = assignRoles(n);
    const players = ctx.players.map((p, i) => ({
      id: p.id, name: p.name, isHost: p.isHost, isBot: p.isBot,
      role: roles[i], team: ROLE_INFO[roles[i]].team,
    }));
    state = {
      players, mission: 1, needSize: MISSION_SIZES[n][0], leaderIdx: 0,
      phase: 'propose', proposed: [], proposer: players[0].id,
      voteCount: 0, missionVotes: [], results: [], // results: [{mission, success, fail}]
      action: '', log: [], winnerIds: [], assassinated: null,
      roundInfo: '', goodWins: 0, evilWins: 0,
    };
    pushRoles();
    startMission(1);
  }

  function pushRoles() {
    const evils = evilList();
    const merlinId = state.players.find(p => p.role === 'merlin');
    const morganaId = state.players.find(p => p.role === 'morgana');
    for (const p of state.players) {
      const info = { type: 'av_role', role: p.role, roleName: roleName(p.role), team: p.team, evils: [], candidates: [] };
      if (p.role === 'merlin') {
        info.evils = evils.filter(id => state.players.find(x => x.id === id).role !== 'mordred');
      } else if (p.role === 'percival') {
        info.candidates = [merlinId.id, morganaId ? morganaId.id : merlinId.id];
      } else if (ROLE_INFO[p.role].team === 'evil' && p.role !== 'oberon') {
        info.evils = evils.filter(id => id !== p.id && state.players.find(x => x.id === id).role !== 'oberon');
      }
      if (p.id === Net.myId()) { myRole = p.role; myEvils = info.evils; myCandidates = info.candidates; }
      else Net.sendTo(p.id, info);
    }
  }

  // 提交队伍：队长选择 players 名单
  function submitProposal(fromId, ids) {
    if (!state || state.phase !== 'propose') return;
    if (fromId !== state.proposer) return;
    if (!Array.isArray(ids) || ids.length !== state.needSize) return;
    const uniq = [...new Set(ids)];
    if (uniq.length !== state.needSize) return;
    for (const id of ids) {
      if (!state.players.find(p => p.id === id)) return;
    }
    state.proposed = ids;
    state.phase = 'vote';
    state.voteCount = 0;
    state.votes = {};
    state.action = '队长 ' + state.players.find(p => p.id === fromId).name + ' 提名：' + ids.map(id => state.players.find(p => p.id === id).name).join('、') + '。全员投票是否通过';
    pushState();
    render();
  }

  function submitVote(fromId, ok) {
    if (!state || state.phase !== 'vote') return;
    if (state.votes && state.votes[fromId] !== undefined) return;
    if (!state.votes) state.votes = {};
    state.votes[fromId] = !!ok;
    state.voteCount++;
    if (state.voteCount >= state.players.length) {
      const approves = Object.values(state.votes).filter(v => v).length;
      state.log.push('队伍投票：' + approves + ' 赞成 / ' + (state.players.length - approves) + ' 反对');
      if (approves > state.players.length / 2) {
        // 通过：任务投票
        state.phase = 'mission';
        state.missionVotes = [];
        state.needMission = state.proposed.length;
        state.action = '队伍通过！请被提名玩家依次任务投票';
        // 任务投票顺序：被提名玩家依次
        state.missionOrder = state.proposed.slice();
      } else {
        // 否决：换队长
        state.log.push('队伍被否决，换下一位队长');
        state.leaderIdx = (state.leaderIdx + 1) % state.players.length;
        state.phase = 'propose';
        state.proposed = [];
        state.votes = {};
        state.voteCount = 0;
        state.action = state.players[state.leaderIdx].name + ' 成为新队长，请提名队伍';
        pushState();
        render();
        return;
      }
    }
    pushState();
    render();
  }

  function submitMissionVote(fromId, ok) {
    if (!state || state.phase !== 'mission') return;
    if (!state.missionOrder.includes(fromId)) return;
    if (state.missionVotes.find(v => v.id === fromId)) return;
    state.missionVotes.push({ id: fromId, fail: !ok });
    if (state.missionVotes.length >= state.needMission) {
      const fails = state.missionVotes.filter(v => v.fail).length;
      const need = missionNeedFail(state.mission);
      const success = fails < need;
      state.results.push({ mission: state.mission, success, fails, need });
      state.log.push('第 ' + state.mission + ' 局任务：' + (success ? '成功' : '失败') + '（失败票 ' + fails + '/' + need + '）');
      if (success) { state.goodWins++; state.action = '第 ' + state.mission + ' 局任务成功！好人阵营 ' + state.goodWins + ' 胜'; }
      else { state.evilWins++; state.action = '第 ' + state.mission + ' 局任务失败！坏人阵营 ' + state.evilWins + ' 胜'; }
      if (state.goodWins >= 3) {
        state.phase = 'assassinate';
        state.action = '🛡️ 好人阵营完成 3 局！刺客可指认梅林（选错则好人胜）';
        pushState();
        render();
        return;
      }
      if (state.evilWins >= 3) {
        state.phase = 'ended';
        state.winnerIds = state.players.filter(p => ROLE_INFO[p.role].team === 'evil').map(p => p.id);
        state.action = '🗡️ 坏人阵营完成 3 局，坏人获胜！';
        pushState();
        render();
        return;
      }
      startMission(state.mission + 1);
      return;
    }
    state.action = '已收任务票 ' + state.missionVotes.length + '/' + state.needMission;
    pushState();
    render();
  }

  function submitAssassinate(fromId, targetId) {
    if (!state || state.phase !== 'assassinate') return;
    const p = state.players.find(x => x.id === fromId);
    if (!p || p.role !== 'assassin') return;
    const target = state.players.find(x => x.id === targetId);
    if (!target) return;
    state.assassinated = target.id;
    if (target.role === 'merlin') {
      state.phase = 'ended';
      state.winnerIds = state.players.filter(x => ROLE_INFO[x.role].team === 'evil').map(x => x.id);
      state.action = '🗡️ 刺客指认 ' + target.name + ' —— 正是梅林！坏人阵营翻盘获胜！';
    } else {
      state.phase = 'ended';
      state.winnerIds = state.players.filter(x => ROLE_INFO[x.role].team === 'good').map(x => x.id);
      state.action = '🛡️ 刺客指认 ' + target.name + '，但 TA 不是梅林。好人阵营获胜！';
    }
    state.log.push('刺客刺杀：' + target.name);
    pushState();
    render();
  }

  function pushState() {
    if (!state) return;
    Net.broadcast(view());
  }

  function view() {
    if (ctx.isHost) {
      return {
        type: 'av_state',
        mission: state.mission, needSize: state.needSize, phase: state.phase,
        players: state.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost, isBot: p.isBot })),
        proposer: state.proposer, proposed: state.proposed || [],
        missionOrder: state.missionOrder || [],
        results: state.results, goodWins: state.goodWins, evilWins: state.evilWins,
        action: state.action, log: state.log.slice(-8), winnerIds: state.winnerIds,
        roundInfo: state.roundInfo, assassinated: state.assassinated,
        missionVotes: state.missionVotes ? state.missionVotes.length : 0,
        needMission: state.needMission || 0,
      };
    }
    return mirror;
  }

  function handleMessage(from, data) {
    if (!data || !data.type) return;
    if (ctx.isHost) {
      if (data.type === 'av_choose') submitProposal(from, data.ids);
      else if (data.type === 'av_vote') submitVote(from, data.ok);
      else if (data.type === 'av_mission') submitMissionVote(from, data.ok);
      else if (data.type === 'av_assassinate') submitAssassinate(from, data.targetId);
      return;
    }
    if (data.type === 'av_role') { myRole = data.role; myEvils = data.evils || []; myCandidates = data.candidates || []; render(); return; }
    if (data.type === 'av_state') { mirror = data; render(); }
  }

  // ---------- 视图 ----------
  function render() {
    if (!ctx) return;
    const c = ctx.container;
    UI.clear(c);
    const v = view();
    if (ctx.isHost && state) v.players = state.players;
    // 我的身份条
    const roleBar = document.createElement('div');
    roleBar.className = 'av-rolebar';
    const myTeam = ROLE_INFO[myRole] ? ROLE_INFO[myRole].team : 'good';
    roleBar.textContent = '我的身份：' + roleName(myRole) + '（' + (myTeam === 'good' ? '好人阵营' : '坏人阵营') + '）';
    c.appendChild(roleBar);
    // 视野
    if (myEvils && myEvils.length) {
      const see = document.createElement('div');
      see.className = 'av-see';
      see.textContent = '你看到的坏人：' + myEvils.map(id => (v.players || []).find(p => p.id === id)?.name || id).join('、');
      c.appendChild(see);
    }
    if (myCandidates && myCandidates.length) {
      const see = document.createElement('div');
      see.className = 'av-see';
      see.textContent = '梅林候选：' + myCandidates.map(id => (v.players || []).find(p => p.id === id)?.name || id).join(' 与 ');
      c.appendChild(see);
    }
    // 结果统计
    const stat = document.createElement('div');
    stat.className = 'av-stat';
    stat.textContent = '好人 ' + (v.goodWins || 0) + ' 胜 / 坏人 ' + (v.evilWins || 0) + ' 胜';
    c.appendChild(stat);
    // 玩家列表
    const list = document.createElement('div');
    list.className = 'av-players';
    (v.players || []).forEach(p => {
      const el = UI.avatarEl(p.id, p.name);
      el.className = 'av-p' + (p.id === v.proposer ? ' av-leader' : '') + ((v.proposed || []).includes(p.id) ? ' av-picked' : '');
      list.appendChild(el);
    });
    c.appendChild(list);
    // 已结算局
    if (v.results && v.results.length) {
      const r = document.createElement('div');
      r.className = 'av-results';
      v.results.forEach(res => {
        const d = document.createElement('span');
        d.className = 'av-result ' + (res.success ? 'ok' : 'fail');
        d.textContent = '第' + res.mission + '局 ' + (res.success ? '成功' : '失败');
        r.appendChild(d);
      });
      c.appendChild(r);
    }
    // 行动提示
    const action = document.createElement('div');
    action.className = 'av-action';
    action.textContent = UI.esc(v.action || '');
    c.appendChild(action);
    // 阶段交互
    const myId = Net.myId();
    if (v.phase === 'propose' && v.proposer === myId) {
      const box = document.createElement('div');
      box.className = 'av-panel';
      const title = document.createElement('div');
      title.textContent = '选择 ' + (v.needSize || 0) + ' 名队员（点击玩家头像）';
      box.appendChild(title);
      const sel = document.createElement('div');
      sel.className = 'av-choose';
      (v.players || []).forEach(p => {
        const b = document.createElement('button');
        b.className = 'av-opt' + (localChoose.includes(p.id) ? ' on' : '');
        b.textContent = p.name;
        b.onclick = () => {
          if (localChoose.includes(p.id)) localChoose = localChoose.filter(x => x !== p.id);
          else if (localChoose.length < (v.needSize || 0)) localChoose.push(p.id);
          render();
        };
        sel.appendChild(b);
      });
      box.appendChild(sel);
      const ok = document.createElement('button');
      ok.className = 'av-btn';
      ok.textContent = '提交队伍';
      ok.onclick = () => {
        if (localChoose.length !== (v.needSize || 0)) { UI.toast('需选满 ' + (v.needSize || 0) + ' 人'); return; }
        const ids = localChoose.slice();
        localChoose = [];
        if (ctx.isHost) submitProposal(myId, ids);
        else Net.sendToHost({ type: 'av_choose', ids });
      };
      box.appendChild(ok);
      c.appendChild(box);
    }
    if (v.phase === 'vote' && !(v.votes || {})[myId]) {
      const box = document.createElement('div');
      box.className = 'av-panel';
      box.textContent = '是否通过队长提名？';
      const yes = document.createElement('button');
      yes.className = 'av-btn';
      yes.textContent = '赞成';
      yes.onclick = () => { if (ctx.isHost) submitVote(myId, true); else Net.sendToHost({ type: 'av_vote', ok: true }); };
      const no = document.createElement('button');
      no.className = 'av-btn av-btn-no';
      no.textContent = '反对';
      no.onclick = () => { if (ctx.isHost) submitVote(myId, false); else Net.sendToHost({ type: 'av_vote', ok: false }); };
      box.appendChild(yes); box.appendChild(no);
      c.appendChild(box);
    }
    if (v.phase === 'mission' && (v.missionOrder || []).includes(myId) && !(v.missionVotes || []).some(x => x.id === myId)) {
      const box = document.createElement('div');
      box.className = 'av-panel';
      box.textContent = '你是任务队员：选择任务结果';
      const s = document.createElement('button');
      s.className = 'av-btn';
      s.textContent = '任务成功';
      s.onclick = () => { if (ctx.isHost) submitMissionVote(myId, true); else Net.sendToHost({ type: 'av_mission', ok: true }); };
      const f = document.createElement('button');
      f.className = 'av-btn av-btn-no';
      f.textContent = '任务失败';
      f.onclick = () => { if (ctx.isHost) submitMissionVote(myId, false); else Net.sendToHost({ type: 'av_mission', ok: false }); };
      box.appendChild(s); box.appendChild(f);
      c.appendChild(box);
    }
    if (v.phase === 'assassinate' && myRole === 'assassin') {
      const box = document.createElement('div');
      box.className = 'av-panel av-danger';
      const title = document.createElement('div');
      title.textContent = '🗡️ 刺客：指认梅林';
      box.appendChild(title);
      const sel = document.createElement('div');
      sel.className = 'av-choose';
      (v.players || []).forEach(p => {
        const b = document.createElement('button');
        b.className = 'av-opt' + (localTarget === p.id ? ' on' : '');
        b.textContent = p.name;
        b.onclick = () => { localTarget = p.id; render(); };
        sel.appendChild(b);
      });
      box.appendChild(sel);
      const ok = document.createElement('button');
      ok.className = 'av-btn';
      ok.textContent = '刺杀';
      ok.onclick = () => {
        if (!localTarget) { UI.toast('请选择目标'); return; }
        const t = localTarget;
        localTarget = null;
        if (ctx.isHost) submitAssassinate(myId, t);
        else Net.sendToHost({ type: 'av_assassinate', targetId: t });
      };
      box.appendChild(ok);
      c.appendChild(box);
    }
    // 日志
    if (v.log && v.log.length) {
      const lg = document.createElement('div');
      lg.className = 'av-log';
      v.log.forEach(l => {
        const d = document.createElement('div');
        d.textContent = l;
        lg.appendChild(d);
      });
      c.appendChild(lg);
    }
    // 终局
    if (v.phase === 'ended' && v.winnerIds && v.winnerIds.length) {
      const w = document.createElement('div');
      w.className = 'av-end';
      w.textContent = '🏆 获胜阵营：' + (v.winnerIds.some(id => (v.players || []).find(p => p.id === id) && ROLE_INFO[state ? state.players.find(p => p.id === id)?.role : 'loyal']?.team === 'evil') ? '坏人阵营' : '好人阵营');
      c.appendChild(w);
      // 明牌
      if (ctx.isHost && state) {
        const reveal = document.createElement('div');
        reveal.className = 'av-see';
        reveal.textContent = '身份揭晓：' + state.players.map(p => p.name + '(' + roleName(p.role) + ')').join('、');
        c.appendChild(reveal);
      }
    }
  }

  return { init: function(c) {
      ctx = c;
      state = null; mirror = null; myRole = null; myEvils = []; myCandidates = []; localChoose = []; localVote = null; localMission = null; localTarget = null;
      if (ctx.isHost) hostStart();
      else render();
    }, handleMessage };
})();
