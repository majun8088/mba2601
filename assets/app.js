/* ============================================================
   MBA 2601 课程日程表 — 前端逻辑
   数据源：ITA/.ics -> Cloudflare Pages Function (/api/ics) 代理
   特性：本地缓存兜底 / 时区修正 / 重复规则展开 / 搜索筛选 / 暗色主题
   ============================================================ */
(function () {
  'use strict';

  // 部署 worker/ics.js 后拿到的 https://xxx.workers.dev 地址。
  // 填到这里后全站默认实时同步，所有人打开即可生效，无需在设置面板手动填写。
  // 留空则只用同源 /api/ics（Pages Functions）与随站快照。
  var DEFAULT_API_BASE = 'young-dawn-8e2f.qingquan0703.workers.dev';

  var CONFIG = {
    API: '/api/ics',
    // 同源静态快照：不受 CORS 限制，作为 Functions 未部署时的兜底
    SNAPSHOT: '/MBA2601.ics',
    DEFAULT_SOURCE: 'https://raw.giteeusercontent.com/blue0703/class-schedule-2601/raw/master/MBA2601.ics',
    CACHE_KEY: 'mba2601.ics.v1',
    PREF_KEY: 'mba2601.prefs.v1',
    CACHE_TTL: 15 * 60 * 1000,   // 本地缓存有效期
    LOOKBACK_DAYS: 90,           // 重复规则展开：向前窗口
    LOOKAHEAD_DAYS: 400,         // 重复规则展开：向后窗口
    AUTO_REFRESH: 30 * 60 * 1000 // 页面可见时自动刷新间隔
  };

  var PALETTE = [
    '#2563eb', '#0891b2', '#7c3aed', '#db2777', '#ea580c',
    '#16a34a', '#4f46e5', '#0d9488', '#b45309', '#be123c',
    '#4338ca', '#0369a1', '#059669', '#9333ea', '#c2410c'
  ];

  var state = {
    allEvents: [],
    filtered: [],
    calendar: null,
    prefs: {
      source: CONFIG.DEFAULT_SOURCE,
      apiBase: DEFAULT_API_BASE || '',
      view: 'dayGridMonth',
      theme: 'auto',
      onlyFuture: false
    },
    lastSync: 0,
    msg: '',
    loading: false
  };

  var $ = function (id) { return document.getElementById(id); };

  /* ---------- 工具函数 ---------- */
  function pad(n) { return String(n).padStart(2, '0'); }

  function asDate(d) {
    if (d instanceof Date) return isNaN(d.getTime()) ? new Date() : d;
    if (typeof d === 'number') return new Date(d);
    if (typeof d === 'string') {
      var t = new Date(d);
      return isNaN(t.getTime()) ? new Date() : t;
    }
    return new Date();
  }

  function fmtDate(d) { d = asDate(d); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function fmtTime(d) { d = asDate(d); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function compactTime(d) { d = asDate(d); return d.getHours() + ':' + pad(d.getMinutes()); }
  function fmtDateTime(d) { d = asDate(d); return fmtDate(d) + ' ' + fmtTime(d); }
  function fmtMD(d) { d = asDate(d); return (d.getMonth() + 1) + '/' + d.getDate(); }

  var WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  function relTime(target) {
    var diff = target.getTime() - Date.now();
    if (diff < 0) return '已结束';
    var m = Math.floor(diff / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
    if (m < 1) return '即将开始';
    if (m < 60) return m + ' 分钟后';
    if (h < 24) return h + ' 小时 ' + (m % 60) + ' 分钟后';
    return d + ' 天后';
  }

  /* 按「开始 ~ 结束」区间判断状态，避免把正在上的课标成已结束 */
  function statusText(startMs, endMs) {
    var now = Date.now();
    if (now < startMs) return relTime(new Date(startMs));
    if (now < endMs) return '进行中 · ' + Math.max(1, Math.round((endMs - now) / 60000)) + ' 分钟后下课';
    return '已结束';
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function linkify(s) {
    return esc(s).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  }

  function cleanText(s) {
    if (!s) return '';
    return String(s)
      .replace(/\r\n/g, '\n')
      .replace(/\\n/gi, '\n')
      .replace(/\\,/g, ',')
      .replace(/\\;/g, ';')
      .trim();
  }

  function courseKey(title) {
    return String(title || '').replace(/[（(].*?[)）]/g, '').trim() || String(title || '其他');
  }

  function colorOf(key) {
    var h = 0;
    for (var i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }

  function toast(msg, kind) {
    var box = $('toastBox');
    if (!box) return;
    var el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.innerHTML = esc(msg);
    box.appendChild(el);
    setTimeout(function () {
      el.style.transition = 'opacity .3s,transform .3s';
      el.style.opacity = '0';
      el.style.transform = 'translateX(16px)';
      setTimeout(function () { el.remove(); }, 320);
    }, 3200);
  }

  /* ---------- 偏好持久化 ---------- */
  function loadPrefs() {
    try {
      var raw = localStorage.getItem(CONFIG.PREF_KEY);
      if (raw) {
        var p = JSON.parse(raw);
        for (var k in p) if (Object.prototype.hasOwnProperty.call(p, k)) state.prefs[k] = p[k];
      }
    } catch (e) { /* 忽略 */ }
    var q = new URLSearchParams(location.search);
    var qSource = q.get('ics');
    if (qSource) state.prefs.source = qSource;
    var qTheme = q.get('theme');
    if (qTheme && ['auto', 'light', 'dark'].indexOf(qTheme) >= 0) state.prefs.theme = qTheme;
    var qView = q.get('view');
    if (qView && ['dayGridMonth', 'timeGridWeek', 'timeGridDay', 'listMonth'].indexOf(qView) >= 0) {
      state.prefs.view = qView;
    }
    var qApi = q.get('api');
    if (qApi) state.prefs.apiBase = qApi.trim().replace(/\/+$/, '');
  }

  function savePrefs() {
    try { localStorage.setItem(CONFIG.PREF_KEY, JSON.stringify(state.prefs)); } catch (e) { /* 忽略 */ }
  }

  /* ---------- 依赖兜底：本地 vendor 缺失时回落 CDN ---------- */
  var CDN = {
    fc: 'https://cdn.jsdelivr.net/npm/fullcalendar@6.1.11/index.global.min.js',
    fcLocale: 'https://cdn.jsdelivr.net/npm/@fullcalendar/core@6.1.11/locales/zh-cn.global.min.js',
    ical: 'https://cdn.jsdelivr.net/npm/ical.js@1.5.0/build/ical.min.js'
  };

  function hasZhLocale() {
    var list = (typeof FullCalendar !== 'undefined' && FullCalendar.globalLocales) || [];
    for (var i = 0; i < list.length; i++) if (list[i].code === 'zh-cn') return true;
    return false;
  }

  function ensureLibs() {
    var jobs = [];
    if (typeof FullCalendar === 'undefined') jobs.push(loadScript(CDN.fc));
    if (typeof ICAL === 'undefined') jobs.push(loadScript(CDN.ical));
    return Promise.all(jobs)
      .then(function () {
        if (typeof FullCalendar !== 'undefined' && !hasZhLocale()) return loadScript(CDN.fcLocale);
      })
      .catch(function () { /* 单网 CDN 不可用时保留英文界面 */ });
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src; s.async = false;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('依赖加载失败: ' + src)); };
      document.head.appendChild(s);
    });
  }

  /* ---------- 时区修正：注册 Asia/Shanghai（固定 UTC+8） ---------- */
  function ensureTimezone() {
    if (typeof ICAL === 'undefined') return;
    var tzid = 'Asia/Shanghai';
    try { if (ICAL.TimezoneService.has(tzid)) return; } catch (e) { /* continue */ }
    try {
      var lines = [
        'BEGIN:VTIMEZONE', 'TZID:' + tzid, 'BEGIN:STANDARD',
        'DTSTART:16010101T000000', 'TZOFFSETFROM:+0800', 'TZOFFSETTO:+0800', 'TZNAME:CST',
        'END:STANDARD', 'END:VTIMEZONE'
      ];
      var parsed = new ICAL.Component(ICAL.parse(lines.join('\r\n')));
      ICAL.TimezoneService.register(tzid, ICAL.Timezone.fromData(parsed));
    } catch (e) {
      console.warn('时区注册失败，时间可能按 UTC 解析', e);
    }
  }

  /* ---------- ICS 解析 ---------- */
  function toISO(t) {
    if (!t) return null;
    if (t.isDate) return t.toString(); // 全天事件：YYYY-MM-DD
    try { return t.toJSDate().toISOString(); } catch (e) { return t.toString(); }
  }

  function parseICS(text) {
    ensureTimezone();
    var root = new ICAL.Component(ICAL.parse(text));
    var vevents = root.getAllSubcomponents('vevent');

    var now = Date.now();
    var rangeStart = ICAL.Time.fromJSDate(new Date(now - CONFIG.LOOKBACK_DAYS * 86400000), true);
    var rangeEnd = ICAL.Time.fromJSDate(new Date(now + CONFIG.LOOKAHEAD_DAYS * 86400000), true);

    var out = [];

    vevents.forEach(function (comp, idx) {
      var ev = new ICAL.Event(comp);
      var recurring = comp.hasProperty('RRULE') || comp.hasProperty('RDATE');
      var occurrences = [];

      try {
        if (recurring) {
          var iter = ev.iterator();
          var cur, guard = 0;
          while ((cur = iter.next()) && guard++ < 2000) {
            if (cur.compare(rangeEnd) > 0) break;
            if (cur.compare(rangeStart) >= 0) occurrences.push(cur.clone());
          }
        } else {
          var st = comp.getFirstPropertyValue('dtstart');
          if (st) occurrences.push(st.clone());
        }
      } catch (e) {
        var fallback = comp.getFirstPropertyValue('dtstart');
        if (fallback) occurrences.push(fallback.clone());
      }

      occurrences.forEach(function (startT) {
        var endT = null;
        try {
          if (recurring) {
            // 重复事件：按首事件的时长推算每一次的结束时间
            var durSec = Math.round(
              (ev.endDate && ev.startDate)
                ? (ev.endDate.toJSDate().getTime() - ev.startDate.toJSDate().getTime()) / 1000
                : 3600
            );
            endT = startT.clone();
            endT.addDuration(new ICAL.Duration({
              hours: Math.floor(durSec / 3600),
              minutes: Math.round((durSec % 3600) / 60)
            }));
          } else {
            var dtEnd = comp.getFirstPropertyValue('dtend');
            if (dtEnd) endT = dtEnd.clone();
          }
        } catch (e2) { endT = null; }

        var jsStart = startT && startT.toJSDate ? startT.toJSDate() : null;
        var jsEnd = endT && endT.toJSDate ? endT.toJSDate() : null;
        if (!jsStart) return;

        var key = courseKey(ev.summary);
        var uid = (comp.getFirstPropertyValue('uid') || 'evt') + '#' + jsStart.getTime();
        var color = colorOf(key);
        out.push({
          id: uid,
          title: cleanText(ev.summary) || '未命名课程',
          start: toISO(startT),
          end: jsEnd ? toISO(endT) : null,
          allDay: !!startT.isDate,
          backgroundColor: color,
          borderColor: color,
          textColor: '#ffffff',
          location: cleanText(ev.location),
          description: cleanText(ev.description),
          course: key,
          color: color,
          _startMs: jsStart.getTime(),
          _endMs: jsEnd ? jsEnd.getTime() : jsStart.getTime() + 3600000,
          _seq: idx
        });
      });
    });

    // 去重 + 排序
    var seen = Object.create(null);
    var unique = [];
    out.forEach(function (e) {
      var sig = e.title + '|' + e._startMs + '|' + e._endMs;
      if (seen[sig]) return;
      seen[sig] = 1;
      unique.push(e);
    });
    unique.sort(function (a, b) { return a._startMs - b._startMs; });
    return unique;
  }

  /* ---------- 数据获取：同源 API -> 公共代理 -> 本地缓存 ---------- */
  function readCache() {
    try {
      var raw = localStorage.getItem(CONFIG.CACHE_KEY);
      if (!raw) return null;
      var c = JSON.parse(raw);
      if (!c || !c.text || !c.ts) return null;
      return c;
    } catch (e) { return null; }
  }

  function writeCache(text) {
    try {
      localStorage.setItem(CONFIG.CACHE_KEY, JSON.stringify({ ts: Date.now(), text: text }));
    } catch (e) { /* 配额不足时忽略 */ }
  }

  function viaAPI(source) {
    // 优先级：外部 Worker（明确填了就优先）→ 同源 /api/ics（Pages Functions）
    var bases = [];
    var ext = (state.prefs.apiBase || '').trim().replace(/\/+$/, '');
    if (ext && ext.indexOf('http') === 0) bases.push(ext);
    bases.push(CONFIG.API);

    var i = 0, lastErr = null;
    function next() {
      if (i >= bases.length) return Promise.reject(lastErr || new Error('无可用代理'));
      var url = bases[i++] + (source ? '?u=' + encodeURIComponent(source) : '');
      return fetchOnce(url).catch(function (e) {
        lastErr = e;
        return next();
      });
    }
    return next();
  }

  function fetchOnce(url) {
    return fetch(url, { headers: { Accept: 'text/calendar' }, cache: 'no-store' })
      .then(function (r) {
        var ct = r.headers.get('content-type') || '';
        if (!r.ok) {
          var e = new Error('代理返回 HTTP ' + r.status);
          e.status = r.status;
          // Pages Functions 没部署时，静态托管会返回 404 页面而不是 JSON
          e.kind = (r.status === 404 && ct.indexOf('json') < 0) ? 'no-api' : 'api-error';
          return r.text().then(function (t) {
            try {
              var j = JSON.parse(t);
              if (j && j.error) e.message = j.error;
            } catch (_) { /* 非 JSON 保持默认文案 */ }
            throw e;
          }, function () { throw e; });
        }
        return r.text();
      })
      .then(function (t) {
        if (!t || t.indexOf('BEGIN:VCALENDAR') === -1) {
          var e = new Error('代理返回内容不是 ICS');
          e.kind = 'bad-body';
          throw e;
        }
        return t;
      })
      .catch(function (e) {
        if (!e.kind) e.kind = 'network';
        throw e;
      });
  }

  /* 同源静态快照 file:// 下无法 fetch，所以单文件版会把 ICS 内容直接注入 window */
  function viaSnapshot() {
    if (window.__MBA_ICS_SNAPSHOT__) {
      return Promise.resolve({
        text: window.__MBA_ICS_SNAPSHOT__,
        date: window.__MBA_ICS_DATE__ ? new Date(window.__MBA_ICS_DATE__) : null
      });
    }
    return fetch(CONFIG.SNAPSHOT, { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) {
          var e = new Error('快照 HTTP ' + r.status);
          e.kind = 'no-snapshot';
          throw e;
        }
        var lm = r.headers.get('last-modified');
        return r.text().then(function (t) {
          if (t.indexOf('BEGIN:VCALENDAR') === -1) {
            var e2 = new Error('快照不是 ICS');
            e2.kind = 'no-snapshot';
            throw e2;
          }
          return { text: t, date: lm ? new Date(lm) : null };
        });
      });
  }

  /* 把失败原因翻成人能看懂的话，方便直接照着修 */
  function diagnose(apiErr, proxyErr) {
    if (location.protocol === 'file:') {
      return '以本地文件方式打开，代理接口 /api/ics 不可用。请改用 standalone.html，或用 http 服务打开';
    }
    if (apiErr && apiErr.kind === 'no-api') {
      return '实时代理未生效：要么把 functions/api/ics.js 放在项目根目录，用 wrangler deploy 或 Git 集成部署；要么单独部署一个 Worker（worker/ics.js），把地址填进「设置 → 实时代理地址」。当前显示的是随站快照';
    }
    if (apiErr && apiErr.kind === 'api-error') {
      return '服务端代理报错：' + (apiErr.message || ('HTTP ' + apiErr.status));
    }
    if (apiErr && apiErr.kind === 'bad-body') {
      return '服务端代理返回内容异常（非 ICS 文件）';
    }
    if (apiErr && proxyErr) {
      return '代理接口不可达（' + (apiErr.message || '网络错误') + '），备用公共代理同样失败';
    }
    if (proxyErr) return '备用公共代理不可用，请检查网络';
    return '未知错误';
  }

  function viaProxy(source) {
    var targets = [
      'https://api.allorigins.win/raw?url=' + encodeURIComponent(source),
      'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(source)
    ];
    var i = 0;
    function attempt() {
      if (i >= targets.length) return Promise.reject(new Error('全部通道失败'));
      var url = targets[i++];
      return fetch(url, { cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
        .then(function (t) { if (t.indexOf('BEGIN:VCALENDAR') === -1) throw new Error('非法内容'); return t; })
        .catch(attempt);
    }
    return attempt();
  }

  function setStatus(kind, text) {
    var el = $('syncStatus');
    if (el) el.innerHTML = '<span class="dot ' + kind + '"></span><span>' + esc(text) + '</span>';
  }

  function parseOrThrow(text) {
    var events = parseICS(text); // 解析失败会 throw
    if (!events.length) throw new Error('ICS 中未找到任何 VEVENT');
    return events;
  }

  async function refresh(silent) {
    if (state.loading) return;
    state.loading = true;
    var btn = $('refreshBtn');
    if (btn) { btn.disabled = true; btn.querySelector('svg').classList.add('spin'); }

    var source = (state.prefs.source || CONFIG.DEFAULT_SOURCE).trim();
    var text = null, channel = '', snapDate = null;
    var apiErr = null, snapErr = null, proxyErr = null;

    // 优先级：服务端代理（实时） → 同源静态快照 → 公共代理 → 本地缓存
    try {
      text = await viaAPI(source);
      channel = 'Cloudflare 边缘同步';
    } catch (e1) {
      apiErr = e1;
      try {
        var snap = await viaSnapshot();
        text = snap.text;
        snapDate = snap.date;
        channel = '静态快照';
      } catch (e2) {
        snapErr = e2;
        try {
          text = await viaProxy(source);
          channel = '备用通道';
        } catch (e3) { proxyErr = e3; text = null; }
      }
    }

    if (text) {
      try {
        state.allEvents = parseOrThrow(text);
        writeCache(text);
        state.lastSync = Date.now();
        render(state.allEvents);
        updateMeta(channel, snapDate);
        if (!silent) toast('已同步 ' + state.allEvents.length + ' 条日程', 'ok');
      } catch (pe) {
        setStatus('down', 'ICS 解析失败');
        setHint('ICS 解析失败：' + pe.message);
        toast('ICS 解析失败：' + pe.message, 'err');
      }
    } else {
      var reason = diagnose(apiErr, proxyErr);
      var cached = readCache();
      if (cached) {
        try {
          state.allEvents = parseICS(cached.text);
          render(state.allEvents);
          setStatus('loading', '离线数据（更新于 ' + fmtDateTime(new Date(cached.ts)) + '）');
          toast('远程拉取失败，已用本地缓存', 'err');
        } catch (pe) {
          setStatus('down', '数据源和缓存均不可用');
        }
      } else {
        setStatus('down', '无法连接数据源');
        toast(reason, 'err');
      }
      setHint(reason);
    }

    if (btn) { btn.disabled = false; btn.querySelector('svg').classList.remove('spin'); }
    state.loading = false;
  }

  /* ---------- 渲染 ---------- */
  function render(events) {
    buildCourseFilter(events);
    ensureCalendar();
    applyFilters();
  }

  function ensureCalendar() {
    if (state.calendar) return state.calendar;
    var el = $('calendar');
    el.classList.remove('skeleton', 'sk-block');

    state.calendar = new FullCalendar.Calendar(el, {
      initialView: state.prefs.view || 'dayGridMonth',
      locale: 'zh-cn',
      firstDay: 1,
      expandRows: true,
      navLinks: true,
      nowIndicator: true,
      weekNumbers: false,
      slotMinTime: '07:00:00',
      slotMaxTime: '22:30:00',
      allDaySlot: true,
      allDayText: '全天',
      slotLabelFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
      eventTimeFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
      slotEventOverlap: false,
      contentHeight: 620,
      headerToolbar: {
        left: 'prev,next today',
        center: 'title',
        right: 'dayGridMonth,timeGridWeek,timeGridDay,listMonth'
      },
      buttonText: { today: '今天', month: '月', week: '周', day: '日', list: '列表' },
      // 只对月视图指定标题格式，周/日视图保留自带日期范围（否则会退化成只显示年月）
      views: {
        dayGridMonth: { titleFormat: { year: 'numeric', month: 'long' } }
      },
      dayHeaderFormat: { weekday: 'short' },
      noEventsText: '暂无课程安排',
      datesSet: function (info) {
        state.prefs.view = info.view.type;
        savePrefs();
        var names = {
          dayGridMonth: '月视图', timeGridWeek: '周视图',
          timeGridDay: '日视图', listMonth: '列表视图'
        };
        var el2 = $('viewName');
        if (el2) el2.textContent = names[info.view.type] || '日程视图';
      },
      eventClick: function (info) { showModal(info.event); },
      eventDidMount: function (info) {
        var s = info.event.start;
        var e = info.event.end;
        var p = info.event.extendedProps || {};
        info.el.title = info.event.title +
          (s ? ' · ' + fmtTime(s) + (e && !info.event.allDay ? '-' + fmtTime(e) : '') : '') +
          (p.location ? ' · ' + p.location : '');
      },
      dayMaxEventRows: 4,
      moreLinkContent: function (arg) { return '+' + arg.num + ' 更多'; },
      eventDisplay: 'block',
      eventContent: function (arg) {
        if (arg.view.type === 'dayGridMonth') {
          var t = arg.event.allDay ? '' : '<span class="seq">' + compactTime(arg.event.start) + '</span>';
          // 月视图格子窄，优先用短课程名（教师名放在 tooltip / 弹窗里），避免频繁被省略
          var p = arg.event.extendedProps || {};
          var name = p.course || arg.event.title;
          return {
            html: '<div class="course-block">' + t +
              '<span class="cname">' + esc(name) + '</span></div>'
          };
        }
        return true;
      }
    });
    state.calendar.render();
    return state.calendar;
  }

  /* ---------- 筛选 ---------- */
  function applyFilters() {
    if (!state.calendar) return;
    var kw = ($('searchInput').value || '').trim().toLowerCase();
    var course = $('courseFilter').value || '';
    var onlyFuture = state.prefs.onlyFuture;
    var now = Date.now();

    var list = state.allEvents.filter(function (e) {
      if (course && e.course !== course) return false;
      if (onlyFuture && e._endMs < now) return false;
      if (!kw) return true;
      return (e.title || '').toLowerCase().indexOf(kw) >= 0
        || (e.description || '').toLowerCase().indexOf(kw) >= 0
        || (e.location || '').toLowerCase().indexOf(kw) >= 0
        || (e.course || '').toLowerCase().indexOf(kw) >= 0;
    });

    state.calendar.removeAllEventSources();
    state.calendar.addEventSource(list);
    state.filtered = list;
    updateStats(list);
    renderUpcoming(list);

    showCountHint((kw || course || onlyFuture) ? ('已筛选 ' + list.length + ' / ' + state.allEvents.length + ' 条') : '');
  }

  /* ---------- 统计 / 侧栏 ---------- */
  function updateStats(list) {
    var now = Date.now();
    var total = list.length;
    var past = 0, future = 0, hours = 0;
    list.forEach(function (e) {
      if (e._endMs < now) past++;
      else future++;
      hours += Math.max(0, (e._endMs - e._startMs) / 3600000);
    });

    setValue('statTotal', total);
    setValue('statTotalSub', '已完成 ' + past + ' · 待进行 ' + future);
    setValue('statHours', Math.round(hours * 10) / 10);
    setValue('statHoursSub', '按当前筛选结果统计');

    var next = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i]._endMs >= now) { next = list[i]; break; }
    }
    if (next) {
      var d = new Date(next._startMs);
      setValue('statNext', next.title);
      setValue('statNextSub', fmtMD(d) + ' ' + WEEK[d.getDay()] + ' ' + fmtTime(d) + ' · ' + statusText(next._startMs, next._endMs));
      var cd = $('nextCountdown');
      if (cd) cd.textContent = now < next._startMs ? relTime(d) : '进行中';
    } else {
      setValue('statNext', '暂无后续安排');
      setValue('statNextSub', '所有筛选结果均已结束');
      var cd2 = $('nextCountdown');
      if (cd2) cd2.textContent = '—';
    }
  }

  function setValue(id, v) {
    var el = $(id);
    if (el) el.textContent = v;
  }

  function renderUpcoming(list) {
    var box = $('upcomingList');
    if (!box) return;
    var now = Date.now();
    var items = list.filter(function (e) { return e._endMs >= now; }).slice(0, 12);
    if (!items.length) {
      box.innerHTML = '<div class="empty">当前筛选条件下没有即将开始的课程</div>';
      return;
    }
    box.innerHTML = items.map(function (e) {
      var d = new Date(e._startMs);
      var end = new Date(e._endMs);
      var live = now >= e._startMs && now < e._endMs;
      return '<li data-start="' + e.start + '">' +
        '<span class="up-bar" style="background:' + e.color + '"></span>' +
        '<span class="up-date">' + fmtMD(d) + '<br>' + WEEK[d.getDay()] + '</span>' +
        '<span style="min-width:0;flex:1">' +
        '<span class="up-title">' + esc(e.title) + '</span>' +
        '<span class="up-meta">' + fmtTime(d) + '–' + fmtTime(end) +
        (e.location ? ' · ' + esc(e.location) : '') + '</span>' +
        '<span class="up-meta" style="color:' + (live ? 'var(--ok)' : 'var(--brand)') + ';font-weight:600">' +
        statusText(e._startMs, e._endMs) + '</span>' +
        '</span></li>';
    }).join('');

    Array.prototype.forEach.call(box.querySelectorAll('li'), function (li) {
      li.addEventListener('click', function () {
        if (!state.calendar) return;
        state.calendar.gotoDate(li.getAttribute('data-start'));
        state.calendar.changeView('timeGridDay');
      });
    });

    markScrollable(box);
  }

  /* 列表可滚动时给底部加渐隐，提示还有更多内容 */
  function markScrollable(box) {
    var update = function () {
      var overflowing = box.scrollHeight > box.clientHeight + 4;
      var atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 4;
      box.classList.toggle('faded', overflowing && !atBottom);
    };
    if (!box.dataset.fadeBound) {
      box.addEventListener('scroll', update, { passive: true });
      window.addEventListener('resize', update);
      box.dataset.fadeBound = '1';
    }
    requestAnimationFrame(update);
  }

  function updateMeta(channel, snapDate) {
    var t = fmtTime(new Date(state.lastSync));
    if (channel === '静态快照') {
      var age = snapDate ? (fmtMD(snapDate) + ' 生成') : '内置数据';
      setStatus('loading', channel + ' · ' + age);
      setHint('代理未启用，使用随站快照；更新数据：tools/fetch-ics.mjs');
      return;
    }
    setStatus('live', channel + ' · ' + t + ' 同步');
    var src = state.prefs.source || CONFIG.DEFAULT_SOURCE;
    var host = '';
    try { host = new URL(src).hostname; } catch (e) { host = src; }
    setHint('数据源：' + host);
  }

  function setHint(t, persistent) {
    if (persistent !== false) state.msg = t || '';
    var el = $('filterHint');
    if (el) el.textContent = t || '';
  }

  /* 筛选计数提示会临时占用同一行，取消筛选后恢复原消息 */
  function showCountHint(t) {
    var el = $('filterHint');
    if (el) el.textContent = t || state.msg || '';
  }

  /* ---------- 课程下拉 ---------- */
  function buildCourseFilter(events) {
    var sel = $('courseFilter');
    if (!sel) return;
    var keep = sel.value;
    var names = [];
    var map = Object.create(null);
    events.forEach(function (e) { if (!map[e.course]) { map[e.course] = 1; names.push(e.course); } });
    names.sort(function (a, b) { return a.localeCompare(b, 'zh-Hans-CN'); });
    sel.innerHTML = '<option value="">全部课程</option>' + names.map(function (n) {
      return '<option value="' + esc(n) + '">' + esc(n) + '</option>';
    }).join('');
    sel.value = names.indexOf(keep) >= 0 ? keep : '';
  }

  /* ---------- 事件弹窗 ---------- */
  function showModal(event) {
    var s = event.start, e = event.end;
    var p = event.extendedProps || {};
    var title = event.title;
    if (e) {
      $('modalTitle').innerHTML = esc(title) + ' <span class="pill">' + fmtTime(s) + ' – ' + fmtTime(e) + '</span>';
    } else {
      $('modalTitle').innerHTML = esc(title);
    }
    var durMin = Math.round((e ? e - s : 0) / 60000);
    $('modalStart').textContent = e ? (fmtDate(s) + ' ' + WEEK[s.getDay()] + ' ' + fmtTime(s)) : '未指定';
    $('modalEnd').textContent = e ? (fmtTime(e) + '（' + (durMin >= 60 ? (Math.floor(durMin / 60) + ' 小时 ' + (durMin % 60) + ' 分') : durMin + ' 分钟') + '）') : '未指定';
    $('modalLocation').textContent = p.location || '未标注';
    $('modalDesc').innerHTML = p.description ? linkify(p.description) : '无';
    $('modalCourse').textContent = p.course || '未分类';
    if (p.color) $('modalBadge').style.background = p.color;
    openModal();
  }

  function openModal() {
    var m = $('eventModal');
    m.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }

  function closeModal() {
    var m = $('eventModal');
    m.classList.add('hidden');
    document.body.style.overflow = '';
  }

  /* ---------- 主题 ---------- */
  function applyTheme(mode) {
    state.prefs.theme = mode;
    if (mode === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', mode);
    savePrefs();
    var btn = $('themeBtn');
    if (btn) {
      var icon = mode === 'dark' ? '🌙' : mode === 'light' ? '☀️' : '◐';
      btn.textContent = icon;
    }
  }

  /* ---------- 订阅链接 ---------- */
  async function copySubscribeLink() {
    var base = state.prefs.apiBase || CONFIG.API;
    var url = base.indexOf('http') === 0 ? new URL(base) : new URL(CONFIG.API, location.href);
    if (state.prefs.source && state.prefs.source !== CONFIG.DEFAULT_SOURCE) {
      url.searchParams.set('u', state.prefs.source);
    }
    var link = url.href;
    try {
      await navigator.clipboard.writeText(link);
      toast('订阅地址已复制，可粘贴到手机日历 App', 'ok');
    } catch (e) {
      var tmp = document.createElement('input');
      tmp.value = link;
      document.body.appendChild(tmp);
      tmp.select();
      try { document.execCommand('copy'); toast('订阅地址已复制', 'ok'); }
      catch (e2) { toast('复制失败，请手动复制：' + link); }
      tmp.remove();
    }
  }

  /* ---------- 启动 ---------- */
  async function bootstrap() {
    loadPrefs();
    applyTheme(state.prefs.theme || 'auto');
    setStatus('loading', '正在连接数据源...');
    var srcInput = $('icsSourceInput');
    if (srcInput) srcInput.value = state.prefs.source || CONFIG.DEFAULT_SOURCE;
    var apiInput = $('apiBaseInput');
    if (apiInput) apiInput.value = state.prefs.apiBase || '';

    try {
      await ensureLibs();
    } catch (e) {
      setStatus('down', '核心依赖加载失败');
      toast('脚本依赖加载失败，请检查网络', 'err');
      return;
    }

    bindUI();

    // 先用本地缓存秒开，再静默拉取远程最新数据
    var cached = readCache();
    if (cached) {
      try {
        state.allEvents = parseICS(cached.text);
        render(state.allEvents);
        setStatus('loading', '离线数据 · 更新于 ' + fmtDateTime(new Date(cached.ts)));
      } catch (e) { /* 缓存损坏则忽略 */ }
    }

    await refresh(true);

    // 自动刷新：仅在页面可见时
    setInterval(function () {
      if (document.visibilityState === 'visible') refresh(true);
    }, CONFIG.AUTO_REFRESH);

    // 仅刷新倒计时文案，避免整表重绘打断用户操作
    setInterval(function () {
      if (state.filtered && document.visibilityState === 'visible') updateStats(state.filtered);
    }, 30000);
  }

  function bindUI() {
    var timer = null;
    $('searchInput').addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(applyFilters, 180);
    });
    $('courseFilter').addEventListener('change', applyFilters);

    var fut = $('futureToggle');
    fut.checked = !!state.prefs.onlyFuture;
    fut.addEventListener('change', function () {
      state.prefs.onlyFuture = fut.checked;
      savePrefs();
      applyFilters();
    });

    $('refreshBtn').addEventListener('click', function () { refresh(false); });
    $('settingsBtn').addEventListener('click', function () {
      $('settingsPanel').classList.toggle('hidden');
    });
    $('themeBtn').addEventListener('click', function () {
      var order = ['auto', 'light', 'dark'];
      var next = order[(order.indexOf(state.prefs.theme) + 1) % order.length];
      applyTheme(next);
    });
    $('copyLinkBtn').addEventListener('click', copySubscribeLink);
    $('applyApiBtn').addEventListener('click', function () {
      var v = ($('apiBaseInput').value || '').trim().replace(/\/+$/, '');
      state.prefs.apiBase = v;
      savePrefs();
      toast(v ? '已保存代理地址，正在实时拉取' : '已清除代理地址，改用同源接口', 'ok');
      refresh(false);
    });
    $('applySourceBtn').addEventListener('click', function () {
      state.prefs.source = ($('icsSourceInput').value || '').trim() || CONFIG.DEFAULT_SOURCE;
      savePrefs();
      toast('订阅源已更新，正在重新加载', 'ok');
      refresh(false);
    });
    $('resetSourceBtn').addEventListener('click', function () {
      $('icsSourceInput').value = CONFIG.DEFAULT_SOURCE;
      state.prefs.source = CONFIG.DEFAULT_SOURCE;
      savePrefs();
      refresh(false);
    });
    $('closeModalBtn').addEventListener('click', closeModal);
    $('okModalBtn').addEventListener('click', closeModal);
    $('eventModal').addEventListener('click', function (e) {
      if (e.target === $('eventModal')) closeModal();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeModal();
      if (e.key === '/' && document.activeElement !== $('searchInput')) {
        e.preventDefault();
        $('searchInput').focus();
      }
    });
  }

  // 调试钩子：控制台可用 MBA2601.state / MBA2601.parseICS 排查问题
  if (typeof window !== 'undefined') {
    window.MBA2601 = {
      CONFIG: CONFIG,
      state: state,
      parseICS: parseICS,
      diagnose: diagnose,
      refresh: refresh,
      applyFilters: applyFilters
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
