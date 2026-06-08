const http = require('http');
const https = require('node:https');
const fs = require('fs');
const path = require('path');

// 加载配置
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8'));
const PORT = config.port || 8899;
const TARGET = config.target;
const PRICE_BOARD_URL = config.priceBoard || 'https://trade.livetools.top/api/pool/price-board';
const REFERER = config.referer || '';
const CYCLE_START_HOUR = config.cycleStartHour || 4;

// 数据目录
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const dbPath = path.join(dataDir, 'nv.db');

let db; // sql.js Database 实例

// 保存数据库到文件
function saveDb() {
  const data = db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
}

// 初始化数据库
async function initDb() {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();

  if (fs.existsSync(dbPath)) {
    const buf = fs.readFileSync(dbPath);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }

  db.run('PRAGMA journal_mode = WAL');
  db.run(`
    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      plus_min INTEGER DEFAULT 0,
      plus_max INTEGER DEFAULT 0,
      plus_min_seller TEXT DEFAULT '',
      plus_max_seller TEXT DEFAULT '',
      team_min INTEGER DEFAULT 0,
      team_max INTEGER DEFAULT 0,
      team_min_seller TEXT DEFAULT '',
      team_max_seller TEXT DEFAULT '',
      seller_count INTEGER DEFAULT 0,
      cycle_start TEXT NOT NULL
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_cycle ON snapshots(cycle_start)');
  db.run('CREATE INDEX IF NOT EXISTS idx_ts ON snapshots(ts)');
  saveDb();
}

// 计算当前周期起始时间
function getCycleStart() {
  const now = new Date();
  const cycle = new Date(now);
  cycle.setHours(CYCLE_START_HOUR, 0, 0, 0);
  if (now < cycle) cycle.setDate(cycle.getDate() - 1);
  return cycle.toISOString();
}

// Cookie 存储
let COOKIE = '';
let COOKIE_SOURCE = '';

const COOKIE_FILE = path.join(__dirname, 'cookie.txt');

function loadCookieFromFile() {
  try {
    if (fs.existsSync(COOKIE_FILE)) {
      const content = fs.readFileSync(COOKIE_FILE, 'utf-8').trim();
      if (content) {
        COOKIE = content;
        COOKIE_SOURCE = 'file';
        console.log(`[Cookie] 从 cookie.txt 加载，长度: ${COOKIE.length}`);
        return true;
      }
    }
  } catch (e) {
    console.error(`[Cookie] 读取 cookie.txt 失败: ${e.message}`);
  }
  return false;
}

// HTTPS 请求
function httpsGet(url, cookie) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'accept': '*/*',
        'content-type': 'application/json',
        'cookie': cookie,
        'referer': REFERER,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
      },
    };
    https.get(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    }).on('error', reject);
  });
}

// MIME 类型
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

// 静态文件服务
function serveStatic(req, res) {
  let filePath = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url);
  filePath = path.normalize(filePath);
  if (!filePath.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403); return res.end('Forbidden');
  }
  if (!fs.existsSync(filePath)) {
    res.writeHead(404); return res.end('Not Found');
  }
  const ext = path.extname(filePath);
  const mime = MIME[ext] || 'application/octet-stream';
  const content = fs.readFileSync(filePath);
  res.writeHead(200, { 'Content-Type': mime });
  res.end(content);
}

// JSON 响应
function jsonResponse(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data));
}

// 解析请求体
function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve(null); }
    });
  });
}

// sql.js 查询辅助：返回对象数组
function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

// 从 sellers 数据中提取 Plus/Team 最高最低价
function extractPlanPrices(sellers) {
  const result = {
    plus_min: Infinity, plus_max: -Infinity, plus_min_seller: '', plus_max_seller: '',
    team_min: Infinity, team_max: -Infinity, team_min_seller: '', team_max_seller: '',
  };

  for (const s of sellers) {
    const prices = s.sale_plan_prices || {};
    const plusPrice = prices.plus?.min_cents;
    const teamPrice = prices.team?.min_cents;

    if (plusPrice != null) {
      if (plusPrice < result.plus_min) { result.plus_min = plusPrice; result.plus_min_seller = s.display_name || ''; }
      if (plusPrice > result.plus_max) { result.plus_max = plusPrice; result.plus_max_seller = s.display_name || ''; }
    }
    if (teamPrice != null) {
      if (teamPrice < result.team_min) { result.team_min = teamPrice; result.team_min_seller = s.display_name || ''; }
      if (teamPrice > result.team_max) { result.team_max = teamPrice; result.team_max_seller = s.display_name || ''; }
    }
  }

  if (result.plus_min === Infinity) { result.plus_min = 0; result.plus_max = 0; }
  if (result.team_min === Infinity) { result.team_min = 0; result.team_max = 0; }

  return result;
}

// HTTP 服务器
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // API: Cookie 状态
  if (url.pathname === '/api/status' && req.method === 'GET') {
    return jsonResponse(res, { hasCookie: COOKIE.length > 0, source: COOKIE_SOURCE, length: COOKIE.length });
  }

  // API: 设置 Cookie
  if (url.pathname === '/api/set-cookie' && req.method === 'POST') {
    const body = await parseBody(req);
    if (!body || !body.cookie || typeof body.cookie !== 'string') {
      return jsonResponse(res, { error: 'cookie 字段必填' }, 400);
    }
    COOKIE = body.cookie.trim();
    COOKIE_SOURCE = 'manual';
    try { fs.writeFileSync(COOKIE_FILE, COOKIE); } catch {}
    console.log(`[Cookie] 手动更新，长度: ${COOKIE.length}`);
    return jsonResponse(res, { ok: true, length: COOKIE.length, source: 'manual' });
  }

  // API: 从文件重新加载 Cookie
  if (url.pathname === '/api/reload-cookie' && req.method === 'POST') {
    const loaded = loadCookieFromFile();
    if (loaded) {
      return jsonResponse(res, { ok: true, length: COOKIE.length, source: 'file' });
    }
    return jsonResponse(res, { error: 'cookie.txt 不存在或为空' }, 404);
  }

  // API: 卖家列表代理
  if (url.pathname === '/api/sellers' && req.method === 'GET') {
    if (!COOKIE) {
      return jsonResponse(res, { error: 'Cookie 未设置，请先通过页面设置 Cookie' }, 401);
    }
    try {
      const result = await httpsGet(TARGET, COOKIE);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      return res.end(result.data);
    } catch (err) {
      return jsonResponse(res, { error: `请求失败: ${err.message}` }, 502);
    }
  }

  // API: 市场价格总览代理
  if (url.pathname === '/api/price-board' && req.method === 'GET') {
    if (!COOKIE) {
      return jsonResponse(res, { error: 'Cookie 未设置' }, 401);
    }
    try {
      const result = await httpsGet(PRICE_BOARD_URL, COOKIE);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      return res.end(result.data);
    } catch (err) {
      return jsonResponse(res, { error: `请求失败: ${err.message}` }, 502);
    }
  }

  // API: 记录快照
  if (url.pathname === '/api/snapshot' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      if (!body || !Array.isArray(body.sellers) || body.sellers.length === 0) {
        return jsonResponse(res, { error: 'sellers 数组必填且非空' }, 400);
      }

      const prices = extractPlanPrices(body.sellers);
      const cycleStart = getCycleStart();
      const ts = new Date().toISOString();

      db.run(
        `INSERT INTO snapshots (ts, plus_min, plus_max, plus_min_seller, plus_max_seller,
         team_min, team_max, team_min_seller, team_max_seller, seller_count, cycle_start)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [ts, prices.plus_min, prices.plus_max, prices.plus_min_seller, prices.plus_max_seller,
         prices.team_min, prices.team_max, prices.team_min_seller, prices.team_max_seller,
         body.sellers.length, cycleStart]
      );

      // 清理旧周期数据
      db.run('DELETE FROM snapshots WHERE cycle_start != ?', [cycleStart]);
      saveDb();

      return jsonResponse(res, { ok: true, ts, cycleStart, ...prices });
    } catch (err) {
      return jsonResponse(res, { error: `快照写入失败: ${err.message}` }, 500);
    }
  }

  // API: 图表数据
  if (url.pathname === '/api/chart-data' && req.method === 'GET') {
    try {
      const cycleStart = getCycleStart();
      const rows = queryAll(
        `SELECT ts, plus_min, plus_max, plus_min_seller, plus_max_seller,
         team_min, team_max, team_min_seller, team_max_seller, seller_count
         FROM snapshots WHERE cycle_start = ? ORDER BY ts ASC`,
        [cycleStart]
      );

      return jsonResponse(res, { cycleStart, data: rows });
    } catch (err) {
      return jsonResponse(res, { error: `查询失败: ${err.message}` }, 500);
    }
  }

  serveStatic(req, res);
});

// 启动
(async () => {
  await initDb();
  loadCookieFromFile();
  server.listen(PORT, () => {
    console.log(`\n  ========================================`);
    console.log(`  LiveTools 卖家监控面板`);
    console.log(`  Server running at http://localhost:${PORT}`);
    console.log(`  Open http://localhost:${PORT} in browser`);
    console.log(`  ========================================\n`);
  });
})();
