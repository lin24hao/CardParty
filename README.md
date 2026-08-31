# WiFi 卡牌联机

一个纯前端（HTML + CSS + JS）的局域网卡牌游戏大厅。玩家连入同一个 WiFi 后，打开同一个网页即可建房/加入，一起抽鬼牌或玩 21 点。

## 技术特点

- **纯静态页面**：直接部署到 GitHub Pages，无需服务器。
- **局域网 P2P**：游戏数据走 WebRTC DataChannel，同一 WiFi 下直接点对点通信，延迟极低。
- **PeerJS 信令**：仅用于“找房间”配对；配对成功后不再依赖服务器。
- **自包含依赖**：PeerJS 库已本地化到 `js/vendor/`，不依赖外部 CDN。
- **移动端优先**：响应式布局，卡牌用纯 CSS/SVG 绘制。

## 玩法

### 抽鬼牌（2–6 人）

去掉黑桃 Q，51 张牌发完，各人先出掉手里的对子。然后轮流从下家抽牌：

1. **整理阶段**：被抽牌的人先调整手牌顺序（点两张牌交换位置），然后点「亮牌」。
2. **抽牌阶段**：抽牌的人点击对方一张背面牌，抽走该位置。
3. 抽到能凑对的牌就打出；最后手里剩下鬼牌的人输。

### 21 点（2–8 人）

与庄家比点数，越接近 21 且不爆为胜；A 可作 1 或 11。

## 本地预览

```bash
cd wifi-card-games
python -m http.server 8137 --bind 127.0.0.1
```

然后打开 http://127.0.0.1:8137。

## 部署到 GitHub Pages

1. 在 GitHub 新建一个空仓库（例如 `wifi-card-games`）。
2. 把本项目推送到仓库：
   ```bash
   git remote add origin https://github.com/my-username/wifi-card-games.git
   git push -u origin main
   ```
3. 进入仓库 **Settings → Pages**。
4. Source 选择 **Deploy from a branch**，Branch 选 `main` / `(root)`，保存。
5. 等待几分钟，访问 `https://my-username.github.io/wifi-card-games`。

> 建议把仓库名改成 `my-username.github.io`，这样可以直接用 `https://my-username.github.io/` 访问，地址更短。

## 现实中一起玩

1. 所有人连接**同一个 WiFi**（手机开热点也可以）。
2. 房主打开网页，点击「创建房间」并选择玩法。
3. 把 4 位房间码告诉其他人。
4. 其他人输入房间码加入，房主点击「开始游戏」。

### 手机热点注意事项

- **开热点的手机必须有移动数据（外网）**，因为配对阶段需要访问 PeerJS 云端信令。
- 配对成功后，出牌/发牌数据走热点局域网直连，几乎不耗流量。
- 部分安卓热点有「AP 隔离 / 客户端隔离」开关，打开后设备间不能互访，**必须关闭**。
- 必须 HTTPS：GitHub Pages 天然满足；本地用 `http://192.168.x.x` 测试会被浏览器拒绝。

## 项目结构

```
wifi-card-games/
├── index.html              # 入口页面
├── css/style.css           # 样式
├── js/
│   ├── vendor/peerjs.min.js # WebRTC 库
│   ├── deck.js             # 牌组/点数工具
│   ├── ui.js               # 通用 UI（卡牌、弹窗、头像）
│   ├── net.js              # PeerJS 网络层 + 联机状态检测
│   ├── bot.js              # 人机对战机器人
│   ├── main.js             # 大厅/房间/路由
│   └── games/
│       ├── oldmaid.js      # 抽鬼牌
│       └── blackjack.js    # 21 点
```

## 自定义与扩展

- **新增玩法**：在 `js/games/` 实现 `init(ctx)` 和 `handleMessage(from, data)` 接口，然后在 `js/main.js` 的 `GAME_REGISTRY` 注册。
- **切换信令服务器**：修改 `js/net.js` 中 `new Peer(...)` 的 `host`/`port`/`path`/`secure` 参数即可。
- **离线手动配对**：若希望热点无外网也能玩，需要实现 SDP 二维码/口令交换（绕过信令服务器）。

## 浏览器支持

需要支持 WebRTC 的现代浏览器：Chrome / Edge / Safari / Firefox。iOS Safari 可用，但建议保持前台。
