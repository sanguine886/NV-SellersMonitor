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

// Cookie 存储
let COOKIE = '';
let COOKIE_SOURCE = ''; // 'file' | 'manual'

const COOKIE_FILE = path.join(__dirname, 'cookie.txt');

// 启动时自动从 cookie.txt 加载
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

// HTTP 服务器
const server = http.createServer(async (req, res) => {
  // CORS
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

  // API: 设置 Cookie（手动输入，同时保存到 cookie.txt）
  if (url.pathname === '/api/set-cookie' && req.method === 'POST') {
    const body = await parseBody(req);
    if (!body || !body.cookie || typeof body.cookie !== 'string') {
      return jsonResponse(res, { error: 'cookie 字段必填' }, 400);
    }
    COOKIE = body.cookie.trim();
    COOKIE_SOURCE = 'manual';
    // 同步保存到文件，下次启动自动加载
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

  // 静态文件
  serveStatic(req, res);
});

// 启动
loadCookieFromFile();
server.listen(PORT, () => {
  console.log(`\n  ========================================`);
  console.log(`  LiveTools 卖家监控面板`);
  console.log(`  Server running at http://localhost:${PORT}`);
  console.log(`  Open http://localhost:${PORT} in browser`);
  console.log(`  ========================================\n`);
});
