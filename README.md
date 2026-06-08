# NV-SellersMonitor

LiveTools 卖家监控面板 - 本地运行版

## 快速开始

```bash
# 安装依赖（仅 sql.js）
npm install

# 启动服务
node server.js

# 打开浏览器访问
# http://localhost:8899
```

## 配置说明

编辑 `config.json` 修改配置：

- `port` - 服务端口，默认 8899
- `target` - 目标 API 地址
- `priceBoard` - 市场价格总览 API 地址
- `referer` - 请求来源
- `cycleStartHour` - 每日起始小时（24小时制），默认 4

## Cookie 设置

支持两种方式：

1. **文件加载** — 在项目目录下创建 `cookie.txt`，粘贴完整 Cookie 内容，启动时自动读取
2. **手动输入** — 在页面输入框粘贴 Cookie，点"保存"后同步写入 `cookie.txt`

## 功能

- Cookie 管理（文件自动加载 / 手动输入）
- 市场价格总览（Plus / Team 计划）
- 卖家列表实时刷新（每 5 秒）
- Plus / Team 计划切换
- 卖家卡片展示（价格、库存、活跃率、可信度）
- Plus/Team 四线价格趋势图（最低价/最高价分开展示）
- SQLite 本地数据存储（`data/nv.db`），周期自动清理

## 依赖

- `sql.js` — 纯 JS/WASM 的 SQLite 实现，无需 C++ 编译环境
