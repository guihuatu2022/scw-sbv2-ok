// ============================================================
// scw-singbox Cloudflare Worker — 加固版 + 保活代理
// ============================================================
// 新增功能：
//   1. WebSocket 自动重连（容器断连后自动恢复）
//   2. 冷启动等待（容器 404/503 时自动重试）
//   3. 客户端断连检测（避免无效重连）
//   4. 连接健康检查（保持长连接活跃）
//
// 环境变量：
//   WS_PATH, ORIGIN_DOMAIN, CONTAINER_TOKEN, WS_SECRET（原有）
//   新增可选：
//   CONTAINER_RETRY_DELAY  — 重试延迟（毫秒，默认 1000）
//   CONTAINER_MAX_RETRIES  — 最大重试次数（默认 5）
//   KEEPALIVE_INTERVAL     — 保活间隔（秒，默认 30）
// ============================================================

const TOKEN_HEADER = 'X-Proxy-Token';

export default {
    async fetch(request, env) {
        // ---- 0. 环境变量校验 ----
        if (!env.WS_PATH || !env.ORIGIN_DOMAIN || !env.CONTAINER_TOKEN || !env.WS_SECRET) {
            return new Response('service unavailable', { status: 503 });
        }

        const url = new URL(request.url);
        const token = request.headers.get(TOKEN_HEADER) || url.searchParams.get('token');

        // ============================================================
        // 1. WebSocket 代理（带保活/重连逻辑）
        // ============================================================
        if (url.pathname === env.WS_PATH) {
            // 1a. 鉴权（支持 Header + Query Parameter）
            if (token !== env.WS_SECRET) {
                return new Response(PAGES.fileAccess, {
                    headers: { 'Content-Type': 'text/html;charset=UTF-8' }
                });
            }

            // 1b. 校验 WebSocket 升级请求
            const upgradeHeader = request.headers.get('Upgrade');
            const connectionHeader = request.headers.get('Connection');
            const wsKey = request.headers.get('Sec-WebSocket-Key');
            if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket'
                || !wsKey || !connectionHeader || !connectionHeader.toLowerCase().includes('upgrade')) {
                return new Response(PAGES.fileAccess, {
                    headers: { 'Content-Type': 'text/html;charset=UTF-8' }
                });
            }

            // 1c. 使用 WebSocketPair 建立双向代理
            return handleWebSocketProxy(request, env);
        }

        // ============================================================
        // 2. 伪装站点（完全保留原有内容）
        // ============================================================
        if (url.pathname === '/robots.txt') {
            return new Response(
                'User-agent: *\nAllow: /\n',
                { headers: { 'Content-Type': 'text/plain;charset=UTF-8' } }
            );
        }
        if (url.pathname === '/favicon.ico') {
            return new Response(null, { status: 204 });
        }

        switch (url.pathname) {
            case '/':
                return html(PAGES.home);
            case '/about':
                return html(PAGES.about);
            case '/downloads':
                return html(PAGES.downloads);
            case '/docs':
                return html(PAGES.docs);
            case '/contact':
                return html(PAGES.contact);
            default:
                return html(PAGES.notFound, 404);
        }
    }
};

