// 主控制：大厅、房间、消息路由、游戏分发
const GAME_REGISTRY = [
  { key: 'oldmaid',   name: '抽鬼牌',     icon: '👻', desc: '轮流抽牌凑对，最后拿到鬼牌的输', min: 2, max: 6, available: true,  module: () => OldMaid },
  { key: 'blackjack', name: '21点',       icon: '🃏', desc: '和庄家比点，看谁更接近 21 不爆', min: 2, max: 8, available: true,  module: () => Blackjack },
  { key: 'doudizhu',  name: '斗地主',     icon: '🎴', desc: '3 人国民玩法，敬请期待',           min: 3, max: 3, available: false },
  { key: 'memory',    name: '记忆翻牌',   icon: '🧠', desc: '2-4 人回合制记忆挑战，敬请期待',   min: 2, max: 4, available: false },
];

const App = (() => {
  let myName = localStorage.getItem('wc_name') || '';
  let roomCode = null;
  let isHost = false;
  let players = [];        // [{id,name,isHost}]
  let gameKey = null;
  let currentGame = null;
  let leaving = false;
  let solo = false;           // 单机人机模式
  let netState = { level: 'checking', title: '正在检测联机环境…', desc: '正在确认能否创建 / 加入房间…' };

  const nameInput = document.getElementById('name-input');

  // ---------- 屏幕切换 ----------
  function show(id) {
    ['screen-home', 'screen-room', 'screen-game'].forEach(s => {
      document.getElementById(s).classList.toggle('hidden', s !== id);
    });
  }

  function setBadges() {
    const conn = document.getElementById('conn-badge');
    const room = document.getElementById('room-badge');
    if (solo) {
      conn.textContent = '人机对战';
      conn.className = 'badge badge-solo';
      room.textContent = '单机';
      room.classList.remove('hidden');
    } else if (roomCode) {
      conn.textContent = '已连接';
      conn.className = 'badge badge-ok';
      room.textContent = '房间 ' + roomCode;
      room.classList.remove('hidden');
    } else {
      conn.textContent = '未连接';
      conn.className = 'badge badge-idle';
      room.classList.add('hidden');
    }
  }

  // ---------- 联机状态指示灯 ----------
  function setNetStatus(s) {
    netState = s;
    const box = document.getElementById('net-status');
    box.className = 'net-status is-' + s.level;
    document.getElementById('ns-title').textContent = s.title;
    document.getElementById('ns-desc').textContent = s.desc;

    const netEl = document.getElementById('ns-net');
    const nt = Net.describeNetwork();
    if (nt) { netEl.textContent = nt; netEl.classList.remove('hidden'); }
    else netEl.classList.add('hidden');

    const canPlay = s.level === 'ready';
    document.getElementById('btn-create').disabled = !canPlay;
    document.getElementById('btn-join').disabled = !canPlay;

    const hint = document.getElementById('net-hint');
    if (canPlay) {
      hint.classList.add('hidden');
    } else {
      hint.classList.remove('hidden');
      hint.textContent = s.level === 'checking'
        ? '检测结果出来后即可创建或加入房间'
        : '联机暂不可用（需要能访问配对服务）· 点「单机人机」可以立刻自己玩';
    }
  }

  let probing = false;
  function runProbe() {
    if (probing) return;
    probing = true;
    setNetStatus({ level: 'checking', title: '正在检测联机环境…', desc: '正在确认能否创建 / 加入房间…' });
    Net.probe(8000).then((r) => {
      probing = false;
      // 检测期间若已进入房间/对局，不覆盖房间态的徽标，仅记录结果
      setNetStatus(r);
      if (solo) setBadges();
    });
  }

  function ensureName() {
    if (!myName) {
      myName = '玩家' + Math.floor(1000 + Math.random() * 9000);
      nameInput.value = myName;
      localStorage.setItem('wc_name', myName);
    }
  }

  // ---------- 大厅 ----------
  function renderGrid() {
    const grid = document.getElementById('game-grid');
    UI.clear(grid);
    GAME_REGISTRY.forEach(g => {
      const card = document.createElement('div');
      card.className = 'game-card' + (g.available ? '' : ' disabled');
      card.innerHTML =
        '<div class="game-icon">' + g.icon + '</div>' +
        '<div class="game-name">' + g.name + '</div>' +
        '<div class="game-desc">' + UI.esc(g.desc) + '</div>' +
        '<span class="game-tag' + (g.available ? '' : ' soon') + '">' + (g.available ? g.min + '-' + g.max + ' 人' : '敬请期待') + '</span>' +
        (g.available ? '<span class="game-tag solo-tag">支持人机</span>' : '');
      if (g.available) card.addEventListener('click', () => openModePicker(g.key));
      grid.appendChild(card);
    });
  }

  // ---------- 模式选择：联机 or 人机 ----------
  // 点玩法卡片弹出：先选人数（人机数量），再决定是开联机房间还是直接人机开局。
  function openModePicker(key) {
    const def = GAME_REGISTRY.find(g => g.key === key);
    if (!def || !def.available) return;
    let count = Math.min(def.max, Math.max(def.min, def.min + 1));

    const opts = [];
    for (let n = def.min; n <= def.max; n++) opts.push(n);

    const html =
      '<div class="mode-block">' +
      '<div class="field-label">对局人数（含你）</div>' +
      '<div class="count-row" id="count-row">' +
      opts.map(n => '<button class="count-btn' + (n === count ? ' selected' : '') + '" data-n="' + n + '">' + n + '</button>').join('') +
      '</div>' +
      '<div class="mode-hint" id="mode-hint"></div>' +
      '</div>';

    const canOnline = netState.level === 'ready';
    const actions = [
      { label: '🤖 人机对战', primary: true, onClick: () => startSolo(key, Math.max(def.min, count) - 1) },
      { label: canOnline ? '创建联机房间' : '联机不可用', onClick: () => { if (canOnline) doCreate(key); } },
      { label: '取消' },
    ];

    UI.modal(def.icon + ' ' + def.name, html, actions);

    const hint = document.getElementById('mode-hint');
    const update = () => {
      hint.innerHTML = '你将与 <b>' + (count - 1) + '</b> 位机器人对战。' +
        (canOnline ? '也可以开房间叫朋友进来。' : '当前无法联机，只能人机。');
    };
    update();
    document.querySelectorAll('#count-row .count-btn').forEach(b => {
      b.addEventListener('click', () => {
        count = parseInt(b.dataset.n, 10);
        document.querySelectorAll('#count-row .count-btn').forEach(x => x.classList.toggle('selected', x === b));
        update();
      });
    });
  }

  function openSoloPicker() {
    const items = GAME_REGISTRY.filter(g => g.available);
    const html = '<div style="display:grid;gap:10px;">' + items.map(g =>
      '<button class="btn btn-ghost pick-solo" data-key="' + g.key + '" style="text-align:left;padding:12px 14px;justify-content:flex-start;">' +
      '<span style="font-size:20px;margin-right:10px;">' + g.icon + '</span>' +
      '<span><b>' + g.name + '</b><br><span style="font-size:12px;color:var(--ink-2);">' + UI.esc(g.desc) + ' · ' + g.min + '-' + g.max + ' 人</span></span>' +
      '</button>'
    ).join('') + '</div>';
    UI.modal('🤖 单机人机 · 选择玩法', html, [{ label: '取消' }]);
    document.querySelectorAll('.pick-solo').forEach(b => {
      b.addEventListener('click', () => { UI.closeModal(); openModePicker(b.dataset.key); });
    });
  }

  // ---------- 单机人机 ----------
  function startSolo(key, botCount) {
    const def = GAME_REGISTRY.find(g => g.key === key);
    if (!def || !def.available) return;
    ensureName();
    Net.enterLocal('me-' + Math.floor(Math.random() * 1e6));
    solo = true; isHost = true; roomCode = null; gameKey = key;
    botCount = Math.max(0, Math.min(def.max - 1, botCount));
    players = [{ id: Net.myId(), name: myName, isHost: true }];
    for (let i = 0; i < botCount; i++) {
      const bid = 'bot-' + (i + 1);
      players.push({ id: bid, name: Bot.nameFor(i), isHost: false, isBot: true });
      Net.registerBot(bid, Bot.create(key, bid, (msg) => onBotMessage(bid, msg)));
    }
    setBadges();
    startGame();
  }

  function onBotMessage(botId, msg) {
    if (currentGame) currentGame.handleMessage(botId, msg);
  }

  // ---------- 建房 / 加入 ----------
  function openCreatePicker() {
    const items = GAME_REGISTRY.filter(g => g.available);
    const html = '<div style="display:grid;gap:10px;">' + items.map(g =>
      '<button class="btn btn-ghost pick-game" data-key="' + g.key + '" style="text-align:left;padding:12px 14px;justify-content:flex-start;">' +
      '<span style="font-size:20px;margin-right:10px;">' + g.icon + '</span>' +
      '<span><b>' + g.name + '</b><br><span style="font-size:12px;color:var(--ink-2);">' + UI.esc(g.desc) + ' · ' + g.min + '-' + g.max + ' 人</span></span>' +
      '</button>'
    ).join('') + '</div>';
    UI.modal('创建联机房间 · 选择玩法', html, [{ label: '取消' }]);
    document.querySelectorAll('.pick-game').forEach(b => {
      b.addEventListener('click', () => { UI.closeModal(); doCreate(b.dataset.key); });
    });
  }

  async function doCreate(key) {
    const def = GAME_REGISTRY.find(g => g.key === key);
    if (!def || !def.available) return;
    ensureName();
    try {
      const { code } = await Net.createRoom();
      isHost = true; roomCode = code; gameKey = key; solo = false;
      players = [{ id: Net.myId(), name: myName, isHost: true }];
      setBadges();
      show('screen-room');
      renderRoom();
    } catch (e) {
      UI.toast(e.message || '创建失败');
    }
  }

  async function doJoin(code) {
    code = (code || '').trim().toUpperCase();
    if (code.length < 4) { UI.toast('请输入 4 位房间码'); return; }
    ensureName();
    const btn = document.getElementById('btn-join-go');
    btn.disabled = true;
    UI.toast('正在加入房间 ' + code + '…', 20000);
    try {
      await Net.joinRoom(code);
      isHost = false; roomCode = code; gameKey = null; players = []; solo = false;
      setBadges();
      show('screen-room');
      renderRoom();
      Net.sendToHost({ type: 'hello', name: myName });
    } catch (e) {
      UI.toast(e.message || '加入失败');
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- 房间 ----------
  function pushRoster() {
    Net.broadcast({ type: 'roster', players, game: gameKey });
  }

  function renderRoom() {
    document.getElementById('room-code').textContent = roomCode || '----';
    const def = GAME_REGISTRY.find(g => g.key === gameKey);
    document.getElementById('player-count').textContent = players.length;
    document.getElementById('player-max').textContent = def ? def.max : 6;

    const row = document.getElementById('game-select-row');
    UI.clear(row);
    GAME_REGISTRY.filter(g => g.available).forEach(g => {
      const chip = document.createElement('button');
      chip.className = 'chip' + (g.key === gameKey ? ' selected' : '');
      chip.textContent = g.icon + ' ' + g.name;
      if (isHost) {
        chip.addEventListener('click', () => { gameKey = g.key; pushRoster(); renderRoom(); });
      } else {
        chip.disabled = true;
      }
      row.appendChild(chip);
    });

    const list = document.getElementById('player-list');
    UI.clear(list);
    players.forEach(p => {
      const li = document.createElement('li');
      li.className = 'player-item';
      const av = UI.avatarEl(p.id, p.name);
      av.classList.add('player-avatar');
      li.appendChild(av);
      const nm = document.createElement('span');
      nm.className = 'player-name';
      nm.textContent = p.name + (p.id === Net.myId() ? '（你）' : '');
      li.appendChild(nm);
      if (p.isHost) {
        const role = document.createElement('span');
        role.className = 'player-role';
        role.textContent = '房主';
        li.appendChild(role);
      }
      list.appendChild(li);
    });

    const startBtn = document.getElementById('btn-start');
    if (isHost) {
      const ok = def && players.length >= def.min && players.length <= def.max;
      startBtn.disabled = !ok;
      startBtn.textContent = ok ? '开始游戏' : '等待玩家加入…';
    } else {
      startBtn.disabled = true;
      startBtn.textContent = '等待房主开始…';
    }
  }

  function hostStart() {
    if (!isHost) return;
    const def = GAME_REGISTRY.find(g => g.key === gameKey);
    if (!def) return;
    if (players.length < def.min || players.length > def.max) { UI.toast('人数不符合该玩法要求'); return; }
    Net.broadcast({ type: 'start', game: gameKey, players });
    startGame();
  }

  // ---------- 游戏 ----------
  function startGame() {
    const def = GAME_REGISTRY.find(g => g.key === gameKey);
    if (!def || !def.available) return;
    currentGame = def.module();
    show('screen-game');
    currentGame.init({
      container: document.getElementById('game-container'),
      players, myId: Net.myId(), isHost, gameType: gameKey, solo: !!solo,
      leave: gameLeave,
    });
  }

  function gameLeave() {
    if (solo) { endSolo(); return; }
    if (isHost) Net.broadcast({ type: 'back_to_room' });
    else Net.sendToHost({ type: 'game_leave' });
    returnToRoom();
  }

  function endSolo() {
    currentGame = null;
    Net.destroy();
    resetToHome();
  }

  function returnToRoom() {
    currentGame = null;
    show('screen-room');
    renderRoom();
  }

  function endGame() {
    if (isHost) Net.broadcast({ type: 'back_to_room' });
    returnToRoom();
  }

  // ---------- 网络消息 ----------
  function handleNetMessage(from, data) {
    if (!data || typeof data !== 'object') return;
    switch (data.type) {
      case 'hello': if (isHost) onGuestHello(from, data); break;
      case 'leave': if (isHost) onGuestLeave(from); break;
      case 'game_leave': if (isHost) endGame(); break;
      case 'roster': if (!isHost) { players = data.players; gameKey = data.game; renderRoom(); } break;
      case 'start': if (!isHost) { gameKey = data.game; players = data.players; startGame(); } break;
      case 'back_to_room': if (!isHost) returnToRoom(); break;
      case 'toast': UI.toast(data.text); break;
      case 'error':
        UI.toast(data.text);
        if (!isHost) { Net.destroy(); resetToHome(); }
        break;
      default:
        if (currentGame) currentGame.handleMessage(from, data);
    }
  }

  function onGuestHello(from, data) {
    if (players.some(p => p.id === from)) return;
    if (currentGame) { Net.sendTo(from, { type: 'error', text: '对局正在进行中，稍后再试' }); return; }
    const def = GAME_REGISTRY.find(g => g.key === gameKey);
    if (def && players.length >= def.max) { Net.sendTo(from, { type: 'error', text: '房间已满' }); return; }
    players.push({ id: from, name: data.name || '玩家', isHost: false });
    pushRoster();
    renderRoom();
  }

  function onGuestLeave(id) {
    if (!isHost) return;
    const existed = players.some(p => p.id === id);
    if (!existed) return;
    players = players.filter(p => p.id !== id);
    if (currentGame) endGame();
    pushRoster();
    renderRoom();
    UI.toast('有玩家离开了房间');
  }

  function leaveRoom() {
    leaving = true;
    if (!isHost) Net.sendToHost({ type: 'leave' });
    Net.destroy();
    resetToHome();
  }

  function resetToHome() {
    currentGame = null; players = []; gameKey = null; roomCode = null; isHost = false; solo = false;
    setBadges();
    show('screen-home');
    leaving = false;
  }

  function copyCode() {
    const t = roomCode || '';
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).then(() => UI.toast('已复制房间码')).catch(() => UI.toast(t));
    } else {
      UI.toast(t);
    }
  }

  // ---------- 初始化 ----------
  function init() {
    nameInput.value = myName;
    nameInput.addEventListener('input', () => {
      myName = nameInput.value.trim();
      localStorage.setItem('wc_name', myName);
    });

    document.getElementById('btn-create').addEventListener('click', () => {
      if (netState.level !== 'ready') { UI.toast('当前无法联机，可以先玩「单机人机」'); return; }
      openCreatePicker();
    });
    document.getElementById('btn-solo').addEventListener('click', openSoloPicker);
    document.getElementById('ns-retry').addEventListener('click', () => { probing = false; runProbe(); });
    document.getElementById('btn-join').addEventListener('click', () => {
      if (netState.level !== 'ready') { UI.toast('当前无法联机，可以先玩「单机人机」'); return; }
      document.getElementById('join-box').classList.toggle('hidden');
      document.getElementById('join-code').focus();
    });
    document.getElementById('btn-join-go').addEventListener('click', () => doJoin(document.getElementById('join-code').value));
    document.getElementById('join-code').addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(e.target.value); });
    document.getElementById('btn-copy').addEventListener('click', copyCode);
    document.getElementById('btn-start').addEventListener('click', hostStart);
    document.getElementById('btn-leave').addEventListener('click', leaveRoom);

    Net.on('msg', ({ from, data }) => handleNetMessage(from, data));
    Net.on('peer-leave', ({ id }) => onGuestLeave(id));
    Net.on('disconnect', () => {
      if (leaving) return;
      UI.toast('房主已离开，连接断开');
      resetToHome();
    });

    // 网络状态监听：上线/离线、回到前台、以及空闲时定期复检
    window.addEventListener('online', () => { probing = false; runProbe(); });
    window.addEventListener('offline', () => {
      setNetStatus({
        level: 'offline',
        title: '设备已离线',
        desc: '网络已断开，无法联机对战。重新连上 WiFi 后会自动检测；人机模式不受影响。',
      });
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && !roomCode && !solo && netState.level !== 'ready') { probing = false; runProbe(); }
    });
    setInterval(() => {
      if (document.hidden) return;
      if (roomCode || solo || isHost) return;   // 房间/对局中不打扰
      if (netState.level === 'ready') return;   // 已正常则不必频繁复检
      probing = false; runProbe();
    }, 20000);

    renderGrid();
    setBadges();
    setNetStatus(netState);
    runProbe();
    show('screen-home');
  }

  return { init };
})();

App.init();
