// 网络层：基于 PeerJS 的星型主机权威架构
// 主机(建房者)是中心节点，客机连接到主机；游戏数据走 WebRTC 数据通道（同 WiFi 下即局域网 P2P）。
//
// 默认使用 PeerJS 免费云端信令（0.peerjs.com）完成“找房间”配对。
// 若要自建信令，替换 createRoom/joinRoom 中的 Peer 构造参数即可，例如：
//   new Peer(id, { host: 'your-domain.com', port: 443, path: '/', secure: true })
const Net = (() => {
  let peer = null;
  let hostFlag = false;
  let roomCode = null;
  let myId = null;
  let conns = new Map();      // 主机侧：guestId -> DataConnection
  let hostConn = null;        // 客机侧：到主机的连接
  let bots = new Map();       // 单机模式：botId -> onData(msg)
  let localMode = false;      // 单机（人机）模式标记
  const handlers = {};

  const PEER_DEBUG = 0;

  function on(type, fn) { (handlers[type] = handlers[type] || []).push(fn); }
  function emit(type, data) { (handlers[type] || []).forEach(fn => fn(data)); }

  function makeRoomCode() {
    const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // 去掉易混淆的 0/O/1/I
    let s = '';
    for (let i = 0; i < 4; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
    return s;
  }

  function sendToHost(msg) { if (hostConn && hostConn.open) hostConn.send(msg); }
  function sendTo(playerId, msg) {
    if (bots.has(playerId)) { setTimeout(() => { const fn = bots.get(playerId); fn && fn(msg); }, 0); return; }
    const c = conns.get(playerId); if (c && c.open) c.send(msg);
  }
  function broadcast(msg, exceptId) {
    conns.forEach((c, id) => { if (c.open && id !== exceptId) c.send(msg); });
    bots.forEach((fn, id) => { if (id !== exceptId) setTimeout(() => fn && fn(msg), 0); });
  }

  // 注册一个本地机器人（单机人机模式）。onData 收到主机广播的消息。
  function registerBot(id, onData) { bots.set(id, onData); }
  function unregisterBots() { bots.clear(); }

  // 进入单机（人机）模式：本机即主机，但不建立任何网络连接
  function enterLocal(id) {
    destroy();
    localMode = true;
    hostFlag = true;
    myId = id || ('local-' + Math.floor(Math.random() * 1e6));
    bots.clear();
  }

  function destroy() {
    try { peer && peer.destroy(); } catch (e) {}
    peer = null; hostConn = null; conns.clear(); bots.clear();
    hostFlag = false; roomCode = null; myId = null; localMode = false;
  }

  // ---------- 网络体检 ----------
  // 判定当前设备是否具备联机条件：
  //  1) 浏览器是否支持 WebRTC
  //  2) navigator.onLine 是否为 true
  //  3) 能否真正连上 PeerJS 信令服务器（决定能否创建/发现房间）
  // 返回 { level, title, desc, reason }
  //   level: 'ready' | 'checking' | 'offline' | 'blocked' | 'unsupported'
  function detectEnvironment() {
    if (typeof RTCPeerConnection === 'undefined' && typeof webkitRTCPeerConnection === 'undefined') {
      return { level: 'unsupported', title: '浏览器不支持联机', desc: '当前浏览器不支持 WebRTC，无法联机对战，但可以玩人机模式。', reason: 'no-webrtc' };
    }
    if (typeof Peer === 'undefined') {
      return { level: 'unsupported', title: '联机组件未加载', desc: '未检测到 PeerJS，请检查网络后刷新页面重试。', reason: 'no-peerjs' };
    }
    if (!navigator.onLine) {
      return { level: 'offline', title: '设备处于离线状态', desc: '请先连上 WiFi 或打开移动数据。离线也能玩人机模式。', reason: 'offline' };
    }
    return null; // 需要进一步探测信令服务器
  }

  function describeNetwork() {
    const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (!c) return null;
    const map = { wifi: 'WiFi', ethernet: '有线网络', cellular: '移动数据', wimax: 'WiMax', other: '网络', none: '无网络' };
    const t = c.type ? (map[c.type] || c.type) : null;
    const eff = c.effectiveType ? String(c.effectiveType).toUpperCase() : null;
    if (t && eff) return t + '（' + eff + '）';
    return t || (eff ? eff : null);
  }

  // 主动探测信令服务器：创建一个临时匿名 Peer，成功 open 即视为可联机
  function probe(timeoutMs = 8000) {
    const env = detectEnvironment();
    if (env) return Promise.resolve(env);
    return new Promise((resolve) => {
      let settled = false;
      let p = null;
      const finish = (r) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { p && p.destroy(); } catch (e) {}
        resolve(r);
      };
      const timer = setTimeout(() => finish({
        level: 'blocked',
        title: '连不上配对服务',
        desc: '设备有网络，但无法访问配对服务器（可能是该 WiFi 无外网、代理或防火墙拦截）。人机模式不受影响。',
        reason: 'timeout',
      }), timeoutMs);

      try {
        p = new Peer({ debug: 0 });
      } catch (e) {
        finish({ level: 'blocked', title: '联机初始化失败', desc: '创建联机实例失败：' + (e && e.message ? e.message : '未知错误'), reason: 'init-failed' });
        return;
      }
      p.on('open', () => finish({
        level: 'ready',
        title: '可以联机对战',
        desc: '网络正常，配对服务已连通 · 现在可以创建或加入房间',
        reason: 'ok',
      }));
      p.on('error', (err) => {
        const t = err && err.type;
        if (t === 'browser-incompatible') {
          finish({ level: 'unsupported', title: '浏览器不支持联机', desc: '当前浏览器不支持 WebRTC，可以玩人机模式。', reason: t });
        } else if (t === 'network' || t === 'server-error' || t === 'socket-error' || t === 'socket-closed' || t === 'ssl-unavailable' || t === 'invalid-key') {
          finish({ level: 'blocked', title: '连不上配对服务', desc: '配对服务器无响应（' + t + '）。若当前 WiFi 无外网，联机将不可用；人机模式不受影响。', reason: t });
        } else {
          finish({ level: 'blocked', title: '联机暂时不可用', desc: '配对失败：' + (t || '未知错误') + '。可以稍后重测，或先玩人机模式。', reason: t || 'error' });
        }
      });
    });
  }

  function createRoom() {
    destroy();
    return new Promise((resolve, reject) => {
      tryCreate();
      function tryCreate() {
        const code = makeRoomCode();
        const p = new Peer(code, { debug: PEER_DEBUG });
        let settled = false;
        p.on('open', (id) => {
          if (settled) return;
          settled = true;
          peer = p; hostFlag = true; roomCode = id; myId = id;
          attachHostListeners();
          resolve({ code: id });
        });
        p.on('error', (err) => {
          if (settled) return;
          if (err.type === 'unavailable-id') { p.destroy(); tryCreate(); }
          else { settled = true; reject(new Error('创建房间失败：' + (err.type || err.message || '网络错误'))); }
        });
      }
    });
  }

  function joinRoom(code, opts = {}) {
    const target = code.trim().toUpperCase();
    const maxAttempts = opts.attempts || 3;
    const connectTimeout = opts.connectTimeout || 12000;
    const retryDelay = opts.retryDelay || 2200;

    destroy();
    return new Promise((resolve, reject) => {
      let p = null;
      let settled = false;
      let attempt = 0;
      let timer = null;
      let currentConn = null;

      function describe(reason) {
        if (reason === 'timeout') return '连接房间超时，请确认房主已创建房间且网络正常';
        if (reason === 'peer-unavailable') return '找不到该房间，请核对房间码并确认房主还在房间内';
        if (reason === 'network') return '房间连接失败（网络错误），请重试';
        return '连接房间失败：' + (reason || '未知错误');
      }

      function fail(reason) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { currentConn && currentConn.close(); } catch (e) {}
        try { p && p.destroy(); } catch (e) {}
        reject(new Error(describe(reason)));
      }

      function doRetry(reason) {
        if (settled) return;
        clearTimeout(timer);
        try { currentConn && currentConn.close(); } catch (e) {}
        if (attempt >= maxAttempts) { fail(reason); return; }
        setTimeout(tryConnect, retryDelay);
      }

      function tryConnect() {
        if (settled) return;
        attempt++;
        let connSettled = false;
        const conn = p.connect(target, { reliable: true });
        currentConn = conn;

        timer = setTimeout(() => {
          if (connSettled || settled) return;
          connSettled = true;
          doRetry('timeout');
        }, connectTimeout);

        conn.on('open', () => {
          if (settled || connSettled) return;
          connSettled = true;
          clearTimeout(timer);
          settled = true;
          peer = p; hostFlag = false; roomCode = target; hostConn = conn;
          resolve({ id: myId });
        });
        conn.on('data', (d) => emit('msg', { from: null, data: d }));
        conn.on('close', () => { if (!settled) return; emit('disconnect'); });
        conn.on('error', (e) => {
          if (connSettled || settled) return;
          connSettled = true;
          doRetry(e && e.type);
        });
      }

      try {
        p = new Peer({ debug: PEER_DEBUG });
      } catch (e) {
        fail('init');
        return;
      }
      p.on('open', (id) => { myId = id; tryConnect(); });
      p.on('error', (err) => {
        const t = err && err.type;
        if (t === 'peer-unavailable') {
          // 目标房间暂时不可见，交给 connect 的重试/超时逻辑处理
          if (attempt >= maxAttempts) fail('peer-unavailable');
          return;
        }
        if (t === 'unavailable-id') { fail('peer-unavailable'); return; }
        fail(t || 'network');
      });
    });
  }

  function attachHostListeners() {
    peer.on('connection', (conn) => {
      conn.on('open', () => {
        conns.set(conn.peer, conn);
        conn.on('data', (d) => emit('msg', { from: conn.peer, data: d }));
        conn.on('close', () => {
          conns.delete(conn.peer);
          emit('peer-leave', { id: conn.peer });
        });
      });
      conn.on('error', () => {});
    });
  }

  return {
    on, emit,
    createRoom, joinRoom, destroy,
    sendToHost, sendTo, broadcast,
    registerBot, unregisterBots, enterLocal,
    probe, detectEnvironment, describeNetwork,
    isHost: () => hostFlag,
    isLocal: () => localMode,
    isBot: (id) => bots.has(id),
    roomCode: () => roomCode,
    myId: () => myId,
    listPeers: () => Array.from(conns.keys()),
  };
})();
