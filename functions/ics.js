export async function onRequest(context) {
  const giteeUrl = "https://raw.giteeusercontent.com/blue0703/class-schedule-2601/raw/master/MBA2601.ics";
  
  try {
    // 从 Gitee 抓取最新课表
    const response = await fetch(giteeUrl);
    if (!response.ok) throw new Error("Gitee fetch failed");
    
    const icsText = await response.text();
    
    // 返回数据，并通过 Cloudflare 的 Cache-Control 强制在边缘节点缓存 2 小时 (7200秒)
    return new Response(icsText, {
      status: 200,
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=7200",
      },
    });
  } catch (err) {
    return new Response("Failed to fetch schedule", { status: 500 });
  }
}