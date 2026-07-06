export default {
    async fetch(request, env, ctx) {
        // Parse the URL immediately so all blocks can use it
        const url = new URL(request.url);

        // --- BOT MITIGATION BLOCK ---
        const ua = request.headers.get('User-Agent') || '';
        const isBot = /bot|crawl|spider|slurp|wget|curl|python|requests|urllib|fetch|headless|node|postman/i.test(ua);
        const isBrowser = /Mozilla|Chrome|Safari|Firefox|Edg|Oper|Brave/i.test(ua);

        if (isBot || !isBrowser) {
            return new Response('Forbidden', { status: 403 });
        }

        // --- PWA ASSETS BLOCK ---
        if (url.pathname === "/manifest.json" && request.method === "GET") {
            const manifest = {
                name: "Cloud PDF Workspace",
                short_name: "PDF Workspace",
                id: "/?source=pwa",
                start_url: "/?source=pwa",
                display: "standalone",
                orientation: "any",
                background_color: "#2b2a33",
                theme_color: "#1c1b22",
                icons: [
                    { src: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAMAAAADAAQMAAAD/mP2PAAAAA1BMVEX/AAAZ4gk3AAAAO0lEQVR4nO3BMQEAAADCoPVPbQwfoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAeAMw+wABmH+2gAAAAABJRU5ErkJggg==", sizes: "192x192", type: "image/png", purpose: "any" },
                    { src: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAMAAADDpiTIAAAAA1BMVEX/AAAZ4gk3AAABJUlEQVR4nO3BMQEAAADCoPVPbQwfoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABwDDhwAAEYB6wKAAAAAElFTkSuQmCC", sizes: "512x512", type: "image/png", purpose: "any" }
                ]
            };
            return new Response(JSON.stringify(manifest), { 
                headers: { "Content-Type": "application/manifest+json" } 
            });
        }


        if (url.pathname === "/sw.js" && request.method === "GET") {
            const swCode = `
                self.addEventListener('fetch', (event) => {
                    event.respondWith(fetch(event.request));
                });
            `;
            return new Response(swCode, { 
                headers: { "Content-Type": "application/javascript" } 
            });
        }

        // --- AUTHENTICATION BLOCK ---
        const expectedUser = env.AUTH_USER;
        const expectedPass = env.AUTH_PASS;

        if (expectedUser && expectedPass) {
            const cookies = request.headers.get('Cookie') || '';
            const isAuthenticated = cookies.includes('pdf_workspace_auth=true');

            if (url.pathname === "/login" && request.method === "POST") {
                const formData = await request.formData();
                const user = formData.get('username');
                const pass = formData.get('password');

                if (user === expectedUser && pass === expectedPass) {
                    return new Response(null, {
                        status: 302,
                        headers: {
                            'Location': '/',
                            'Set-Cookie': 'pdf_workspace_auth=true; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000; Path=/'
                        }
                    });
                } else {
                    return new Response('Invalid credentials. <a href="/">Try again</a>', { 
                        status: 401, 
                        headers: { 'Content-Type': 'text/html' }
                    });
                }
            }

            if (!isAuthenticated) {
                return new Response(loginHtml, {
                    headers: { 'Content-Type': 'text/html; charset=utf-8' }
                });
            }
        }

        try {
            // --- STORAGE BINDING BLOCK ---
            const r2 = env.pdf_r2_library;
            const kv = env.pdf_kv_store;
            
            // Prefer R2. Fallback to KV if R2 isn't linked.
            const store = r2 || kv;
            const isKVOnly = !r2 && !!kv;
            
            if (!store && url.pathname.startsWith("/api/")) {
                throw new Error("No Storage Binding found! Please link pdf_r2_library or pdf_kv_store in Cloudflare settings.");
            }

            const db = {
                async put(key, data) { 
                    await store.put(key, data); 
                },
                async getJson(key) {
                    if (r2) {
                        // R2 does not accept a 2nd parameter
                        const res = await r2.get(key); 
                        if (!res) return null;
                        return JSON.parse(await res.text());
                    } else {
                        // KV needs the 2nd parameter
                        const res = await kv.get(key, "text"); 
                        if (!res) return null;
                        return typeof res === 'string' ? JSON.parse(res) : null;
                    }
                },
                async getBuffer(key) {
                    if (r2) {
                        // R2 does not accept a 2nd parameter
                        const res = await r2.get(key); 
                        if (!res) return null;
                        return await res.arrayBuffer();
                    } else {
                        // KV needs the 2nd parameter
                        return await kv.get(key, "arrayBuffer"); 
                    }
                },
                async list(prefix) {
                    const res = await store.list({ prefix });
                    // R2 uses 'objects', KV uses 'keys'
                    return res.keys || res.objects || [];
                },
                async delete(key) { 
                    await store.delete(key); 
                }
            };

            // --- API: LIBRARY MANAGEMENT BLOCK ---
            if (url.pathname === "/api/library") {
                if (request.method === "GET") {
                    const items = await db.list("meta:");
                    const files = [];
                    let totalBytes = 0;
                    
                    await Promise.all(items.map(async (item) => {
                        const keyName = item.name || item.key;
                        const parsed = await db.getJson(keyName);
                        if (parsed) {
                            files.push(parsed);
                            if (parsed.size) { totalBytes += parsed.size; }
                        }
                    }));
                    
                    // Added isKVOnly to the response
                    return new Response(JSON.stringify({ files, totalBytes, isKVOnly }), { 
                        headers: { "Content-Type": "application/json" } 
                    });
                }
                
                if (request.method === "POST") {
                    const payload = await request.json();
                    
                    if (payload.action === "create_folder") {
                        const folderHash = payload.hash || ('folder_' + Date.now());
                        await db.put('meta:' + folderHash, JSON.stringify({ 
                            name: payload.name, 
                            isFolder: true, 
                            created: payload.created || Date.now(), 
                            hash: folderHash, 
                            parent: payload.parent || "" 
                        }));
                    } 
                    else if (payload.action === "copy") {
                        const buffer = await db.getBuffer('file:' + payload.source);
                        if (buffer) {
                            const newHash = payload.source + '-copy-' + Date.now();
                            await db.put('file:' + newHash, buffer);
                            
                            const meta = await db.getJson('meta:' + payload.source);
                            if (meta) {
                                meta.name = meta.name + " (Copy)";
                                meta.hash = newHash;
                                meta.created = Date.now();
                                await db.put('meta:' + newHash, JSON.stringify(meta));
                            }
                        }
                    } 
                    else if (payload.action === "rename") {
                        const meta = await db.getJson('meta:' + payload.target);
                        if (meta) {
                            meta.name = payload.newName;
                            await db.put('meta:' + payload.target, JSON.stringify(meta));
                        }
                    } 
                    else if (payload.action === "move") {
                        const meta = await db.getJson('meta:' + payload.target);
                        if (meta) {
                            meta.parent = payload.newParent;
                            await db.put('meta:' + payload.target, JSON.stringify(meta));
                        }
                    } 
                    else if (payload.action === "delete") {
                        await db.delete('meta:' + payload.target);
                        await db.delete('file:' + payload.target);
                    }
                    
                    return new Response(JSON.stringify({ success: true }), { 
                        headers: { "Content-Type": "application/json" } 
                    });
                }
            }

            // --- API: FILE UPLOAD/DOWNLOAD BLOCK ---
            if (url.pathname === "/api/library/upload" && request.method === "POST") {
                const hash = url.searchParams.get("hash");
                const name = url.searchParams.get("name");
                const parent = url.searchParams.get("parent") || "";
                
                let stats = null;
                const statsStr = url.searchParams.get("stats");
                if (statsStr && statsStr !== "undefined") {
                    try { stats = JSON.parse(statsStr); } catch(e){}
                }

                const buffer = await request.arrayBuffer();
                const size = buffer.byteLength;
                
                await db.put('file:' + hash, buffer);
                await db.put('meta:' + hash, JSON.stringify({ 
                    hash, 
                    name, 
                    created: Date.now(), 
                    isFolder: false, 
                    parent, 
                    size,
                    stats
                }));
                
                return new Response(JSON.stringify({ success: true }), { 
                    headers: { "Content-Type": "application/json" } 
                });
            }

            if (url.pathname === "/api/library/download" && request.method === "GET") {
                const hash = url.searchParams.get("hash");
                const buffer = await db.getBuffer('file:' + hash);
                
                if (!buffer) return new Response("Not found", { status: 404 });
                
                return new Response(buffer, { 
                    headers: { "Content-Type": "application/pdf" } 
                });
            }

            // --- API: WORKSPACE STATE BLOCK ---
            if (url.pathname === "/api/load" && request.method === "GET") {
                const fileHash = url.searchParams.get("hash");
                if (!fileHash) return new Response("Missing hash", { status: 400 });
                
                const data = await db.getJson(fileHash);
                return new Response(JSON.stringify(data || null), { 
                    headers: { "Content-Type": "application/json" } 
                });
            }

            if (url.pathname === "/api/versions" && request.method === "GET") {
                const fileHash = url.searchParams.get("hash");
                if (!fileHash) return new Response("Missing hash", { status: 400 });

                const historyData = await db.getJson('history:' + fileHash);
                return new Response(JSON.stringify(historyData || []), { 
                    headers: { "Content-Type": "application/json" } 
                });
            }

            if (url.pathname === "/api/save" && request.method === "POST") {
                const payload = await request.json();
                if (!payload.hash) return new Response("Missing hash", { status: 400 });

                await db.put(payload.hash, JSON.stringify({ drawing: payload.drawing, stats: payload.stats }));

                if (payload.stats) {
                    const meta = await db.getJson('meta:' + payload.hash);
                    if (meta) {
                        meta.stats = payload.stats;
                        await db.put('meta:' + payload.hash, JSON.stringify(meta));
                    }
                }

                if (payload.createVersion) {
                    const historyKey = 'history:' + payload.hash;
                    let history = await db.getJson(historyKey) || [];
                    
                    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
                    history = history.filter(item => item.timestamp > oneDayAgo);
                    
                    const compressedDrawing = payload.drawing.map(annot => {
                        if (annot.type === 'image') {
                            const { dataUrl, ...rest } = annot;
                            return { ...rest, hasImage: true };
                        }
                        return annot;
                    });
                    
                    const currentStr = JSON.stringify(compressedDrawing);
                    const isDuplicate = history.length > 0 && JSON.stringify(history[0].drawing) === currentStr;
                    
                    if (!isDuplicate) {
                        history.unshift({ 
                            id: Date.now().toString(), 
                            timestamp: new Date().toISOString(), 
                            drawing: compressedDrawing 
                        });
                        if (history.length > 20) history.pop(); 
                        await db.put(historyKey, JSON.stringify(history));
                    }
                }
                
                return new Response(JSON.stringify({ success: true }), { 
                    headers: { "Content-Type": "application/json" } 
                });
            }

            // --- API: FRONTEND RENDER BLOCK ---
            if (url.pathname === "/" && request.method === "GET") {
                return new Response(html, { 
                    headers: { "Content-Type": "text/html; charset=utf-8" } 
                });
            }
            
            return new Response("Not Found", { status: 404 });
            
        } catch (err) {
            console.error("Unhandled error in worker fetch", err);
            return new Response(JSON.stringify({ error: "Internal Server Error" }), { 
                status: 500, 
                headers: { "Content-Type": "application/json" } 
            });
        }
    }
};

const html = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Cloud PDF Workspace</title>

    <link rel="manifest" href="/manifest.json">
    <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23d70022'%3E%3Cpath d='M20 2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-8.5 7.5c0 .83-.67 1.5-1.5 1.5H9v2H7.5V7H10c.83 0 1.5.67 1.5 1.5v1zm5 2c0 .83-.67 1.5-1.5 1.5h-2.5V7H15c.83 0 1.5.67 1.5 1.5v3zm4-3H19v1h1.5V11H19v2h-1.5V7h3v1.5zM9 9.5h1v-1H9v1zM4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm10 5.5h1v-3h-1v3z'/%3E%3C/svg%3E">
    
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf_viewer.min.css">
    <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
    <script src="https://unpkg.com/pdf-lib/dist/pdf-lib.min.js"></script>
    
    <style>
        /* --- CSS VARIABLES BLOCK --- */
        :root { 
            --bg-color: #2b2a33; 
            --text-color: #fbfbfe; 
            --toolbar-bg: #1c1b22; 
            --panel-bg: #2b2a33; 
            --hover-bg: #3b3a42; 
            --border-color: #555; 
            --input-bg: #3b3a42; 
            --annot-text: #000; 
            --ribbon-bg: #1c1b22;
            --ribbon-text: #fbfbfe;
        }
        
        [data-theme="light"] { 
            --bg-color: #f0f0f4; 
            --text-color: #111111; 
            --toolbar-bg: #e0e0e6; 
            --panel-bg: #ffffff; 
            --hover-bg: #d0d0d7; 
            --border-color: #ccc; 
            --input-bg: #ffffff; 
            --annot-text: #000; 
            --ribbon-bg: #e0e0e6;
            --ribbon-text: #111111;
        }

        body { 
            background-color: var(--bg-color); 
            color: var(--text-color); 
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
            display: flex; 
            flex-direction: column; 
            margin: 0; 
            height: 100dvh; 
            width: 100dvw;
            position: fixed;
            top: 0;
            left: 0;
            overflow: hidden; 
            transition: background-color 0.3s, color 0.3s; 
        }
        
        /* --- TOOLBAR UI BLOCK --- */
        .toolbar { 
            background-color: var(--toolbar-bg); 
            width: 100%; 
            min-height: 54px; 
            display: flex; 
            flex-wrap: wrap;
            justify-content: space-between; 
            align-items: center; 
            padding: max(8px, env(safe-area-inset-top)) 15px 8px 15px; 
            box-sizing: border-box; 
            z-index: 1000; 
            flex-shrink: 0; 
            border-bottom: 1px solid var(--border-color); 
            gap: 10px; 
            overflow: visible;
            position: relative;
        }
        
        .toolbar-group { display: flex; align-items: center; gap: 8px; flex-wrap: nowrap; flex-shrink: 0; }
        .left-group { flex: 1 1 0%; justify-content: flex-start; min-width: 0; }
        .center-group { flex: 0 0 auto; justify-content: center; gap: 4px; }
        .right-group { flex: 1 1 0%; justify-content: flex-end; overflow: visible; min-width: 0; gap: 8px; }

        .left-group .icon-btn-simple { min-width: 28px !important; height: 28px; padding: 4px !important; }
        .left-group .icon-btn-simple svg { width: 16px !important; height: 16px !important; min-width: 16px !important; min-height: 16px !important; }
        
        .tool-btn-container { 
            display: flex; flex-direction: column; align-items: center; justify-content: space-between; 
            padding: 4px; border-radius: 4px; cursor: pointer; border: 1px solid transparent; 
            transition: 0.2s; width: 34px; height: 36px; flex-shrink: 0; box-sizing: border-box; 
        }
        .tool-btn-container:hover { background-color: var(--hover-bg); }
        .tool-btn-container.active { background-color: rgba(100, 216, 255, 0.15); border-color: #64d8ff; }
        
        button.tool-mode-btn { 
            background: transparent; color: var(--text-color); border: none; padding: 0; 
            cursor: pointer; display: flex; align-items: center; justify-content: center; 
            width: 100%; height: 20px; pointer-events: none; 
        }
        button.tool-mode-btn svg { width: 18px; height: 18px; min-width: 18px; min-height: 18px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; flex-shrink: 0; }
        
        .tool-color-bar { width: 16px; height: 4px; padding: 0; border: none; cursor: pointer; border-radius: 2px; }
        .tool-color-bar::-webkit-color-swatch-wrapper { padding: 0; }
        .tool-color-bar::-webkit-color-swatch { border: none; border-radius: 2px; }
        .color-bar-placeholder { width: 16px; height: 4px; }

        .sub-toolbar { 
            background-color: var(--panel-bg); width: 100%; height: auto; min-height: 36px; 
            display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 15px; 
            padding: 4px 15px; border-bottom: 1px solid var(--border-color); flex-shrink: 0; box-sizing: border-box; 
        }
        .sub-group { display: none; align-items: center; gap: 8px; }

        button.icon-btn-simple { 
            background: transparent; color: var(--text-color); border: none; border-radius: 4px; 
            padding: 6px; cursor: pointer; display: flex; align-items: center; justify-content: center; 
            transition: 0.2s; flex-shrink: 0; min-width: 32px; height: 32px; box-sizing: border-box; 
        }
        button.icon-btn-simple:hover { background-color: var(--hover-bg); }
        button.icon-btn-simple svg { width: 18px; height: 18px; min-width: 18px; min-height: 18px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; flex-shrink: 0; display: block; }

        /* --- GOOGLE DOCS STYLE SAVE INDICATOR --- */
        .cloud-sync-status {
            position: relative; display: flex; align-items: center; justify-content: center;
            cursor: pointer; padding: 6px; border-radius: 4px; transition: 0.2s;
        }
        .cloud-sync-status:hover { background-color: var(--hover-bg); }
        .cloud-sync-status svg { width: 22px; height: 22px; fill: currentColor; }
        
        .cloud-popup {
            position: absolute; top: 40px; right: 0; background: var(--panel-bg); 
            border: 1px solid var(--border-color); border-radius: 8px; width: 250px; 
            padding: 15px; box-shadow: 0 8px 24px rgba(0,0,0,0.5); z-index: 9000;
            display: none; flex-direction: column; gap: 8px;
        }
        .cloud-popup-title { font-weight: 600; font-size: 14px; display: flex; align-items: center; gap: 8px; }
        .cloud-popup-desc { font-size: 12px; opacity: 0.8; line-height: 1.4; }
        
        @keyframes spin-smooth {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }

        .spin-anim {
            animation: spin-smooth 1s linear infinite;
            transform-origin: center;
            display: block;
        }

        .tool-control { background: var(--input-bg); color: var(--text-color); border: 1px solid var(--border-color); border-radius: 3px; padding: 4px; font-size: 12px; outline: none; }
        
        .page-info { font-size: 13px; color: var(--text-color); display: flex; align-items: center; gap: 5px; flex-shrink: 0; }
        .page-info input { width: 40px; background: var(--input-bg); color: var(--text-color); border: 1px solid var(--border-color); text-align: center; border-radius: 3px; padding: 3px; outline: none; }
        
        .zoom-controls { display: flex; align-items: center; background: var(--input-bg); border: 1px solid var(--border-color); border-radius: 4px; overflow: hidden; height: 26px; }
        .zoom-controls input, .zoom-controls select { background: transparent; border: none; color: var(--text-color); font-size: 12px; outline: none; padding: 0 4px; }
        .zoom-controls input { width: 40px; text-align: center; }
        .zoom-controls span { font-size: 12px; opacity: 0.7; padding: 0 2px; }

        .tab-bar { display: flex; background: var(--toolbar-bg); border-bottom: 1px solid var(--border-color); overflow-x: auto; height: 36px; flex-shrink: 0; scrollbar-width: none; }
        .tab-bar::-webkit-scrollbar { display: none; }
        .tab { padding: 0 15px; font-size: 13px; cursor: pointer; border-right: 1px solid var(--border-color); display: flex; align-items: center; gap: 8px; opacity: 0.6; transition: 0.2s; white-space: nowrap; }
        .tab:hover { opacity: 0.8; background: var(--hover-bg); }
        .tab.active { opacity: 1; background: var(--bg-color); border-bottom: 2px solid #64d8ff; font-weight: 500; }
        .tab-close { display: inline-flex; justify-content: center; align-items: center; width: 18px; height: 18px; border-radius: 50%; opacity: 0.5; margin-left: 4px; }
        .tab-close:hover { opacity: 1; background-color: #d70022; color: white; }

        /* --- SIDEBAR AND PANELS BLOCK --- */
        .main-area { display: flex; flex: 1; width: 100%; overflow: hidden; position: relative; }
        #sidebar { width: 280px; background-color: var(--toolbar-bg); border-right: 1px solid var(--border-color); display: none; flex-direction: column; box-sizing: border-box; }
        .sidebar-tabs { display: flex; border-bottom: 1px solid var(--border-color); background: var(--toolbar-bg); flex-shrink: 0; }
        .sidebar-tab { flex: 1; text-align: center; padding: 10px; font-size: 12px; cursor: pointer; font-weight: bold; opacity: 0.6; border-bottom: 2px solid transparent; text-transform: uppercase; }
        .sidebar-tab.active { opacity: 1; border-bottom-color: #2e8482; color: #64d8ff; }
        .sidebar-content-pane { display: none; flex-direction: column; padding: 15px; overflow-y: auto; flex: 1; }
        .sidebar-content-pane.active { display: flex; }

        .sidebar-comment, .history-item { background-color: var(--panel-bg); padding: 10px; border-radius: 6px; margin-bottom: 10px; cursor: pointer; border-left: 3px solid transparent; font-size: 13px; line-height: 1.4; transition: 0.2s; border: 1px solid var(--border-color); }
        .sidebar-comment:hover { background-color: var(--hover-bg); border-left-color: #64d8ff; }
        .sidebar-comment-page { font-size: 11px; opacity: 0.7; margin-bottom: 4px; font-weight: bold; }
        .history-item:hover { background-color: var(--hover-bg); border-left-color: #2e8482; }
        .history-action-btn { align-self: flex-end; background: #2e8482; color: white; border: none; padding: 3px 8px; font-size: 11px; border-radius: 3px; cursor: pointer; margin-top: 5px; }

        .pages-manage-bar { display: flex; gap: 8px; margin-bottom: 15px; }
        .custom-dropdown { position: relative; width: 100%; font-size: 13px; }
        .dropdown-toggle { width: 100%; background: var(--input-bg); color: var(--text-color); border: 1px solid var(--border-color); border-radius: 3px; padding: 8px 12px; text-align: left; cursor: pointer; display: flex; justify-content: space-between; align-items: center; }
        .dropdown-toggle:hover { background: var(--hover-bg); }
        .dropdown-menu { display: none; position: absolute; top: 100%; left: 0; width: 100%; background: var(--panel-bg); border: 1px solid var(--border-color); border-radius: 4px; z-index: 1000; box-shadow: 0 8px 16px rgba(0,0,0,0.5); flex-direction: column; padding: 6px 0; margin-top: 4px; }
        .dropdown-menu.show { display: flex; }
        .dropdown-item { padding: 10px 16px; font-size: 13px; cursor: pointer; color: var(--text-color); }
        .dropdown-item:hover { background: var(--hover-bg); }

        .thumb-grid { display: grid; grid-template-columns: 1fr; gap: 15px; }
        .thumb-wrapper { position: relative; background: var(--panel-bg); border: 1px solid var(--border-color); border-radius: 4px; padding: 10px; cursor: pointer; transition: 0.2s; display: flex; flex-direction: column; align-items: center; }
        .thumb-wrapper:hover { border-color: #64d8ff; }
        .thumb-wrapper canvas { max-width: 100%; box-shadow: 0 2px 4px rgba(0,0,0,0.2); pointer-events: none; }
        .thumb-checkbox { position: absolute; top: 10px; left: 10px; transform: scale(1.2); cursor: pointer; }
        .thumb-label { margin-top: 8px; font-size: 12px; background: rgba(0,0,0,0.6); color: white; padding: 2px 8px; border-radius: 10px; }

        /* --- PDF VIEWER BLOCK --- */
        #viewer-container { flex: 1; overflow: auto; -webkit-overflow-scrolling: touch; touch-action: pan-x pan-y; display: block; text-align: center; padding: 20px 0; position: relative; background: var(--bg-color); user-select: none; box-sizing: border-box; }
        
        /* Layout: Single Page (Default) */
        #viewer-container.layout-single .page-wrapper { display: block; margin: 0 auto 20px auto; }
        
        /* Layout: Multi-Page Grid */
        #viewer-container.layout-grid .page-wrapper { display: inline-block; margin: 10px; vertical-align: top; }
        
        .page-wrapper { position: relative; background-color: white; box-shadow: 0 4px 8px rgba(0,0,0,0.3); text-align: left; overflow: hidden; }
        .page-wrapper canvas { display: block; max-width: none !important; height: auto !important; z-index: 1; pointer-events: none; }
        
        .textLayer { position: absolute; top: 0; left: 0; right: 0; bottom: 0; opacity: 1; z-index: 2; user-select: text; }
        .textLayer ::selection { background: rgba(0, 100, 255, 0.3); }
        
        .drawing-layer { position: absolute; top: 0; left: 0; width: 100%; height: 100%; z-index: 3; pointer-events: none; overflow: hidden; }
        .drawing-layer path, .drawing-layer line { pointer-events: stroke; cursor: grab; fill: none; stroke-linecap: round; stroke-linejoin: round; }
        .drawing-layer path:hover, .drawing-layer path.selected-target, .drawing-layer line:hover, .drawing-layer line.selected-target { outline: none; filter: drop-shadow(0 0 3px #0060df); }

        .highlight-box { position: absolute; mix-blend-mode: multiply; z-index: 4; border-radius: 2px; cursor: grab; box-sizing: border-box; }
        .highlight-box:hover, .highlight-box.selected-target { outline: 2px solid #0060df; }
        .comment-box { border-bottom: 2px dashed #d70022; }
        
        .interactive-annot { position: absolute; z-index: 5; pointer-events: auto; box-sizing: border-box; cursor: grab; }
        .interactive-annot:active, .highlight-box:active, .drawing-layer path:active, .drawing-layer line:active { cursor: grabbing !important; }
        .interactive-annot, .highlight-box, .drawing-layer path, .drawing-layer line { touch-action: none; }
        .interactive-annot img { width: 100%; height: 100%; display: block; -webkit-user-drag: none; user-select: none; pointer-events: none; }
        .interactive-annot:hover, .interactive-annot.selected-target { outline: 2px dashed #0060df; }
        
        .resize-handle { position: absolute; width: 12px; height: 12px; background-color: #0060df; bottom: -6px; right: -6px; cursor: se-resize; z-index: 6; border-radius: 50%; display: none; border: 1px solid white; }
        .interactive-annot:hover .resize-handle, .interactive-annot.selected-target .resize-handle { display: block; }
        
        .text-annot-box { color: var(--annot-text); white-space: pre-wrap; transform-origin: top left; pointer-events: none; }
        .live-text-input { position: absolute; z-index: 10; background: transparent; border: 1px dashed #0060df; outline: none; padding: 0; margin: 0; line-height: 1; min-width: 50px; color: var(--annot-text); }
        .marquee-box { position: absolute; border: 1px dashed #64d8ff; background-color: rgba(100, 216, 255, 0.1); z-index: 9999; pointer-events: none; }

        /* --- SETTINGS & MODALS BLOCK --- */
        #settings-panel { position: absolute; top: 48px; right: 15px; background: var(--panel-bg); border: 1px solid var(--border-color); border-radius: 0 0 6px 6px; padding: 15px; box-shadow: 0 8px 16px rgba(0,0,0,0.5); z-index: 2000; display: none; flex-direction: column; gap: 12px; min-width: 260px; max-height: calc(100vh - 60px); overflow-y: auto; }
        .setting-row { display: flex; align-items: center; justify-content: space-between; font-size: 13px; gap: 10px; }
        .menu-item { padding: 8px 16px; font-size: 13px; cursor: pointer; display: flex; align-items: center; gap: 10px; color: var(--text-color); border-radius: 4px; }
        .menu-item:hover { background: var(--hover-bg); }
        .menu-item svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
        hr.menu-divider { border: 0; border-top: 1px solid var(--border-color); margin: 6px 0; width: 100%; }

        .tool-mode-select .textLayer, .tool-mode-marquee .textLayer, .tool-mode-draw .textLayer, .tool-mode-shape .textLayer, .tool-mode-erase .textLayer, .tool-mode-text .textLayer { pointer-events: none !important; user-select: none !important; }
        .tool-mode-textselect .textLayer, .tool-mode-highlight .textLayer, .tool-mode-comment .textLayer { pointer-events: auto !important; user-select: text !important; }
        .tool-mode-draw #viewer-container, .tool-mode-shape #viewer-container, .tool-mode-erase #viewer-container, .tool-mode-marquee #viewer-container { cursor: crosshair !important; }
        .tool-mode-draw .page-wrapper, .tool-mode-shape .page-wrapper, .tool-mode-erase .page-wrapper, .tool-mode-marquee .page-wrapper { touch-action: none; }

        #hl-context-menu, #lib-context-menu { position: absolute; display: none; background: var(--panel-bg); border: 1px solid var(--border-color); border-radius: 6px; padding: 6px; box-shadow: 0 4px 10px rgba(0,0,0,0.5); z-index: 4000; align-items: center; gap: 4px; }
        #lib-context-menu { width: 150px; flex-direction: column; padding: 4px 0; align-items: stretch; z-index: 6000; }

        /* --- MOBILE UI BLOCK --- */
        #mobile-selection-tools { display: none; position: fixed; bottom: 40px; right: 15px; z-index: 9999; flex-direction: column; gap: 12px; }
        #mobile-selection-tools button { width: 50px; height: 60px; border-radius: 8px; font-weight: 900; font-size: 24px; cursor: pointer; border: 2px solid var(--border-color); background: var(--toolbar-bg); box-shadow: 0 6px 16px rgba(0,0,0,0.6); transition: 0.2s; display: flex; justify-content: center; align-items: center; }
        #mob-hl-btn { color: #ffffaa; border-color: #ffffaa; }
        #mob-cmt-btn { color: #87ceeb; border-color: #87ceeb; }
        #mobile-selection-tools button:active { transform: scale(0.95); }
        @media (min-width: 901px) { #mobile-selection-tools { display: none !important; } }
        
        #comment-modal-overlay, #save-modal-overlay, #debug-modal-overlay, #library-modal-overlay, #props-modal-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 5000; display: none; align-items: center; justify-content: center; }
        
        .custom-comment-box { background-color: #212117; border: 2px solid #5d5d21; border-radius: 8px; width: 320px; padding: 12px 16px; box-shadow: 0 8px 24px rgba(0,0,0,0.6); color: white; }
        .custom-comment-box h3 { margin: 0 0 10px 0; font-size: 14px; font-weight: 600; }
        .custom-comment-box textarea, .custom-comment-box .read-content { width: 100%; background-color: #3b3a42; border: 1px solid #4fc3f7; border-radius: 4px; color: #ffffff; padding: 10px; box-sizing: border-box; font-size: 13px; }
        .custom-comment-box textarea { height: 90px; resize: none; }
        .custom-comment-box textarea:focus { outline: none; border-color: #64d8ff; }
        .custom-comment-box .read-content { min-height: 50px; border-color: #5d5d21; }
        .comment-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 12px; }
        .comment-btn-cancel { background-color: #353526; border: 1px solid #4a4a32; color: #ffffff; padding: 6px 14px; border-radius: 4px; cursor: pointer; font-size: 13px; }
        .comment-btn-add { background-color: #2e8482; border: none; color: #ffffff; padding: 6px 16px; border-radius: 4px; cursor: pointer; font-size: 13px; }
        
        #read-comment-modal { position: absolute; display: none; z-index: 4500; }

        /* --- LIBRARY UI BLOCK --- */
        .lib-window { background: var(--bg-color); width: 850px; height: 600px; max-width: 95vw; max-height: 90vh; border-radius: 8px; border: 1px solid var(--border-color); display: flex; flex-direction: column; box-shadow: 0 15px 40px rgba(0,0,0,0.7); overflow: hidden; }
        .lib-header { background: var(--toolbar-bg); padding: 12px 15px; font-size: 14px; font-weight: 600; border-bottom: 1px solid var(--border-color); display: flex; justify-content: space-between; align-items: center; }
        .lib-header-close { background: transparent; border: none; color: var(--text-color); cursor: pointer; font-size: 18px; }
        .lib-body { display: flex; flex: 1; overflow: hidden; }
        .lib-sidebar { width: 200px; background: var(--toolbar-bg); border-right: 1px solid var(--border-color); display: flex; flex-direction: column; }
        .lib-nav-item { padding: 12px 15px; cursor: pointer; font-size: 13px; opacity: 0.8; display: flex; align-items: center; gap: 8px; transition: 0.2s; }
        .lib-nav-item:hover { background: var(--hover-bg); opacity: 1; }
        .lib-storage { margin-top: auto; padding: 15px; font-size: 12px; border-top: 1px solid var(--border-color); opacity: 0.8; }
        .lib-storage progress { width: 100%; height: 6px; margin-bottom: 5px; }
        .lib-main-area { flex: 1; display: flex; flex-direction: column; background: var(--panel-bg); overflow: hidden; min-width: 0; }
        .lib-toolbar { padding: 10px 15px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border-color); background: var(--bg-color); flex-wrap: wrap; gap: 10px; }
        .lib-breadcrumbs { font-size: 13px; display: flex; align-items: center; gap: 5px; opacity: 0.9; flex-wrap: wrap; }
        .lib-breadcrumb-link { cursor: pointer; display: inline-flex; align-items: center; }
        .lib-breadcrumb-link:hover { text-decoration: underline; color: #64d8ff; }
        .lib-file-table { width: 100%; min-width: 600px; border-collapse: collapse; text-align: left; font-size: 13px; }
        .lib-file-table th { padding: 8px 10px; border-bottom: 1px solid var(--border-color); opacity: 0.7; font-weight: 500; }
        .lib-file-table td { padding: 8px 10px; border-bottom: 1px solid var(--border-color); border-top: 1px solid transparent; border-bottom: 1px solid transparent; }
        .lib-file-row { cursor: pointer; transition: 0.1s; user-select: none; }
        .lib-file-row:hover { background: var(--hover-bg); }
        .lib-file-row.drag-over { background: rgba(100, 216, 255, 0.2); border: 1px dashed #64d8ff; }
        .lib-content-scroll { overflow: auto; flex: 1; min-width: 0; width: 100%; }
        .lib-checkbox { transform: scale(1.1); cursor: pointer; }
        .lib-btn { background: var(--input-bg); color: var(--text-color); border: 1px solid var(--border-color); padding: 4px 8px; border-radius: 3px; cursor: pointer; font-size: 12px; }
        .lib-btn:hover { background: var(--hover-bg); }
        #lib-sort option { background-color: var(--panel-bg); color: var(--text-color); }

        .props-modal-box { background: var(--panel-bg); border: 1px solid var(--border-color); border-radius: 6px; width: 400px; box-shadow: 0 10px 30px rgba(0,0,0,0.6); display: flex; flex-direction: column; overflow: hidden; }
        .props-header { background: var(--toolbar-bg); padding: 10px 15px; font-size: 13px; display: flex; justify-content: space-between; border-bottom: 1px solid var(--border-color); }
        .props-header button { background: transparent; border: none; color: var(--text-color); cursor: pointer; }
        .props-body { padding: 20px 15px; font-size: 13px; }
        .props-table { width: 100%; border-collapse: collapse; }
        .props-table td { padding: 4px 0; vertical-align: top; }
        .props-table td:first-child { width: 100px; opacity: 0.7; }
        .props-footer { background: var(--toolbar-bg); padding: 10px 15px; text-align: right; border-top: 1px solid var(--border-color); }

        .shortcut-legend { font-size: 11px; opacity: 0.7; line-height: 1.5; padding: 0 10px; }
        .shortcut-legend table { width: 100%; border-collapse: collapse; }
        .shortcut-legend td { padding: 2px 0; }
        .shortcut-legend td:last-child { text-align: right; font-weight: bold; color: #64d8ff; }
        
        .empty-state { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; color: var(--border-color); font-size: 24px; font-weight: bold; }
        
        #bottom-ribbon { height: 24px; background-color: var(--toolbar-bg); color: var(--text-color); border-top: 1px solid var(--border-color); display: flex; align-items: center; justify-content: space-between; padding: 0 10px; font-size: 11px; flex-shrink: 0; user-select: none; opacity: 0.85; }
        .ribbon-divider { border-left: 1px solid var(--border-color); height: 12px; margin: 0 8px; }
        .ribbon-left, .ribbon-right { display: flex; align-items: center; }

        @media (max-width: 900px) {
            .toolbar { flex-wrap: wrap; height: auto; min-height: auto; padding: max(6px, env(safe-area-inset-top)) 6px 6px 6px; overflow: visible; }
            .left-group { flex: 1 1 auto; justify-content: flex-start; }
            .right-group { flex: 1 1 auto; justify-content: flex-end; }
            .center-group { flex: 1 1 100%; justify-content: center; margin-top: 5px; order: 3; flex-wrap: wrap; overflow: visible; padding-bottom: 4px; gap: 8px; }
            #zoom-wrapper { display: none !important; }
            #library-modal-overlay { padding: 0; background: var(--bg-color); }
            .lib-window { width: 100%; height: 100%; max-width: 100%; max-height: 100%; border-radius: 0; border: none; display: flex; flex-direction: column; }
            .lib-body { flex-direction: column; overflow: hidden; flex: 1; }
            .lib-sidebar { width: 100%; border-right: none; border-bottom: 1px solid var(--border-color); flex-direction: row; flex-wrap: wrap; padding: 5px 10px; flex-shrink: 0; }
            .lib-storage { border-top: none; padding: 0 10px; margin-top: 0; display: flex; align-items: center; gap: 10px; flex: 1; }
            .lib-storage progress { width: 100px; margin: 0; }
            .lib-main-area { flex: 1; overflow: hidden; display: flex; flex-direction: column; min-width: 0; }
            .lib-toolbar { flex-direction: column; align-items: stretch; flex-shrink: 0; }
            .lib-content-scroll { flex: 1; overflow: auto; min-height: 0; }
            .lib-file-table { min-width: 500px; }
            #sidebar { position: absolute; z-index: 50; height: calc(100% - 40px); width: 100%; top: 0; }
            .props-modal-box { width: 90%; }
        }
    </style>
</head>
<body class="tool-mode-textselect">

    <div class="toolbar">
        <div class="toolbar-group left-group">
            <button class="icon-btn-simple" id="toggle-sidebar" title="Toggle Sidebar">
                <svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="9" y1="3" x2="9" y2="21"></line></svg>
            </button>
            <span style="border-left: 1px solid var(--border-color); height: 20px; margin: 0 2px;"></span>
            <div class="page-info" style="display:none;" id="page-nav-wrapper">
                <input type="number" id="page-input" value="1" min="1"> of <span id="page-count" style="margin-left: 4px;">0</span>
            </div>
            <span style="border-left: 1px solid var(--border-color); height: 20px; margin: 0 2px;"></span>
            <button class="icon-btn-simple" id="btn-undo" title="Undo (Ctrl+Z)" style="opacity:0.3; pointer-events:none;">
                <svg viewBox="0 0 24 24"><path d="M3 10h10a5 5 0 0 1 5 5v2a5 5 0 0 1-5 5H6"></path><polyline points="7 6 3 10 7 14"></polyline></svg>
            </button>
            <button class="icon-btn-simple" id="btn-redo" title="Redo (Ctrl+Y / Ctrl+Shift+Z)" style="opacity:0.3; pointer-events:none;">
                <svg viewBox="0 0 24 24"><path d="M21 10H11a5 5 0 0 0-5 5v2a5 5 0 0 0 5 5h7"></path><polyline points="17 6 21 10 17 14"></polyline></svg>
            </button>
            <span style="border-left: 1px solid var(--border-color); height: 20px; margin: 0 2px;"></span>
            <div id="zoom-wrapper" style="display: none;">
                <div class="zoom-controls">
                    <input type="number" id="zoom-custom" value="150" min="10" max="1000" title="Custom Zoom %">
                    <span>%</span>
                    <select id="zoom-select" title="Zoom Presets">
                        <option value="auto">Auto</option>
                        <option value="fit">Fit</option>
                        <option value="width">Width</option>
                        <option value="0.75">75%</option>
                        <option value="1">100%</option>
                        <option value="1.25">125%</option>
                        <option value="1.5" selected>150%</option>
                        <option value="2">200%</option>
                    </select>
                </div>
            </div>
            <span style="border-left: 1px solid var(--border-color); height: 20px; margin: 0 2px;"></span>
            <button class="icon-btn-simple" id="btn-toggle-layout" title="Toggle Single/Grid Layout">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="3" y="3" width="7" height="7" rx="1"></rect>
                    <rect x="14" y="3" width="7" height="7" rx="1"></rect>
                    <rect x="14" y="14" width="7" height="7" rx="1"></rect>
                    <rect x="3" y="14" width="7" height="7" rx="1"></rect>
                </svg>
            </button>
        </div>
        
        <div class="toolbar-group center-group" id="tools-group">
            <div class="tool-btn-container active" data-mode="textselect" title="Select Text (Native Copy)">
                <button class="tool-mode-btn"><svg viewBox="0 0 24 24"><line x1="12" y1="3" x2="12" y2="21"></line><line x1="8" y1="3" x2="16" y2="3"></line><line x1="8" y1="21" x2="16" y2="21"></line></svg></button>
                <div class="color-bar-placeholder"></div>
            </div>
            <div class="tool-btn-container" data-mode="select" title="Select / Move">
                <button class="tool-mode-btn"><svg viewBox="0 0 24 24"><polygon points="3 3 10.5 21 13.5 13.5 21 10.5 3 3"></polygon></svg></button>
                <div class="color-bar-placeholder"></div>
            </div>
            <div class="tool-btn-container" data-mode="marquee" title="Marquee Tool (Box Select)">
                <button class="tool-mode-btn"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2" ry="2" stroke-dasharray="4"></rect></svg></button>
                <div class="color-bar-placeholder"></div>
            </div>
            <div class="tool-btn-container" data-mode="highlight" title="Highlight Tool">
                <button class="tool-mode-btn"><svg viewBox="0 0 24 24"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path><path d="M15 5l4 4"></path></svg></button>
                <input type="color" id="color-highlight" class="tool-color-bar tool-modifier" value="#ffffaa">
            </div>
            <div class="tool-btn-container" data-mode="comment" title="Comment Tool (Shift+M)">
                <button class="tool-mode-btn"><svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg></button>
                <input type="color" id="color-comment" class="tool-color-bar tool-modifier" value="#87ceeb">
            </div>
            <div class="tool-btn-container" data-mode="text" title="Text Tool">
                <button class="tool-mode-btn"><svg viewBox="0 0 24 24"><polyline points="4 7 4 4 20 4 20 7"></polyline><line x1="9" y1="20" x2="15" y2="20"></line><line x1="12" y1="4" x2="12" y2="20"></line></svg></button>
                <input type="color" id="color-text" class="tool-color-bar tool-modifier" value="#000080">
            </div>
            <div class="tool-btn-container" data-mode="draw" title="Draw Tool">
                <button class="tool-mode-btn"><svg viewBox="0 0 24 24"><path d="M12 19l7-7 3 3-7 7-3-3z"></path><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"></path><path d="M2 2l7.586 7.586"></path><circle cx="11" cy="11" r="2"></circle></svg></button>
                <input type="color" id="color-draw" class="tool-color-bar tool-modifier" value="#d70022">
            </div>
            <div class="tool-btn-container" data-mode="shape" title="Shapes Tool">
                <button class="tool-mode-btn"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect></svg></button>
                <input type="color" id="color-shape" class="tool-color-bar tool-modifier" value="#4364e8">
            </div>
            <div class="tool-btn-container" data-mode="erase" title="Eraser Tool">
                <button class="tool-mode-btn"><svg viewBox="0 0 24 24"><path d="M20 20H7L3 16C2.5 15.5 2.5 14.5 3 14L13 4C13.5 3.5 14.5 3.5 15 4L20 9C20.5 9.5 20.5 10.5 20 11L11 20"></path></svg></button>
                <div class="color-bar-placeholder"></div>
            </div>
            <div class="tool-btn-container" id="tool-image-btn" title="Insert Image">
                <button class="tool-mode-btn"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg></button>
                <div class="color-bar-placeholder"></div>
            </div>
        </div>

        <div class="toolbar-group right-group">

            <div id="cloud-sync-btn" class="cloud-sync-status" title="Document Status" style="display: none;">
                <svg id="icon-cloud-saved" viewBox="0 0 24 24" style="color: #64d8ff;"><path d="M17.5 19c2.5 0 4.5-2 4.5-4.5a4.5 4.5 0 0 0-4-4.47A6 6 0 0 0 6 10.5a5.5 5.5 0 0 0-1 10.9V21h12.5v-2zM9 16.5l-3.5-3.5 1.4-1.4 2.1 2.1 5.6-5.6 1.4 1.4L9 16.5z"/></svg>
                <svg id="icon-cloud-saving" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" style="display:none; color: #ffca28; width: 22px; height: 22px;" class="spin-anim">
                    <circle cx="12" cy="12" r="9" stroke-dasharray="16 6"></circle>
                </svg>
                
                <div class="cloud-popup" id="cloud-sync-popup">
                    <div class="cloud-popup-title">
                        <svg viewBox="0 0 24 24" style="width: 18px; height: 18px; fill: #64d8ff;"><path d="M17.5 19c2.5 0 4.5-2 4.5-4.5a4.5 4.5 0 0 0-4-4.47A6 6 0 0 0 6 10.5a5.5 5.5 0 0 0-1 10.9V21h12.5v-2zM9 16.5l-3.5-3.5 1.4-1.4 2.1 2.1 5.6-5.6 1.4 1.4L9 16.5z"/></svg>
                        <span id="cloud-popup-status-text">All changes saved to Library</span>
                    </div>
                    <div class="cloud-popup-desc">Every change you make is automatically saved to the Cloud Library.</div>
                </div>
            </div>

            <button class="icon-btn-simple" id="installBtn" title="Install App" style="display: none; border: 1px dashed #64d8ff; color: #64d8ff; padding: 4px 8px; font-size: 12px; font-weight: bold;">
                ↓ Install
            </button>

            <button class="icon-btn-simple" id="toggle-library" title="Library Window">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path>
                    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path>
                </svg>
            </button>
            <button id="open-file-btn" class="icon-btn-simple" title="Open File">
                <svg viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
            </button>
            <input type="file" id="fallback-file-input" accept="application/pdf" style="display: none;">
            <input type="file" id="image-upload-input" accept="image/png, image/jpeg, image/jpg" style="display: none;">
            
            <button class="icon-btn-simple" id="toggle-settings" title="Settings">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M12 15a3 3 0 100-6 3 3 0 000 6z"></path>
                    <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"></path>
                </svg>
            </button>
        </div>
    </div>

    <div class="sub-toolbar" id="sub-toolbar">
        <div id="prop-size" class="sub-group">
            <span style="font-size: 12px;">Thickness:</span>
            <input type="range" id="tool-size" class="tool-modifier" min="1" max="10" value="2" class="tool-control" style="width:100px;">
        </div>
        <div id="prop-font" class="sub-group">
            <select id="tool-font" class="tool-control tool-modifier">
                <option value="Helvetica">Helvetica</option>
                <option value="TimesRoman">Times</option>
                <option value="Courier">Courier</option>
            </select>
            <input type="number" id="tool-fontsize" class="tool-control tool-modifier" value="14" min="8" max="72" style="width: 50px;">
        </div>
        <div id="prop-shape" class="sub-group">
            <span style="font-size: 12px;">Shape Type:</span>
            <select id="tool-shape-type" class="tool-control tool-modifier">
                <option value="rect">Rectangle</option>
                <option value="circle">Circle</option>
                <option value="line">Line</option>
            </select>
        </div>
        <div id="prop-action-text" class="sub-group">
            <span style="font-size:12px; opacity:0.7;"></span>
        </div>
    </div>

    <div id="tab-bar" class="tab-bar"></div>

    <div id="settings-panel">
        <div class="setting-row">
            <span>Theme:</span>
            <select id="theme-toggle" class="tool-control">
                <option value="dark">Dark Mode</option>
                <option value="light">Light Mode</option>
            </select>
        </div>
        <hr class="menu-divider">
        <div class="menu-item" id="menu-rotate-ccw">
            <svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path><polyline points="3 3 3 8 8 8"></polyline></svg> 
            Rotate Counterclockwise
        </div>
        <div class="menu-item" id="menu-rotate-cw">
            <svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"></path><polyline points="21 3 21 8 16 8"></polyline></svg> 
            Rotate Clockwise
        </div>
        <div class="menu-item" id="menu-first-page">
            <svg viewBox="0 0 24 24"><polyline points="12 19 12 5"></polyline><polyline points="5 12 12 5 19 12"></polyline></svg> 
            Go to First Page
        </div>
        <div class="menu-item" id="menu-last-page">
            <svg viewBox="0 0 24 24"><polyline points="12 5 12 19"></polyline><polyline points="19 12 12 19 5 12"></polyline></svg> 
            Go to Last Page
        </div>
        <div class="menu-item" id="menu-presentation">
            <svg viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg> 
            Presentation Mode
        </div>
        <div class="menu-item" id="btn-print">
            <svg viewBox="0 0 24 24"><polyline points="6 9 6 2 18 2 18 9"></polyline><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path><rect x="6" y="14" width="12" height="8"></rect></svg> 
            Print
        </div>
        <div class="menu-item" id="menu-doc-props">
            <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg> 
            Document Properties...
        </div>
        <hr class="menu-divider">
        <div class="shortcut-legend">
            <table>
                <tr><td>Highlight Selection</td><td>Shift + H</td></tr>
                <tr><td>Comment Selection</td><td>Shift + M</td></tr>
                <tr><td>Zoom In / Out</td><td>Shift + Scroll</td></tr>
                <tr><td>Rotate</td><td>Shift + R / E</td></tr>
                <tr><td>Delete Item</td><td>Del / Backspace</td></tr>
                <tr><td>Undo</td><td>Ctrl + Z</td></tr>
                <tr><td>Redo</td><td>Ctrl + Y</td></tr>
            </table>
        </div>
    </div>

    <div class="main-area">
        <div id="sidebar">
            <div class="sidebar-tabs">
                <div class="sidebar-tab" data-target="pane-pages">Pages</div>
                <div class="sidebar-tab active" data-target="pane-comments">Comments</div>
                <div class="sidebar-tab" data-target="pane-history">History</div>
            </div>
            
            <div id="pane-pages" class="sidebar-content-pane">
                <div class="pages-manage-bar">
                    <div class="custom-dropdown" id="manage-pages-dropdown">
                        <button class="dropdown-toggle">Manage <span>⌄</span></button>
                        <div class="dropdown-menu">
                            <div class="dropdown-item" data-action="merge">Merge PDF...</div>
                            <div class="dropdown-item" data-action="delete">Delete selected</div>
                            <div class="dropdown-item" data-action="export">Export selected...</div>
                        </div>
                    </div>
                </div>
                <div class="thumb-grid" id="thumbnails-container"></div>
            </div>
            
            <div id="pane-comments" class="sidebar-content-pane active">
                <div id="comment-list"></div>
            </div>
            
            <div id="pane-history" class="sidebar-content-pane">
                <div id="history-list"></div>
            </div>
        </div>
        <div id="viewer-container" class="layout-single">
            <div class="empty-state">No PDFs Open</div>
        </div>
    </div>
    
    <div id="bottom-ribbon">
        <div class="ribbon-left">
            <span id="ribbon-file-info">No workspace active</span>
            <span class="ribbon-divider"></span>
            <span id="ribbon-stats"></span>
        </div>
        <div class="ribbon-right" id="text-selection-stats" style="display: none; color: #64d8ff; font-weight: bold; gap: 8px;">
        </div>
    </div>

    <div id="mobile-selection-tools">
        <button id="mob-hl-btn" title="Highlight">H</button>
        <button id="mob-cmt-btn" title="Comment">C</button>
    </div>

    <div id="hl-context-menu">
        <input type="color" id="ctx-color-picker" title="Change Color" class="tool-color-bar" style="margin-right: 8px; width: 20px; height: 20px; cursor: pointer;">
        <button class="icon-btn-simple" id="comment-hl-btn" title="Add Comment" style="margin-right: 4px;">
            <svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
        </button>
        <button class="icon-btn-simple" id="delete-hl-btn" title="Delete Annotation">
            <svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
        </button>
    </div>

    <div id="lib-context-menu" class="dropdown-menu" style="display: none; position: absolute; z-index: 6000;">
        <div class="dropdown-item" id="ctx-lib-rename">Rename</div>
        <div class="dropdown-item" id="ctx-lib-props">Properties</div>
        <hr class="menu-divider">
        <div class="dropdown-item" id="ctx-lib-delete" style="color: #ff6b6b;">Delete</div>
    </div>

    <div id="comment-modal-overlay">
        <div class="custom-comment-box">
            <h3>Add comment</h3>
            <textarea id="comment-input" placeholder="Start typing..."></textarea>
            <div class="comment-actions">
                <button class="comment-btn-cancel" id="cancel-comment">Cancel</button>
                <button class="comment-btn-add" id="submit-comment">Add</button>
            </div>
        </div>
    </div>

    <div id="conflict-modal-overlay" style="position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 5500; display: none; align-items: center; justify-content: center;">
        <div class="custom-comment-box" style="width:350px;">
            <h3>File Conflict</h3>
            <p id="conflict-modal-text" style="font-size: 13px; color: #ccc; margin-bottom: 15px; margin-top: 5px;"></p>
            <div style="display: flex; gap: 10px; flex-direction: column;">
            <button class="comment-btn-add" id="conflict-overwrite" style="width: 100%; padding: 10px; background-color: #d70022;">Overwrite Existing</button>
            <button class="comment-btn-add" id="conflict-copy" style="width: 100%; padding: 10px;">Save as Copy</button>
            <button class="comment-btn-cancel" id="conflict-cancel" style="width: 100%; margin-top: 5px; border-color: transparent; background: transparent;">Cancel</button>
            </div>
         </div>
    </div>

    <div id="read-comment-modal">
        <div class="custom-comment-box" style="width: auto; min-width: 250px;">
            <h3>Comment</h3>
            <div class="read-content" id="read-comment-text"></div>
            <div class="comment-actions">
                <button class="comment-btn-cancel" id="close-read-comment">Close</button>
            </div>
        </div>
    </div>

    <div id="library-modal-overlay">
        <div class="lib-window">
            <div id="kv-warning-banner" style="display:none; background: #5a3a00; color: #ffeb3b; padding: 10px; font-size: 12px; border-bottom: 1px solid #ffca28; text-align: center;">
                ⚠️ <strong>Limited Storage Mode:</strong> You are using KV Storage (1,000 saves/day limit)
                <a href="#" onclick="document.getElementById('setup-guide-modal').style.display='flex'" style="color: #64d8ff; text-decoration: underline;">View Storage Setup Guide</a>
            </div>
            <div class="lib-header">
                <div>Library Explorer</div>
                <button class="lib-header-close" onclick="document.getElementById('library-modal-overlay').style.display='none'">×</button>
            </div>
            <div class="lib-body">
                <div class="lib-sidebar">
                    <div class="lib-nav-item" onclick="appState.currentLibPath = ''; renderLibrary();">
                        <span style="font-size: 16px;">🏠</span> Home
                    </div>
                    <div class="lib-storage">
                        <div style="margin-bottom:4px;">Cloud Storage Usage</div>
                        <progress id="lib-storage-bar" max="100" value="0"></progress>
                        <div id="lib-storage-text">Loading...</div>
                    </div>
                </div>
                <div class="lib-main-area">
                    <div class="lib-toolbar">
                        <div class="lib-breadcrumbs" id="lib-breadcrumbs">Root</div>
                        <div style="display:flex; gap: 8px; flex-wrap:wrap; align-items:center;">
                            <input type="text" id="lib-search" placeholder="Search..." class="tool-control" style="width: 150px;">
                            
                            <div id="lib-bulk-actions" style="display:none; align-items:center; gap:8px; border-left: 1px solid var(--border-color); padding-left: 8px;">
                                <span id="lib-bulk-count" style="font-size: 12px; opacity:0.8;">1 selected</span>
                                <button class="lib-btn" id="lib-bulk-download">Download</button>
                                <button class="lib-btn" id="lib-bulk-delete" style="color: #ff6b6b;">Delete</button>
                            </div>

                            <button class="icon-btn-simple" id="lib-btn-upload" title="Upload PDF to Library" style="border: 1px solid var(--border-color);">📄+</button>
                            <input type="file" id="lib-upload-input" accept="application/pdf" style="display: none;">
                            <button class="icon-btn-simple" id="lib-btn-newfolder" title="New Folder" style="border: 1px solid var(--border-color);">📁+</button>
                            <button class="icon-btn-simple" id="lib-btn-refresh" title="Refresh" style="border: 1px solid var(--border-color);">🔄</button>
                        </div>
                    </div>
                    <div class="lib-content-scroll">
                        <table class="lib-file-table">
                            <thead>
                                <tr>
                                    <th style="width: 5%;"><input type="checkbox" id="lib-select-all" class="lib-checkbox"></th>
                                    <th style="width: 45%;">
                                        Name 
                                        <select id="lib-sort" class="tool-control" style="margin-left:4px; padding:2px;">
                                            <option value="name_asc">A-Z</option>
                                            <option value="name_desc">Z-A</option>
                                            <option value="date_desc" selected>Newest First</option>
                                            <option value="date_asc">Oldest First</option>
                                            <option value="size_desc">Largest First</option>
                                            <option value="size_asc">Smallest First</option>
                                        </select>
                                    </th>
                                    <th style="width: 20%;">Date Modified</th>
                                    <th style="width: 15%;">Type</th>
                                    <th style="width: 15%;">Size</th>
                                </tr>
                            </thead>
                            <tbody id="lib-file-tbody"></tbody>
                        </table>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <div id="props-modal-overlay">
        <div class="props-modal-box">
            <div class="props-header">
                <span id="props-title">Properties</span> 
                <button onclick="document.getElementById('props-modal-overlay').style.display='none'">×</button>
            </div>
            <div class="props-body">
                <div style="display:flex; align-items:center; gap: 15px; margin-bottom: 15px;">
                    <span id="props-icon" style="font-size: 32px;">📄</span>
                    <input type="text" id="props-name" class="tool-control" style="flex:1;" readonly>
                </div>
                <hr class="menu-divider">
                <table class="props-table">
                    <tr><td>Type:</td><td id="props-type"></td></tr>
                    <tr><td>Location:</td><td id="props-location"></td></tr>
                    <tr><td>File Size:</td><td id="props-size"></td></tr>
                    <tr class="file-only-prop"><td>Total Pages:</td><td id="props-pages"></td></tr>
                </table>
                <hr class="menu-divider">
                <table class="props-table">
                    <tr class="file-only-prop"><td>Creator:</td><td id="props-creator"></td></tr>
                    <tr><td>Created:</td><td id="props-created"></td></tr>
                    <tr><td>Hash ID:</td><td id="props-hash" style="word-break: break-all; font-family: monospace; font-size: 11px;"></td></tr>
                </table>
                <div id="props-stats-section" style="display:none;">
                    <hr class="menu-divider">
                    <div style="text-align:center; opacity:0.8; margin: 10px 0 5px 0;">--- Document Statistics ---</div>
                    <table class="props-table">
                        <tr><td>Characters:</td><td id="props-chars"></td></tr>
                        <tr><td>Words:</td><td id="props-words"></td></tr>
                        <tr><td>Sentences:</td><td id="props-sentences"></td></tr>
                        <tr><td>Paragraphs:</td><td id="props-paragraphs"></td></tr>
                        <tr><td>Highlights:</td><td id="props-highlights"></td></tr>
                        <tr><td>Comments:</td><td id="props-comments"></td></tr>
                    </table>
                </div>
            </div>
            <div class="props-footer">
                <button class="lib-btn" onclick="document.getElementById('props-modal-overlay').style.display='none'">OK</button>
            </div>
        </div>
    </div>

    <div id="debug-modal-overlay">
        <div style="background:#1e1e1e; border: 2px solid #d70022; border-radius: 8px; width: 600px; max-width:90%; padding: 20px; color:white; font-family:monospace; box-shadow: 0 10px 30px rgba(0,0,0,0.8); display:flex; flex-direction:column;">
            <h3 style="color:#ff4444; margin-top:0;">⚠️ Execution Error</h3>
            <div id="debug-text" style="background:#000; padding:10px; font-size:12px; white-space:pre-wrap; border-radius:4px; flex:1; overflow-y:auto; color:#aaffaa; max-height:400px;"></div>
            <div style="text-align:right; margin-top:15px; flex-shrink:0;">
                <button onclick="document.getElementById('debug-modal-overlay').style.display='none'" style="background:#333; color:white; border:1px solid #555; padding:6px 12px; cursor:pointer; border-radius:4px;">Close</button>
            </div>
        </div>
    </div>
    
    <div id="setup-guide-modal" style="position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.7); z-index: 9999; display: none; align-items: center; justify-content: center;">
        <div class="custom-comment-box" style="width: 450px; max-width: 90%;">
            <h3 style="color: #64d8ff;">Storage Setup Guide</h3>
            <div style="font-size: 13px; line-height: 1.6; margin-bottom: 20px; color: #ccc;">
                <p>To save your PDFs and annotations, you must bind storage to your Cloudflare Worker.</p>
                
                <strong style="color:white;">Option 1: R2 Storage (Recommended)</strong><br>
                <em>Massive limits (1 million saves/month). Requires a card on file with Cloudflare to prevent abuse, but stays well within the free tier.</em>
                <ol style="margin-top: 5px; padding-left: 20px;">
                    <li>In Cloudflare, go to <strong>R2</strong> and Create a bucket.</li>
                    <li>Go to your Worker > Settings > Bindings.</li>
                    <li>Add an R2 Bucket binding. Set the Variable name to exactly: <code style="background:#000; padding:2px 4px; color:#fff;">pdf_r2_library</code></li>
                </ol>

                <strong style="color:white; margin-top:15px; display:block;">Option 2: KV Storage (Fallback)</strong><br>
                <em>No card required, but limited to 1,000 saves per day.</em>
                <ol style="margin-top: 5px; padding-left: 20px;">
                    <li>In Cloudflare, go to Workers & Pages > <strong>KV</strong> and create a namespace.</li>
                    <li>Go to your Worker > Settings > Bindings.</li>
                    <li>Add a KV Namespace binding. Set the Variable name to exactly: <code style="background:#000; padding:2px 4px; color:#fff;">pdf_kv_store</code></li>
                </ol>
            </div>
            <div style="text-align: right;">
                <button class="comment-btn-cancel" onclick="document.getElementById('setup-guide-modal').style.display='none'">Close Guide</button>
            </div>
        </div>
    </div>

    <script>
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        
        // --- GLOBAL STATE MANAGEMENT BLOCK ---
        const appState = {
            tabs: new Map(), 
            activeTabId: null,
            selectedIds: new Set(),
            pendingCommentData: null,
            pendingCommentForId: null,
            placementMode: null,
            pendingImageDataUrl: null,
            toolMode: 'textselect',
            undoStack: new Map(),
            redoStack: new Map(),
            libraryFiles: [],
            currentLibPath: "", 
            libCtxItem: null,
            lastSavedHistoryHash: "", 
            totalBytes: 0,
            libSelected: new Set(),
            defaultScale: null,
            isSavingCloud: false
        };

        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('/sw.js');
        }

        let deferredPrompt;
        const installBtn = document.getElementById('installBtn');

        window.addEventListener('beforeinstallprompt', (e) => {
            e.preventDefault();
            deferredPrompt = e;
            if (installBtn) installBtn.style.display = 'block';
        });

        if (installBtn) {
            installBtn.addEventListener('click', async () => {
                if (!deferredPrompt) return;
                deferredPrompt.prompt();
                const { outcome } = await deferredPrompt.userChoice;
                deferredPrompt = null;
                installBtn.style.display = 'none';
            });
        }

        // --- UTILITY FUNCTIONS BLOCK ---
        function cloneBuffer(data) {
            if (!data) return null;
            if (data instanceof ArrayBuffer) return data.slice(0);
            if (data instanceof Uint8Array) {
                const copy = new Uint8Array(data.length);
                copy.set(data);
                return copy.buffer;
            }
            return data;
        }

        function calculateFolderSize(folderHash) {
            let size = 0;
            appState.libraryFiles.forEach(file => {
                if (file.parent === folderHash) {
                    if (file.isFolder) {
                        size += calculateFolderSize(file.hash);
                    } else {
                        size += file.size || 0;
                    }
                }
            });
            return size;
        }

        function askConflictResolution(fileName) {
            return new Promise((resolve) => {
                const overlay = document.getElementById('conflict-modal-overlay');
                document.getElementById('conflict-modal-text').innerText = 'A file named "' + fileName + '" already exists. What would you like to do?';
                overlay.style.display = 'flex';

                const cleanup = () => {
                overlay.style.display = 'none';
                btnCancel.removeEventListener('click', onCancel);
                btnCopy.removeEventListener('click', onCopy);
                btnOverwrite.removeEventListener('click', onOverwrite);
                };

                const onCancel = () => { cleanup(); resolve('cancel'); };
                const onCopy = () => { cleanup(); resolve('copy'); };
                const onOverwrite = () => { cleanup(); resolve('overwrite'); };

                const btnCancel = document.getElementById('conflict-cancel');
                const btnCopy = document.getElementById('conflict-copy');
                const btnOverwrite = document.getElementById('conflict-overwrite');

                btnCancel.addEventListener('click', onCancel);
                btnCopy.addEventListener('click', onCopy);
                btnOverwrite.addEventListener('click', onOverwrite);
            });
        }

        function getActive() {
            return appState.tabs.get(appState.activeTabId);
        }

        function showDebug(contextMsg, error) {
            console.error(contextMsg, error);
            const overlay = document.getElementById('debug-modal-overlay');
            const debugText = document.getElementById('debug-text');
            if (overlay && debugText) {
                debugText.innerText = 'Context: ' + contextMsg + '\\n\\nMessage: ' + error.message + '\\n\\nStack Trace:\\n' + (error.stack || 'N/A');
                overlay.style.display = 'flex';
            }
            const st = document.getElementById('ribbon-file-info');
            if (st) st.innerText = "Failed: " + contextMsg;
        }

        window.addEventListener('error', function(e) {
            showDebug('Frontend JS Error', e.error || new Error(e.message));
        });
        
        window.addEventListener('unhandledrejection', function(e) {
            showDebug('Unhandled Promise Rejection', e.reason || new Error(e.reason));
        });

        async function apiFetch(url, options = {}) {
            try {
                const separator = url.includes('?') ? '&' : '?';
                const finalUrl = options.method === 'POST' ? url : url + separator + '_t=' + Date.now();
                
                const res = await fetch(finalUrl, options);
                
                if (!res.ok) {
                    let errStr = await res.text();
                    let parsed = { error: errStr };
                    try { parsed = JSON.parse(errStr); } catch(e) {}
                    const errObj = new Error(parsed.error || 'HTTP ' + res.status);
                    errObj.stack = parsed.stack || errObj.stack;
                    throw errObj;
                }
                
                const contentType = res.headers.get("Content-Type");
                if (contentType && contentType.includes("application/json")) {
                    return await res.json();
                }
                return res;
            } catch (e) {
                showDebug('API Call Failed: ' + url, e);
                throw e; 
            }
        }

        // --- DOM ELEMENTS BLOCK ---
        const container = document.getElementById('viewer-container');
        const tabBar = document.getElementById('tab-bar');
        const sidebar = document.getElementById('sidebar');
        const commentList = document.getElementById('comment-list');
        const historyList = document.getElementById('history-list');
        const thumbContainer = document.getElementById('thumbnails-container');
        const contextMenu = document.getElementById('hl-context-menu');
        const readModal = document.getElementById('read-comment-modal');
        const settingsPanel = document.getElementById('settings-panel');
        const pageInput = document.getElementById('page-input');
        const pageCount = document.getElementById('page-count');
        const zoomSelect = document.getElementById('zoom-select');
        const zoomCustom = document.getElementById('zoom-custom');
        const zoomWrapper = document.getElementById('zoom-wrapper');
        const btnUndo = document.getElementById('btn-undo');
        const btnRedo = document.getElementById('btn-redo');
        const pSize = document.getElementById('prop-size');
        const pFont = document.getElementById('prop-font');
        const pShape = document.getElementById('prop-shape');
        const pActionText = document.getElementById('prop-action-text');

        const cloudSyncBtn = document.getElementById('cloud-sync-btn');
        const cloudIconSaved = document.getElementById('icon-cloud-saved');
        const cloudIconSaving = document.getElementById('icon-cloud-saving');
        const cloudPopup = document.getElementById('cloud-sync-popup');
        const cloudPopupText = document.getElementById('cloud-popup-status-text');

        // --- CLOUD SYNC UI BLOCK ---
        function setCloudStatus(status) {
            cloudSyncBtn.style.display = 'flex';
            if (status === 'saving') {
                appState.isSavingCloud = true;
                cloudIconSaved.style.display = 'none';
                cloudIconSaving.style.display = 'block';
                cloudPopupText.innerText = "Saving to Library...";
            } else if (status === 'saved') {
                appState.isSavingCloud = false;
                cloudIconSaving.style.display = 'none';
                cloudIconSaved.style.display = 'block';
                cloudPopupText.innerText = "All changes saved to Library";
            }
        }

        cloudSyncBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            cloudPopup.style.display = cloudPopup.style.display === 'flex' ? 'none' : 'flex';
        });

        // --- MOBILE SELECTION TOOLS BLOCK ---
        const mobileTools = document.getElementById('mobile-selection-tools');
        const mobHlBtn = document.getElementById('mob-hl-btn');
        const mobCmtBtn = document.getElementById('mob-cmt-btn');

        mobHlBtn.addEventListener('pointerdown', e => e.preventDefault());
        mobHlBtn.addEventListener('click', (e) => { 
            e.stopPropagation(); 
            processSelection('highlight'); 
            mobileTools.style.display = 'none'; 
        });

        mobCmtBtn.addEventListener('pointerdown', e => e.preventDefault());
        mobCmtBtn.addEventListener('click', (e) => { 
            e.stopPropagation(); 
            processSelection('comment'); 
            mobileTools.style.display = 'none'; 
        });

        window.addEventListener('resize', () => {
            if (window.innerWidth <= 900) {
                document.getElementById('text-selection-stats').style.display = 'none';
            }
        });

        document.addEventListener('selectionchange', () => {
            const selection = window.getSelection();
            const text = selection.toString();
            const trimmed = text.trim();
            const selectionStats = document.getElementById('text-selection-stats');

            if (text.length > 0 && selection.rangeCount > 0) {
                const range = selection.getRangeAt(0);
                const rect = range.getBoundingClientRect();

                if (rect.width > 0 && rect.height > 0) {
                    mobileTools.style.display = 'flex';
                } else {
                    mobileTools.style.display = 'none';
                }

                if (window.innerWidth > 900) {
                    let sanitized = "";
                    for (let i = 0; i < trimmed.length; i++) {
                        let code = trimmed.charCodeAt(i);
                        if (code === 32 || code === 9 || code === 10 || code === 13 || code === 160) {
                            sanitized += " ";
                        } else if (code > 32 && code !== 127 && code !== 65279) {
                            sanitized += trimmed[i];
                        }
                    }
                    
                    let prev = "";
                    while (sanitized !== prev) {
                        prev = sanitized;
                        sanitized = sanitized.split('  ').join(' ');
                    }
                    sanitized = sanitized.trim();

                    let wordCount = 0;
                    let charCount = 0;
                    const words = sanitized.split(' ');
                    
                    for (let w = 0; w < words.length; w++) {
                        const word = words[w];
                        let hasAlphanumeric = false;
                        
                        for (let c = 0; c < word.length; c++) {
                            charCount++; 
                            let code = word.charCodeAt(c);
                            if ((code > 47 && code < 58) || 
                                (code > 64 && code < 91) || 
                                (code > 96 && code < 123) || 
                                code > 191) {                 
                                hasAlphanumeric = true;
                            }
                        }
                        if (hasAlphanumeric) {
                            wordCount++;
                        }
                    }

                    selectionStats.innerText = wordCount + ' words | ' + charCount + ' chars';
                    selectionStats.style.display = 'flex';
                } else {
                    selectionStats.style.display = 'none';
                }
            } else {
                mobileTools.style.display = 'none';
                selectionStats.style.display = 'none';
            }
        });

        // --- HISTORY & UNDO/REDO BLOCK ---
        function saveStateForUndo(active, structureChange = false) {
            if (!active) return;
            if (!appState.undoStack.has(active.tabId)) {
                appState.undoStack.set(active.tabId, []);
            }
            const stack = appState.undoStack.get(active.tabId);
            const state = { annots: JSON.stringify(active.annots), rotation: active.rotation };
            
            if (structureChange) {
                state.bytes = cloneBuffer(active.bytes);
                state.originalBytes = cloneBuffer(active.originalBytes);
            }
            
            stack.push(state);
            if (stack.length > 50) stack.shift(); 
            appState.redoStack.set(active.tabId, []); 
            updateUndoRedoUI();
        }

        async function triggerUndo() {
            const active = getActive();
            if (!active) return;
            const stack = appState.undoStack.get(active.tabId);
            if (!stack || stack.length === 0) return;
            if (!appState.redoStack.has(active.tabId)) {
                appState.redoStack.set(active.tabId, []);
            }
            
            const prevStatePeek = stack[stack.length - 1];
            const currentState = { 
                annots: JSON.stringify(active.annots), 
                rotation: active.rotation 
            };
            
            if (prevStatePeek.bytes || active.rotation !== prevStatePeek.rotation) {
                currentState.bytes = cloneBuffer(active.bytes);
                currentState.originalBytes = cloneBuffer(active.originalBytes);
            }
            appState.redoStack.get(active.tabId).push(currentState);

            const prevState = stack.pop();
            active.annots = JSON.parse(prevState.annots);
            let structureChanged = false;

            if (prevState.bytes) {
                active.bytes = cloneBuffer(prevState.bytes);
                active.originalBytes = cloneBuffer(prevState.originalBytes);
                active.pdfDoc = await pdfjsLib.getDocument({ data: new Uint8Array(cloneBuffer(active.bytes)) }).promise;
                structureChanged = true;
            }
            
            if (prevState.rotation !== undefined && active.rotation !== prevState.rotation) {
                active.rotation = prevState.rotation;
                structureChanged = true;
            }

            appState.selectedIds.clear();
            contextMenu.style.display = 'none';
            mobileTools.style.display = 'none';

            if (structureChanged) {
                pageInput.max = active.pdfDoc.numPages;
                pageCount.innerText = active.pdfDoc.numPages;
                await renderAllPages();
                renderThumbnails();
            }
            
            renderAnnotations(); 
            syncAnnotations(true);
            updateUndoRedoUI();
            updateStatusCounter();
        }

        async function triggerRedo() {
            const active = getActive();
            if (!active) return;
            const stack = appState.redoStack.get(active.tabId);
            if (!stack || stack.length === 0) return;
            if (!appState.undoStack.has(active.tabId)) {
                appState.undoStack.set(active.tabId, []);
            }
            
            const nextStatePeek = stack[stack.length - 1];
            const currentState = { 
                annots: JSON.stringify(active.annots), 
                rotation: active.rotation 
            };
            
            if (nextStatePeek.bytes || active.rotation !== nextStatePeek.rotation) {
                currentState.bytes = cloneBuffer(active.bytes);
                currentState.originalBytes = cloneBuffer(active.originalBytes);
            }
            appState.undoStack.get(active.tabId).push(currentState);

            const nextState = stack.pop();
            active.annots = JSON.parse(nextState.annots);
            let structureChanged = false;

            if (nextState.bytes) {
                active.bytes = cloneBuffer(nextState.bytes);
                active.originalBytes = cloneBuffer(nextState.originalBytes);
                active.pdfDoc = await pdfjsLib.getDocument({ data: new Uint8Array(cloneBuffer(active.bytes)) }).promise;
                structureChanged = true;
            }
            
            if (nextState.rotation !== undefined && active.rotation !== nextState.rotation) {
                active.rotation = nextState.rotation;
                structureChanged = true;
            }

            appState.selectedIds.clear();
            contextMenu.style.display = 'none';
            mobileTools.style.display = 'none';

            if (structureChanged) {
                pageInput.max = active.pdfDoc.numPages;
                pageCount.innerText = active.pdfDoc.numPages;
                await renderAllPages();
                renderThumbnails();
            }
            
            renderAnnotations();
            syncAnnotations(true);
            updateUndoRedoUI();
            updateStatusCounter();
        }

        function updateUndoRedoUI() {
            const active = getActive();
            if (!active) {
                btnUndo.style.opacity = '0.3'; btnUndo.style.pointerEvents = 'none';
                btnRedo.style.opacity = '0.3'; btnRedo.style.pointerEvents = 'none';
                return;
            }
            const uStack = appState.undoStack.get(active.tabId);
            const rStack = appState.redoStack.get(active.tabId);
            
            if (uStack && uStack.length > 0) { 
                btnUndo.style.opacity = '1'; 
                btnUndo.style.pointerEvents = 'auto'; 
            } else { 
                btnUndo.style.opacity = '0.3'; 
                btnUndo.style.pointerEvents = 'none'; 
            }
            
            if (rStack && rStack.length > 0) { 
                btnRedo.style.opacity = '1'; 
                btnRedo.style.pointerEvents = 'auto'; 
            } else { 
                btnRedo.style.opacity = '0.3'; 
                btnRedo.style.pointerEvents = 'none'; 
            }
        }

        btnUndo.addEventListener('click', triggerUndo);
        btnRedo.addEventListener('click', triggerRedo);

        // --- TOOLBAR FUNCTIONALITY BLOCK ---
        function updateSubToolbar() {
            pSize.style.display = 'none'; 
            pFont.style.display = 'none'; 
            pShape.style.display = 'none'; 
            pActionText.style.display = 'none';
            
            if (appState.toolMode === 'draw' || appState.toolMode === 'shape') {
                pSize.style.display = 'flex';
            }
            if (appState.toolMode === 'shape') {
                pShape.style.display = 'flex';
            }
            if (appState.toolMode === 'text') { 
                pFont.style.display = 'flex'; 
                pActionText.style.display = 'flex'; 
                pActionText.innerHTML = '<span style="font-size:12px; opacity:0.7;">Click on page to type. Double-click text to edit.</span>';
            }
            if (appState.toolMode === 'highlight' || appState.toolMode === 'comment') {
                pActionText.style.display = 'flex';
                pActionText.innerHTML = '<span style="font-size:12px; opacity:0.7;">Select text to ' + appState.toolMode + '. Color options are under the main toolbar icons.</span>';
            }
        }

        function setToolMode(modeStr) {
            document.querySelectorAll('.tool-btn-container').forEach(function(b) { 
                b.classList.remove('active'); 
            });
            const targetBtn = document.querySelector('.tool-btn-container[data-mode="' + modeStr + '"]');
            if (targetBtn) targetBtn.classList.add('active');

            appState.toolMode = modeStr;
            document.body.className = 'tool-mode-' + appState.toolMode;
            
            if (appState.toolMode === 'text') {
                appState.placementMode = 'text';
            } else if (appState.placementMode !== 'image') {
                appState.placementMode = null;
            }
            
            container.classList.remove('cursor-text');
            if (appState.placementMode !== 'image') {
                container.classList.remove('cursor-image');
            }
            if (appState.toolMode === 'text') {
                container.classList.add('cursor-text');
            }
            
            updateSubToolbar();
        }

        document.querySelectorAll('.tool-btn-container').forEach(function(btnContainer) {
            btnContainer.addEventListener('dblclick', function(e) {
                if(e.target.tagName.toLowerCase() === 'input') return;
                const defaultTool = document.querySelector('.tool-btn-container[data-mode="textselect"]');
                if(defaultTool && btnContainer !== defaultTool) {
                    defaultTool.click();
                }
            });
            
            btnContainer.addEventListener('click', function(e) {
                if(e.target.tagName.toLowerCase() === 'input') return;
                if(btnContainer.id === 'tool-image-btn') return; 
                setToolMode(btnContainer.dataset.mode);
            });
        });

        document.querySelectorAll('.tool-modifier').forEach(function(el) {
            el.addEventListener('input', function() {
                const active = getActive();
                if (active && appState.selectedIds.size > 0) {
                    saveStateForUndo(active);
                    appState.selectedIds.forEach(id => {
                        const target = active.annots.find(a => a.id === id);
                        if (target) {
                            if (el.type === 'color') target.color = el.value;
                            if (el.id === 'tool-size') target.size = parseInt(el.value) * 2;
                            if (el.id === 'tool-fontsize') target.size = parseInt(el.value);
                            if (el.id === 'tool-font') target.font = el.value;
                            if (el.id === 'tool-shape-type' && target.type === 'shape') target.shapeType = el.value;
                        }
                    });
                    renderAnnotations();
                    syncAnnotations(false);
                }
            });
        });

        document.getElementById('ctx-color-picker').addEventListener('input', function(e) {
            const active = getActive();
            if (!active || appState.selectedIds.size === 0) return;
            const newColor = e.target.value;
            saveStateForUndo(active);
            appState.selectedIds.forEach(id => {
                const target = active.annots.find(a => a.id === id);
                if (target && target.color) {
                    target.color = newColor;
                }
            });
            renderAnnotations();
            syncAnnotations(false);
        });

        document.getElementById('comment-hl-btn').addEventListener('click', function(e) {
            e.stopPropagation();
            if (appState.selectedIds.size > 0) {
                const id = Array.from(appState.selectedIds)[0];
                appState.pendingCommentForId = id;
                document.getElementById('comment-modal-overlay').style.display = 'flex';
                document.getElementById('comment-input').value = ''; 
                document.getElementById('comment-input').focus();
                contextMenu.style.display = 'none';
            }
        });

        function updateSelectionUI() {
            document.querySelectorAll('.selected-target').forEach(w => w.classList.remove('selected-target'));
            appState.selectedIds.forEach(id => {
                document.querySelectorAll('[data-id="' + id + '"]').forEach(el => el.classList.add('selected-target'));
            });
            if (appState.selectedIds.size === 0) {
                contextMenu.style.display = 'none';
                if (appState.toolMode === 'select') setToolMode('textselect');
            }
        }

        const manageDropdown = document.getElementById('manage-pages-dropdown');
        const manageToggle = manageDropdown.querySelector('.dropdown-toggle');
        const manageMenu = manageDropdown.querySelector('.dropdown-menu');

        manageToggle.addEventListener('click', function(e) {
            e.stopPropagation();
            manageMenu.classList.toggle('show');
        });

        manageDropdown.querySelectorAll('.dropdown-item').forEach(function(item) {
            item.addEventListener('click', async function(e) {
                const action = e.target.dataset.action;
                manageMenu.classList.remove('show');
                const active = getActive();
                if (!active || !action) return;

                if (action === 'merge') {
                    const input = document.createElement('input');
                    input.type = 'file'; 
                    input.accept = 'application/pdf';
                    input.onchange = async function(ev) {
                        try {
                            const file = ev.target.files[0];
                            if (!file) return;
                            document.getElementById('ribbon-file-info').innerText = "Merging PDF...";
                            const bytes = await file.arrayBuffer();
                            const pdfLib = window.PDFLib;
                            
                            saveStateForUndo(active, true);
                            
                            const activePdf = await pdfLib.PDFDocument.load(cloneBuffer(active.originalBytes));
                            const newPdf = await pdfLib.PDFDocument.load(bytes);
                            const copiedPages = await activePdf.copyPages(newPdf, newPdf.getPageIndices());
                            copiedPages.forEach(function(p) { activePdf.addPage(p); });
                            
                            const newBytesUint8 = await activePdf.save();
                            active.bytes = cloneBuffer(newBytesUint8);
                            active.originalBytes = cloneBuffer(newBytesUint8);
                            active.pdfDoc = await pdfjsLib.getDocument({ data: new Uint8Array(cloneBuffer(active.bytes)) }).promise;
                            
                            await syncAnnotations(true);
                            await renderAllPages();
                            renderThumbnails();
                            
                            pageInput.max = active.pdfDoc.numPages;
                            pageCount.innerText = active.pdfDoc.numPages;
                            setTimeout(updateStatusCounter, 3000);
                        } catch (err) { 
                            showDebug('Failed to merge document', err); 
                        }
                    };
                    input.click(); 
                    return;
                }

                const selectedBoxes = Array.from(document.querySelectorAll('.thumb-checkbox:checked'));
                if (selectedBoxes.length === 0) { 
                    alert("Select pages first."); 
                    return; 
                }
                const pagesToProcess = selectedBoxes.map(function(cb) { return parseInt(cb.dataset.page); }).sort(function(a,b) { return a - b; });

                if (action === 'delete') {
                    if (pagesToProcess.length === active.pdfDoc.numPages) { 
                        alert("Cannot delete all pages."); 
                        return; 
                    }
                    if (confirm('Delete ' + pagesToProcess.length + ' page(s)?')) {
                        try {
                            document.getElementById('ribbon-file-info').innerText = "Modifying PDF...";
                            saveStateForUndo(active, true);
                            
                            const pdfLib = window.PDFLib;
                            const pdfDoc = await pdfLib.PDFDocument.load(cloneBuffer(active.originalBytes));
                            for (let i = pagesToProcess.length - 1; i >= 0; i--) {
                                pdfDoc.removePage(pagesToProcess[i] - 1);
                            }
                            const newBytesUint8 = await pdfDoc.save();
                            let newAnnots = [];
                            active.annots.forEach(function(a) {
                                if (!pagesToProcess.includes(a.page)) {
                                    let shift = pagesToProcess.filter(function(p) { return p < a.page; }).length;
                                    a.page -= shift; 
                                    newAnnots.push(a);
                                }
                            });
                            active.bytes = cloneBuffer(newBytesUint8); 
                            active.originalBytes = cloneBuffer(newBytesUint8); 
                            active.annots = newAnnots;
                            active.pdfDoc = await pdfjsLib.getDocument({ data: new Uint8Array(cloneBuffer(active.bytes)) }).promise;
                            
                            pageInput.max = active.pdfDoc.numPages;
                            pageCount.innerText = active.pdfDoc.numPages;
                            if (parseInt(pageInput.value) > active.pdfDoc.numPages) {
                                pageInput.value = active.pdfDoc.numPages;
                            }
                            
                            await syncAnnotations(true); 
                            await renderAllPages(); 
                            renderAnnotations(); 
                            renderThumbnails(); 
                            updateStatusCounter();
                        } catch (err) { 
                            showDebug('Failed to delete pages', err); 
                        }
                    }
                } else if (action === 'export') {
                    try {
                        document.getElementById('ribbon-file-info').innerText = "Exporting...";
                        const pdfLib = window.PDFLib;
                        const srcDoc = await pdfLib.PDFDocument.load(cloneBuffer(active.originalBytes));
                        const outDoc = await pdfLib.PDFDocument.create();
                        const zeroIndexed = pagesToProcess.map(function(p) { return p - 1; });
                        const copiedPages = await outDoc.copyPages(srcDoc, zeroIndexed);
                        copiedPages.forEach(function(p) { outDoc.addPage(p); });
                        const outBytes = await outDoc.save();
                        const blob = new Blob([outBytes], { type: 'application/pdf' });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a'); 
                        a.href = url; 
                        a.download = 'Exported_' + pagesToProcess.length + '_pages.pdf';
                        document.body.appendChild(a); 
                        a.click(); 
                        document.body.removeChild(a); 
                        URL.revokeObjectURL(url);
                        updateStatusCounter();
                    } catch (err) { 
                        showDebug('Failed to export pages', err); 
                    }
                }
            });
        });

        // --- LOCAL INDEXEDDB TEMP CACHE BLOCK ---
        const dbPromise = new Promise(function(resolve, reject) {
            const req = indexedDB.open('PdfWorkspaceDB', 1);
            req.onupgradeneeded = function(e) {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('FilesCache')) {
                    db.createObjectStore('FilesCache');
                }
            };
            req.onsuccess = function(e) { resolve(e.target.result); };
            req.onerror = function(e) { reject(e); };
        });

        async function saveToLocalTemp(tabId, dataObj) {
            const db = await dbPromise;
            const tx = db.transaction('FilesCache', 'readwrite');
            const store = tx.objectStore('FilesCache');
            store.put({ tabId: tabId, hash: dataObj.hash, name: dataObj.name, bytes: dataObj.bytes, annots: dataObj.annots, currentPage: dataObj.currentPage }, tabId);
            if (tabId !== dataObj.hash) { 
                try { store.delete(dataObj.hash); } catch(e) {} 
            }
        }

        async function removeFromLocalTemp(tabId) {
            const db = await dbPromise;
            const tx = db.transaction('FilesCache', 'readwrite');
            tx.objectStore('FilesCache').delete(tabId);
        }

        async function loadAllFromLocalTemp() {
            const db = await dbPromise;
            const tx = db.transaction('FilesCache', 'readonly');
            const req = tx.objectStore('FilesCache').getAll();
            return new Promise(function(r) { 
                req.onsuccess = function() { r(req.result); }; 
            });
        }
        // --- INITIALIZATION BLOCK ---
        window.addEventListener('DOMContentLoaded', async function() {
            document.getElementById('fallback-file-input').value = '';
            document.getElementById('image-upload-input').value = '';
            
            try {
                const cachedFiles = await loadAllFromLocalTemp();
                if (cachedFiles && cachedFiles.length > 0) {
                    let orderedFiles = [];
                    try {
                        const savedOrder = JSON.parse(localStorage.getItem('pdf_workspace_tab_order') || '[]');
                        if (savedOrder.length > 0) {
                            // Strictly reconstruct the array to match the exact saved order
                            savedOrder.forEach(id => {
                                const file = cachedFiles.find(f => f.tabId === id || f.hash === id);
                                if (file) orderedFiles.push(file);
                            });
                            // Append any cache files that somehow weren't in the saved order list
                            cachedFiles.forEach(file => {
                                if (!orderedFiles.includes(file)) orderedFiles.push(file);
                            });
                        } else {
                            orderedFiles = cachedFiles;
                        }
                    } catch(e) {
                        orderedFiles = cachedFiles;
                    }
                    
                    document.getElementById('ribbon-file-info').innerText = "Restoring previous session...";
                    for (const file of orderedFiles) {
                        await ingestFileBytes(file.bytes, file.name, null, file.hash, true, file, true);
                    }
                    
                    const lastActive = localStorage.getItem('pdf_workspace_active_tab');
                    if (lastActive && appState.tabs.has(lastActive)) {
                        switchTab(lastActive);
                    } else if (appState.tabs.size > 0) {
                        switchTab(Array.from(appState.tabs.keys())[0]);
                    }
                }
            } catch (err) { 
                showDebug('Failed to load local DB', err); 
            }
            
            apiFetch('/api/library').then(data => {
                appState.libraryFiles = data.files || [];
                appState.totalBytes = data.totalBytes || 0;
                updateStorageUI();
            }).catch(e => {});
        });

        document.querySelectorAll('.sidebar-tab').forEach(function(tab) {
            tab.addEventListener('click', function() {
                document.querySelectorAll('.sidebar-tab, .sidebar-content-pane').forEach(function(el) { 
                    el.classList.remove('active'); 
                });
                tab.classList.add('active');
                document.getElementById(tab.dataset.target).classList.add('active');
                if (tab.dataset.target === 'pane-history') fetchVersionHistory();
                if (tab.dataset.target === 'pane-pages') renderThumbnails();
            });
        });

        document.getElementById('theme-toggle').addEventListener('change', function(e) { 
            document.documentElement.setAttribute('data-theme', e.target.value); 
        });
        
        document.getElementById('toggle-settings').addEventListener('click', function(e) { 
            e.stopPropagation(); 
            settingsPanel.style.display = settingsPanel.style.display === 'flex' ? 'none' : 'flex'; 
        });
        
        settingsPanel.addEventListener('mousedown', function(e) { 
            e.stopPropagation(); 
        }); 

        document.getElementById('toggle-sidebar').addEventListener('click', function() { 
            sidebar.style.display = sidebar.style.display === 'none' || sidebar.style.display === '' ? 'flex' : 'none'; 
        });

        document.getElementById('toggle-library').addEventListener('click', function() { 
            document.getElementById('library-modal-overlay').style.display = 'flex';
            appState.libSelected.clear();
            loadLibrary();
        });

        document.getElementById('menu-presentation').addEventListener('click', function() { 
            if (container.requestFullscreen) {
                container.requestFullscreen(); 
            }
        });
        
        document.getElementById('menu-first-page').addEventListener('click', function() { 
            const active = getActive(); 
            if (active) { 
                pageInput.value = 1; 
                document.getElementById('page-1')?.scrollIntoView({ behavior: 'smooth' }); 
            } 
        });
        
        document.getElementById('menu-last-page').addEventListener('click', function() { 
            const active = getActive(); 
            if (active) { 
                pageInput.value = active.pdfDoc.numPages; 
                document.getElementById('page-' + active.pdfDoc.numPages)?.scrollIntoView({ behavior: 'smooth' }); 
            } 
        });
        
        document.getElementById('menu-rotate-cw').addEventListener('click', async function() { 
            const active = getActive(); 
            if (active) { 
                saveStateForUndo(active, true); 
                active.rotation = (active.rotation + 90) % 360; 
                await renderAllPages(); 
                renderAnnotations(); 
                renderThumbnails(); 
            } 
        });
        
        document.getElementById('menu-rotate-ccw').addEventListener('click', async function() { 
            const active = getActive(); 
            if (active) { 
                saveStateForUndo(active, true); 
                active.rotation = (active.rotation - 90 + 360) % 360; 
                await renderAllPages(); 
                renderAnnotations(); 
                renderThumbnails(); 
            } 
        });
        
        document.getElementById('menu-doc-props').addEventListener('click', async function() {
            const active = getActive();
            if (active) {
                try {
                    let info = 'File Name: ' + active.name + '\\nFile Size: ' + ((active.bytes.byteLength / 1024 / 1024).toFixed(2)) + ' MB\\nTotal Pages: ' + active.pdfDoc.numPages + '\\n\\n';
                    if (active.creator) {
                        info += 'Creator: ' + active.creator + '\\n';
                    }
                    
                    let h = 0, c = 0;
                    active.annots.forEach(a => { 
                        if (a.type === 'highlight') h++; 
                        if (a.type === 'comment') c++; 
                    });
                    
                    info += '\\n--- Document Statistics ---\\n';
                    if (active.statsCalculated) {
                        info += 'Characters: ' + active.stats.chars + '\\nWords: ' + active.stats.words + '\\nSentences: ' + active.stats.sentences + '\\nParagraphs: ' + active.stats.paragraphs + '\\n';
                    } else { 
                        info += 'Text stats calculating...\\n'; 
                    }
                    
                    info += 'Highlights: ' + h + '\\nComments: ' + c + '\\n';
                    alert(info);
                } catch(err) { 
                    showDebug('Failed to fetch doc properties', err); 
                }
            }
        });

        document.getElementById('tool-image-btn').addEventListener('click', function(e) {
            e.stopPropagation(); 
            document.getElementById('image-upload-input').click();
        });

        document.getElementById('image-upload-input').addEventListener('change', function(e) {
            try {
                const file = e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = function(event) {
                    appState.pendingImageDataUrl = event.target.result;
                    appState.placementMode = 'image'; 
                    setToolMode('select');
                    container.classList.add('cursor-image'); 
                    settingsPanel.style.display = 'none';
                };
                reader.readAsDataURL(file); 
                e.target.value = ''; 
            } catch(err) { 
                showDebug('Image parsing failed', err); 
            }
        });

        // --- ZOOM CONTROL BLOCK ---
        async function applyZoom() {
            const active = getActive();
            if (!active) return;
            
            // Save scroll state relative to the exact center of the screen
            const cX = container.scrollLeft + container.clientWidth / 2;
            const cY = container.scrollTop + container.clientHeight / 2;
            const sW = container.scrollWidth || 1;
            const sH = container.scrollHeight || 1;
            
            const ratioX = cX / sW;
            const ratioY = cY / sH;

            // Temporarily clear to prevent renderAllPages from fighting the zoom math
            active.scrollTop = undefined;

            await renderAllPages();
            renderAnnotations();

            // Wait a frame for DOM to update, then restore the exact scroll position
            requestAnimationFrame(() => {
                container.scrollLeft = (ratioX * container.scrollWidth) - (container.clientWidth / 2);
                container.scrollTop = (ratioY * container.scrollHeight) - (container.clientHeight / 2);
                
                active.scrollTop = container.scrollTop;
                active.scrollLeft = container.scrollLeft;
            });
        }

        zoomSelect.addEventListener('change', async function(e) {
            const active = getActive();
            if (!active) return;
            const val = e.target.value;
            try {
                if (val === 'auto' || val === 'actual') {
                    active.scale = 1.0;
                } else if (val === 'fit') {
                    const page = await active.pdfDoc.getPage(1); 
                    const vp = page.getViewport({ scale: 1 });
                    active.scale = (container.clientHeight - 40) / vp.height;
                } else if (val === 'width') {
                    const page = await active.pdfDoc.getPage(1); 
                    const vp = page.getViewport({ scale: 1 });
                    active.scale = (container.clientWidth - 40) / vp.width;
                } else {
                    active.scale = parseFloat(val);
                }
                
                appState.defaultScale = active.scale;
                zoomCustom.value = Math.round(active.scale * 100);
                applyZoom();
            } catch(err) { 
                showDebug('Zoom apply failed', err); 
            }
        });

        zoomCustom.addEventListener('change', function(e) {
            const active = getActive();
            if (!active) return;
            let val = parseInt(e.target.value);
            if (isNaN(val) || val < 10) val = 10;
            active.scale = val / 100; 
            appState.defaultScale = active.scale;
            zoomSelect.value = "auto"; 
            applyZoom();
        });

        pageInput.addEventListener('change', function(e) {
            const active = getActive();
            if (!active) return;
            const num = parseInt(e.target.value);
            if (active.pdfDoc && num >= 1 && num <= active.pdfDoc.numPages) {
                const target = document.getElementById('page-' + num);
                if (target) target.scrollIntoView({ behavior: 'smooth' });
            } else { 
                e.target.value = 1; 
            }
        });

        let wheelZoomTimer = null;
        let wheelStartScale = null;

        container.addEventListener('wheel', function(e) {
            if (e.shiftKey) {
                e.preventDefault(); 
                const active = getActive();
                if (!active) return;
                
                if (wheelStartScale === null) {
                    wheelStartScale = active.scale;
                }

                const zoomFactor = 1.1;
                if (e.deltaY < 0) {
                    active.scale *= zoomFactor; 
                } else {
                    active.scale /= zoomFactor; 
                }
                
                if (active.scale < 0.2) active.scale = 0.2;
                if (active.scale > 5.0) active.scale = 5.0;
                
                appState.defaultScale = active.scale; 
                zoomCustom.value = Math.round(active.scale * 100);
                zoomSelect.value = "auto";
                
                // Visual smooth scaling without rebuilding the DOM
                const visualMultiplier = active.scale / wheelStartScale;
                document.querySelectorAll('.page-wrapper').forEach(p => {
                    p.style.transform = 'scale(' + visualMultiplier + ')';
                    p.style.transformOrigin = 'center top';
                });

                // Debounce the heavy re-render until scrolling stops
                clearTimeout(wheelZoomTimer);
                wheelZoomTimer = setTimeout(() => {
                    document.querySelectorAll('.page-wrapper').forEach(p => {
                        p.style.transform = 'none';
                    });
                    wheelStartScale = null;
                    applyZoom();
                }, 200);
            }
        }, { passive: false });

        container.addEventListener('scroll', function() {
            const active = getActive();
            if (active) {
                active.scrollTop = container.scrollTop;
                active.scrollLeft = container.scrollLeft;
            }
        }, { passive: true });

        // --- PAGE RENDERING BLOCK (Lazy Loading) ---
        let renderObserver = null;
        let navObserver = null;

        function setupIntersectionObserver() {
            if (renderObserver) renderObserver.disconnect();
            if (navObserver) navObserver.disconnect();
            
            // 1. Observer for lazy loading (triggers 400px early)
            renderObserver = new IntersectionObserver(function(entries) {
                entries.forEach(function(entry) { 
                    if (entry.isIntersecting) {
                        const pg = parseInt(entry.target.dataset.page);
                        const active = getActive();
                        if (entry.target.dataset.rendered === 'false' && active) {
                            entry.target.dataset.rendered = 'true';
                            renderSinglePage(pg, active);
                        }
                    }
                });
            }, { root: container, rootMargin: '400px 0px', threshold: 0.01 });

            // 2. Observer for page tracking (triggers exactly at the center of the screen)
            navObserver = new IntersectionObserver(function(entries) {
                entries.forEach(function(entry) { 
                    if (entry.isIntersecting) {
                        const pg = parseInt(entry.target.dataset.page);
                        pageInput.value = pg; 
                        const active = getActive();
                        
                        if (active && active.currentPage !== pg) {
                            active.currentPage = pg;
                            saveToLocalTemp(active.tabId, active);
                        }
                    }
                });
            }, { root: container, rootMargin: '-49% 0px -49% 0px' }); 
            
            document.querySelectorAll('.page-wrapper').forEach(function(p) { 
                renderObserver.observe(p); 
                navObserver.observe(p);
            });
        }

        async function renderAllPages() {
            const active = getActive();
            if (!active) return;
            
            container.innerHTML = '';
            
            // Fetch page 1 just to get the base dimensions for the skeletons
            const page1 = await active.pdfDoc.getPage(1);
            const vp1 = page1.getViewport({ scale: active.scale, rotation: active.rotation });
            
            for (let pageNum = 1; pageNum <= active.pdfDoc.numPages; pageNum++) {
                const pageDiv = document.createElement('div'); 
                pageDiv.className = 'page-wrapper';
                pageDiv.id = 'page-' + pageNum; 
                pageDiv.dataset.page = pageNum; 
                pageDiv.dataset.rendered = 'false';
                
                // Pre-size the skeleton so scrolling behaves normally before it renders
                pageDiv.style.width = vp1.width + 'px';
                pageDiv.style.height = vp1.height + 'px';
                
                container.appendChild(pageDiv);
            }

            // INSTANTLY SCROLL BEFORE THE OBSERVER IS ATTACHED
            if (active.scrollTop !== undefined) {
                requestAnimationFrame(() => {
                    container.scrollTop = active.scrollTop;
                    container.scrollLeft = active.scrollLeft;
                });
            } else {
                const targetPage = document.getElementById('page-' + (active.currentPage || 1));
                if (targetPage) targetPage.scrollIntoView({ behavior: 'auto' });
            }


            setupIntersectionObserver();
        }

        async function renderSinglePage(pageNum, active) {
            try {
                const pageDiv = document.getElementById('page-' + pageNum);
                if (!pageDiv) return;

                const page = await active.pdfDoc.getPage(pageNum);
                const viewport = page.getViewport({ scale: active.scale, rotation: active.rotation });
                
                // Update actual exact dimensions for this specific page and clear skeleton
                pageDiv.style.width = viewport.width + 'px'; 
                pageDiv.style.height = viewport.height + 'px';
                pageDiv.innerHTML = ''; 

                const canvas = document.createElement('canvas');
                canvas.width = viewport.width; 
                canvas.height = viewport.height; 
                pageDiv.appendChild(canvas);

                const textLayerDiv = document.createElement('div'); 
                textLayerDiv.className = 'textLayer';
                textLayerDiv.style.setProperty('--scale-factor', viewport.scale); 
                pageDiv.appendChild(textLayerDiv);
                
                const drawingLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); 
                drawingLayer.setAttribute('class', 'drawing-layer');
                drawingLayer.setAttribute('viewBox', '0 0 1000 1000'); 
                drawingLayer.setAttribute('preserveAspectRatio', 'none');
                pageDiv.appendChild(drawingLayer);

                await page.render({ canvasContext: canvas.getContext('2d'), viewport: viewport, annotationMode: 0 }).promise;
                const textContent = await page.getTextContent();
                await pdfjsLib.renderTextLayer({ textContentSource: textContent, container: textLayerDiv, viewport: viewport, textDivs: [] }).promise;

                // [KEEP YOUR EXISTING NATIVE ANNOTATION EXTRACTOR LOOP HERE]
                if (!active.nativeAnnotsImported) {
                    const nativeAnnotations = await page.getAnnotations();
                    let importedAny = false;
                    nativeAnnotations.forEach(function(annot, idx) {
                        const subtype = annot.subtype;
                        if (subtype === 'Highlight' || subtype === 'Text') {
                            const type = subtype === 'Text' ? 'comment' : 'highlight';
                            const pdfRect = annot.rect; 
                            const viewBuffer = page.view; 
                            const pWidth = viewBuffer[2] - viewBuffer[0]; 
                            const pHeight = viewBuffer[3] - viewBuffer[1];
                            const x0 = pdfRect[0] - viewBuffer[0]; 
                            const y0 = pdfRect[1] - viewBuffer[1];
                            const x1 = pdfRect[2] - viewBuffer[0]; 
                            const y1 = pdfRect[3] - viewBuffer[1];
                            const leftPct = (Math.min(x0, x1) / pWidth) * 100; 
                            const topPct = ((pHeight - Math.max(y0, y1)) / pHeight) * 100;
                            const widthPct = (Math.abs(x1 - x0) / pWidth) * 100; 
                            const heightPct = (Math.abs(y1 - y0) / pHeight) * 100;

                            let colorHex = '#ffff00';
                            if (annot.color && annot.color.length >= 3) {
                                const r = Math.round(annot.color[0]).toString(16).padStart(2, '0');
                                const g = Math.round(annot.color[1]).toString(16).padStart(2, '0');
                                const b = Math.round(annot.color[2]).toString(16).padStart(2, '0');
                                colorHex = '#' + r + g + b;
                            }
                            const exists = active.annots.some(function(a) { 
                                return a.page === pageNum && Math.abs(a.leftPct - leftPct) < 0.5 && Math.abs(a.topPct - topPct) < 0.5; 
                            });
                            
                            if (!exists) {
                                active.annots.push({
                                    id: 'native-' + pageNum + '-' + idx + '-' + Date.now(), 
                                    type: type, page: pageNum, text: annot.contents || '', color: colorHex,
                                    leftPct: leftPct, topPct: topPct, widthPct: widthPct, heightPct: heightPct
                                });
                                importedAny = true;
                            }
                        }
                    });
                    if (pageNum === active.pdfDoc.numPages) {
                        active.nativeAnnotsImported = true;
                        if (importedAny) syncAnnotations(false); 
                    }
                }
                // [END EXISTING NATIVE EXTRACTION]

                // NEW: Redraw annotations for this specific page after it loads
                active.annots.filter(a => a.page === pageNum).forEach(annot => {
                    drawAnnotationBox(annot, pageDiv);
                });
                updateSelectionUI();

            } catch (err) { }
        }

        async function renderThumbnails() {
            const active = getActive();
            if (!active) return;
            thumbContainer.innerHTML = '';
            for (let i = 1; i <= active.pdfDoc.numPages; i++) {
                const wrap = document.createElement('div'); 
                wrap.className = 'thumb-wrapper';
                const cb = document.createElement('input'); 
                cb.type = 'checkbox'; 
                cb.className = 'thumb-checkbox'; 
                cb.dataset.page = i;
                const canvas = document.createElement('canvas'); 
                wrap.appendChild(cb); 
                wrap.appendChild(canvas);
                const lbl = document.createElement('div'); 
                lbl.className = 'thumb-label'; 
                lbl.innerText = i; 
                wrap.appendChild(lbl);
                thumbContainer.appendChild(wrap);
                
                active.pdfDoc.getPage(i).then(function(page) {
                    const vp = page.getViewport({ scale: 0.3, rotation: active.rotation });
                    canvas.width = vp.width; 
                    canvas.height = vp.height; 
                    page.render({ canvasContext: canvas.getContext('2d'), viewport: vp });
                });
            }
        }

        // --- FILE INGESTION & CLOUD AUTO-ADD BLOCK ---
        async function calculateHash(arrayBuffer) {
            try {
                if (crypto && crypto.subtle) {
                    const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer.slice(0));
                    return Array.from(new Uint8Array(hashBuffer)).map(function(b) { return b.toString(16).padStart(2, '0'); }).join('');
                }
            } catch(e) {}
            return 'hash-' + arrayBuffer.byteLength + '-' + Date.now();
        }

        document.getElementById('open-file-btn').addEventListener('click', async function() {
            if ('showOpenFilePicker' in window) {
                try {
                    const [handle] = await window.showOpenFilePicker({ types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }] });
                    const file = await handle.getFile();
                    const bytes = await file.arrayBuffer();
                    const hash = await calculateHash(bytes);
                    await ingestFileBytes(bytes, file.name, handle, hash, true);
                } catch (err) { 
                    if (err.name !== 'AbortError') document.getElementById('fallback-file-input').click(); 
                }
            } else { 
                document.getElementById('fallback-file-input').click(); 
            }
        });

        document.getElementById('fallback-file-input').addEventListener('change', async function(e) {
            try {
                const file = e.target.files[0];
                if (!file) return;
                const bytes = await file.arrayBuffer();
                const hash = await calculateHash(bytes);
                await ingestFileBytes(bytes, file.name, null, hash, true);
                e.target.value = '';
            } catch(err) { 
                showDebug('Failed reading local file', err); 
            }
        });

        document.getElementById('btn-toggle-layout')?.addEventListener('click', () => {
            if (container.classList.contains('layout-grid')) {
                container.classList.remove('layout-grid');
                container.classList.add('layout-single');
            } else {
                container.classList.remove('layout-single');
                container.classList.add('layout-grid');
            }
            applyZoom(); // Refresh observer alignment
        });

        async function ingestFileBytes(bytes, name, handle, hash, fetchCloud, restoredData = null, preventSwitch = false) {
            let existingTabId = null;
            appState.tabs.forEach(t => { 
                if(t.name === name || t.hash === hash) {
                    existingTabId = t.tabId; 
                }
            });
            
            if (existingTabId && !restoredData) {
                if(!confirm('The file "' + name + '" is already open. Open another instance anyway?')) {
                    switchTab(existingTabId); 
                    return;
                }
            }

            const tabId = restoredData ? (restoredData.tabId || restoredData.hash) : (hash + '-' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5));
            document.getElementById('ribbon-file-info').innerText = "Parsing Data...";
            
            try {
                const pristineBytes = cloneBuffer(bytes);
                const pdfLib = window.PDFLib;

                // 1. Load a temporary PDF.js instance to extract metadata & native annotations
                const tempPdfJs = await pdfjsLib.getDocument({ data: new Uint8Array(cloneBuffer(pristineBytes)) }).promise;
                
                let creator = 'Unknown';
                try {
                    const meta = await tempPdfJs.getMetadata();
                    if (meta.info && meta.info.Creator) creator = meta.info.Creator;
                } catch(e) {}

                let workspaceAnnots = [];
                let hasCloudState = false;

                if (restoredData) {
                    workspaceAnnots = restoredData.annots || [];
                    hasCloudState = true;
                } 
                
                // FORCE SYNC: If fetching cloud, it must override local cache to prevent split-brain conflicts
                if (fetchCloud) {
                    try {
                        const data = await apiFetch('/api/load?hash=' + encodeURIComponent(hash));
                        if (data && data.drawing !== undefined) {
                            workspaceAnnots = data.drawing;
                            hasCloudState = true;
                        }
                    } catch(e) {
                        console.log('Cloud sync unavailable, falling back to local state.');
                    }
                }

                if (!hasCloudState) {
                    // Extract native annotations to interactive elements if no cloud state exists yet
                    for (let i = 1; i <= tempPdfJs.numPages; i++) {
                        try {
                            const page = await tempPdfJs.getPage(i);
                            const nativeAnnotations = await page.getAnnotations();
                            const viewBuffer = page.view; 
                            const pWidth = viewBuffer[2] - viewBuffer[0]; 
                            const pHeight = viewBuffer[3] - viewBuffer[1];

                            nativeAnnotations.forEach((annot, idx) => {
                                const subtype = annot.subtype;
                                if (subtype === 'Highlight' || subtype === 'Text') {
                                    const type = subtype === 'Text' ? 'comment' : 'highlight';
                                    const pdfRect = annot.rect; 
                                    
                                    const x0 = pdfRect[0] - viewBuffer[0]; 
                                    const y0 = pdfRect[1] - viewBuffer[1];
                                    const x1 = pdfRect[2] - viewBuffer[0]; 
                                    const y1 = pdfRect[3] - viewBuffer[1];

                                    const leftPct = (Math.min(x0, x1) / pWidth) * 100; 
                                    const topPct = ((pHeight - Math.max(y0, y1)) / pHeight) * 100;
                                    const widthPct = (Math.abs(x1 - x0) / pWidth) * 100; 
                                    const heightPct = (Math.abs(y1 - y0) / pHeight) * 100;

                                    let colorHex = '#ffff00';
                                    if (annot.color && annot.color.length >= 3) {
                                        const r = Math.round(annot.color[0]).toString(16).padStart(2, '0');
                                        const g = Math.round(annot.color[1]).toString(16).padStart(2, '0');
                                        const b = Math.round(annot.color[2]).toString(16).padStart(2, '0');
                                        colorHex = '#' + r + g + b;
                                    }
                                    
                                    workspaceAnnots.push({
                                        id: 'native-' + i + '-' + idx + '-' + Date.now(), 
                                        type: type, 
                                        page: i, 
                                        text: annot.contents || '', 
                                        color: colorHex,
                                        leftPct: leftPct, 
                                        topPct: topPct, 
                                        widthPct: widthPct, 
                                        heightPct: heightPct
                                    });
                                }
                            });
                        } catch(e) {}
                    }
                }

                // 2. Strip visual annotations from bytes so PDF.js doesn't paint ghost highlights
                document.getElementById('ribbon-file-info').innerText = "Optimizing viewing...";
                const pdfLibDoc = await pdfLib.PDFDocument.load(cloneBuffer(pristineBytes));
                const pages = pdfLibDoc.getPages();
                
                pages.forEach(page => {
                    let annotsList = page.node.lookup(pdfLib.PDFName.of('Annots'));
                    if (annotsList instanceof pdfLib.PDFArray) {
                        const keptAnnots = [];
                        for (let i = 0; i < annotsList.size(); i++) {
                            try {
                                const annotRef = annotsList.get(i); 
                                const annot = pdfLibDoc.context.lookup(annotRef);
                                if (annot instanceof pdfLib.PDFDict) {
                                    const subtypeName = annot.lookup(pdfLib.PDFName.of('Subtype')); 
                                    const subtypeStr = subtypeName ? (subtypeName.name || String(subtypeName).replace('/', '')) : '';
                                    if (!['Highlight', 'Text', 'Ink', 'Square', 'Circle', 'Line', 'Polygon', 'PolyLine', 'FreeText'].includes(subtypeStr)) {
                                        keptAnnots.push(annotRef); // Keep links, form elements etc.
                                    }
                                } else {
                                    keptAnnots.push(annotRef);
                                }
                            } catch(e) {}
                        }
                        page.node.set(pdfLib.PDFName.of('Annots'), pdfLibDoc.context.obj(keptAnnots)); 
                    }
                });
                
                const workingBytes = await pdfLibDoc.save();

                // 3. Load stripped bytes into actual workspace viewer
                const finalPdfJs = await pdfjsLib.getDocument({ data: new Uint8Array(cloneBuffer(workingBytes)) }).promise;

                appState.tabs.set(tabId, {
                    tabId: tabId, 
                    hash: hash, 
                    name: name, 
                    bytes: workingBytes, 
                    originalBytes: pristineBytes, 
                    fileHandle: handle, 
                    pdfDoc: finalPdfJs,
                    creator: creator,
                    scale: 1.5, 
                    rotation: restoredData ? (restoredData.rotation || 0) : 0, 
                    annots: workspaceAnnots, 
                    unsaved: false, 
                    nativeAnnotsImported: true, 
                    statsCalculated: false, 
                    isCalculatingStats: false,
                    initialFitDone: false,
                    currentPage: restoredData ? (restoredData.currentPage || 1) : 1
                });

                await saveToLocalTemp(tabId, appState.tabs.get(tabId));

                // --- PRE-LOAD UNDO STACK FROM CLOUD HISTORY ---
                try {
                    const history = await apiFetch('/api/versions?hash=' + encodeURIComponent(hash));
                    if (history && history.length > 0) {
                        const stack = [];
                        // Skip index 0 because that is the current active state
                        for (let i = history.length - 1; i >= 1; i--) {
                            // Reconstruct image dataUrls that were compressed for the cloud
                            const reconstructedDrawing = history[i].drawing.map(vAnnot => {
                                if (vAnnot.hasImage) {
                                    const existingImg = workspaceAnnots.find(a => a.id === vAnnot.id);
                                    if (existingImg) return { ...vAnnot, dataUrl: existingImg.dataUrl };
                                }
                                return vAnnot;
                            });
                            stack.push({
                                annots: JSON.stringify(reconstructedDrawing),
                                rotation: restoredData ? (restoredData.rotation || 0) : 0
                            });
                        }
                        appState.undoStack.set(tabId, stack);
                    }
                } catch(e) {}
                
                // --- AUTO-UPLOAD NEW FILES TO CLOUD LIBRARY ---
                const alreadyInLib = appState.libraryFiles.some(f => f.hash === hash);
                if (!alreadyInLib) {
                    appState.libraryFiles.push({
                        name: name, hash: hash, isFolder: false, size: workingBytes.byteLength, created: Date.now(), parent: appState.currentLibPath, stats: null
                    });
                    apiFetch('/api/library/upload?hash=' + encodeURIComponent(hash) + '&name=' + encodeURIComponent(name) + '&parent=' + encodeURIComponent(appState.currentLibPath), {
                        method: 'POST',
                        body: cloneBuffer(pristineBytes)
                    }).catch(e => console.log('Auto-upload failed', e));
                }

                renderTabsUI();
                if (!preventSwitch) switchTab(tabId);
            } catch (err) { 
                showDebug('Error rendering PDF data', err); 
            }
        }

        window.addEventListener('beforeunload', function(e) {
            if (appState.isSavingCloud) { 
                e.preventDefault(); 
                e.returnValue = 'Changes are currently saving to the cloud. Are you sure you want to leave?'; 
            }
        });

        // --- TAB MANAGEMENT BLOCK ---
        function renderTabsUI() {
            tabBar.innerHTML = '';
            appState.tabs.forEach(function(tab, tabId) {
                const div = document.createElement('div');
                div.className = 'tab ' + (tabId === appState.activeTabId ? 'active' : '') + ' ' + (tab.unsaved ? 'unsaved' : '');
                div.draggable = true; 
                div.dataset.tabid = tabId;

                div.innerHTML = '<span class="tab-unsaved-dot"></span><span class="tab-name" style="pointer-events: none;">' + tab.name + '</span> <span class="tab-close" data-tabid="' + tabId + '">×</span>';

                // Single click to switch/close
                div.onclick = function(e) { 
                    if (e.target.classList.contains('tab-close')) closeTab(tabId); 
                    else switchTab(tabId); 
                };

                // Double click to rename
                div.addEventListener('dblclick', async (e) => {
                    if (e.target.classList.contains('tab-close')) return;
                    e.stopPropagation();
                    const newName = prompt("Rename PDF:", tab.name);
                    if (newName && newName.trim() !== '' && newName !== tab.name) {
                        const cleanName = newName.trim();
                        
                        // 1. Update the Tab State
                        tab.name = cleanName;
                        
                        // 2. Update the Active Workspace State
                        const active = getActive();
                        if (active && active.tabId === tabId) {
                            active.name = cleanName;
                        }

                        // 3. Update Library List
                        const libFile = appState.libraryFiles.find(f => f.hash === tab.hash);
                        if (libFile) {
                            libFile.name = cleanName;
                        }

                        // 4. Save locally and to server
                        saveToLocalTemp(tabId, tab);
                        apiFetch('/api/library', { 
                            method: 'POST', 
                            body: JSON.stringify({ action: 'rename', target: tab.hash, newName: cleanName }) 
                        }).catch(() => {});

                        renderTabsUI();
                        renderLibrary(); // Refresh library list to show new name
                        updateStatusCounter();
                    }
                });

                // Desktop drag and drop
                div.addEventListener('dragstart', e => {
                    e.dataTransfer.setData('text/plain', tabId);
                    div.style.opacity = '0.5';
                });
                div.addEventListener('dragend', () => div.style.opacity = '1');
                div.addEventListener('dragover', e => e.preventDefault());
                div.addEventListener('drop', e => {
                    e.preventDefault();
                    const draggedId = e.dataTransfer.getData('text/plain');
                    if (draggedId && draggedId !== tabId) reorderTabs(draggedId, tabId);
                });

                tabBar.appendChild(div);
            });
            localStorage.setItem('pdf_workspace_tab_order', JSON.stringify(Array.from(appState.tabs.keys())));
        }

        function reorderTabs(draggedId, targetId) {
            const entries = Array.from(appState.tabs.entries());
            const draggedIndex = entries.findIndex(e => e[0] === draggedId);
            const targetIndex = entries.findIndex(e => e[0] === targetId);

            if (draggedIndex > -1 && targetIndex > -1 && draggedIndex !== targetIndex) {
                // Remove the dragged item first
                const item = entries.splice(draggedIndex, 1)[0];
                // Recalculate target index since array mutated
                const newTargetIndex = entries.findIndex(e => e[0] === targetId);
                // Insert after target if dragging right, otherwise at target
                const insertIndex = draggedIndex < targetIndex ? newTargetIndex + 1 : newTargetIndex;
                
                entries.splice(insertIndex, 0, item);
                appState.tabs = new Map(entries);
                renderTabsUI();
            }
        }

        async function calculatePDFStats(active) {
            if (active.statsCalculated || active.isCalculatingStats) return;
            active.isCalculatingStats = true;
            try {
                let fullText = "";
                for (let i = 1; i <= active.pdfDoc.numPages; i++) {
                    const page = await active.pdfDoc.getPage(i);
                    const textContent = await page.getTextContent({ disableCombineTextItems: false });
                    
                    let pageText = "";
                    for (let j = 0; j < textContent.items.length; j++) {
                        const item = textContent.items[j];
                        if (item.str) {
                            pageText += item.str;
                        }
                        if (item.hasEOL) {
                            pageText += " "; 
                        }
                    }
                    fullText += pageText + " ";
                    if (i % 5 === 0) await new Promise(r => setTimeout(r, 10)); 
                }

                let sanitized = "";
                for (let i = 0; i < fullText.length; i++) {
                    let code = fullText.charCodeAt(i);
                    if (code === 32 || code === 9 || code === 10 || code === 13 || code === 160) {
                        sanitized += " ";
                    } 
                    else if (code > 32 && code !== 127 && code !== 65279) {
                        sanitized += fullText[i];
                    }
                }

                let prev = "";
                while (sanitized !== prev) {
                    prev = sanitized;
                    sanitized = sanitized.split('  ').join(' ');
                }
                sanitized = sanitized.trim();

                let wordCount = 0;
                let charCount = 0;
                const words = sanitized.split(' ');
                
                for (let w = 0; w < words.length; w++) {
                    const word = words[w];
                    let hasAlphanumeric = false;
                    
                    for (let c = 0; c < word.length; c++) {
                        charCount++; 
                        let code = word.charCodeAt(c);
                        if ((code > 47 && code < 58) || 
                            (code > 64 && code < 91) || 
                            (code > 96 && code < 123) || 
                            code > 191) {                 
                            hasAlphanumeric = true;
                        }
                    }
                    
                    if (hasAlphanumeric) {
                        wordCount++;
                    }
                }

                const sentenceCount = sanitized.split('. ').length + sanitized.split('! ').length + sanitized.split('? ').length - 2;

                active.stats = {
                    chars: charCount,
                    words: wordCount,
                    sentences: sentenceCount > 0 ? sentenceCount : 0,
                    paragraphs: Math.max(1, Math.ceil((sentenceCount > 0 ? sentenceCount : 1) / 4))
                };
                
                active.statsCalculated = true;
                if (getActive() === active) updateStatusCounter();
                syncAnnotations(false);
            } catch (err) { 
                console.error("Stats calculating error", err); 
                active.stats = { chars: 0, words: 0, sentences: 0, paragraphs: 0 };
                active.statsCalculated = true;
            } finally { 
                active.isCalculatingStats = false; 
            }
        }

        function updateStatusCounter() {
            const active = getActive();
            if (!active) { 
                document.getElementById('ribbon-file-info').innerText = "No workspace active"; 
                document.getElementById('ribbon-stats').innerText = "";
                setCloudStatus('saved');
                cloudSyncBtn.style.display = 'none';
                return; 
            }
            let h = 0, c = 0;
            active.annots.forEach(a => { 
                if (a.type === 'highlight') h++; 
                if (a.type === 'comment') c++; 
            });
            document.getElementById('ribbon-file-info').innerText = active.name;
            document.getElementById('ribbon-stats').innerText = 'Highlights: ' + h + ' | Comments: ' + c;
            cloudSyncBtn.style.display = 'flex';
        }

        let initialPinchDistance = null;
        let initialScale = 1;
        let isPinching = false;
        let currentVisualMultiplier = 1;

        container.addEventListener('touchstart', function(e) {
            if (e.touches.length >= 2) {
                isPinching = true;
                e.preventDefault(); 

                initialPinchDistance = Math.hypot(
                    e.touches[0].clientX - e.touches[1].clientX,
                    e.touches[0].clientY - e.touches[1].clientY
                );
                const active = getActive();
                if (active) initialScale = active.scale;
                currentVisualMultiplier = 1;
            }
        }, { passive: false });

        container.addEventListener('touchmove', function(e) {
            if (isPinching && e.touches.length >= 2 && initialPinchDistance) {
                e.preventDefault(); 
                
                const currentDistance = Math.hypot(
                    e.touches[0].clientX - e.touches[1].clientX,
                    e.touches[0].clientY - e.touches[1].clientY
                );
                
                const active = getActive();
                if (active) {
                    const scaleRatio = currentDistance / initialPinchDistance;
                    let targetScale = initialScale * scaleRatio;
                    
                    if (targetScale < 0.2) targetScale = 0.2;
                    if (targetScale > 5.0) targetScale = 5.0;

                    currentVisualMultiplier = targetScale / initialScale;
                    document.querySelectorAll('.page-wrapper').forEach(p => {
                        p.style.transform = 'scale(' + currentVisualMultiplier + ')';
                        p.style.transformOrigin = 'center top';
                    });
                }
            }
        }, { passive: false });

        container.addEventListener('touchend', function(e) {
            if (isPinching && e.touches.length < 2) {
                isPinching = false;
                const active = getActive();
                
                if (active && initialPinchDistance) {
                    if (Math.abs(currentVisualMultiplier - 1) > 0.03) {
                        active.scale = initialScale * currentVisualMultiplier;
                        
                        if (active.scale < 0.2) active.scale = 0.2;
                        if (active.scale > 5.0) active.scale = 5.0;
                        
                        appState.defaultScale = active.scale;
                        if (typeof zoomCustom !== 'undefined' && zoomCustom) zoomCustom.value = Math.round(active.scale * 100);
                        if (typeof zoomSelect !== 'undefined' && zoomSelect) zoomSelect.value = "auto";
                        
                        document.querySelectorAll('.page-wrapper').forEach(p => {
                            p.style.transform = 'none';
                        });
                        
                        applyZoom(); 
                    } else {
                        document.querySelectorAll('.page-wrapper').forEach(p => {
                            p.style.transform = 'none';
                        });
                    }
                }
                initialPinchDistance = null;
                currentVisualMultiplier = 1;
            }
        });

        async function switchTab(tabId) {
            if (!appState.tabs.has(tabId)) return;
            if (appState.activeTabId === tabId) return; // Prevent re-render on active tab to allow dblclick

            appState.activeTabId = tabId;
            localStorage.setItem('pdf_workspace_active_tab', tabId);
            const active = getActive();
            
            renderTabsUI(); 
            document.getElementById('page-nav-wrapper').style.display = 'flex';
            zoomWrapper.style.display = 'block'; 
            updateStatusCounter();

            pageCount.innerText = active.pdfDoc.numPages; 
            pageInput.max = active.pdfDoc.numPages; 
            pageInput.value = active.currentPage || 1;
            
            updateUndoRedoUI(); 
            calculatePDFStats(active);
            
            if (!active.initialFitDone) {
                if (appState.defaultScale !== null) {
                    active.scale = appState.defaultScale;
                } else {
                    const cWidth = container.clientWidth || window.innerWidth;
                    if (cWidth > 900) {
                        active.scale = 1.5; 
                        appState.defaultScale = 1.5;
                    } else {
                        try {
                            const page = await active.pdfDoc.getPage(1);
                            const vp = page.getViewport({ scale: 1 });
                            let newScale = (cWidth - 20) / vp.width;
                            if (newScale < 0.2) newScale = 0.2;
                            active.scale = newScale;
                            appState.defaultScale = newScale;
                        } catch(e) {
                            active.scale = 1.0;
                        }
                    }
                }
                active.initialFitDone = true;
            }
            
            zoomCustom.value = Math.round(active.scale * 100);
            
            await renderAllPages(); 
            renderAnnotations(); 
            fetchVersionHistory();
            
            if (document.querySelector('.sidebar-tab[data-target="pane-pages"]').classList.contains('active')) {
                renderThumbnails();
            }
        }

        async function closeTab(tabId) {
            const tab = appState.tabs.get(tabId);
            if (!tab) return;

            if (appState.isSavingCloud) {
                if (!confirm('Changes are currently saving to the cloud. Close anyway and risk losing recent progress?')) return;
            } else if (tab.unsaved) {
                if (!confirm('"' + tab.name + '" has unsaved local changes that did not reach the cloud. Close anyway?')) return;
            }

            appState.tabs.delete(tabId); 
            await removeFromLocalTemp(tabId);
            appState.undoStack.delete(tabId); 
            appState.redoStack.delete(tabId);

            if (appState.activeTabId === tabId) {
                const remaining = Array.from(appState.tabs.keys());
                if (remaining.length > 0) { 
                    switchTab(remaining[remaining.length - 1]); 
                } else {
                    appState.activeTabId = null; 
                    container.innerHTML = '<div class="empty-state">No PDFs Open</div>';
                    document.getElementById('page-nav-wrapper').style.display = 'none'; 
                    zoomWrapper.style.display = 'none';
                    cloudSyncBtn.style.display = 'none';
                    document.getElementById('ribbon-file-info').innerText = 'No workspace active';
                    document.getElementById('ribbon-stats').innerText = '';
                    commentList.innerHTML = ''; 
                    historyList.innerHTML = ''; 
                    thumbContainer.innerHTML = '';
                    updateUndoRedoUI(); 
                    renderTabsUI();
                }
            } else { 
                renderTabsUI(); 
            }
        }

        // --- PAGE RENDERING BLOCK (Eager Loading) ---
        async function renderAllPages() {
            const active = getActive();
            if (!active) return;
            container.innerHTML = '';
            for (let pageNum = 1; pageNum <= active.pdfDoc.numPages; pageNum++) {
                const pageDiv = document.createElement('div'); 
                pageDiv.className = 'page-wrapper';
                pageDiv.id = 'page-' + pageNum; 
                pageDiv.dataset.page = pageNum; 
                container.appendChild(pageDiv);
                await renderSinglePage(pageNum, active);
            }
            const targetPage = document.getElementById('page-' + (active.currentPage || 1));
            if (targetPage) targetPage.scrollIntoView({ behavior: 'auto' });
            setupIntersectionObserver();
        }

        async function renderSinglePage(pageNum, active) {
            try {
                const page = await active.pdfDoc.getPage(pageNum);
                const viewport = page.getViewport({ scale: active.scale, rotation: active.rotation });
                const pageDiv = document.getElementById('page-' + pageNum);
                pageDiv.style.width = viewport.width + 'px'; 
                pageDiv.style.height = viewport.height + 'px';

                const canvas = document.createElement('canvas');
                canvas.width = viewport.width; 
                canvas.height = viewport.height; 
                pageDiv.appendChild(canvas);

                const textLayerDiv = document.createElement('div'); 
                textLayerDiv.className = 'textLayer';
                textLayerDiv.style.setProperty('--scale-factor', viewport.scale); 
                pageDiv.appendChild(textLayerDiv);
                
                const drawingLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); 
                drawingLayer.setAttribute('class', 'drawing-layer');
                drawingLayer.setAttribute('viewBox', '0 0 1000 1000'); 
                drawingLayer.setAttribute('preserveAspectRatio', 'none');
                pageDiv.appendChild(drawingLayer);

                await page.render({ canvasContext: canvas.getContext('2d'), viewport: viewport, annotationMode: 0 }).promise;
                const textContent = await page.getTextContent();
                await pdfjsLib.renderTextLayer({ textContentSource: textContent, container: textLayerDiv, viewport: viewport, textDivs: [] }).promise;

                if (!active.nativeAnnotsImported) {
                    const nativeAnnotations = await page.getAnnotations();
                    let importedAny = false;
                    nativeAnnotations.forEach(function(annot, idx) {
                        const subtype = annot.subtype;
                        if (subtype === 'Highlight' || subtype === 'Text') {
                            const type = subtype === 'Text' ? 'comment' : 'highlight';
                            const pdfRect = annot.rect; 
                            const viewBuffer = page.view; 
                            const pWidth = viewBuffer[2] - viewBuffer[0]; 
                            const pHeight = viewBuffer[3] - viewBuffer[1];

                            const x0 = pdfRect[0] - viewBuffer[0]; 
                            const y0 = pdfRect[1] - viewBuffer[1];
                            const x1 = pdfRect[2] - viewBuffer[0]; 
                            const y1 = pdfRect[3] - viewBuffer[1];

                            const leftPct = (Math.min(x0, x1) / pWidth) * 100; 
                            const topPct = ((pHeight - Math.max(y0, y1)) / pHeight) * 100;
                            const widthPct = (Math.abs(x1 - x0) / pWidth) * 100; 
                            const heightPct = (Math.abs(y1 - y0) / pHeight) * 100;

                            let colorHex = '#ffff00';
                            if (annot.color && annot.color.length >= 3) {
                                const r = Math.round(annot.color[0]).toString(16).padStart(2, '0');
                                const g = Math.round(annot.color[1]).toString(16).padStart(2, '0');
                                const b = Math.round(annot.color[2]).toString(16).padStart(2, '0');
                                colorHex = '#' + r + g + b;
                            }
                            const exists = active.annots.some(function(a) { 
                                return a.page === pageNum && Math.abs(a.leftPct - leftPct) < 0.5 && Math.abs(a.topPct - topPct) < 0.5; 
                            });
                            
                            if (!exists) {
                                active.annots.push({
                                    id: 'native-' + pageNum + '-' + idx + '-' + Date.now(), 
                                    type: type, 
                                    page: pageNum, 
                                    text: annot.contents || '', 
                                    color: colorHex,
                                    leftPct: leftPct, 
                                    topPct: topPct, 
                                    widthPct: widthPct, 
                                    heightPct: heightPct
                                });
                                importedAny = true;
                            }
                        }
                    });
                    if (pageNum === active.pdfDoc.numPages) {
                        active.nativeAnnotsImported = true;
                        if (importedAny) { 
                            renderAnnotations(); 
                            syncAnnotations(false); 
                        }
                    }
                }
            } catch (err) { }
        }

        async function renderThumbnails() {
            const active = getActive();
            if (!active) return;
            thumbContainer.innerHTML = '';
            for (let i = 1; i <= active.pdfDoc.numPages; i++) {
                const wrap = document.createElement('div'); 
                wrap.className = 'thumb-wrapper';
                const cb = document.createElement('input'); 
                cb.type = 'checkbox'; 
                cb.className = 'thumb-checkbox'; 
                cb.dataset.page = i;
                const canvas = document.createElement('canvas'); 
                wrap.appendChild(cb); 
                wrap.appendChild(canvas);
                const lbl = document.createElement('div'); 
                lbl.className = 'thumb-label'; 
                lbl.innerText = i; 
                wrap.appendChild(lbl);
                thumbContainer.appendChild(wrap);
                
                active.pdfDoc.getPage(i).then(function(page) {
                    const vp = page.getViewport({ scale: 0.3, rotation: active.rotation });
                    canvas.width = vp.width; 
                    canvas.height = vp.height; 
                    page.render({ canvasContext: canvas.getContext('2d'), viewport: vp });
                });
            }
        }

        // --- INTERACTION & ANNOTATION LOGIC BLOCK ---
        let isDrawing = false; 
        let currentDrawPath = []; 
        let currentSvgPathEl = null; 
        let dragStart = null; 
        let dragEl = null; 
        let marqueeStart = null; 
        let marqueeBox = null;

        function startDraggingSelection(e, pageDiv) {
            const active = getActive(); 
            if (!active || appState.selectedIds.size === 0) return;
            const startX = e.clientX || (e.touches && e.touches[0].clientX); 
            const startY = e.clientY || (e.touches && e.touches[0].clientY); 
            const startPositions = new Map();

            appState.selectedIds.forEach(id => {
                const a = active.annots.find(x => x.id === id); 
                if (!a) return;
                const annotPageDiv = document.getElementById('page-' + a.page); 
                if (!annotPageDiv) return;
                const rect = annotPageDiv.getBoundingClientRect();
                
                if (a.path) {
                    startPositions.set(id, { path: JSON.parse(JSON.stringify(a.path)), rect });
                } else if (a.x1 !== undefined) {
                    startPositions.set(id, { x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2, rect });
                } else {
                    startPositions.set(id, { leftPct: a.leftPct, topPct: a.topPct, rect });
                }
            });

            let dragged = false;
            
            function trackMove(mEvent) {
                const currentX = mEvent.clientX !== undefined ? mEvent.clientX : mEvent.touches[0].clientX;
                const currentY = mEvent.clientY !== undefined ? mEvent.clientY : mEvent.touches[0].clientY;
                
                const dx = Math.abs(currentX - startX); 
                const dy = Math.abs(currentY - startY);
                if (dx > 3 || dy > 3) {
                    dragged = true; 
                    contextMenu.style.display = 'none';
                    appState.selectedIds.forEach(id => {
                        const a = active.annots.find(x => x.id === id); 
                        const startData = startPositions.get(id); 
                        if (!a || !startData) return;
                        
                        const deltaX = ((currentX - startX) / startData.rect.width) * 100; 
                        const deltaY = ((currentY - startY) / startData.rect.height) * 100;
                        
                        if (a.path) {
                            a.path = startData.path.map(p => ({ x: p.x + deltaX, y: p.y + deltaY }));
                            const pathEl = document.querySelector('path[data-id="' + id + '"]');
                            if (pathEl) {
                                let d = 'M ' + (a.path[0].x * 10) + ' ' + (a.path[0].y * 10);
                                for(let i=1; i<a.path.length; i++) {
                                    d += ' L ' + (a.path[i].x * 10) + ' ' + (a.path[i].y * 10);
                                }
                                pathEl.setAttribute('d', d);
                            }
                        } else if (a.x1 !== undefined) {
                            a.x1 = startData.x1 + deltaX; 
                            a.y1 = startData.y1 + deltaY; 
                            a.x2 = startData.x2 + deltaX; 
                            a.y2 = startData.y2 + deltaY;
                            const lineEl = document.querySelector('line[data-id="' + id + '"]');
                            if (lineEl) {
                                lineEl.setAttribute('x1', a.x1 * 10); 
                                lineEl.setAttribute('y1', a.y1 * 10); 
                                lineEl.setAttribute('x2', a.x2 * 10); 
                                lineEl.setAttribute('y2', a.y2 * 10);
                            }
                        } else {
                            a.leftPct = startData.leftPct + deltaX; 
                            a.topPct = startData.topPct + deltaY;
                            const el = document.querySelector('[data-id="' + id + '"]');
                            if (el) { 
                                el.style.left = a.leftPct + '%'; 
                                el.style.top = a.topPct + '%'; 
                            }
                        }
                    });
                }
            }
            
            function dropMove(mEvent) {
                window.removeEventListener('pointermove', trackMove); 
                window.removeEventListener('pointerup', dropMove);
                if (dragged) { 
                    saveStateForUndo(active); 
                    syncAnnotations(true); 
                    contextMenu.style.display = 'flex'; 
                    contextMenu.style.left = (mEvent.pageX || (mEvent.changedTouches && mEvent.changedTouches[0].pageX)) + 'px'; 
                    contextMenu.style.top = ((mEvent.pageY || (mEvent.changedTouches && mEvent.changedTouches[0].pageY)) - 40) + 'px'; 
                }
            }
            
            window.addEventListener('pointermove', trackMove); 
            window.addEventListener('pointerup', dropMove);
        }

        container.addEventListener('contextmenu', function(e) {
            const active = getActive(); 
            if (!active) return;
            const targetAnnot = e.target.closest('.interactive-annot, .highlight-box, path, line');
            if (targetAnnot) {
                e.preventDefault(); 
                e.stopPropagation();
                const id = targetAnnot.dataset.id;
                if (id && !appState.selectedIds.has(id)) { 
                    appState.selectedIds.clear(); 
                    appState.selectedIds.add(id); 
                    updateSelectionUI(); 
                }
                const annotObj = active.annots.find(a => a.id === id);
                const ctxColorPicker = document.getElementById('ctx-color-picker');
                if (annotObj && annotObj.color && annotObj.type !== 'image' && annotObj.type !== 'redact') { 
                    ctxColorPicker.value = annotObj.color; 
                    ctxColorPicker.style.display = 'inline-block'; 
                } else { 
                    ctxColorPicker.style.display = 'none'; 
                }
                contextMenu.style.display = 'flex'; 
                contextMenu.style.left = e.pageX + 'px'; 
                contextMenu.style.top = (e.pageY - 40) + 'px';
            }
        });

        window.addEventListener('pointerdown', function(e) {
            if (!settingsPanel.contains(e.target) && !e.target.closest('#toggle-settings')) {
                settingsPanel.style.display = 'none';
            }
            if (manageDropdown && !manageDropdown.contains(e.target)) {
                manageMenu.classList.remove('show');
            }
            if (contextMenu.style.display === 'flex' && !contextMenu.contains(e.target) && !e.target.closest('.interactive-annot, .highlight-box, path, line')) {
                contextMenu.style.display = 'none';
            }
            if (document.getElementById('lib-context-menu').style.display === 'flex' && !e.target.closest('#lib-context-menu')) {
                document.getElementById('lib-context-menu').style.display = 'none';
            }
            if (document.getElementById('props-modal-overlay').style.display === 'flex' && !e.target.closest('.props-modal-box')) {
                document.getElementById('props-modal-overlay').style.display = 'none';
            }
        });

        container.addEventListener('pointerdown', function(e) {
            if (e.pointerType === 'mouse' && e.button === 2) return; 
            
            const active = getActive(); 
            if (!active) return;
            
            const targetAnnot = e.target.closest('.interactive-annot, .highlight-box, path, line');
            const pageDiv = e.target.closest('.page-wrapper'); 
            if (!pageDiv) return;

            if (targetAnnot && (e.button === 0 || e.pointerType === 'touch')) {
                 const id = targetAnnot.dataset.id;
                 if (id && !e.target.classList.contains('resize-handle')) {
                     if (['draw', 'shape', 'marquee'].includes(appState.toolMode)) {
                         // Let it fall through to drawing logic
                     } else {
                         if (!e.ctrlKey && !e.metaKey) appState.selectedIds.clear();
                         appState.selectedIds.add(id); 
                         updateSelectionUI();
                         
                         if (appState.toolMode !== 'erase' && appState.toolMode !== 'select') {
                             setToolMode('select');
                         }
                         if (appState.toolMode === 'select') {
                             startDraggingSelection(e, pageDiv);
                         }
                     }
                 }
            }

            if (appState.placementMode === 'text') {
                e.preventDefault(); 
                e.stopPropagation();
                const rect = pageDiv.getBoundingClientRect(); 
                const xPct = ((e.clientX - rect.left) / rect.width) * 100; 
                const yPct = ((e.clientY - rect.top) / rect.height) * 100;
                const pageNum = parseInt(pageDiv.dataset.page);

                const input = document.createElement('div'); 
                input.className = 'live-text-input'; 
                input.contentEditable = true;
                const fontSize = parseInt(document.getElementById('tool-fontsize').value) * active.scale;
                const fontColor = document.getElementById('color-text').value; 
                const fontFam = document.getElementById('tool-font').value;
                
                input.style.left = xPct + '%'; 
                input.style.top = yPct + '%'; 
                input.style.fontSize = fontSize + 'px'; 
                input.style.color = fontColor; 
                input.style.fontFamily = fontFam;
                pageDiv.appendChild(input); 
                input.focus();
                
                input.addEventListener('blur', async function() {
                    if (input.innerText.trim() !== '') {
                        const annot = { 
                            id: Date.now().toString(), 
                            type: 'text', 
                            page: pageNum, 
                            text: input.innerText, 
                            color: fontColor, 
                            font: fontFam, 
                            size: parseInt(document.getElementById('tool-fontsize').value), 
                            leftPct: xPct, 
                            topPct: yPct 
                        };
                        saveStateForUndo(active); 
                        active.annots.push(annot); 
                        syncAnnotations(true); 
                        drawAnnotationBox(annot, pageDiv);
                    }
                    input.remove();
                });
                
                appState.placementMode = null; 
                container.classList.remove('cursor-text'); 
                setToolMode('textselect');
                return;
            }

            if (appState.placementMode === 'image' && appState.pendingImageDataUrl) {
                e.preventDefault(); 
                e.stopPropagation();
                const rect = pageDiv.getBoundingClientRect(); 
                const xPct = ((e.clientX - rect.left) / rect.width) * 100; 
                const yPct = ((e.clientY - rect.top) / rect.height) * 100;
                const pageNum = parseInt(pageDiv.dataset.page);
                const img = new Image(); 
                img.src = appState.pendingImageDataUrl;
                
                img.onload = function() {
                    const altText = prompt("Enter alt text for this photo (optional):", "");
                    const aspect = img.height / img.width; 
                    const wPct = 25; 
                    const hPct = wPct * aspect * (rect.width / rect.height);
                    const annot = { 
                        id: Date.now().toString(), 
                        type: 'image', 
                        page: pageNum, 
                        dataUrl: appState.pendingImageDataUrl, 
                        leftPct: xPct - (wPct/2), 
                        topPct: yPct - (hPct/2), 
                        widthPct: wPct, 
                        heightPct: hPct, 
                        alt: altText || '',
                        aspectRatio: aspect
                    };
                    saveStateForUndo(active); 
                    active.annots.push(annot); 
                    syncAnnotations(true); 
                    drawAnnotationBox(annot, pageDiv);
                    appState.pendingImageDataUrl = null; 
                    appState.placementMode = null; 
                    container.classList.remove('cursor-image');
                    setToolMode('textselect');
                };
                return;
            }

            if (!targetAnnot && !e.ctrlKey && !e.metaKey) { 
                appState.selectedIds.clear(); 
                updateSelectionUI(); 
            }

            const rect = pageDiv.getBoundingClientRect(); 
            const xPct = ((e.clientX - rect.left) / rect.width) * 100; 
            const yPct = ((e.clientY - rect.top) / rect.height) * 100;

            if (['draw', 'shape', 'erase'].includes(appState.toolMode)) {
                if (e.target.classList.contains('resize-handle')) return;
                
                if (appState.toolMode === 'draw') {
                    isDrawing = true; 
                    currentDrawPath = [{x: xPct, y: yPct}];
                    const svgLayer = pageDiv.querySelector('.drawing-layer');
                    currentSvgPathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                    currentSvgPathEl.setAttribute('stroke', document.getElementById('color-draw').value);
                    const strokeWidth = document.getElementById('tool-size').value * 2; 
                    currentSvgPathEl.setAttribute('stroke-width', strokeWidth); 
                    svgLayer.appendChild(currentSvgPathEl);
                } else if (appState.toolMode === 'shape' || appState.toolMode === 'erase') {
                    const shapeType = document.getElementById('tool-shape-type') ? document.getElementById('tool-shape-type').value : 'rect';
                    dragStart = { pageDiv: pageDiv, pageNum: parseInt(pageDiv.dataset.page), x: xPct, y: yPct };
                    
                    if (appState.toolMode === 'shape' && shapeType === 'line') {
                        const svgLayer = pageDiv.querySelector('.drawing-layer');
                        currentSvgPathEl = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                        currentSvgPathEl.setAttribute('stroke', document.getElementById('color-shape').value);
                        const strokeWidth = document.getElementById('tool-size').value * 2; 
                        currentSvgPathEl.setAttribute('stroke-width', strokeWidth); 
                        currentSvgPathEl.setAttribute('x1', (dragStart.x * 10)); 
                        currentSvgPathEl.setAttribute('y1', (dragStart.y * 10));
                        currentSvgPathEl.setAttribute('x2', (dragStart.x * 10)); 
                        currentSvgPathEl.setAttribute('y2', (dragStart.y * 10));
                        svgLayer.appendChild(currentSvgPathEl);
                    } else {
                        dragEl = document.createElement('div'); 
                        dragEl.style.position = 'absolute'; 
                        dragEl.style.zIndex = '10'; 
                        dragEl.style.boxSizing = 'border-box';
                        if (appState.toolMode === 'erase') { 
                            dragEl.style.backgroundColor = '#ffffff'; 
                            dragEl.style.border = 'none'; 
                        } else {
                            const sColor = document.getElementById('color-shape').value; 
                            const sSize = document.getElementById('tool-size').value;
                            dragEl.style.border = sSize + 'px solid ' + sColor; 
                            if(shapeType === 'circle') dragEl.style.borderRadius = '50%';
                        }
                        dragEl.style.left = dragStart.x + '%'; 
                        dragEl.style.top = dragStart.y + '%'; 
                        pageDiv.appendChild(dragEl);
                    }
                }
                return;
            }

            if (appState.toolMode === 'marquee') {
                marqueeStart = { x: e.clientX, y: e.clientY, pageDiv: pageDiv };
                marqueeBox = document.createElement('div'); 
                marqueeBox.className = 'marquee-box';
                marqueeBox.style.left = (e.clientX - rect.left) + 'px'; 
                marqueeBox.style.top = (e.clientY - rect.top) + 'px';
                marqueeBox.style.width = '0px'; 
                marqueeBox.style.height = '0px'; 
                pageDiv.appendChild(marqueeBox);
            }
        });

        container.addEventListener('pointermove', function(e) {
            if (isDrawing && appState.toolMode === 'draw' && currentSvgPathEl) {
                const pageDiv = currentSvgPathEl.closest('.page-wrapper'); 
                const rect = pageDiv.getBoundingClientRect();
                const xPct = ((e.clientX - rect.left) / rect.width) * 100; 
                const yPct = ((e.clientY - rect.top) / rect.height) * 100;
                currentDrawPath.push({x: xPct, y: yPct});
                
                let d = 'M ' + (currentDrawPath[0].x * 10) + ' ' + (currentDrawPath[0].y * 10);
                for(let i = 1; i < currentDrawPath.length; i++) {
                    d += ' L ' + (currentDrawPath[i].x * 10) + ' ' + (currentDrawPath[i].y * 10);
                }
                currentSvgPathEl.setAttribute('d', d);
            } 
            else if (dragStart && dragEl) {
                const rect = dragStart.pageDiv.getBoundingClientRect();
                const curX = ((e.clientX - rect.left) / rect.width) * 100; 
                const curY = ((e.clientY - rect.top) / rect.height) * 100;
                const left = Math.min(dragStart.x, curX); 
                const top = Math.min(dragStart.y, curY);
                const w = Math.abs(curX - dragStart.x); 
                const h = Math.abs(curY - dragStart.y);
                dragEl.style.left = left + '%'; 
                dragEl.style.top = top + '%'; 
                dragEl.style.width = w + '%'; 
                dragEl.style.height = h + '%';
            } 
            else if (dragStart && currentSvgPathEl && appState.toolMode === 'shape') {
                const rect = dragStart.pageDiv.getBoundingClientRect();
                const curX = ((e.clientX - rect.left) / rect.width) * 100; 
                const curY = ((e.clientY - rect.top) / rect.height) * 100;
                currentSvgPathEl.setAttribute('x2', (curX * 10)); 
                currentSvgPathEl.setAttribute('y2', (curY * 10));
            }
            else if (marqueeStart && marqueeBox) {
                const rect = marqueeStart.pageDiv.getBoundingClientRect();
                const left = Math.min(marqueeStart.x, e.clientX) - rect.left; 
                const top = Math.min(marqueeStart.y, e.clientY) - rect.top;
                const width = Math.abs(e.clientX - marqueeStart.x); 
                const height = Math.abs(e.clientY - marqueeStart.y);
                marqueeBox.style.left = left + 'px'; 
                marqueeBox.style.top = top + 'px'; 
                marqueeBox.style.width = width + 'px'; 
                marqueeBox.style.height = height + 'px';
            }
        });

        window.addEventListener('pointerup', function(e) {
            const active = getActive();
            
            if (isDrawing && appState.toolMode === 'draw' && currentDrawPath.length > 1 && active) {
                const pageDiv = currentSvgPathEl.closest('.page-wrapper'); 
                const pageNum = parseInt(pageDiv.dataset.page);
                const annot = { 
                    id: Date.now().toString(), 
                    type: 'draw', 
                    page: pageNum, 
                    color: document.getElementById('color-draw').value, 
                    size: document.getElementById('tool-size').value * 2, 
                    path: currentDrawPath 
                };
                saveStateForUndo(active); 
                active.annots.push(annot); 
                currentSvgPathEl.dataset.id = annot.id; 
                syncAnnotations(true);
            } else if (isDrawing && currentSvgPathEl) { 
                currentSvgPathEl.remove(); 
            }
            
            isDrawing = false; 
            currentDrawPath = []; 
            currentSvgPathEl = null;

            if (dragStart && active) {
                if (dragEl) {
                    const w = parseFloat(dragEl.style.width) || 0; 
                    const h = parseFloat(dragEl.style.height) || 0;
                    if (w > 0.5 && h > 0.5) { 
                        const isErase = appState.toolMode === 'erase';
                        const annot = {
                            id: Date.now().toString(), 
                            type: isErase ? 'redact' : 'shape', 
                            page: dragStart.pageNum,
                            color: isErase ? '#ffffff' : document.getElementById('color-shape').value,
                            size: isErase ? 0 : parseInt(document.getElementById('tool-size').value) || 2,
                            shapeType: document.getElementById('tool-shape-type') ? document.getElementById('tool-shape-type').value : null,
                            leftPct: parseFloat(dragEl.style.left), 
                            topPct: parseFloat(dragEl.style.top), 
                            widthPct: w, 
                            heightPct: h
                        };
                        saveStateForUndo(active); 
                        active.annots.push(annot); 
                        syncAnnotations(true); 
                        drawAnnotationBox(annot, dragStart.pageDiv);
                    }
                    dragEl.remove();
                } else if (currentSvgPathEl) {
                    const rect = dragStart.pageDiv.getBoundingClientRect(); 
                    const curX = ((e.clientX - rect.left) / rect.width) * 100; 
                    const curY = ((e.clientY - rect.top) / rect.height) * 100;
                    const annot = {
                        id: Date.now().toString(), 
                        type: 'shape', 
                        shapeType: 'line', 
                        page: dragStart.pageNum,
                        color: document.getElementById('color-shape').value, 
                        size: document.getElementById('tool-size').value * 2, 
                        x1: dragStart.x, 
                        y1: dragStart.y, 
                        x2: curX, 
                        y2: curY
                    };
                    saveStateForUndo(active); 
                    active.annots.push(annot); 
                    currentSvgPathEl.dataset.id = annot.id; 
                    syncAnnotations(true); 
                    currentSvgPathEl = null;
                }
            }
            dragStart = null; 
            dragEl = null;

            if (marqueeStart && marqueeBox) {
                if (active) {
                    const boxRect = marqueeBox.getBoundingClientRect();
                    if (boxRect.width > 5 && boxRect.height > 5) {
                        if (!e.ctrlKey && !e.metaKey) {
                            appState.selectedIds.clear(); 
                        }
                        document.querySelectorAll('.interactive-annot, .highlight-box, .drawing-layer path, .drawing-layer line').forEach(el => {
                            if (!el.dataset.id) return;
                            const annotData = active.annots.find(a => a.id === el.dataset.id);
                            if (annotData && annotData.page === parseInt(marqueeStart.pageDiv.dataset.page)) {
                                const elRect = el.getBoundingClientRect();
                                const intersect = !(boxRect.right < elRect.left || boxRect.left > elRect.right || boxRect.bottom < elRect.top || boxRect.top > elRect.bottom);
                                if (intersect) appState.selectedIds.add(el.dataset.id);
                            }
                        });
                        updateSelectionUI();
                    }
                }
                marqueeBox.remove(); 
                marqueeStart = null; 
                marqueeBox = null;
            }
            
            if (appState.toolMode === 'highlight') {
                processSelection('highlight');
            } else if (appState.toolMode === 'comment') {
                processSelection('comment');
            }
        });

        function renderAnnotations() {
            const active = getActive(); 
            if (!active) return;
            document.querySelectorAll('.highlight-box, .interactive-annot, .drawing-layer path, .drawing-layer line').forEach(function(el) { el.remove(); });
            active.annots.forEach(function(annot) {
                const pageDiv = document.getElementById('page-' + annot.page);
                if (pageDiv) drawAnnotationBox(annot, pageDiv);
            });
            updateSelectionUI(); 
            updateSidebar();
        }

        function drawAnnotationBox(annot, pageDiv) {
            const active = getActive();
            if (annot.type === 'draw') {
                const svgLayer = pageDiv.querySelector('.drawing-layer');
                if (svgLayer && annot.path && annot.path.length > 0) {
                    const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                    let d = 'M ' + (annot.path[0].x * 10) + ' ' + (annot.path[0].y * 10);
                    for(let i = 1; i < annot.path.length; i++) {
                        d += ' L ' + (annot.path[i].x * 10) + ' ' + (annot.path[i].y * 10);
                    }
                    pathEl.setAttribute('d', d); 
                    pathEl.setAttribute('stroke', annot.color); 
                    pathEl.setAttribute('stroke-width', annot.size); 
                    pathEl.dataset.id = annot.id;
                    if (appState.selectedIds.has(annot.id)) {
                        pathEl.classList.add('selected-target'); 
                    }
                    svgLayer.appendChild(pathEl);
                }
                return;
            }

            if (annot.type === 'shape' && annot.shapeType === 'line') {
                const svgLayer = pageDiv.querySelector('.drawing-layer');
                if (svgLayer) {
                    const lineEl = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                    lineEl.setAttribute('x1', (annot.x1 * 10)); 
                    lineEl.setAttribute('y1', (annot.y1 * 10)); 
                    lineEl.setAttribute('x2', (annot.x2 * 10)); 
                    lineEl.setAttribute('y2', (annot.y2 * 10));
                    lineEl.setAttribute('stroke', annot.color); 
                    lineEl.setAttribute('stroke-width', annot.size); 
                    lineEl.dataset.id = annot.id;
                    if (appState.selectedIds.has(annot.id)) {
                        lineEl.classList.add('selected-target'); 
                    }
                    svgLayer.appendChild(lineEl);
                }
                return;
            }

            if ((annot.type === 'shape' && annot.shapeType !== 'line') || annot.type === 'redact') {
                const wrapper = document.createElement('div'); 
                wrapper.className = 'interactive-annot'; 
                wrapper.dataset.id = annot.id;
                wrapper.style.left = annot.leftPct + '%'; 
                wrapper.style.top = annot.topPct + '%'; 
                wrapper.style.width = annot.widthPct + '%'; 
                wrapper.style.height = annot.heightPct + '%';
                
                if (annot.type === 'redact') { 
                    wrapper.style.backgroundColor = '#ffffff'; 
                    wrapper.style.border = 'none'; 
                } else { 
                    wrapper.style.border = annot.size + 'px solid ' + annot.color; 
                    if (annot.shapeType === 'circle') {
                        wrapper.style.borderRadius = '50%'; 
                    }
                }
                
                if (appState.selectedIds.has(annot.id)) {
                    wrapper.classList.add('selected-target'); 
                }
                pageDiv.appendChild(wrapper);
                return;
            }

            if (annot.type === 'highlight' || annot.type === 'comment') {
                const box = document.createElement('div'); 
                box.className = 'highlight-box'; 
                box.dataset.id = annot.id;
                if (annot.type === 'comment') {
                    box.classList.add('comment-box');
                }
                box.style.backgroundColor = annot.color; 
                box.style.left = annot.leftPct + '%'; 
                box.style.top = annot.topPct + '%'; 
                box.style.width = annot.widthPct + '%'; 
                box.style.height = annot.heightPct + '%';
                
                if (appState.selectedIds.has(annot.id)) {
                    box.classList.add('selected-target');
                }
                box.addEventListener('dblclick', function(e) {
                    if (annot.type === 'comment') {
                        document.getElementById('read-comment-text').innerText = annot.text || '';
                        readModal.style.display = 'block'; 
                        readModal.style.left = (e.pageX + 15) + 'px'; 
                        readModal.style.top = (e.pageY + 15) + 'px';
                    }
                });
                pageDiv.appendChild(box); 
                return;
            }

            const wrapper = document.createElement('div'); 
            wrapper.className = 'interactive-annot'; 
            wrapper.dataset.id = annot.id;
            wrapper.style.left = annot.leftPct + '%'; 
            wrapper.style.top = annot.topPct + '%';
            if (appState.selectedIds.has(annot.id)) {
                wrapper.classList.add('selected-target');
            }

            if (annot.type === 'image') {
                wrapper.style.width = annot.widthPct + '%'; 
                wrapper.style.height = annot.heightPct + '%';
                if (annot.alt) wrapper.title = annot.alt;
                
                const img = document.createElement('img'); 
                img.src = annot.dataUrl; 
                wrapper.appendChild(img); 
                
                const handle = document.createElement('div'); 
                handle.className = 'resize-handle'; 
                wrapper.appendChild(handle);
                
                handle.addEventListener('pointerdown', function(e) {
                    e.preventDefault(); 
                    e.stopPropagation();
                    const pageRect = pageDiv.getBoundingClientRect(); 
                    const startX = e.clientX; 
                    const startY = e.clientY; 
                    const startW = annot.widthPct; 
                    const startH = annot.heightPct;
                    const aspect = annot.aspectRatio || (startH / startW); 
                    
                    function trackResize(mEvent) {
                        const deltaX = ((mEvent.clientX - startX) / pageRect.width) * 100; 
                        let newW = Math.max(3, startW + deltaX);
                        let newH;

                        if (mEvent.shiftKey) {
                            newH = newW * aspect * (pageRect.width / pageRect.height);
                        } else {
                            const deltaY = ((mEvent.clientY - startY) / pageRect.height) * 100;
                            newH = Math.max(3, startH + deltaY);
                        }

                        annot.widthPct = newW;
                        annot.heightPct = newH;
                        wrapper.style.width = annot.widthPct + '%'; 
                        wrapper.style.height = annot.heightPct + '%';
                    }
                    function dropResize() { 
                        window.removeEventListener('pointermove', trackResize); 
                        window.removeEventListener('pointerup', dropResize); 
                        saveStateForUndo(active); 
                        syncAnnotations(true); 
                    }
                    window.addEventListener('pointermove', trackResize); 
                    window.addEventListener('pointerup', dropResize);
                });
            } else if (annot.type === 'text') {
                const textBox = document.createElement('div'); 
                textBox.className = 'text-annot-box'; 
                textBox.innerText = annot.text;
                textBox.style.color = annot.color; 
                textBox.style.fontFamily = annot.font; 
                textBox.style.fontSize = (annot.size * active.scale) + 'px'; 
                wrapper.appendChild(textBox);
                
                wrapper.addEventListener('dblclick', function(e) {
                    e.stopPropagation(); 
                    if (appState.toolMode !== 'select') return;
                    
                    contextMenu.style.display = 'none'; 
                    wrapper.style.display = 'none';
                    
                    const input = document.createElement('div'); 
                    input.className = 'live-text-input'; 
                    input.contentEditable = true; 
                    input.innerText = annot.text; 
                    const fontSize = annot.size * active.scale;
                    
                    input.style.left = annot.leftPct + '%'; 
                    input.style.top = annot.topPct + '%'; 
                    input.style.fontSize = fontSize + 'px'; 
                    input.style.color = annot.color; 
                    input.style.fontFamily = annot.font;
                    pageDiv.appendChild(input); 
                    input.focus();
                    
                    const range = document.createRange(); 
                    range.selectNodeContents(input); 
                    const sel = window.getSelection(); 
                    sel.removeAllRanges(); 
                    sel.addRange(range);
                    
                    input.addEventListener('blur', async function() {
                        saveStateForUndo(active);
                        if (input.innerText.trim() !== '') { 
                            annot.text = input.innerText; 
                        } else { 
                            active.annots = active.annots.filter(function(a){ return a.id !== annot.id; }); 
                        }
                        input.remove(); 
                        renderAnnotations(); 
                        syncAnnotations(true);
                    });
                });
            }
            pageDiv.appendChild(wrapper);
        }

        document.getElementById('delete-hl-btn').addEventListener('click', async function(e) {
            e.stopPropagation(); 
            const active = getActive();
            if (active && appState.selectedIds.size > 0) {
                saveStateForUndo(active);
                appState.selectedIds.forEach(id => { 
                    document.querySelectorAll('[data-id="' + id + '"]').forEach(el => el.remove()); 
                });
                active.annots = active.annots.filter(a => !appState.selectedIds.has(a.id));
                appState.selectedIds.clear(); 
                syncAnnotations(true); 
                updateSidebar(); 
                updateStatusCounter();
                contextMenu.style.display = 'none'; 
                readModal.style.display = 'none';
                if (appState.toolMode === 'select') setToolMode('textselect');
            }
        });

        document.addEventListener('keydown', function(e) {
            const active = getActive(); 
            if (!active) return;
            
            if (e.key === 'Delete' || e.key === 'Backspace') {
                if (appState.selectedIds.size > 0 && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA' && !e.target.isContentEditable) {
                    e.preventDefault(); 
                    document.getElementById('delete-hl-btn').click(); 
                    if (appState.toolMode === 'select') setToolMode('textselect');
                    return;
                }
            }

            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
                e.preventDefault();
                triggerUndo();
                return;
            }
            
            if (
                ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && e.shiftKey) || 
                ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y')
            ) { 
                e.preventDefault(); 
                triggerRedo(); 
                return; 
            }
            
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { 
                e.preventDefault(); 
                triggerRedo(); 
                return; 
            }
            
            const isShift = e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey;
            if (isShift) {
                if(e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
                switch(e.key.toLowerCase()) {
                    case 'h': 
                        e.preventDefault(); 
                        processSelection('highlight'); 
                        break;
                    case 'm': 
                        e.preventDefault(); 
                        processSelection('comment'); 
                        break;
                    case 'r': 
                        e.preventDefault(); 
                        document.getElementById('menu-rotate-cw').click(); 
                        break;
                    case 'e': 
                        e.preventDefault(); 
                        document.getElementById('menu-rotate-ccw').click(); 
                        break;
                }
            }
        });

        function processSelection(type) {
            const selection = window.getSelection(); 
            if (selection.isCollapsed) return;
            
            const range = selection.getRangeAt(0).cloneRange();
            
            let endNode = range.endContainer;
            let endOffset = range.endOffset;
            if (endNode.nodeType === Node.TEXT_NODE) {
                while (endOffset > 0 && /\s/.test(endNode.textContent.charAt(endOffset - 1))) {
                    endOffset--;
                }
                if (endOffset >= 0) range.setEnd(endNode, endOffset);
            }
            
            let startNode = range.startContainer;
            let startOffset = range.startOffset;
            if (startNode.nodeType === Node.TEXT_NODE) {
                while (startOffset < startNode.textContent.length && /\s/.test(startNode.textContent.charAt(startOffset))) {
                    startOffset++;
                }
                if (startOffset <= endNode.textContent.length) range.setStart(startNode, startOffset);
            }

            if (range.collapsed) return;

            const rects = Array.from(range.getClientRects()); 
            let pageDiv = selection.anchorNode.parentElement ? selection.anchorNode.parentElement.closest('.page-wrapper') : null; 
            if (!pageDiv) return;
            
            const selectionData = { 
                rects: rects, 
                pageDiv: pageDiv, 
                pageRect: pageDiv.getBoundingClientRect(), 
                pageNum: parseInt(pageDiv.dataset.page) 
            };
            
            if (type === 'highlight') { 
                finalizeAnnotation('highlight', '', selectionData); 
                selection.removeAllRanges(); 
            } 
            else if (type === 'comment') { 
                appState.pendingCommentData = selectionData; 
                document.getElementById('comment-modal-overlay').style.display = 'flex';
                document.getElementById('comment-input').value = ''; 
                document.getElementById('comment-input').focus(); 
                selection.removeAllRanges(); 
            }
        }

        document.getElementById('cancel-comment').addEventListener('click', function() { 
            document.getElementById('comment-modal-overlay').style.display = 'none'; 
            appState.pendingCommentData = null; 
            appState.pendingCommentForId = null; 
        });

        document.getElementById('submit-comment').addEventListener('click', function() {
            const text = document.getElementById('comment-input').value.trim();
            if (text) {
                if (appState.pendingCommentForId) {
                    const active = getActive();
                    if (active) {
                        const targetAnnot = active.annots.find(a => a.id === appState.pendingCommentForId);
                        if (targetAnnot) {
                            saveStateForUndo(active); 
                            targetAnnot.text = text;
                            if (targetAnnot.type === 'highlight') {
                                targetAnnot.type = 'comment';
                            }
                            syncAnnotations(true); 
                            renderAnnotations();
                        }
                    }
                } else if (appState.pendingCommentData) { 
                    finalizeAnnotation('comment', text, appState.pendingCommentData); 
                }
            }
            document.getElementById('comment-modal-overlay').style.display = 'none'; 
            appState.pendingCommentData = null; 
            appState.pendingCommentForId = null;
        });

        document.getElementById('close-read-comment').addEventListener('click', function() { 
            readModal.style.display = 'none'; 
        });

        async function finalizeAnnotation(type, text, data) {
            const active = getActive(); 
            saveStateForUndo(active);
            const color = document.getElementById('color-' + type).value; 
            const groupId = Date.now().toString();
            
            data.rects.forEach(function(rect) {
                const annot = {
                    id: groupId, 
                    page: data.pageNum, 
                    type: type, 
                    text: text, 
                    color: color,
                    topPct: ((rect.top - data.pageRect.top) / data.pageRect.height) * 100, 
                    leftPct: ((rect.left - data.pageRect.left) / data.pageRect.width) * 100,
                    widthPct: (rect.width / data.pageRect.width) * 100, 
                    heightPct: (rect.height / data.pageRect.height) * 100
                };
                active.annots.push(annot); 
                drawAnnotationBox(annot, data.pageDiv);
            });
            syncAnnotations(true); 
            updateSidebar();
        }

        function updateSidebar() {
            const active = getActive(); 
            if (!active) return;
            commentList.innerHTML = '';
            
            const comments = active.annots.filter(function(h) { 
                return h.type === 'comment' || (h.type === 'highlight' && h.text); 
            });
            
            if (comments.length === 0) { 
                commentList.innerHTML = '<div style="opacity: 0.5; font-size: 13px; text-align: center; margin-top: 20px;">No comments.</div>'; 
                return; 
            }
            
            comments.sort(function(a, b) { return a.page - b.page; }).forEach(function(c) {
                const div = document.createElement('div'); 
                div.className = 'sidebar-comment';
                
                const pageLabel = document.createElement('div'); 
                pageLabel.className = 'sidebar-comment-page'; 
                pageLabel.innerText = 'Page ' + c.page; 
                div.appendChild(pageLabel);
                
                const textPreview = document.createElement('div'); 
                textPreview.innerText = c.text.length > 60 ? c.text.substring(0, 60) + '...' : c.text; 
                div.appendChild(textPreview);
                
                div.addEventListener('click', function() {
                    const targetPage = document.getElementById('page-' + c.page); 
                    if (targetPage) {
                        targetPage.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    }
                });
                commentList.appendChild(div);
            });
        }

        async function fetchVersionHistory() {
            const active = getActive(); 
            if (!active) return;
            try {
                const history = await apiFetch('/api/versions?hash=' + active.hash);
                historyList.innerHTML = '';
                if (history.length === 0) { 
                    historyList.innerHTML = '<div style="opacity: 0.5; font-size: 13px; text-align: center; margin-top: 20px;">No version history found.</div>'; 
                    return; 
                }

                history.forEach(function(version, idx) {
                    const item = document.createElement('div'); 
                    item.className = 'history-item';
                    
                    const time = document.createElement('div'); 
                    time.className = 'history-time'; 
                    time.innerText = new Date(version.timestamp).toLocaleString();
                    
                    const meta = document.createElement('div'); 
                    meta.style.fontSize = '11px'; 
                    meta.style.opacity = '0.7'; 
                    meta.innerText = version.drawing.length + ' active annotations' + (idx === 0 ? ' (Current State)' : '');
                    
                    const revertBtn = document.createElement('button'); 
                    revertBtn.className = 'history-action-btn'; 
                    revertBtn.innerText = 'Revert';
                    
                    revertBtn.addEventListener('click', async function(e) {
                        e.stopPropagation();
                        
                        const currentStripped = active.annots.map(a => {
                            if (a.type === 'image') {
                                const { dataUrl, ...rest } = a;
                                return { ...rest, hasImage: true };
                            }
                            return a;
                        });
                        
                        if (JSON.stringify(currentStripped) === JSON.stringify(version.drawing)) {
                            alert("Document is already at this exact state."); 
                            return;
                        }
                        
                        if (confirm("Are you sure you want to revert to this version? Unsaved modifications will be overwritten.")) {
                            saveStateForUndo(active); 
                            
                            const newAnnots = version.drawing.map(vAnnot => {
                                if (vAnnot.hasImage) {
                                    const existingImg = active.annots.find(a => a.id === vAnnot.id);
                                    if (existingImg) return { ...vAnnot, dataUrl: existingImg.dataUrl };
                                }
                                return vAnnot;
                            });
                            
                            active.annots = newAnnots; 
                            renderAnnotations(); 
                            
                            await syncAnnotations(false); 
                            document.getElementById('ribbon-file-info').innerText = "Reverted to previous version!"; 
                            setTimeout(updateStatusCounter, 3000);
                        }
                    });
                    
                    item.appendChild(time); 
                    item.appendChild(meta); 
                    item.appendChild(revertBtn); 
                    historyList.appendChild(item);
                });
            } catch (err) { 
                showDebug('Failed to fetch history', err); 
            }
        }

        function formatBytes(bytes) {
            if (bytes === 0 || !bytes) return '0 B';
            const k = 1024, dm = 2, sizes = ['B', 'KB', 'MB', 'GB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
        }

        // --- AUTO-SAVE DEBOUNCE BLOCK ---
        let autoSaveTimer = null;
        
        async function syncAnnotations(createVersionSnapshot) {
            const active = getActive();
            if (!active) return;
            
            // Save locally immediately
            saveToLocalTemp(active.tabId, active);
            
            const historyCompareData = active.annots.map(a => {
                if (a.type === 'image') {
                    const { dataUrl, ...rest } = a;
                    return { ...rest, hasImage: true };
                }
                return a;
            });
            const currentStr = JSON.stringify(historyCompareData);
            if (createVersionSnapshot && appState.lastSavedHistoryHash === currentStr) {
                createVersionSnapshot = false; 
            }

            // Trigger debounced cloud auto-save
            setCloudStatus('saving');
            clearTimeout(autoSaveTimer);
            autoSaveTimer = setTimeout(() => {
                executeCloudSave(active, createVersionSnapshot, currentStr);
            }, 1000);
        }

        async function executeCloudSave(active, createVersionSnapshot, currentStr) {
            let statsObj = null;
            if (active.statsCalculated) {
                let h = 0, c = 0;
                active.annots.forEach(a => { 
                    if (a.type === 'highlight') h++; 
                    if (a.type === 'comment') c++; 
                });
                statsObj = {
                    numPages: active.pdfDoc.numPages,
                    creator: active.creator || 'Unknown',
                    chars: active.stats.chars,
                    words: active.stats.words,
                    sentences: active.stats.sentences,
                    paragraphs: active.stats.paragraphs,
                    highlights: h,
                    comments: c
                };
            }
            
            try {
                await apiFetch('/api/save', { 
                    method: 'POST', 
                    body: JSON.stringify({ 
                        hash: active.hash, 
                        drawing: active.annots, 
                        createVersion: createVersionSnapshot,
                        stats: statsObj
                    }) 
                });
                
                if (createVersionSnapshot) {
                    appState.lastSavedHistoryHash = currentStr;
                }

                if (statsObj) {
                    const libFile = appState.libraryFiles.find(f => f.hash === active.hash);
                    if (libFile) libFile.stats = statsObj;
                }
                
                active.unsaved = false; 
                setCloudStatus('saved');
                renderTabsUI(); 
                
                if (createVersionSnapshot && document.querySelector('.sidebar-tab[data-target="pane-history"]').classList.contains('active')) {
                    fetchVersionHistory();
                }
                updateStatusCounter();
            } catch(e) {
                showDebug('Auto-save to Cloud failed', e);
            }
        }

        async function generateModifiedPdf() {
            const active = getActive(); 
            const pdfLib = window.PDFLib; 
            
            const pdfDoc = await pdfLib.PDFDocument.load(cloneBuffer(active.originalBytes));
            
            const fonts = { 
                Helvetica: await pdfDoc.embedFont(pdfLib.StandardFonts.Helvetica), 
                TimesRoman: await pdfDoc.embedFont(pdfLib.StandardFonts.TimesRoman), 
                Courier: await pdfDoc.embedFont(pdfLib.StandardFonts.Courier) 
            };
            
            pdfDoc.setSubject(JSON.stringify(active.annots)); 
            pdfDoc.setCreator('Online PDF Reader/Editor');
            const pages = pdfDoc.getPages();
            
            pages.forEach(function(page) {
                let annotsList = page.node.lookup(pdfLib.PDFName.of('Annots'));
                if (annotsList instanceof pdfLib.PDFArray) {
                    const keptAnnots = [];
                    for (let i = 0; i < annotsList.size(); i++) {
                        try {
                            const annotRef = annotsList.get(i); 
                            const annot = pdfDoc.context.lookup(annotRef);
                            
                            if (annot instanceof pdfLib.PDFDict) {
                                const subtypeName = annot.lookup(pdfLib.PDFName.of('Subtype')); 
                                const subtypeStr = subtypeName ? (subtypeName.name || String(subtypeName).replace('/', '')) : '';
                                
                                if (!['Highlight', 'Text', 'Ink', 'Square', 'Circle', 'Line', 'Polygon', 'PolyLine', 'FreeText'].includes(subtypeStr)) {
                                    keptAnnots.push(annotRef);
                                }
                            } else {
                                keptAnnots.push(annotRef);
                            }
                        } catch(e) {}
                    }
                    page.node.set(pdfLib.PDFName.of('Annots'), pdfDoc.context.obj(keptAnnots)); 
                }
            });

            const grouped = {}; 
            active.annots.forEach(function(a) { 
                if (!grouped[a.id]) {
                    grouped[a.id] = []; 
                }
                grouped[a.id].push(a); 
            });

            for (const id in grouped) {
                const group = grouped[id]; 
                const type = group[0].type; 
                const pageNum = group[0].page;
                try {
                    const page = pdfDoc.getPage(pageNum - 1); 
                    const size = page.getSize(); 
                    const width = size.width; 
                    const height = size.height;
                    
                    if (type === 'highlight' || type === 'comment') {
                        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity; 
                        const quadPoints = [];
                        group.forEach(function(annot) {
                            const x = (annot.leftPct / 100) * width; 
                            const w = (annot.widthPct / 100) * width; 
                            const h = (annot.heightPct / 100) * height; 
                            const y = height - ((annot.topPct / 100) * height) - h;
                            minX = Math.min(minX, x); 
                            minY = Math.min(minY, y); 
                            maxX = Math.max(maxX, x + w); 
                            maxY = Math.max(maxY, y + h);
                            quadPoints.push(x, y + h, x + w, y + h, x, y, x + w, y);
                        });
                        
                        const annot = group[0]; 
                        const r = parseInt(annot.color.substring(1, 3), 16) / 255; 
                        const g = parseInt(annot.color.substring(3, 5), 16) / 255; 
                        const b = parseInt(annot.color.substring(5, 7), 16) / 255;
                        
                        const pdfAnnot = pdfDoc.context.obj({ 
                            Type: 'Annot', 
                            Subtype: type === 'comment' ? 'Text' : 'Highlight', 
                            Rect: [minX, minY, maxX, maxY], 
                            QuadPoints: quadPoints, 
                            C: [r, g, b], 
                            Contents: pdfLib.PDFString.of(annot.text || ''), 
                            T: pdfLib.PDFString.of('Workspace') 
                        });
                        
                        let annotsList = page.node.lookup(pdfLib.PDFName.of('Annots')); 
                        if (!annotsList) { 
                            annotsList = pdfDoc.context.obj([]); 
                            page.node.set(pdfLib.PDFName.of('Annots'), annotsList); 
                        }
                        annotsList.push(pdfDoc.context.register(pdfAnnot));
                    } 
                    else if (type === 'draw') {
                        const annot = group[0]; 
                        const r = parseInt(annot.color.substring(1, 3), 16) / 255; 
                        const g = parseInt(annot.color.substring(3, 5), 16) / 255; 
                        const b = parseInt(annot.color.substring(5, 7), 16) / 255;
                        let pathStr = 'M ' + ((annot.path[0].x / 100) * width) + ' ' + (height - ((annot.path[0].y / 100) * height));
                        for(let i = 1; i < annot.path.length; i++) {
                            pathStr += ' L ' + ((annot.path[i].x / 100) * width) + ' ' + (height - ((annot.path[i].y / 100) * height));
                        }
                        const calculatedWidth = (annot.size / 1000) * width; 
                        page.drawSvgPath(pathStr, { 
                            borderColor: pdfLib.rgb(r, g, b), 
                            borderWidth: calculatedWidth 
                        });
                    } 
                    else if (type === 'shape' && group[0].shapeType === 'line') {
                        const annot = group[0]; 
                        const r = parseInt(annot.color.substring(1, 3), 16) / 255; 
                        const g = parseInt(annot.color.substring(3, 5), 16) / 255; 
                        const b = parseInt(annot.color.substring(5, 7), 16) / 255;
                        const startX = (annot.x1 / 100) * width; 
                        const startY = height - ((annot.y1 / 100) * height); 
                        const endX = (annot.x2 / 100) * width; 
                        const endY = height - ((annot.y2 / 100) * height);
                        const calculatedWidth = (annot.size / 1000) * width; 
                        page.drawLine({ 
                            start: {x: startX, y: startY}, 
                            end: {x: endX, y: endY}, 
                            color: pdfLib.rgb(r, g, b), 
                            thickness: calculatedWidth 
                        });
                    } 
                    else if (type === 'shape' || type === 'redact') {
                        const annot = group[0]; 
                        const x = (annot.leftPct / 100) * width; 
                        const w = (annot.widthPct / 100) * width; 
                        const h = (annot.heightPct / 100) * height; 
                        const y = height - ((annot.topPct / 100) * height) - h;
                        
                        if (type === 'redact') { 
                            page.drawRectangle({ 
                                x: x, 
                                y: y, 
                                width: w, 
                                height: h, 
                                color: pdfLib.rgb(1, 1, 1), 
                                borderWidth: 0 
                            }); 
                        } 
                        else {
                            const r = parseInt(annot.color.substring(1, 3), 16) / 255; 
                            const g = parseInt(annot.color.substring(3, 5), 16) / 255; 
                            const b = parseInt(annot.color.substring(5, 7), 16) / 255;
                            const sizeVal = (annot.size / 1000) * width;
                            if (annot.shapeType === 'circle') {
                                page.drawEllipse({ 
                                    x: x + w/2, 
                                    y: y + h/2, 
                                    xScale: w/2, 
                                    yScale: h/2, 
                                    borderColor: pdfLib.rgb(r, g, b), 
                                    borderWidth: sizeVal 
                                });
                            } else {
                                page.drawRectangle({ 
                                    x: x, 
                                    y: y, 
                                    width: w, 
                                    height: h, 
                                    borderColor: pdfLib.rgb(r, g, b), 
                                    borderWidth: sizeVal 
                                });
                            }
                        }
                    } 
                    else {
                        const annot = group[0]; 
                        const x = (annot.leftPct / 100) * width; 
                        let y, w, h;
                        if (annot.type === 'text') {
                            const r = parseInt(annot.color.substring(1, 3), 16) / 255; 
                            const g = parseInt(annot.color.substring(3, 5), 16) / 255; 
                            const b = parseInt(annot.color.substring(5, 7), 16) / 255;
                            y = height - ((annot.topPct / 100) * height) - annot.size; 
                            page.drawText(annot.text, { 
                                x: x, 
                                y: y, 
                                size: annot.size, 
                                font: fonts[annot.font], 
                                color: pdfLib.rgb(r, g, b) 
                            });
                        } 
                        else if (annot.type === 'image') {
                            try {
                                const base64Data = annot.dataUrl.split(',')[1]; 
                                const binaryString = atob(base64Data); 
                                const imgBytes = new Uint8Array(binaryString.length);
                                for (let i = 0; i < binaryString.length; i++) {
                                    imgBytes[i] = binaryString.charCodeAt(i);
                                }
                                const img = annot.dataUrl.indexOf('image/png') !== -1 ? await pdfDoc.embedPng(imgBytes) : await pdfDoc.embedJpg(imgBytes);
                                w = (annot.widthPct / 100) * width; 
                                h = (annot.heightPct / 100) * height; 
                                y = height - ((annot.topPct / 100) * height) - h;
                                page.drawImage(img, { x: x, y: y, width: w, height: h });
                            } catch(err) { }
                        }
                    }
                } catch(e) {}
            }
            return await pdfDoc.save();
        }

        // --- LIBRARY UI BLOCK ---
        function updateStorageUI() {
            const mbUsed = ((appState.totalBytes || 0) / (1024 * 1024)).toFixed(2);
            const textEl = document.getElementById('lib-storage-text');
            const barEl = document.getElementById('lib-storage-bar');
            if (textEl) textEl.innerText = mbUsed + ' MB / 10 GB (last 30 days)';
            if (barEl) barEl.value = Math.min(((appState.totalBytes || 0) / (10 * 1024 * 1024 * 1024)) * 100, 100); 
        }

        async function loadLibrary() {
            try {
                const data = await apiFetch('/api/library');
                appState.libraryFiles = data.files || [];
                appState.totalBytes = data.totalBytes || 0;
                
                // Show the warning banner if the backend reports we are on KV only
                const warningBanner = document.getElementById('kv-warning-banner');
                if (warningBanner) {
                    warningBanner.style.display = data.isKVOnly ? 'block' : 'none';
                }

                updateStorageUI();
                renderLibrary();
            } catch(err) {}
        }

        function getLibraryPathName() {
            let htmlStr = '<span class="lib-breadcrumb-link" onclick="appState.currentLibPath=\\'\\'; renderLibrary();">Root</span>';
            if (appState.currentLibPath !== "") {
                let path = [];
                let curr = appState.currentLibPath;
                
                let safety = 0;
                while(curr && safety < 20) {
                    safety++;
                    const f = appState.libraryFiles.find(x => x.hash === curr);
                    if (f) {
                        path.unshift(f);
                        curr = f.parent;
                    } else {
                        break;
                    }
                }
                
                path.forEach(f => {
                    htmlStr += ' > <span class="lib-breadcrumb-link" onclick="appState.currentLibPath=\\'' + f.hash + '\\'; renderLibrary();">' + f.name + '</span>';
                });
            }
            return htmlStr;
        }

        function renderLibrary() {
            const tbody = document.getElementById('lib-file-tbody');
            if (!tbody) return; 

            tbody.innerHTML = '';
            
            const breadcrumbEl = document.getElementById('lib-breadcrumbs');
            if (breadcrumbEl) breadcrumbEl.innerHTML = getLibraryPathName();
            
            const sortPrefEl = document.getElementById('lib-sort');
            const searchQEl = document.getElementById('lib-search');
            
            const sortPref = sortPrefEl ? sortPrefEl.value : 'date_desc';
            const searchQ = searchQEl ? searchQEl.value.toLowerCase() : '';
            
            let filteredList = appState.libraryFiles.filter(item => {
                if (searchQ) return item.name.toLowerCase().includes(searchQ);
                return (item.parent || "") === appState.currentLibPath;
            });

            filteredList.sort((a, b) => {
                if (a.isFolder && !b.isFolder) return -1;
                if (!a.isFolder && b.isFolder) return 1;
                
                const nameA = (a.name || "").toLowerCase();
                const nameB = (b.name || "").toLowerCase();
                const dateA = a.created || 0;
                const dateB = b.created || 0;
                
                const sizeA = a.isFolder ? calculateFolderSize(a.hash) : (a.size || 0);
                const sizeB = b.isFolder ? calculateFolderSize(b.hash) : (b.size || 0);

                switch(sortPref) {
                    case 'name_asc': return nameA.localeCompare(nameB);
                    case 'name_desc': return nameB.localeCompare(nameA);
                    case 'date_asc': return dateA - dateB;
                    case 'date_desc': return dateB - dateA;
                    case 'size_desc': return sizeB - sizeA;
                    case 'size_asc': return sizeA - sizeB;
                    default: return dateB - dateA;
                }
            });

            const selectAllCheck = document.getElementById('lib-select-all');
            if (selectAllCheck) {
                selectAllCheck.checked = filteredList.length > 0 && Array.from(filteredList).every(item => appState.libSelected.has(item.hash));
                selectAllCheck.onclick = (e) => {
                    if (e.target.checked) {
                        filteredList.forEach(item => appState.libSelected.add(item.hash));
                    } else {
                        filteredList.forEach(item => appState.libSelected.delete(item.hash));
                    }
                    renderLibrary();
                };
            }
            
            const bulkBar = document.getElementById('lib-bulk-actions');
            const bulkCount = document.getElementById('lib-bulk-count');
            if (bulkBar && bulkCount) {
                if (appState.libSelected.size > 0) {
                    bulkBar.style.display = 'flex';
                    bulkCount.innerText = appState.libSelected.size + " selected";
                } else {
                    bulkBar.style.display = 'none';
                }
            }

            filteredList.forEach(item => {
                const tr = document.createElement('tr');
                tr.className = 'lib-file-row';
                tr.draggable = true;
                
                const isSelected = appState.libSelected.has(item.hash);
                if (isSelected) tr.style.background = 'var(--hover-bg)';

                const d = new Date(item.created);
                const dateStr = d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                const typeStr = item.isFolder ? "File folder" : "PDF Document";
                const sizeStr = formatBytes(item.isFolder ? calculateFolderSize(item.hash) : item.size);

                tr.innerHTML = 
                    '<td onclick="event.stopPropagation()">' +
                    '    <input type="checkbox" class="lib-checkbox" data-hash="' + item.hash + '" ' + (isSelected ? 'checked' : '') + '>' +
                    '</td>' +
                    '<td><span style="font-size:16px; margin-right:8px;">' + (item.isFolder ? '📁' : '📄') + '</span>' + item.name + '</td>' +
                    '<td>' + dateStr + '</td>' +
                    '<td>' + typeStr + '</td>' +
                    '<td>' + sizeStr + '</td>';

                const cb = tr.querySelector('.lib-checkbox');
                cb.addEventListener('change', (e) => {
                    if (e.target.checked) appState.libSelected.add(item.hash);
                    else appState.libSelected.delete(item.hash);
                    renderLibrary();
                });

                tr.addEventListener('dragstart', e => {
                    e.dataTransfer.setData('text/plain', item.hash);
                    e.dataTransfer.effectAllowed = 'move';
                });

                if (item.isFolder) {
                    tr.addEventListener('dragenter', e => {
                        e.preventDefault();
                    });
                    tr.addEventListener('dragover', e => { 
                        e.preventDefault(); 
                        tr.classList.add('drag-over'); 
                    });
                    tr.addEventListener('dragleave', e => { 
                        tr.classList.remove('drag-over'); 
                    });
                    tr.addEventListener('drop', async e => {
                        e.preventDefault(); 
                        tr.classList.remove('drag-over');
                        const draggedHash = e.dataTransfer.getData('text/plain');
                        if (draggedHash && draggedHash !== item.hash) {
                            const draggedItem = appState.libraryFiles.find(x => x.hash === draggedHash);
                            if (draggedItem) {
                                draggedItem.parent = item.hash;
                                renderLibrary();
                            }
                            try {
                                await apiFetch('/api/library', { 
                                    method:'POST', 
                                    body: JSON.stringify({
                                        action:'move', 
                                        target:draggedHash, 
                                        newParent:item.hash 
                                    })
                                });
                            } catch(err){
                                loadLibrary();
                            }
                        }
                    });
                }

                tr.addEventListener('dblclick', async () => {
                    if(item.isFolder) {
                        appState.currentLibPath = item.hash;
                        appState.libSelected.clear();
                        renderLibrary();
                    } else {
                        document.getElementById('ribbon-file-info').innerText = 'Loading from Library...';
                        document.getElementById('library-modal-overlay').style.display = 'none';
                        try {
                            const dlRes = await apiFetch('/api/library/download?hash=' + item.hash);
                            const buffer = await dlRes.arrayBuffer();
                            await ingestFileBytes(buffer, item.name, null, item.hash, true);
                        } catch(err) { }
                    }
                });

                tr.addEventListener('contextmenu', e => {
                    e.preventDefault(); 
                    e.stopPropagation();
                    appState.libCtxItem = item;
                    const menu = document.getElementById('lib-context-menu');
                    menu.style.display = 'flex';
                    menu.style.left = e.pageX + 'px';
                    menu.style.top = e.pageY + 'px';
                });

                tbody.appendChild(tr);
            });

            if (filteredList.length === 0) {
                tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; opacity:0.5; padding: 20px;">This folder is empty.</td></tr>';
            }
        }

        document.getElementById('lib-bulk-delete').addEventListener('click', async () => {
            if (appState.libSelected.size === 0) return;
            if (confirm('Permanently delete ' + appState.libSelected.size + ' item(s)?')) {
                const itemsToDelete = Array.from(appState.libSelected);
                itemsToDelete.forEach(hash => {
                    const item = appState.libraryFiles.find(x => x.hash === hash);
                    if (item && !item.isFolder && item.size) appState.totalBytes -= item.size;
                    appState.libraryFiles = appState.libraryFiles.filter(x => x.hash !== hash);
                });
                appState.libSelected.clear();
                updateStorageUI();
                renderLibrary();

                try {
                    await Promise.all(itemsToDelete.map(hash => 
                        apiFetch('/api/library', { 
                            method: 'POST', 
                            body: JSON.stringify({ action: 'delete', target: hash }) 
                        })
                    ));
                } catch(e) {
                    loadLibrary();
                }
            }
        });

        document.getElementById('lib-bulk-download').addEventListener('click', async () => {
            if (appState.libSelected.size === 0) return;
            
            const hashes = Array.from(appState.libSelected);
            let foldersPresent = false;
            
            for (const hash of hashes) {
                const item = appState.libraryFiles.find(x => x.hash === hash);
                if (item && item.isFolder) foldersPresent = true;
            }
            
            if (foldersPresent) {
                alert("Folders cannot be bulk downloaded directly yet. Please select only files.");
                return;
            }

            document.getElementById('ribbon-file-info').innerText = "Downloading files...";
            for (const hash of hashes) {
                const item = appState.libraryFiles.find(x => x.hash === hash);
                if (item && !item.isFolder) {
                    try {
                        const dlRes = await apiFetch('/api/library/download?hash=' + item.hash);
                        const buffer = await dlRes.arrayBuffer();
                        const blob = new Blob([buffer], { type: 'application/pdf' });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a'); 
                        a.href = url; 
                        a.download = item.name; 
                        document.body.appendChild(a); 
                        a.click(); 
                        document.body.removeChild(a); 
                        URL.revokeObjectURL(url);
                        await new Promise(r => setTimeout(r, 500));
                    } catch(err) {}
                }
            }
            document.getElementById('ribbon-file-info').innerText = "Downloads complete.";
            appState.libSelected.clear();
            renderLibrary();
        });

        document.getElementById('ctx-lib-rename').addEventListener('click', async (e) => {
            e.stopPropagation(); 
            document.getElementById('lib-context-menu').style.display = 'none';
            if (!appState.libCtxItem) return;
            
            const newName = prompt("Rename to:", appState.libCtxItem.name);
            if (newName && newName !== appState.libCtxItem.name) {
                const oldName = appState.libCtxItem.name;
                appState.libCtxItem.name = newName;
                renderLibrary();
                
                try {
                    await apiFetch('/api/library', { 
                        method:'POST', 
                        body: JSON.stringify({
                            action:'rename', 
                            target: appState.libCtxItem.hash, 
                            newName 
                        })
                    });
                } catch(err){
                    appState.libCtxItem.name = oldName;
                    renderLibrary();
                }
            }
        });

        document.getElementById('ctx-lib-props').addEventListener('click', (e) => {
            e.stopPropagation(); 
            document.getElementById('lib-context-menu').style.display = 'none';
            if (!appState.libCtxItem) return;
            
            const item = appState.libCtxItem;
            document.getElementById('props-icon').innerText = item.isFolder ? '📁' : '📄';
            document.getElementById('props-name').value = item.name;
            document.getElementById('props-type').innerText = item.isFolder ? 'File folder' : 'PDF Document';
            
            let loc = "Root";
            let curr = item.parent;
            while(curr) {
                const f = appState.libraryFiles.find(x => x.hash === curr);
                if (f) { loc = f.name + " \\ " + loc; curr = f.parent; }
                else break;
            }
            document.getElementById('props-location').innerText = loc;
            
            document.getElementById('props-size').innerText = formatBytes(item.isFolder ? calculateFolderSize(item.hash) : item.size);
            document.getElementById('props-created').innerText = new Date(item.created).toLocaleString();
            document.getElementById('props-hash').innerText = item.hash;

            const statsTable = document.getElementById('props-stats-section');
            if (item.isFolder || !item.stats) {
                document.querySelectorAll('.file-only-prop').forEach(el => el.style.display = 'none');
                statsTable.style.display = 'none';
            } else {
                document.querySelectorAll('.file-only-prop').forEach(el => el.style.display = 'table-row');
                statsTable.style.display = 'block';
                
                document.getElementById('props-pages').innerText = item.stats.numPages || '--';
                document.getElementById('props-creator').innerText = item.stats.creator || 'Unknown';
                document.getElementById('props-chars').innerText = item.stats.chars || '0';
                document.getElementById('props-words').innerText = item.stats.words || '0';
                document.getElementById('props-sentences').innerText = item.stats.sentences || '0';
                document.getElementById('props-paragraphs').innerText = item.stats.paragraphs || '0';
                document.getElementById('props-highlights').innerText = item.stats.highlights || '0';
                document.getElementById('props-comments').innerText = item.stats.comments || '0';
            }
            
            document.getElementById('props-modal-overlay').style.display = 'flex';
        });

        document.getElementById('ctx-lib-delete').addEventListener('click', async (e) => {
            e.stopPropagation(); 
            document.getElementById('lib-context-menu').style.display = 'none';
            if (!appState.libCtxItem) return;
            
            if (confirm('Permanently delete "' + appState.libCtxItem.name + '"?')) {
                const itemToDelete = appState.libCtxItem;
                appState.libraryFiles = appState.libraryFiles.filter(x => x.hash !== itemToDelete.hash);
                if (!itemToDelete.isFolder && itemToDelete.size) {
                    appState.totalBytes -= itemToDelete.size;
                }
                updateStorageUI();
                renderLibrary();
                
                try {
                    await apiFetch('/api/library', { 
                        method:'POST', 
                        body: JSON.stringify({
                            action:'delete', 
                            target: itemToDelete.hash 
                        })
                    });
                } catch(err){
                    loadLibrary(); 
                }
            }
        });

        const libRefreshBtn = document.getElementById('lib-btn-refresh');
        if (libRefreshBtn) libRefreshBtn.addEventListener('click', loadLibrary);

        const libUploadBtn = document.getElementById('lib-btn-upload');
        if (libUploadBtn) libUploadBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            document.getElementById('lib-upload-input').click();
        });

        const libUploadInput = document.getElementById('lib-upload-input');
        if (libUploadInput) libUploadInput.addEventListener('change', async function(e) {
            try {
                const file = e.target.files[0];
                if (!file) return;
                
                let targetName = file.name;
                const buffer = await file.arrayBuffer();
                let hash = await calculateHash(buffer);

                let numPages = '--';
                let creator = 'Unknown';
                try {
                    const tempDoc = await pdfjsLib.getDocument({ data: new Uint8Array(cloneBuffer(buffer)) }).promise;
                    numPages = tempDoc.numPages;
                    const meta = await tempDoc.getMetadata();
                    if (meta.info && meta.info.Creator) creator = meta.info.Creator;
                } catch(err) {}

                const statsObj = {
                    numPages: numPages,
                    creator: creator,
                    chars: 0, words: 0, sentences: 0, paragraphs: 0, highlights: 0, comments: 0
                };
                
                const existing = appState.libraryFiles.find(f => f.name === targetName && f.parent === appState.currentLibPath);
                if (existing) {
                    const resolution = await askConflictResolution(targetName);
                    if (resolution === 'cancel') {
                        e.target.value = '';
                        return;
                    } else if (resolution === 'overwrite') {
                        hash = existing.hash; 
                        appState.totalBytes -= existing.size || 0; 
                        appState.libraryFiles = appState.libraryFiles.filter(f => f.hash !== hash); 
                    } else if (resolution === 'copy') {
                        const nameWithoutExt = targetName.toLowerCase().endsWith('.pdf') ? targetName.slice(0, -4) : targetName;
                        targetName = nameWithoutExt + '_' + Date.now() + '.pdf';
                        hash = await calculateHash(new TextEncoder().encode(targetName + Date.now()));
                    }
                }
                
                appState.libraryFiles.push({
                    name: targetName,
                    hash: hash,
                    isFolder: false,
                    size: buffer.byteLength,
                    created: Date.now(),
                    parent: appState.currentLibPath,
                    stats: statsObj
                });
                appState.totalBytes += buffer.byteLength;
                updateStorageUI();
                renderLibrary();
                
                document.getElementById('ribbon-file-info').innerText = "Uploading to Cloud Library...";
                await apiFetch('/api/library/upload?hash=' + encodeURIComponent(hash) + '&name=' + encodeURIComponent(targetName) + '&parent=' + encodeURIComponent(appState.currentLibPath) + '&stats=' + encodeURIComponent(JSON.stringify(statsObj)), {
                    method: 'POST', 
                    body: cloneBuffer(buffer)
                });
                
                document.getElementById('ribbon-file-info').innerText = "Uploaded successfully!";
                e.target.value = ''; 
                setTimeout(updateStatusCounter, 3000);
            } catch(err) {
                showDebug('Failed uploading direct to library', err);
                loadLibrary();
            }
        });

        // --- PRINT GENERATION BLOCK ---
        document.getElementById('btn-print').addEventListener('click', async function() {
            const active = getActive(); 
            if (!active) return;
            
            try {
                settingsPanel.style.display = 'none'; 
                document.getElementById('ribbon-file-info').innerText = "Preparing Print (Rendering pages)...";
                
                // 1. Generate the final PDF bytes with all annotations flattened
                const pdfBytes = await generateModifiedPdf(); 
                await syncAnnotations(true);
                
                // 2. Load the flattened PDF back into a temporary PDF.js instance
                const printPdf = await pdfjsLib.getDocument({ data: pdfBytes }).promise;
                
                // 3. Create a hidden iframe for standard HTML printing
                const iframe = document.createElement('iframe');
                iframe.style.position = 'absolute';
                iframe.style.width = '0px';
                iframe.style.height = '0px';
                iframe.style.border = 'none';
                document.body.appendChild(iframe);
                
                const printDoc = iframe.contentWindow.document;
                printDoc.open();
                // CSS to ensure the images fit the print page perfectly
                printDoc.write('<html><head><style>@page { margin: 0; } body { margin: 0; } .page { page-break-after: always; display: flex; justify-content: center; align-items: center; width: 100vw; height: 100vh; } img { max-width: 100%; max-height: 100%; display: block; }</style></head><body>');
                
                // 4. Convert each page to a high-res image to bypass the browser's PDF downloader
                for (let i = 1; i <= printPdf.numPages; i++) {
                    const page = await printPdf.getPage(i);
                    const viewport = page.getViewport({ scale: 2.0 }); // 2.0 scale for sharp print quality
                    const canvas = document.createElement('canvas');
                    canvas.width = viewport.width;
                    canvas.height = viewport.height;
                    
                    await page.render({ canvasContext: canvas.getContext('2d'), viewport: viewport }).promise;
                    
                    // Use JPEG to keep memory usage lower during print spooling
                    printDoc.write('<div class="page"><img src="' + canvas.toDataURL('image/jpeg', 0.85) + '"></div>');
                }
                
                printDoc.write('</body></html>');
                printDoc.close();
                
                // 5. Wait briefly for the DOM images to parse, then trigger the native print dialog
                setTimeout(() => {
                    iframe.contentWindow.focus();
                    iframe.contentWindow.print();
                    document.getElementById('ribbon-file-info').innerText = "Print dialog opened."; 
                    setTimeout(updateStatusCounter, 3000);
                    
                    // Cleanup the iframe after giving the print spooler time to finish
                    setTimeout(() => {
                        document.body.removeChild(iframe);
                    }, 120000);
                }, 1000);

            } catch(e) { 
                showDebug('Print preparation failed', e); 
            }
        });

        // --- FILE BLOCK ---
        const newFolderBtn = document.getElementById('lib-btn-newfolder');
        if (newFolderBtn) newFolderBtn.addEventListener('click', async () => {
            const name = prompt('Folder Name:');
            if(name) {
                const folderHash = 'folder_' + Date.now();
                appState.libraryFiles.push({
                    name: name,
                    isFolder: true,
                    created: Date.now(),
                    hash: folderHash,
                    parent: appState.currentLibPath
                });
                renderLibrary();
                
                try {
                    await apiFetch('/api/library', { 
                        method:'POST', 
                        body: JSON.stringify({
                            action:'create_folder', 
                            name: name, 
                            hash: folderHash,
                            parent: appState.currentLibPath,
                            created: Date.now()
                        })
                    });
                } catch(e) {
                    loadLibrary();
                }
            }
        });

        const libSearchInput = document.getElementById('lib-search');
        if (libSearchInput) libSearchInput.addEventListener('input', renderLibrary);
        const libSortSelect = document.getElementById('lib-sort');
        if (libSortSelect) libSortSelect.addEventListener('change', renderLibrary);

    </script>
</body>
</html>`;

const loginHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Login - PDF Workspace</title>
    <style>
        body {
            background-color: #2b2a33;
            color: #fbfbfe;
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100vh;
            margin: 0;
        }
        form {
            background: #1c1b22;
            padding: 30px;
            border-radius: 8px;
            border: 1px solid #555;
            box-shadow: 0 10px 30px rgba(0,0,0,0.5);
            display: flex;
            flex-direction: column;
            width: 100%;
            max-width: 300px;
        }
        h2 { margin: 0 0 20px 0; text-align: center; }
        input {
            background: #3b3a42;
            color: white;
            border: 1px solid #555;
            padding: 10px;
            margin-bottom: 15px;
            border-radius: 4px;
            font-size: 14px;
        }
        button {
            background: #2e8482;
            color: white;
            border: none;
            padding: 12px;
            border-radius: 4px;
            cursor: pointer;
            font-weight: bold;
            font-size: 14px;
        }
        button:hover { background: #3a9c9a; }
    </style>
</head>
<body>
    <form action="/login" method="POST">
        <h2>Workspace Login</h2>
        <label for="username">Username</label>
        <input type="text" id="username" name="username" required autocomplete="username">
        
        <label for="password">Password</label>
        <input type="password" id="password" name="password" required autocomplete="current-password">
        
        <button type="submit">Sign In</button>
    </form>
</body>
</html>`;

