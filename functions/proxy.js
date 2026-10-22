/**
 * Cloudflare Pages Functions - ICS 代理
 * 用途：绕过浏览器 CORS 限制，从服务器端抓取远程 ICS 文件并返回
 * 路由：/proxy?url=<encoded_url>
 */

export async function onRequest(context) {
    const { request } = context;

    // 只接受 GET 请求
    if (request.method !== 'GET') {
        return new Response(JSON.stringify({ error: '仅支持 GET 请求' }), {
            status: 405,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    // 从 URL 参数里取目标地址
    const url = new URL(request.url);
    const targetUrl = url.searchParams.get('url');

    if (!targetUrl) {
        return new Response(JSON.stringify({ error: '缺少 url 参数' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    // 校验协议，防止被用作任意代理
    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
        return new Response(JSON.stringify({ error: 'url 必须以 http:// 或 https:// 开头' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    try {
        const response = await fetch(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; MBA-Schedule-Bot/1.0)'
            }
        });

        if (!response.ok) {
            return new Response(
                JSON.stringify({ error: `远程服务器返回 ${response.status} ${response.statusText}` }),
                {
                    status: response.status,
                    headers: { 'Content-Type': 'application/json' }
                }
            );
        }

        const text = await response.text();

        // 可选：校验返回内容是否为 ICS 格式
        if (!text.includes('BEGIN:VCALENDAR')) {
            return new Response(
                JSON.stringify({ error: '远程地址返回的不是有效的 ICS 文件' }),
                {
                    status: 502,
                    headers: { 'Content-Type': 'application/json' }
                }
            );
        }

        return new Response(text, {
            status: 200,
            headers: {
                'Content-Type': 'text/calendar; charset=utf-8',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-store'
            }
        });
    } catch (e) {
        return new Response(
            JSON.stringify({ error: `请求远程地址失败: ${e.message}` }),
            {
                status: 502,
                headers: { 'Content-Type': 'application/json' }
            }
        );
    }
}
