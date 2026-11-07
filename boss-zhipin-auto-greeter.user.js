// ==UserScript==
// @name         BOSS直聘 自动打招呼(海投助手安全增强版)
// @namespace    https://github.com/tiantongss/boss-zhipin-userscript
// @version      2.0.1
// @description  在职位搜索页自动逐个点击"立即沟通",支持关键词过滤、随机长间隔、安全熔断机制、防风控冷却锁、弹窗自动处理与异常强行停止；投递成功后停留在当前页并自动发送简历附件；按岗位名与岗位描述同简历履历的匹配度过滤，仅投递高相似岗位；循环执行"立即沟通→留在此页"直到无推荐岗位或触发风控；支持接入 OpenAI 兼容大模型接口做岗位语义匹配（API Key 仅存本地）；按关键词队列依次搜索，列表滚动到底自动切换下一个关键词，异常时由 AI 从有限动作集中选择处置动作
// @updateURL    https://cdn.jsdelivr.net/gh/tiantongss/boss-zhipin-userscript@main/boss-zhipin-auto-greeter.user.js
// @downloadURL  https://cdn.jsdelivr.net/gh/tiantongss/boss-zhipin-userscript@main/boss-zhipin-auto-greeter.user.js
// @match        https://www.zhipin.com/web/geek/job*
// @match        https://www.zhipin.com/web/geek/jobs*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @connect      api.openai.com
// @connect      api.deepseek.com
// @connect      dashscope.aliyuncs.com
// @connect      api.moonshot.cn
// @connect      open.bigmodel.cn
// @connect      api.siliconflow.cn
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';
  /* ===================== 跨浏览器兼容层（Tampermonkey / Violentmonkey / Greasemonkey 通用） ===================== */
  const _gmGet = (k, d) => {
    try { return typeof GM_getValue === 'function' ? GM_getValue(k, d) : (localStorage.getItem('bz_' + k) !== null ? JSON.parse(localStorage.getItem('bz_' + k)) : d); }
    catch (e) { console.warn('[兼容层] 读取失败', k, e); return d; }
  };
  const _gmSet = (k, v) => {
    try { if (typeof GM_setValue === 'function') GM_setValue(k, v); else localStorage.setItem('bz_' + k, JSON.stringify(v)); }
    catch (e) { console.warn('[兼容层] 保存失败', k, e); }
  };
  const _gmStyle = (css) => {
    if (typeof GM_addStyle === 'function') { try { return GM_addStyle(css); } catch (e) {} }
    const s = document.createElement('style'); s.textContent = css; (document.head || document.documentElement).appendChild(s); return s;
  };
  const _gmClip = (text) => {
    if (typeof GM_setClipboard === 'function') { try { GM_setClipboard(text); return; } catch (e) {} }
    const ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) { console.warn('[兼容层] 复制失败', e); }
    ta.remove();
  };
  const _gmPost = (url, data, headers) => new Promise((resolve) => {
    const body = JSON.stringify(data);
    const done = (txt, err) => { if (err) resolve(null); else { try { resolve(JSON.parse(txt)); } catch (e) { resolve(null); } } };
    if (typeof GM_xmlhttpRequest === 'function') {
      GM_xmlhttpRequest({
        method: 'POST', url, headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}), data: body,
        timeout: 20000,
        onload: (r) => done(r.responseText, r.status < 200 || r.status >= 300),
        onerror: () => resolve(null),
        ontimeout: () => resolve(null),
      });
    } else {
      fetch(url, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}), body })
        .then((r) => r.text().then((t) => done(t, !r.ok)))
        .catch(() => resolve(null));
    }
  });

  console.log('[%s] 脚本已加载 v2.0.1 (安全增强版)', 'BOSS海投助手');

  /* ===== 简历画像（来自 朱鑫海 的履历，用于岗位相似度打分）===== */
  const RESUME = {
    titles: ['运维工程师', 'it运维', '桌面运维', '系统运维', '网络运维', '技术支持', '实施工程师', 'ai agent', '智能体', '大模型', '自动化'],
    skills: {
      'linux': 5, 'windows': 4, 'windowsserver': 4, '服务器': 4, '机房': 5, 'idc': 5,
      '网络': 4, '局域网': 4, 'tcp/ip': 3, 'vlan': 3, 'acl': 2, 'dns': 3, 'dhcp': 3,
      'vpn': 4, 'openvpn': 3, '防火墙': 3, '路由器': 3, '交换机': 3,
      '桌面': 4, '打印机': 2, '故障': 3, '排查': 3, '处理': 1,
      'mysql': 3, 'sql': 3, 'python': 3, 'shell': 3, 'docker': 4, '容器': 3,
      '云平台': 3, '阿里云': 2, 'ubuntu': 2, '麒麟': 3, 'kylin': 2, '域控': 3,
      '资产': 2, '工单': 2, 'ai': 2, '大模型': 4, '智能体': 4, 'agent': 4, '自动化': 3, '脚本': 2,
    },
    baseWeight: 60,
  };

  /* ===== 简历全文（AI 语义匹配用） ===== */
  const RESUME_TEXT = [
    '25岁，专科（浙江机电职业技术大学 数控技术专业），意向城市杭州，约3年运维经验。',
    '专业技能：Linux/Windows 系统管理与维护；Web 服务器搭建；Docker 与容器虚拟化；局域网维护与故障处理；TCP/IP、VLAN、ACL、DNS、DHCP、VPN；x86 服务器、防火墙、路由器、三层交换机配置；桌面与办公设备（打印机/扫描仪/投影仪）维护；SQL/MySQL；Python/Shell 脚本；AI 工具应用与改进方案。',
    '工作经历1：AI Agent 工程师，负责 OpenClaw 智能体部署、环境搭建、日常运维与参数调优，设计 AI 自动化工作流，对接大模型接口，编写自动化脚本。',
    '工作经历2：运维工程师（银行网点），负责桌面电脑与办公设备软硬件维护、机房设备日常维护、企业局域网维护与故障排查、域控与用户权限管理、资产管理与 IT 支持。',
    '工作经历3：运维工程师（IDC 机房），x86 服务器维护保养升级与故障排除、WindowsServer/Linux 安装配置、7x24 机房运维监控、网络故障诊断、客户资产统计与工单处理。',
    '项目：OpenVPN 异地组网（阿里云轻量服务器 + Ubuntu 部署，实现跨地域内网互联）。',
  ].join('\n');

  /* ===== 硬性排除（命中即跳过，先于任何打分） ===== */
  const HARD_BLOCK = ['销售', '外包', '驻场', '中介', '派遣', '人力资源服务', '猎头'];

  function scoreJob(text, title) {
    const t = (text || '').toLowerCase();
    const ty = (title || '').toLowerCase();
    let w = 0;
    const hits = [];
    for (const k of Object.keys(RESUME.skills)) {
      if (t.includes(k)) { w += RESUME.skills[k]; hits.push(k); }
    }
    const skillScore = Math.min(100, (w / RESUME.baseWeight) * 100);
    const titleHit = RESUME.titles.some((k) => ty.includes(k));
    const score = Math.min(100, Math.round(skillScore * 0.75 + (titleHit ? 25 : 0)));
    return { score, hits };
  }

  /* ===== AI 语义匹配（OpenAI 兼容 /chat/completions） ===== */
  const AI_CACHE_TTL = 7 * 24 * 3600 * 1000;
  let _aiLastAt = 0;

  async function aiScore(title, company, jd) {
    const key = _gmGet('aiKey', '');
    if (!key) return null;

    const ck = title + '|' + company;
    const cache = _gmGet('ai_cache', {}) || {};
    const old = cache[ck];
    if (old && typeof old.s === 'number' && old.t && Date.now() - old.t < AI_CACHE_TTL) {
      return { score: old.s, reason: old.r || '' };
    }

    // 全局限速：两次调用间隔 ≥1000ms
    const gap = _aiLastAt + 1000 - Date.now();
    if (gap > 0) await sleep(gap);
    _aiLastAt = Date.now();

    const prompt = [
      '判断下列岗位与候选人简历的匹配程度，按运维/IT支持/AI工程方向评估。',
      '【简历】',
      RESUME_TEXT,
      '【岗位】' + title + ' @ ' + company,
      '【岗位描述】',
      (jd || '').slice(0, 1800),
      '只输出 JSON：{"score":0-100,"reason":"30字内","fit":true|false}',
    ].join('\n');

    const res = await _gmPost(cfg.aiBase.replace(/\/+$/, '') + '/chat/completions', {
      model: cfg.aiModel,
      temperature: 0,
      messages: [
        { role: 'system', content: '你是技术招聘匹配专家，只输出JSON' },
        { role: 'user', content: prompt },
      ],
    }, { Authorization: 'Bearer ' + key });
    if (!res) return null;

    try {
      let txt = (((res.choices || [])[0] || {}).message || {}).content || '';
      txt = String(txt).replace(/```json/gi, '').replace(/```/g, '').trim();
      const m = txt.match(/\{[\s\S]*\}/);
      if (!m) return null;
      const o = JSON.parse(m[0]);
      const score = Math.min(100, Math.max(0, Math.round(Number(o.score))));
      if (!isFinite(score)) return null;
      const reason = String(o.reason || '').replace(/\s+/g, ' ').slice(0, 30);

      // 写缓存：清理过期项；超过 500 条清空重建
      const now = Date.now();
      const next = {};
      for (const k of Object.keys(cache)) {
        const v = cache[k];
        if (v && v.t && now - v.t < AI_CACHE_TTL) next[k] = v;
      }
      next[ck] = { s: score, r: reason, t: now };
      const cnt = Object.keys(next).length;
      _gmSet('ai_cache', cnt > 500 ? { [ck]: next[ck] } : next);

      return { score, reason };
    } catch (e) {
      return null;
    }
  }

  /* ===== AI 异常裁判（异常时从有限动作集中选一个） ===== */
  const AI_ACTIONS = ['retry', 'scroll_bottom', 'scroll_top', 'close_dialog', 'search_again', 'abort'];
  let _aiDecideAt = 0;

  // 异常时让 AI 从有限动作集中选一个；返回动作名或 null
  async function aiDecide(situation, ctx) {
    const key = _gmGet('aiKey', '');
    if (!cfg.aiEnabled || !key) return null;
    if (Date.now() - _aiDecideAt < 4000) return null;
    _aiDecideAt = Date.now();
    const cards = [...document.querySelectorAll(SEL.card)];
    const brief = [
      'URL:' + location.href,
      '岗位卡片数:' + cards.length,
      '前3个岗位:' + cards.slice(0, 3).map((c) => (c.textContent || '').trim().slice(0, 30)).join(' / '),
      '已投递:' + sent + '/' + cfg.max,
      '页面文本片段:' + (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 500),
    ].join('\n');
    const prompt = [
      '你是浏览器自动化流程的异常裁判。当前任务：在BOSS直聘搜索目标职位并逐个点击"立即沟通"。',
      '【异常】' + situation,
      '【上下文】' + JSON.stringify(ctx || {}),
      '【页面状态】', brief,
      '【可选动作】retry=原地重试; scroll_bottom=滚动列表到底部; scroll_top=回到顶部; close_dialog=关闭弹窗; search_again=重新搜索; abort=立即停止',
      '只输出 JSON：{"action":"上面之一","reason":"20字内"}',
    ].join('\n');
    const res = await _gmPost(cfg.aiBase.replace(/\/+$/, '') + '/chat/completions', {
      model: cfg.aiModel, temperature: 0,
      messages: [{ role: 'system', content: '你是自动化异常裁判，只输出JSON' }, { role: 'user', content: prompt }],
    }, { Authorization: 'Bearer ' + key });
    if (!res) return null;
    try {
      let txt = (((res.choices || [])[0] || {}).message || {}).content || '';
      txt = String(txt).replace(/```json/gi, '').replace(/```/g, '');
      const m = txt.match(/\{[\s\S]*\}/);
      if (!m) return null;
      const o = JSON.parse(m[0]);
      const act = String(o.action || '').trim();
      if (!AI_ACTIONS.includes(act)) return null;
      log(`AI决策:${act}(${String(o.reason || '').slice(0, 24)})`);
      return act;
    } catch (e) { return null; }
  }

  // 执行 AI 给出的动作；返回 false 表示应当终止
  async function applyAiAction(act) {
    if (act === 'abort') { running = false; log('AI 判定应停止'); return false; }
    if (act === 'close_dialog') return await closeDialog();
    if (act === 'scroll_bottom') { await loadMore(); return true; }
    if (act === 'scroll_top') { window.scrollTo({ top: 0, behavior: 'smooth' }); await sleep(rand(800, 1200)); return true; }
    if (act === 'retry' || act === 'search_again') { await sleep(rand(1500, 2500)); return true; }
    return true;
  }

  /* ===================== 配置 ===================== */
  const DEFAULTS = {
    keywords: '运维工程师\n桌面运维\nIT支持',  // 每行一个职位关键词，按顺序搜索
    include: '',          // 职位名必须包含其一(逗号分隔,留空不限)
    exclude: '外包,销售,实习', // 职位名含其一则跳过
    excludeCompany: '',   // 公司名含其一则跳过
    minScore: 45,   // 岗位匹配度阈值(低于此分跳过)
    max: 50,              // 本次最多投递数量
    minDelay: 8,          // 每次投递最小间隔(秒)
    maxDelay: 20,         // 每次投递最大间隔(秒)
    maxFail: 3,           // 连续失败N条即熔断停止
    cooldownMin: 30,      // 熔断后冷却(分钟)
    aiEnabled: false, aiBase: 'https://api.deepseek.com/v1', aiModel: 'deepseek-chat', aiThreshold: 60,
  };
  const cfg = Object.assign({}, DEFAULTS, _gmGet('cfg', {}));

  // 选择器集中放这里,BOSS 改版后只需改这里
  const SEL = {
    card: '.job-card-wrapper, .job-card-box, li.job-card-wrapper',
    cardTitle: '.job-name, .job-title',
    cardCompany: '.company-name, .boss-name',
    detail: '.job-detail-box, .job-detail',
    detailBox: '#job-detail, .job-detail-box, .job-detail-container, .job-detail, .job-detail-wrap',
    chatBtn: '.job-detail-box .btn-startchat, .job-detail-box .op-btn-chat, .job-detail .btn-startchat',
    nextPage: '.options-pages a.next, .options-pages .next',
    dialog: '.dialog-container, .greet-boss-dialog',
    jdText: '.job-sec-text, .job-detail-section .text, .job-detail .job-sec-text, .job-detail-box .job-sec-text',
  };

  /* ===================== 工具函数 ===================== */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => a + Math.random() * (b - a);
  const list = (s) => s.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);

  async function waitFor(fn, timeout = 5000, step = 150) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const v = fn();
      if (v) return v;
      await sleep(step);
    }
    return null;
  }

  /* ===================== 风控检测与熔断机制 ===================== */
  const RISK = {
    url: /\/web\/user\/(\?|$)|safe\/verify|verify-slider|captcha|security-check|\/error/i,
    title: /安全验证|访问异常|异常访问|请稍候/,
    phrases: [
      '安全验证', '访问异常', '异常访问', '请完成验证', '拖动滑块', '拖动下方滑块', '点击验证',
      '账号异常', '账号存在异常', '暂时无法访问', '操作过于频繁', '访问过于频繁', '请稍后再试',
      '请先登录', '登录后查看', '登录已过期', '被限制', '达到上限', '明天再',
    ],
    overlay: '[class*="captcha"], [class*="geetest"], [class*="slider-verify"], [class*="verify-wrap"], [class*="verify-dialog"], iframe[src*="captcha"], iframe[src*="geetest"]',
  };

  function todayKey() { return new Date().toLocaleDateString(); }
  
  function getLock() {
    const l = _gmGet('bag_lock', null);
    return l && l.until > Date.now() ? l : null;
  }

  function visible(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function detectRisk() {
    if (RISK.url.test(location.pathname + location.search)) return '网址疑似验证/登录/错误页:' + location.pathname;
    if (RISK.title.test(document.title)) return '页面标题异常:' + document.title;
    let ov = null;
    try { ov = [...document.querySelectorAll(RISK.overlay)].find(visible); } catch (e) {}
    if (ov) return '检测到验证类弹窗或滑块控件';
    
    // 检查页面主体或弹窗中是否包含风控/频繁短语
    const bodyText = [...document.body.children].filter((c) => c !== panel).map(el => el.textContent || '').join('\n');
    const hit = RISK.phrases.find((p) => bodyText.includes(p));
    if (hit) return '页面出现风控/限制提示:' + hit;
    
    return '';
  }

  function trip(reason, silent) {
    running = false;
    _gmSet('bag_hb', 0);
    _gmSet('bag_lock', { until: Date.now() + cfg.cooldownMin * 60000, reason, at: Date.now() });
    panel.style.borderColor = '#e55';
    log('⛔ 已自动停止:' + reason);
    log(`安全冷却 ${cfg.cooldownMin} 分钟。请先在页面手动完成验证/处理异常，不要立刻重试。`);
    updateStatus();
    $('bag-start').disabled = false;
    if (!silent) setTimeout(() => alert(`海投助手已安全熔断\n原因:${reason}\n已进入冷却期 ${cfg.cooldownMin} 分钟`), 50);
  }

  /* ===================== UI 界面 ===================== */
  _gmStyle(`
    #bag-panel{position:fixed;right:16px;bottom:16px;width:300px;z-index:99999;background:#fff;
      border:1px solid #00bebd;border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.18);
      font:12px/1.5 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#333}
    #bag-panel header{background:#00bebd;color:#fff;padding:6px 10px;border-radius:9px 9px 0 0;
      display:flex;justify-content:space-between;cursor:pointer;font-weight:600}
    #bag-body{padding:8px 10px}
    #bag-panel label{display:block;margin:4px 0 2px;color:#666}
    #bag-panel input{width:100%;box-sizing:border-box;padding:3px 6px;border:1px solid #ccc;border-radius:4px}
    #bag-panel textarea{width:100%;box-sizing:border-box;padding:3px 6px;border:1px solid #ccc;border-radius:4px;
      font:inherit;resize:vertical}
    #bag-panel .row{display:flex;gap:6px}
    #bag-panel button{flex:1;margin-top:8px;padding:5px;border:0;border-radius:4px;color:#fff;cursor:pointer}
    #bag-start{background:#00bebd}#bag-stop{background:#e55}#bag-unlock{background:#888}
    #bag-count{margin-top:6px;font-weight:600;color:#00bebd}
    #bag-log{margin-top:8px;height:120px;overflow:auto;background:#f6f6f6;border-radius:4px;padding:4px 6px;
      font-size:11px;white-space:pre-wrap}
  `);

  const panel = document.createElement('div');
  panel.id = 'bag-panel';
  panel.innerHTML = `
    <header><span>海投助手(安全增强版)</span><span id="bag-toggle">收起</span></header>
    <div id="bag-body">
      <label>职位关键词(每行一个，按顺序搜索)</label><textarea id="bag-keywords" rows="3"></textarea>
      <label>职位名包含(逗号分隔,留空不限)</label><input id="bag-include">
      <label>职位名排除</label><input id="bag-exclude">
      <label>公司名排除</label><input id="bag-excomp">
      <div class="row">
        <div><label>最大数量</label><input id="bag-max" type="number" min="1"></div>
        <div><label>间隔下限(s)</label><input id="bag-min" type="number" min="3"></div>
        <div><label>间隔上限(s)</label><input id="bag-maxd" type="number" min="3"></div>
      </div>
      <div class="row">
        <div><label>最低匹配度</label><input id="bag-minScore" type="number" min="1" max="100"></div>
      </div>
      <label style="display:flex;align-items:center;gap:6px;margin-top:8px;color:#333">
        <input id="bag-aiEnabled" type="checkbox" style="width:auto">启用AI匹配
      </label>
      <label>接口地址</label><input id="bag-aiBase">
      <div class="row">
        <div><label>模型名</label><input id="bag-aiModel"></div>
        <div><label>AI 匹配阈值</label><input id="bag-aiThreshold" type="number" min="1" max="100"></div>
      </div>
      <label>API Key（仅存本地）</label><input id="bag-aiKey" type="password" autocomplete="off">
      <div class="row">
        <button id="bag-start">开始投递</button>
        <button id="bag-stop">停止</button>
      </div>
      <div class="row">
        <button id="bag-unlock" style="background:#888; margin-top:4px;">解除冷却(已手动处理)</button>
      </div>
      <div class="row">
        <button id="bag-diag" style="background:#00bebd; margin-top:4px;">界面自检(不点也不改页面)</button>
      </div>
      <div id="bag-count"></div>
      <div id="bag-log"></div>
    </div>`;
  document.body.appendChild(panel);

  const $ = (id) => document.getElementById(id);
  $('bag-keywords').value = _gmGet('bag_cfg', cfg).keywords;
  $('bag-include').value = cfg.include;
  $('bag-exclude').value = cfg.exclude;
  $('bag-excomp').value = cfg.excludeCompany;
  $('bag-max').value = cfg.max;
  $('bag-min').value = cfg.minDelay;
  $('bag-maxd').value = cfg.maxDelay;
  $('bag-minScore').value = cfg.minScore;
  $('bag-aiEnabled').checked = !!cfg.aiEnabled;
  $('bag-aiBase').value = cfg.aiBase;
  $('bag-aiModel').value = cfg.aiModel;
  $('bag-aiThreshold').value = cfg.aiThreshold;
  $('bag-aiKey').value = _gmGet('aiKey', '');

  panel.querySelector('header').onclick = () => {
    const b = $('bag-body');
    const hide = b.style.display !== 'none';
    b.style.display = hide ? 'none' : '';
    $('bag-toggle').textContent = hide ? '展开' : '收起';
  };

  function updateStatus() {
    const l = getLock();
    $('bag-count').textContent = l 
      ? `⛔ 冷却中,剩余约${Math.ceil((l.until - Date.now()) / 60000)}分钟` 
      : `状态: 就绪`;
  }
  updateStatus();
  setInterval(updateStatus, 30000);

  function log(msg) {
    const box = $('bag-log');
    const t = new Date().toTimeString().slice(0, 8);
    box.textContent += `[${t}] ${msg}\n`;
    box.scrollTop = box.scrollHeight;
  }

  function readCfg() {
    cfg.keywords = $('bag-keywords').value;
    cfg.include = $('bag-include').value;
    cfg.exclude = $('bag-exclude').value;
    cfg.excludeCompany = $('bag-excomp').value;
    cfg.max = Math.max(1, +$('bag-max').value || DEFAULTS.max);
    cfg.minDelay = Math.max(3, +$('bag-min').value || DEFAULTS.minDelay);
    cfg.maxDelay = Math.max(cfg.minDelay, +$('bag-maxd').value || DEFAULTS.maxDelay);
    cfg.minScore = Math.min(100, Math.max(1, +$('bag-minScore').value || DEFAULTS.minScore));
    cfg.aiEnabled = !!$('bag-aiEnabled').checked;
    cfg.aiBase = $('bag-aiBase').value.trim() || DEFAULTS.aiBase;
    cfg.aiModel = $('bag-aiModel').value.trim() || DEFAULTS.aiModel;
    cfg.aiThreshold = Math.min(100, Math.max(1, +$('bag-aiThreshold').value || DEFAULTS.aiThreshold));
    _gmSet('aiKey', $('bag-aiKey').value.trim()); // Key 单独存储，不进 cfg
    _gmSet('cfg', cfg);
  }

  /* ===================== 核心逻辑 ===================== */
  let running = false;
  const seen = new Set();
  let sent = 0;

  function passFilter(title, company) {
    const inc = list(cfg.include);
    const exc = list(cfg.exclude);
    const exComp = list(cfg.excludeCompany);
    if (inc.length && !inc.some((k) => title.includes(k))) return '不含关键词';
    if (exc.some((k) => title.includes(k))) return '命中排除词';
    if (exComp.some((k) => company.includes(k))) return '公司被排除';
    return null;
  }

  // 寻找「留在此页 / 留在此界面」按钮（常见于"已向BOSS发送消息"提示弹窗）
  const STAY_TEXT = /^留在此(页面?|界面)?$/;

  function isShown(el) {
    return !!(el && el.getClientRects && el.getClientRects().length > 0);
  }

  function findStayBtn() {
    const norm = (s) => (s || '').replace(/\s+/g, '');
    const els = document.querySelectorAll('a,button,span,div,p,li,em,i,strong');
    for (const el of els) {
      if (!isShown(el)) continue;
      const t = norm(el.textContent);
      if (!t || t.length > 12) continue; // 按钮文案很短，避免命中整块容器
      if (STAY_TEXT.test(t)) {
        const inner = [...el.querySelectorAll('*')].find((c) => isShown(c) && STAY_TEXT.test(norm(c.textContent)));
        return inner || el;
      }
    }
    return null;
  }

  function clickStay(btn) {
    ['mousedown', 'mouseup', 'click'].forEach((type) =>
      btn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }))
    );
  }

  // 按文案找按钮：忽略空白、限制字数、校验可见与尺寸
  function btnByText(root, re) {
    return [...root.querySelectorAll('a, button, span, div')].find((el) => {
      if (!visible(el)) return false;
      const t = (el.textContent || '').replace(/\s+/g, '');
      if (t.length > 8 || !re.test(t)) return false;
      const r = el.getBoundingClientRect();
      return r.width > 30 && r.height > 20;
    }) || null;
  }

  // 打开岗位详情：先点标题，再兜底整卡点击
  async function openDetail(card) {
    const hasJd = () => [...document.querySelectorAll(SEL.jdText)]
      .some((el) => visible(el) && (el.textContent || '').trim().length > 30);
    card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await sleep(rand(400, 700));
    const titleEl = card.querySelector(SEL.cardTitle);
    (titleEl || card).click();
    await sleep(rand(700, 1100));
    if (await waitFor(hasJd, 2200, 150)) return true;
    card.click();
    await sleep(rand(600, 900));
    if (await waitFor(hasJd, 2500, 150)) return true;
    return false;
  }

  // 找「立即沟通」按钮：详情容器 → 整页 → 当前卡片内，共三级兜底
  function findChatBtn(card) {
    const boxes = [...document.querySelectorAll(SEL.detailBox)].filter(visible);
    for (const b of boxes) {
      const el = b.querySelector(SEL.chatBtn) || btnByText(b, /^立即沟通$/);
      if (el) return el;
    }
    const loose = btnByText(document.body, /^立即沟通$/);
    if (loose && !loose.closest(SEL.card)) return loose;
    if (card) {
      const inCard = card.querySelector(SEL.chatBtn) || btnByText(card, /^立即沟通$/);
      if (inCard) return inCard;
    }
    return null;
  }

  function anyDialog() {
    return [...document.querySelectorAll(SEL.dialog)].find(isShown) || null;
  }

  async function waitDialogGone(timeout) {
    return await waitFor(() => !anyDialog(), timeout, 120);
  }

  // 点「留在此页」关掉弹窗；true=已清空，false=关不掉
  async function closeDialog() {
    for (let i = 0; i < 3; i++) {
      const btn = await waitFor(findStayBtn, 2500, 100);
      if (btn) {
        clickStay(btn);
        log('已点击"留在此页"');
        await sleep(rand(400, 700));
        if (await waitDialogGone(1500)) return true;
        continue;
      }
      const close = document.querySelector(`${SEL.dialog} .close, ${SEL.dialog} .icon-close, ${SEL.dialog} .cancel-btn`);
      if (close) {
        close.click();
        log('未找到"留在此页",已点关闭按钮');
        await sleep(rand(400, 700));
        if (await waitDialogGone(1200)) return true;
        continue;
      }
      const r = detectRisk();
      if (r) { trip(r); return false; }
      break;
    }
    // 兜底：Esc 关闭遮罩
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, which: 27, bubbles: true }));
    await sleep(500);
    if (await waitDialogGone(1200)) return true;
    log('⚠ 弹窗无法关闭，为避免误点已终止');
    return false;
  }

  // 进入下一个岗位前清场：有弹窗就关，没有直接返回
  async function ensureClear() {
    if (!anyDialog()) return true;
    return await closeDialog();
  }

  /* ===== 发送简历附件 ===== */
  const RESUME_BTN_TEXT = /^(发送简历|发简历|附件简历|发送附件简历|简历附件)$/;

  function findResumeBtn(scope) {
    const root = scope || document;
    const els = root.querySelectorAll('a,button,span,div,li,i');
    for (const el of els) {
      if (el.offsetParent === null) continue;
      if (RESUME_BTN_TEXT.test((el.textContent || '').trim())) {
        const inner = [...el.querySelectorAll('*')].find((c) => RESUME_BTN_TEXT.test((c.textContent || '').trim()));
        return inner || el;
      }
    }
    return null;
  }

  function findConfirmBtn() {
    const dlg = document.querySelector('.dialog-container, .greet-boss-dialog, [class*="dialog"]');
    if (!dlg) return null;
    return [...dlg.querySelectorAll('a,button,span,div')].find(
      (el) => el.offsetParent !== null && /^(发送|确定|确认发送)$/.test((el.textContent || '').trim())
    );
  }

  async function sendResumeAttachment() {
    const chat = await waitFor(
      () => document.querySelector('.chat-container, .chat-content, .message-container, .chat-panel, [class*="chat-"]'),
      3000, 150
    );
    const btn = await waitFor(() => findResumeBtn(chat || document), 2500, 150);
    if (!btn) {
      log('未找到"发送简历"入口，跳过附件发送');
      return false;
    }
    btn.click();
    await sleep(rand(600, 1000));
    const ok = findConfirmBtn();
    if (ok) {
      ok.click();
      await sleep(rand(400, 700));
    }
    log('✔ 已发送简历附件');
    return true;
  }

  // 突变监听：发现阻断弹窗自动点留在此页
  let lastStayClick = 0;
  new MutationObserver(() => {
    if (!running) return;
    if (Date.now() - lastStayClick < 1500) return;
    const btn = findStayBtn();
    if (btn) {
      lastStayClick = Date.now();
      setTimeout(() => clickStay(btn), 200);
    }
  }).observe(document.body, { childList: true, subtree: true });

  async function processCard(card) {
    const title = (card.querySelector(SEL.cardTitle)?.textContent || '').trim();
    const company = (card.querySelector(SEL.cardCompany)?.textContent || '').trim();

    const reason = passFilter(title, company);
    if (reason) {
      log(`跳过:${title} @ ${company}(${reason})`);
      return 'skip';
    }

    // 每次点击前先过一遍风控检测
    const r = detectRisk();
    if (r) {
      trip(r);
      return 'halt';
    }

    const opened = await openDetail(card);
    const jdEl = opened
      ? [...document.querySelectorAll(SEL.jdText)].find((el) => visible(el) && (el.textContent || '').trim().length > 30) || null
      : null;
    if (!jdEl) log(`未读到JD，改按标题与卡片标签打分:${title}`);

    const jobText = `${title} ${card.textContent || ''} ${jdEl ? jdEl.textContent : ''}`;

    // 硬性排除：命中即跳过（先于任何打分）
    const hit = HARD_BLOCK.find((k) => (title + company + (jdEl ? jdEl.textContent : '')).includes(k));
    if (hit) {
      log('跳过(硬性排除:' + hit + '):' + title + ' @ ' + company);
      return 'skip';
    }

    let score = null, hits = [], why = '';
    if (cfg.aiEnabled) {
      const ai = await aiScore(title, company, jdEl ? jdEl.textContent : '');
      if (ai) { score = ai.score; why = ai.reason; }
      else log('AI 调用失败，回退本地匹配');
    }
    if (score == null) { const r = scoreJob(jobText, title); score = r.score; hits = r.hits; }
    const threshold = cfg.aiEnabled ? Number(cfg.aiThreshold || 60) : Number(cfg.minScore || 45);
    if (score < threshold) { log(`跳过(匹配度${score}<${threshold})${why ? ' AI:' + why : ''}:${title} @ ${company}`); return 'skip'; }
    log(`匹配度${score}${why ? '(AI:' + why + ')' : '(命中:' + (hits.slice(0, 6).join('/') || '无') + ')'}:${title} @ ${company}`);

    const btn = await waitFor(() => findChatBtn(card), 4000);
    if (!btn) {
      log(`未找到沟通按钮:${title}｜详情面板${opened ? '已打开' : '未打开'}`);
      return 'fail';
    }
    const text = btn.textContent.trim();
    if (!/立即沟通/.test(text)) {
      log(`已沟通过,跳过:${title} @ ${company}`);
      return 'skip';
    }

    log(`点击沟通按钮:"${btn.textContent.trim()}"(${btn.className || btn.tagName})`);
    btn.click();
    // 等「留在此页」弹窗出现（最多 4 秒），出现后立即处理
    await waitFor(anyDialog, 4000, 120);

    // 投递后再次严格检测是否触发风控限制
    const riskAfter = detectRisk();
    if (riskAfter) {
      trip('投递后触发限制或风控: ' + riskAfter);
      return 'halt';
    }

    if (!(await closeDialog())) return 'halt';
    await sleep(rand(600, 1000));
    const resumeSent = await sendResumeAttachment();
    sent++;
    log(`✔ 已投递(${sent}/${cfg.max}):${title} @ ${company}${resumeSent ? '｜含简历附件' : ''}`);
    return 'ok';
  }

  /* ===== 关键词搜索（多关键词队列用） ===== */
  const SEARCH_SEL = 'input[placeholder*="搜索"], input[placeholder*="职位"], .search-input input, .job-search-form input, input[name="query"]';

  function firstCardKey() {
    const c = document.querySelector(SEL.card);
    if (!c) return '';
    const a = c.querySelector('a[href*="/job_detail/"]');
    return (a ? a.getAttribute('href') : '') + '|' + (c.querySelector(SEL.cardTitle)?.textContent || '').trim();
  }

  // 在搜索框输入关键词并回车，等待列表刷新
  async function doSearch(kw) {
    const box = await waitFor(() => [...document.querySelectorAll(SEARCH_SEL)].find(visible), 8000, 200);
    if (!box) { log('未找到搜索框'); return false; }
    box.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(box, kw);
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(rand(300, 600));
    for (const t of ['keydown', 'keyup']) {
      box.dispatchEvent(new KeyboardEvent(t, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    }
    const before = firstCardKey();
    const changed = await waitFor(() => { const k = firstCardKey(); return k && k !== before; }, 12000, 300);
    await sleep(rand(1200, 2000));
    log(changed ? `已搜索「${kw}」` : `未检测到列表刷新:「${kw}」`);
    return true;
  }

  // 卡片去重键（DOM 节点会重渲染，用字符串键）
  function cardKey(card) {
    const a = card.querySelector('a[href*="/job_detail/"]');
    const href = a ? a.getAttribute('href') : '';
    const t = (card.querySelector(SEL.cardTitle)?.textContent || '').trim();
    const c = (card.querySelector(SEL.cardCompany)?.textContent || '').trim();
    return href || (t + '|' + c);
  }

  async function loadMore() {
    const before = document.querySelectorAll(SEL.card).length;
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    const listEl = document.querySelector(SEL.card)?.closest('.job-list-box, .job-list-container, .job-list') || document.querySelector(SEL.card)?.parentElement;
    if (listEl) listEl.scrollTop = listEl.scrollHeight;
    await sleep(rand(1500, 2500));
    if (document.querySelectorAll(SEL.card).length > before) return true;

    const next = document.querySelector(SEL.nextPage);
    if (next && !/disabled/.test(next.className)) {
      log('翻到下一页…');
      next.click();
      await sleep(rand(2500, 3500));
      return true;
    }
    return false;
  }

  // 界面自检：只读取 DOM，不点击、不修改页面，把结果打到自己面板的日志区
  function runDiag() {
    const q = (s) => [...document.querySelectorAll(s)];
    const vis = (e) => !!e.getClientRects().length;
    log('===== 界面自检开始 =====');
    Object.keys(SEL).forEach((k) => {
      const els = q(SEL[k]);
      log(`自检:${k} = ${els.length} (可见 ${els.filter(vis).length})`);
    });
    const btns = [...document.querySelectorAll('a,button,span,div')]
      .filter((e) => vis(e) && /^立即沟通$/.test((e.textContent || '').replace(/\s+/g, '')));
    log(`自检:文案=立即沟通 的元素 ${btns.length} 个`);
    btns.slice(0, 5).forEach((e, i) => {
      const cls = String(e.className || '').trim().slice(0, 40);
      log(`自检:[${i}] <${e.tagName.toLowerCase()} class="${cls}"> 在卡片内=${!!e.closest(SEL.card)}`);
    });
    const bodyText = document.body.innerText || '';
    log(`自检:页面含"留在此页" = ${/留在此页/.test(bodyText)}`);
    log(`自检:页面含"验证/滑块/频繁" = ${/验证|滑块|过于频繁/.test(bodyText)}`);
    log(`自检:当前URL = ${location.href.slice(0, 80)}`);
    const blocked = /^立即沟通$/.test(bodyText.slice(0, 3));
    log(`自检:AI已启用 = ${cfg.aiEnabled}, Key已填 = ${!!_gmGet('aiKey', '')}`);
    if (blocked) log('自检:警告-页面疑似异常');
    log('===== 界面自检结束 =====');
  }

  // 单个关键词：从第一张卡到最后一张，滚动加载直到无新增
  async function runKeyword(kw) {
    let idx = 0, emptyRounds = 0, failStreak = 0, aiTries = 0;
    while (running) {
      _gmSet('bag_hb', Date.now());

      const r = detectRisk();
      if (r) { trip(r); return; }
      if (sent >= cfg.max) return;

      let cards = [...document.querySelectorAll(SEL.card)];
      if (!cards.length) {
        if (aiTries < 2) {
          aiTries++;
          const act = await aiDecide('列表没有岗位卡片', { kw, idx });
          if (act && !(await applyAiAction(act))) return;
        }
        if (++emptyRounds >= 3) { log(`「${kw}」列表为空，跳过`); return; }
        await sleep(2000);
        continue;
      }
      emptyRounds = 0;

      if (idx >= cards.length) {
        const more = await loadMore();
        if (!more) {
          const act = aiTries < 3 ? (aiTries++, await aiDecide('滚动加载后没有新岗位', { kw, idx })) : null;
          if (act === 'abort') { running = false; return; }
          if (act === 'search_again') return;
          if (act === 'scroll_bottom') { await loadMore(); continue; }
          if (++emptyRounds >= 2) { log(`「${kw}」已无新岗位，共 ${idx} 个`); return; }
          await sleep(1500);
          continue;
        }
        emptyRounds = 0;
        continue;
      }

      const card = cards[idx];
      idx++;
      const ck = cardKey(card);
      if (seen.has(ck)) continue;
      seen.add(ck);

      if (!(await ensureClear())) return;

      let st = 'skip';
      try { st = await processCard(card); }
      catch (e) { log('出错:' + e.message); st = 'fail'; }

      if (st === 'halt') return;
      if (st === 'ok') {
        failStreak = 0;
        await sleep(rand(cfg.minDelay, cfg.maxDelay) * 1000);
      } else if (st === 'fail') {
        if (++failStreak >= cfg.maxFail) {
          const act = await aiDecide('连续失败', { kw, failStreak });
          if (act && !(await applyAiAction(act))) return;
          if (failStreak >= cfg.maxFail + 2) { trip(`连续失败 ${failStreak} 次，触发熔断保护机制`); return; }
        }
        await sleep(rand(2000, 3000));
      }
    }
  }

  async function run() {
    readCfg();
    const lock = getLock();
    if (lock) {
      log(`⛔ 安全冷却中,剩余约${Math.ceil((lock.until - Date.now()) / 60000)}分钟。原因:${lock.reason}`);
      return;
    }
    const risk0 = detectRisk();
    if (risk0) { trip(risk0); return; }

    const kws = String(cfg.keywords || '').split(/\r?\n|,|，/).map((s) => s.trim()).filter(Boolean);
    if (!kws.length) { log('请先填写职位关键词'); return; }

    running = true;
    sent = 0;
    seen.clear();
    $('bag-start').disabled = true;
    panel.style.borderColor = '#00bebd';
    log(`开始运行：${kws.length} 个关键词，上限 ${cfg.max} 个投递`);

    for (let i = 0; i < kws.length && running && sent < cfg.max; i++) {
      const kw = kws[i];
      log(`=== (${i + 1}/${kws.length}) 搜索「${kw}」 ===`);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      await sleep(rand(600, 1000));

      let okSearch = await doSearch(kw);
      if (!okSearch) {
        const act = await aiDecide('找不到搜索框', { kw });
        if (act === 'abort') break;
        if (act === 'close_dialog') await closeDialog();
        if (act === 'scroll_top') window.scrollTo({ top: 0, behavior: 'smooth' });
        await sleep(rand(1500, 2500));
        okSearch = await doSearch(kw);
        if (!okSearch) { log('搜索失败，程序停止'); break; }
      }

      await runKeyword(kw);
      if (!running) break;
      log(`「${kw}」处理完成，累计投递 ${sent} 个`);
    }

    running = false;
    _gmSet('bag_hb', 0);
    $('bag-start').disabled = false;
    log(`结束，本次共投递 ${sent} 个`);
  }

  /* ===================== 按钮绑定 ===================== */
  $('bag-start').onclick = () => !running && run();
  $('bag-stop').onclick = () => {
    if (running) log('正在手动停止…');
    running = false;
  };
  $('bag-diag').onclick = () => runDiag();
  $('bag-unlock').onclick = () => {
    const l = _gmGet('bag_lock', null);
    if (!l || l.until <= Date.now()) return log('当前没有处于冷却中');
    if (!confirm(`上次熔断原因:${l.reason}\n请确认已在页面手动完成验证/处理，确定解除冷却吗？`)) return;
    _gmSet('bag_lock', null);
    panel.style.borderColor = '#00bebd';
    updateStatus();
    log('已手动解除冷却');
  };

  // 启动时自检
  setTimeout(() => {
    const l = getLock();
    if (l) {
      panel.style.borderColor = '#e55';
      log(`⛔ 安全冷却中(原因:${l.reason}),剩余约${Math.ceil((l.until - Date.now()) / 60000)}分钟`);
    }
  }, 2000);
})();