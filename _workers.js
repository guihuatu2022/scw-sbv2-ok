// scw-singbox Cloudflare Worker — 加固版
// 配合 scw-singbox 项目使用：VLESS+WS 反代 + 多页面伪装站
// 新增：共享密钥闸门（防未授权激活容器）、Private 容器鉴权头、env 校验、robots/favicon
//
// 需要在 Worker Settings → Variables 中配置：
//   WS_PATH         — WebSocket 路径，必须与 Scaleway 容器的 WS_PATH 完全一致
//   ORIGIN_DOMAIN   — Scaleway 容器分配的域名（如 xxx.functions.fnc.fr-par.scw.cloud）
//   CONTAINER_TOKEN — Scaleway Private 容器的 IAM API Key secret（X-Auth-Token），用于鉴权放行
//   WS_SECRET       — 共享密钥，客户端 WS 请求需带 X-Proxy-Token 头且值与此一致才放行
// 建议 ORIGIN_DOMAIN / CONTAINER_TOKEN / WS_SECRET 均设为 Secret（加密存储）。

const TOKEN_HEADER = 'X-Proxy-Token';

export default {
    async fetch(request, env) {
        // ---- 0. 环境变量校验：缺失直接 503，避免反代到 undefined ----
        if (!env.WS_PATH || !env.ORIGIN_DOMAIN || !env.CONTAINER_TOKEN || !env.WS_SECRET) {
            return new Response('service unavailable', { status: 503 });
        }

        let url = new URL(request.url);

        // ============================================================
        // 1. 核心代理逻辑：仅转发带共享密钥的合法 WebSocket 升级请求
        // ============================================================
        if (url.pathname === env.WS_PATH) {
            // 1a. 共享密钥闸门：无凭据的请求一律返回伪装页，不转发到容器
            //     → 阻止爬虫/主动探测命中 WS 路径导致容器冷启动（成本 & 隐蔽）
            if (request.headers.get(TOKEN_HEADER) !== env.WS_SECRET) {
                return new Response(PAGES.fileAccess, {
                    headers: { 'Content-Type': 'text/html;charset=UTF-8' }
                });
            }

            // 1b. 校验是否为完整的 WebSocket 升级请求
            const upgradeHeader = request.headers.get('Upgrade');
            const connectionHeader = request.headers.get('Connection');
            const wsKey = request.headers.get('Sec-WebSocket-Key');
            if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket'
                || !wsKey || !connectionHeader || !connectionHeader.toLowerCase().includes('upgrade')) {
                // 普通 GET 命中 WS 路径（已带密钥但非 WS）→ 返回与下载上下文一致的页面
                return new Response(PAGES.fileAccess, {
                    headers: { 'Content-Type': 'text/html;charset=UTF-8' }
                });
            }

            // 1c. 合法 WS 升级 → 反代到 Scaleway Private 容器
            url.protocol = 'https:';
            url.hostname = env.ORIGIN_DOMAIN;

            let newHeaders = new Headers(request.headers);
            newHeaders.set('Host', env.ORIGIN_DOMAIN);            // 覆写 Host，过 Scaleway 网关
            newHeaders.set('X-Auth-Token', env.CONTAINER_TOKEN);   // Private 容器鉴权
            // 共享密钥头不必透传到容器，删除以减少信息泄露
            newHeaders.delete(TOKEN_HEADER);

            let new_request = new Request(url, {
                method: request.method,
                headers: newHeaders,
                body: request.body,
                redirect: request.redirect
            });

            // 直接返回 fetch 响应，不包装
            // WebSocket 升级响应必须原样返回，不能用 new Response() 包装，否则握手失败
            return fetch(new_request);
        }

        // ============================================================
        // 2. 站点辅助文件：robots.txt / favicon，让站点更像真实网站
        // ============================================================
        if (url.pathname === '/robots.txt') {
            return new Response(
                'User-agent: *\nAllow: /\n',
                { headers: { 'Content-Type': 'text/plain;charset=UTF-8' } }
            );
        }
        if (url.pathname === '/favicon.ico') {
            // 返回 204，避免对每个 favicon 请求返回大段 HTML 404
            return new Response(null, { status: 204 });
        }

        // ============================================================
        // 3. 多页面伪装站路由
        // ============================================================
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

function html(body, status = 200) {
    return new Response(body, {
        status,
        headers: { 'Content-Type': 'text/html;charset=UTF-8' }
    });
}

// ============================================================
// 伪装页面模板 — 软件下载站主题
// 站名：OpenSoft Hub，与代理/容器/基础设施厂商无关
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
</body>
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
</body>
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