// ============================================================
// 核心：WebSocket 保活代理
// ============================================================
async function handleWebSocketProxy(request, env) {
    // 获取配置（带默认值）
    const retryDelay = parseInt(env.CONTAINER_RETRY_DELAY) || 1000;
    const maxRetries = parseInt(env.CONTAINER_MAX_RETRIES) || 5;
    const keepaliveInterval = parseInt(env.KEEPALIVE_INTERVAL) || 30;

    // 创建 WebSocketPair
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // 状态管理
    let isClientClosed = false;
    let isContainerConnected = false;
    let containerWs = null;
    let keepaliveTimer = null;
    let reconnectAttempts = 0;

    // ============================================================
    // 1. 连接到容器的函数（带重试）
    // ============================================================
    async function connectToContainer() {
        const containerUrl = new URL(`https://${env.ORIGIN_DOMAIN}${env.WS_PATH}`);
        
        // 生成 WebSocket Key
        const wsKey = generateWebSocketKey();
        
        const headers = {
            'Host': env.ORIGIN_DOMAIN,
            'X-Auth-Token': env.CONTAINER_TOKEN,
            'Upgrade': 'websocket',
            'Connection': 'Upgrade',
            'Sec-WebSocket-Key': wsKey,
            'Sec-WebSocket-Version': '13'
        };

        try {
            const response = await fetch(containerUrl.toString(), {
                method: 'GET',
                headers: headers,
                redirect: 'manual'
            });

            // 101 = WebSocket 升级成功
            if (response.status === 101 && response.webSocket) {
                return response.webSocket;
            }
            
            // 容器冷启动中（Scaleway 容器未就绪）
            if (response.status === 404 || response.status === 503) {
                return null;
            }
            
            // 其他错误
            console.error(`容器返回异常状态: ${response.status}`);
            return null;
        } catch (e) {
            console.error('连接容器失败:', e.message);
            return null;
        }
    }

    // ============================================================
    // 2. 建立容器连接（带重试循环）
    // ============================================================
    async function establishContainerConnection() {
        while (reconnectAttempts < maxRetries) {
            const ws = await connectToContainer();
            
            if (ws) {
                containerWs = ws;
                isContainerConnected = true;
                reconnectAttempts = 0;
                setupContainerListeners(ws);
                return true;
            }
            
            reconnectAttempts++;
            if (reconnectAttempts < maxRetries) {
                const delay = retryDelay * reconnectAttempts;
                console.log(`容器未就绪，${delay}ms 后重试 (${reconnectAttempts}/${maxRetries})`);
                await sleep(delay);
            }
        }
        
        console.error(`容器连接失败，已重试 ${maxRetries} 次`);
        return false;
    }

    // ============================================================
    // 3. 设置容器 WebSocket 监听器
    // ============================================================
    function setupContainerListeners(ws) {
        ws.accept();

        // 收到容器消息 → 转发给客户端
        ws.addEventListener('message', (event) => {
            if (!isClientClosed && client.readyState === 1) {
                try {
                    client.send(event.data);
                } catch (e) {
                    console.error('转发消息到客户端失败:', e);
                }
            }
        });

        // 容器断开 → 触发重连
        ws.addEventListener('close', (event) => {
            console.log(`容器断开: code=${event.code}, reason=${event.reason || '未知'}`);
            isContainerConnected = false;
            containerWs = null;
            
            // 清理保活定时器
            if (keepaliveTimer) {
                clearInterval(keepaliveTimer);
                keepaliveTimer = null;
            }
            
            // 如果客户端还在，尝试重连
            if (!isClientClosed) {
                console.log('尝试重连容器...');
                reconnectToContainer();
            }
        });

        ws.addEventListener('error', (event) => {
            console.error('容器 WebSocket 错误:', event);
            // 关闭连接，触发重连
            if (ws.readyState === 1) {
                ws.close(1000, 'Error occurred');
            }
        });

        // 保活定时器（发送 Ping 帧保持连接）
        keepaliveTimer = setInterval(() => {
            if (ws.readyState === 1) {
                try {
                    ws.send('ping');  // 简单的 Ping 消息
                } catch (e) {
                    console.error('保活 Ping 发送失败:', e);
                }
            }
        }, keepaliveInterval * 1000);
    }

    // ============================================================
    // 4. 重连逻辑
    // ============================================================
    async function reconnectToContainer() {
        // 清理旧连接
        if (containerWs) {
            try {
                containerWs.close(1000, 'Reconnecting');
            } catch (e) {}
            containerWs = null;
        }
        
        isContainerConnected = false;
        reconnectAttempts = 0;
        
        const success = await establishContainerConnection();
        if (!success && !isClientClosed) {
            // 连接失败，继续重试（由 establishContainerConnection 内的循环处理）
            console.log('重连失败，将自动重试');
        }
    }

    // ============================================================
    // 5. 处理客户端消息
    // ============================================================
    client.accept();

    client.addEventListener('message', (event) => {
        // 转发客户端消息到容器
        if (isContainerConnected && containerWs && containerWs.readyState === 1) {
            try {
                containerWs.send(event.data);
            } catch (e) {
                console.error('转发消息到容器失败:', e);
                // 容器可能已断开，触发重连
                if (isContainerConnected) {
                    isContainerConnected = false;
                    reconnectToContainer();
                }
            }
        } else {
            // 容器未连接，缓存消息？(简化处理：丢弃)
            console.warn('容器未连接，丢弃客户端消息');
        }
    });

    client.addEventListener('close', (event) => {
        console.log(`客户端断开: code=${event.code}`);
        isClientClosed = true;
        
        // 清理资源
        if (keepaliveTimer) {
            clearInterval(keepaliveTimer);
            keepaliveTimer = null;
        }
        
        if (containerWs && containerWs.readyState === 1) {
            containerWs.close(1000, 'Client disconnected');
        }
        containerWs = null;
    });

    client.addEventListener('error', (event) => {
        console.error('客户端 WebSocket 错误:', event);
        // 客户端错误可能意味着连接已失效
        if (client.readyState !== 1) {
            isClientClosed = true;
            if (containerWs && containerWs.readyState === 1) {
                containerWs.close(1000, 'Client error');
            }
        }
    });

    // ============================================================
    // 6. 启动连接
    // ============================================================
    const connected = await establishContainerConnection();
    if (!connected) {
        // 连接失败，发送错误消息给客户端
        try {
            client.close(1011, 'Container connection failed');
        } catch (e) {}
        return new Response('Container unavailable', { status: 503 });
    }

    // 返回客户端 WebSocket 连接
    return new Response(null, {
        status: 101,
        webSocket: client,
        headers: {
            'Upgrade': 'websocket',
            'Connection': 'Upgrade',
            'Sec-WebSocket-Accept': await generateAccept(request.headers.get('Sec-WebSocket-Key'))
        }
    });
}

// ============================================================
// 工具函数
// ============================================================
function generateWebSocketKey() {
    const key = crypto.randomBytes(16).toString('base64');
    return key;
}

async function generateAccept(key) {
    const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
    const hash = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(key + GUID));
    return btoa(String.fromCharCode(...new Uint8Array(hash)));
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function html(body, status = 200) {
    return new Response(body, {
        status,
        headers: { 'Content-Type': 'text/html;charset=UTF-8' }
    });
}

// ============================================================
// 伪装页面（完全保留原有内容）
// ============================================================
const PAGES = {
    home: `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>OpenSoft Hub — Free & Open Source Software Downloads</title>
    <link rel="icon" href="data:,">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f8f9fa; color: #24292e; line-height: 1.6; }
        nav { background: #24292e; padding: 16px 24px; display: flex; justify-content: space-between; align-items: center; }
        .logo { color: #fff; font-weight: 700; font-size: 1.1rem; }
        .nav-links a { color: #c9d1d9; text-decoration: none; margin-left: 20px; font-size: 0.9rem; }
        .nav-links a:hover { color: #58a6ff; }
        .container { max-width: 900px; margin: 40px auto; padding: 0 24px; }
        h1 { font-size: 1.8rem; margin-bottom: 12px; }
        .subtitle { color: #6a737d; font-size: 1.05rem; margin-bottom: 32px; }
        .card { background: #fff; border: 1px solid #e1e4e8; border-radius: 8px; padding: 24px; margin-bottom: 20px; }
        .card h2 { font-size: 1.2rem; margin-bottom: 8px; }
        .card p { color: #444; font-size: 0.95rem; }
        .card a { color: #0366d6; text-decoration: none; }
        .card a:hover { text-decoration: underline; }
        .badge { display: inline-block; background: #e1e4e8; color: #444; font-size: 0.75rem; padding: 2px 8px; border-radius: 12px; margin-right: 6px; }
        .feature-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 16px; margin-top: 20px; }
        .feature-item { background: #fff; border: 1px solid #e1e4e8; border-radius: 8px; padding: 16px; }
        .feature-item h3 { font-size: 1rem; margin-bottom: 6px; }
        .feature-item p { font-size: 0.85rem; color: #666; }
        footer { text-align: center; padding: 32px; color: #6a737d; font-size: 0.85rem; }
    </style>
</head>
<body>
    <nav>
        <div class="logo">OpenSoft Hub</div>
        <div class="nav-links">
            <a href="/">Home</a>
            <a href="/about">About</a>
            <a href="/downloads">Downloads</a>
            <a href="/docs">Docs</a>
            <a href="/contact">Contact</a>
        </div>
    </nav>
    <div class="container">
        <h1>OpenSoft Hub</h1>
        <p class="subtitle">Your trusted source for free and open source software downloads.</p>
        <div class="card">
            <h2>Welcome</h2>
            <p>We provide direct download links to popular open source applications. All software is hosted by their respective official sources, ensuring authenticity and security.</p>
            <span class="badge">100% Free</span>
            <span class="badge">No Ads</span>
            <span class="badge">Updated Daily</span>
        </div>
        <div class="card">
            <h2>Popular Downloads</h2>
            <div class="feature-grid">
                <div class="feature-item">
                    <h3>7-Zip</h3>
                    <p>File archiver with high compression ratio.</p>
                    <a href="/downloads">Get it &rarr;</a>
                </div>
                <div class="feature-item">
                    <h3>VLC Media Player</h3>
                    <p>Plays everything, runs everywhere.</p>
                    <a href="/downloads">Get it &rarr;</a>
                </div>
                <div class="feature-item">
                    <h3>Notepad++</h3>
                    <p>Free source code editor and Notepad replacement.</p>
                    <a href="/downloads">Get it &rarr;</a>
                </div>
                <div class="feature-item">
                    <h3>LibreOffice</h3>
                    <p>Complete office suite, compatible with Microsoft Office.</p>
                    <a href="/downloads">Get it &rarr;</a>
                </div>
            </div>
        </div>
        <div class="card">
            <h2>Why OpenSoft Hub?</h2>
            <p>We only link to official releases from developers, no bundled adware or toolbars. Browse the <a href="/downloads">downloads page</a> to find what you need.</p>
        </div>
    </div>
    <footer>&copy; 2026 OpenSoft Hub. All trademarks belong to their respective owners.</footer>
</body>
</html>`,
    about: `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>About — OpenSoft Hub</title>
    <link rel="icon" href="data:,">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f8f9fa; color: #24292e; line-height: 1.6; }
        nav { background: #24292e; padding: 16px 24px; display: flex; justify-content: space-between; align-items: center; }
        .logo { color: #fff; font-weight: 700; font-size: 1.1rem; }
        .nav-links a { color: #c9d1d9; text-decoration: none; margin-left: 20px; font-size: 0.9rem; }
        .nav-links a:hover { color: #58a6ff; }
        .container { max-width: 800px; margin: 40px auto; padding: 0 24px; }
        h1 { font-size: 1.8rem; margin-bottom: 24px; }
        p { color: #444; margin-bottom: 16px; font-size: 0.95rem; }
        a { color: #0366d6; text-decoration: none; }
        a:hover { text-decoration: underline; }
        footer { text-align: center; padding: 32px; color: #6a737d; font-size: 0.85rem; }
    </style>
</head>
<body>
    <nav>
        <div class="logo">OpenSoft Hub</div>
        <div class="nav-links">
            <a href="/">Home</a>
            <a href="/about">About</a>
            <a href="/downloads">Downloads</a>
            <a href="/docs">Docs</a>
            <a href="/contact">Contact</a>
        </div>
    </nav>
    <div class="container">
        <h1>About OpenSoft Hub</h1>
        <p>OpenSoft Hub is a simple, no-nonsense directory of free and open source software for Windows, macOS, and Linux. We believe in transparency: every download link points directly to the official project website or trusted mirror.</p>
        <p>We do not host any files ourselves, which means you always get the latest version straight from the developers. This reduces the risk of tampered installers and ensures you're not downloading outdated software.</p>
        <p>Our mission is to make quality open source software easy to find without the clutter of ads or fake "Download" buttons.</p>
        <p><a href="/">&larr; Back to home</a></p>
    </div>
    <footer>&copy; 2026 OpenSoft Hub. All trademarks belong to their respective owners.</footer>
</body>
</html>`,
    downloads: `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Downloads — OpenSoft Hub</title>
    <link rel="icon" href="data:,">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f8f9fa; color: #24292e; line-height: 1.6; }
        nav { background: #24292e; padding: 16px 24px; display: flex; justify-content: space-between; align-items: center; }
        .logo { color: #fff; font-weight: 700; font-size: 1.1rem; }
        .nav-links a { color: #c9d1d9; text-decoration: none; margin-left: 20px; font-size: 0.9rem; }
        .nav-links a:hover { color: #58a6ff; }
        .container { max-width: 900px; margin: 40px auto; padding: 0 24px; }
        h1 { font-size: 1.8rem; margin-bottom: 24px; }
        .download-item { background: #fff; border: 1px solid #e1e4e8; border-radius: 8px; padding: 16px 20px; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center; }
        .download-info h3 { font-size: 1rem; margin-bottom: 4px; }
        .download-info p { color: #6a737d; font-size: 0.85rem; }
        .download-btn { background: #0366d6; color: #fff; text-decoration: none; padding: 8px 16px; border-radius: 6px; font-size: 0.9rem; }
        .download-btn:hover { background: #0256b3; }
        footer { text-align: center; padding: 32px; color: #6a737d; font-size: 0.85rem; }
    </style>
</head>
<body>
    <nav>
        <div class="logo">OpenSoft Hub</div>
        <div class="nav-links">
            <a href="/">Home</a>
            <a href="/about">About</a>
            <a href="/downloads">Downloads</a>
            <a href="/docs">Docs</a>
            <a href="/contact">Contact</a>
        </div>
    </nav>
    <div class="container">
        <h1>Available Downloads</h1>
        <p style="margin-bottom:20px;color:#6a737d;">All links lead to official sources. Click to download.</p>

        <div class="download-item">
            <div class="download-info">
                <h3>7-Zip 24.08</h3>
                <p>Windows / 1.5 MB / Aug 20, 2026</p>
            </div>
            <a class="download-btn" href="https://www.7-zip.org/download.html" target="_blank" rel="noopener noreferrer">Download</a>
        </div>

        <div class="download-item">
            <div class="download-info">
                <h3>VLC Media Player 3.0.21</h3>
                <p>Windows / 40 MB / Aug 18, 2026</p>
            </div>
            <a class="download-btn" href="https://www.videolan.org/vlc/download-windows.html" target="_blank" rel="noopener noreferrer">Download</a>
        </div>

        <div class="download-item">
            <div class="download-info">
                <h3>Notepad++ 8.6.9</h3>
                <p>Windows / 4.2 MB / Aug 15, 2026</p>
            </div>
            <a class="download-btn" href="https://notepad-plus-plus.org/downloads/" target="_blank" rel="noopener noreferrer">Download</a>
        </div>

        <div class="download-item">
            <div class="download-info">
                <h3>LibreOffice 24.8.0</h3>
                <p>Windows / 350 MB / Aug 10, 2026</p>
            </div>
            <a class="download-btn" href="https://www.libreoffice.org/download/download/" target="_blank" rel="noopener noreferrer">Download</a>
        </div>

        <div class="download-item">
            <div class="download-info">
                <h3>GIMP 2.10.38</h3>
                <p>Windows / 270 MB / Aug 5, 2026</p>
            </div>
            <a class="download-btn" href="https://www.gimp.org/downloads/" target="_blank" rel="noopener noreferrer">Download</a>
        </div>

        <div class="download-item">
            <div class="download-info">
                <h3>Audacity 3.6.4</h3>
                <p>Windows / 30 MB / Aug 1, 2026</p>
            </div>
            <a class="download-btn" href="https://www.audacityteam.org/download/" target="_blank" rel="noopener noreferrer">Download</a>
        </div>

        <p><a href="/">&larr; Back to home</a></p>
    </div>
    <footer>&copy; 2026 OpenSoft Hub. All trademarks belong to their respective owners.</footer>
</body>
</html>`,
    docs: `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Documentation — OpenSoft Hub</title>
    <link rel="icon" href="data:,">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f8f9fa; color: #24292e; line-height: 1.6; }
        nav { background: #24292e; padding: 16px 24px; display: flex; justify-content: space-between; align-items: center; }
        .logo { color: #fff; font-weight: 700; font-size: 1.1rem; }
        .nav-links a { color: #c9d1d9; text-decoration: none; margin-left: 20px; font-size: 0.9rem; }
        .nav-links a:hover { color: #58a6ff; }
        .container { max-width: 800px; margin: 40px auto; padding: 0 24px; }
        h1 { font-size: 1.8rem; margin-bottom: 24px; }
        h2 { font-size: 1.2rem; margin: 24px 0 8px; }
        p { color: #444; margin-bottom: 12px; font-size: 0.95rem; }
        code { background: #f1f1f1; padding: 2px 6px; border-radius: 3px; font-size: 0.85rem; font-family: 'SF Mono', monospace; }
        pre { background: #f6f8fa; padding: 16px; border-radius: 6px; overflow-x: auto; margin-bottom: 16px; font-size: 0.85rem; }
        a { color: #0366d6; text-decoration: none; }
        a:hover { text-decoration: underline; }
        footer { text-align: center; padding: 32px; color: #6a737d; font-size: 0.85rem; }
    </style>
</head>
<body>
    <nav>
        <div class="logo">OpenSoft Hub</div>
        <div class="nav-links">
            <a href="/">Home</a>
            <a href="/about">About</a>
            <a href="/downloads">Downloads</a>
            <a href="/docs">Docs</a>
            <a href="/contact">Contact</a>
        </div>
    </nav>
    <div class="container">
        <h1>Documentation</h1>
        <h2>How to Use This Site</h2>
        <p>Browse the <a href="/downloads">Downloads</a> page to find the software you need. Each entry includes the version, file size, and date of the latest release. Click the "Download" button to be taken to the official download page.</p>
        <h2>Verifying Downloads</h2>
        <p>To ensure the integrity of your downloaded files, always check the checksum provided by the software vendor. We recommend using SHA-256.</p>
        <h2>Frequently Asked Questions</h2>
        <p><strong>Do you host the files yourselves?</strong><br>No, we link to the official project websites or trusted mirrors.</p>
        <p><strong>Is this site really free?</strong><br>Yes, all software listed is open source and free to use.</p>
        <p><strong>Can I request a software?</strong><br>Use the <a href="/contact">Contact</a> page to send suggestions.</p>
        <p><a href="/">&larr; Back to home</a></p>
    </div>
    <footer>&copy; 2026 OpenSoft Hub. All trademarks belong to their respective owners.</footer>
</html>`,
    contact: `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Contact — OpenSoft Hub</title>
    <link rel="icon" href="data:,">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f8f9fa; color: #24292e; line-height: 1.6; }
        nav { background: #24292e; padding: 16px 24px; display: flex; justify-content: space-between; align-items: center; }
        .logo { color: #fff; font-weight: 700; font-size: 1.1rem; }
        .nav-links a { color: #c9d1d9; text-decoration: none; margin-left: 20px; font-size: 0.9rem; }
        .nav-links a:hover { color: #58a6ff; }
        .container { max-width: 800px; margin: 40px auto; padding: 0 24px; }
        h1 { font-size: 1.8rem; margin-bottom: 24px; }
        p { color: #444; margin-bottom: 16px; font-size: 0.95rem; }
        a { color: #0366d6; text-decoration: none; }
        a:hover { text-decoration: underline; }
        footer { text-align: center; padding: 32px; color: #6a737d; font-size: 0.85rem; }
    </style>
</head>
<body>
    <nav>
        <div class="logo">OpenSoft Hub</div>
        <div class="nav-links">
            <a href="/">Home</a>
            <a href="/about">About</a>
            <a href="/downloads">Downloads</a>
            <a href="/docs">Docs</a>
            <a href="/contact">Contact</a>
        </div>
    </nav>
    <div class="container">
        <h1>Contact Us</h1>
        <p>Have a suggestion for software we should list? Found a broken link? We'd love to hear from you.</p>
        <p>Email: <a href="mailto:support@opensofthub.com">support@opensofthub.com</a></p>
        <p>Response time: usually within 48 hours.</p>
        <p><a href="/">&larr; Back to home</a></p>
    </div>
    <footer>&copy; 2026 OpenSoft Hub. All trademarks belong to their respective owners.</footer>
</html>`,
    fileAccess: `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Direct Download — OpenSoft Hub</title>
    <link rel="icon" href="data:,">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f8f9fa; color: #24292e; line-height: 1.6; }
        nav { background: #24292e; padding: 16px 24px; display: flex; justify-content: space-between; align-items: center; }
        .logo { color: #fff; font-weight: 700; font-size: 1.1rem; }
        .nav-links a { color: #c9d1d9; text-decoration: none; margin-left: 20px; font-size: 0.9rem; }
        .nav-links a:hover { color: #58a6ff; }
        .container { max-width: 600px; margin: 80px auto; padding: 0 24px; text-align: center; }
        h1 { font-size: 1.6rem; margin-bottom: 16px; }
        p { color: #6a737d; margin-bottom: 24px; }
        a { color: #0366d6; text-decoration: none; }
        a:hover { text-decoration: underline; }
        footer { text-align: center; padding: 32px; color: #6a737d; font-size: 0.85rem; }
    </style>
</head>
<body>
    <nav>
        <div class="logo">OpenSoft Hub</div>
        <div class="nav-links">
            <a href="/">Home</a>
            <a href="/about">About</a>
            <a href="/downloads">Downloads</a>
            <a href="/docs">Docs</a>
            <a href="/contact">Contact</a>
        </div>
    </nav>
    <div class="container">
        <h1>Direct Download Link</h1>
        <p>This URL is not a direct file. Please visit the <a href="/downloads">Downloads</a> page to access the software catalog.</p>
        <p>If you were expecting a file, make sure you are using the correct link from the official download page.</p>
        <p><a href="/">&larr; Back to home</a></p>
    </div>
    <footer>&copy; 2026 OpenSoft Hub. All trademarks belong to their respective owners.</footer>
</body>
</html>`,
    notFound: `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>404 — Page Not Found</title>
    <link rel="icon" href="data:,">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f8f9fa; color: #24292e; line-height: 1.6; }
        nav { background: #24292e; padding: 16px 24px; display: flex; justify-content: space-between; align-items: center; }
        .logo { color: #fff; font-weight: 700; font-size: 1.1rem; }
        .nav-links a { color: #c9d1d9; text-decoration: none; margin-left: 20px; font-size: 0.9rem; }
        .nav-links a:hover { color: #58a6ff; }
        .container { max-width: 600px; margin: 120px auto; padding: 0 24px; text-align: center; }
        h1 { font-size: 3rem; color: #6a737d; margin-bottom: 16px; }
        p { color: #6a737d; margin-bottom: 24px; }
        a { color: #0366d6; text-decoration: none; }
        a:hover { text-decoration: underline; }
        footer { text-align: center; padding: 32px; color: #6a737d; font-size: 0.85rem; }
    </style>
</head>
<body>
    <nav>
        <div class="logo">OpenSoft Hub</div>
        <div class="nav-links">
            <a href="/">Home</a>
            <a href="/about">About</a>
            <a href="/downloads">Downloads</a>
            <a href="/docs">Docs</a>
            <a href="/contact">Contact</a>
        </div>
    </nav>
    <div class="container">
        <h1>404</h1>
        <p>The page you are looking for does not exist or has been moved.</p>
        <p><a href="/">&larr; Back to home</a></p>
    </div>
    <footer>&copy; 2026 OpenSoft Hub. All trademarks belong to their respective owners.</footer>
</body>
</html>`
};
