// ==UserScript==
// @name         BOSS直聘 自动打招呼(海投助手安全增强版)
// @namespace    https://github.com/tiantongss/boss-zhipin-userscript
// @version      3.7.0
// @description  模块化架构:任务状态机+页面识别+分级定位+执行/验证分离+统一action诊断日志+IndexedDB岗位库。逐个点击"立即沟通",关键词过滤、随机间隔、熔断冷却、弹窗自动处理;按简历匹配度过滤,AI语义打分;关键词队列循环搜索;合成点击无效时升级系统级真实点击(需本地服务)
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
// @connect      127.0.0.1
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
  const _gmPost = (url, data, headers, timeoutMs) => new Promise((resolve) => {
    const body = JSON.stringify(data);
    const done = (txt, err) => { if (err) resolve(null); else { try { resolve(JSON.parse(txt)); } catch (e) { resolve(null); } } };
    if (typeof GM_xmlhttpRequest === 'function') {
      GM_xmlhttpRequest({
        method: 'POST', url, headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}), data: body,
        timeout: timeoutMs || 20000,
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

  console.log('[%s] 脚本已加载 v3.7.0 (进度记忆+每词配额+轮巡)', 'BOSS海投助手');
  // 探测本地点击服务是否在线（系统级真实点击依赖它）
  _gmPost('http://127.0.0.1:8901/ping', {}, {}).then((r) =>
    console.log('[BOSS海投助手] 本地点击服务:%s', r && r.ok ? '在线(系统级点击可用)' : '离线(仅合成点击)')
  );

  /* ===================== 工具函数 ===================== */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => a + Math.random() * (b - a);
  const list = (s) => s.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);

  async function waitFor(fn, timeout = 5000, step = 150) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      let v = null;
      try { v = fn(); } catch (e) { v = null; }
      if (v) return v;
      await sleep(step);
    }
    return null;
  }

  /* ============================================================
   * 模块0：统一诊断日志（P0）
   * 每次操作分配唯一 action_id，结构化记录：操作类型/元素/执行方式/前后状态/结果
   * 面板「导出诊断日志」可下载完整 JSON，交给 AI 即可定位问题环节
   * ============================================================ */
  const Logger = (() => {
    const MAX = 3000;
    const buf = [];
    let taskId = null, seq = 0;
    function push(type, msg, data) {
      seq++;
      const e = Object.assign({
        task_id: taskId || '-',
        action_id: (taskId || 'BOOT') + '-' + String(seq).padStart(4, '0'),
        ts: new Date().toISOString(),
        type,
        msg,
        url: location.href,
      }, data || {});
      buf.push(e);
      if (buf.length > MAX) buf.splice(0, buf.length - MAX);
      return e;
    }
    function newTask(meta) {
      taskId = 'T' + Date.now().toString(36).toUpperCase();
      seq = 0;
      push('TASK_START', '任务开始', meta || {});
    }
    function endTask(result, meta) {
      if (!taskId) return;
      push('TASK_END', '任务结束:' + result, Object.assign({ result }, meta || {}));
      // 落盘最近 300 条,页面崩溃/跳转后仍可找回
      try { _gmSet('last_log', buf.slice(-300)); } catch (e) {}
    }
    function exportFile() {
      const data = buf.length ? buf : (_gmGet('last_log', []) || []);
      const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'boss-helper-log-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      return data.length;
    }
    return { push, newTask, endTask, exportFile, size: () => buf.length };
  })();

  // 结构化日志 + 面板人类可读日志（log 在 UI 区定义,函数声明提升,运行时才调用,安全）
  function alog(type, msg, data) {
    Logger.push(type, msg, data);
    log(msg);
  }

  /* ============================================================
   * 模块1：任务控制中心（状态机）
   * IDLE/RUNNING/PAUSED/WAITING/NEEDS_HUMAN/FAILED/COMPLETED/STOPPED
   * 暂停/停止通过 checkpoint() 在每个操作间隙真实生效
   * ============================================================ */
  const STATE_NAMES = {
    IDLE: '空闲', INITIALIZING: '初始化', RUNNING: '运行中', PAUSED: '已暂停',
    WAITING: '等待页面', NEEDS_HUMAN: '需人工处理', FAILED: '失败', COMPLETED: '完成', STOPPED: '已停止',
  };
  const Task = {
    state: 'IDLE',
    set(s, why) {
      if (this.state === s) return;
      const from = this.state;
      this.state = s;
      alog('STATE', `状态:${STATE_NAMES[from] || from} → ${STATE_NAMES[s] || s}${why ? '(' + why + ')' : ''}`, { from, to: s });
      try { updateStatus(); } catch (e) {}
    },
    // working: 任务未终结（含暂停,暂停时 checkpoint 会卡住等待）
    get working() { return this.state === 'RUNNING' || this.state === 'WAITING' || this.state === 'PAUSED'; },
    // active: 正在真正执行（暂停时不执行新操作）
    get active() { return this.state === 'RUNNING' || this.state === 'WAITING'; },
  };
  class StopError extends Error { constructor() { super('__STOP__'); this.name = 'StopError'; } }
  // 每个操作间隙调用:暂停时阻塞等待,停止/熔断时抛 StopError 终止任务
  async function checkpoint() {
    while (Task.state === 'PAUSED') await sleep(400);
    if (!Task.working) throw new StopError();
  }
  // 可中断长睡眠：每 400ms 醒一次响应暂停/停止
  async function pauseableSleep(ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      await sleep(400);
      await checkpoint();
    }
  }

  /* ===== 挂机模式:拟人行为模拟 ===== */
  // 每岗间隔:挂机模式用更长更分散的区间(配置在面板,默认30-75s)
  // 反爬策略:返回 {min,max,human};custom 取面板自定义参数。human=是否启用拟人轨迹(阅读滚动/点击犹豫/定时休息)
  function paceCfg() {
    const P = { slow: { min: 45, max: 120, human: true }, normal: { min: 20, max: 50, human: true }, fast: { min: 8, max: 20, human: false } }[cfg.pace];
    if (P) return P;
    const mn = Math.max(3, cfg.custMin || 15);
    return { min: mn, max: Math.max(mn, cfg.custMax || 45), human: !!cfg.custHuman };
  }
  const actDelayMs = () => cfg.stealth
    ? rand(cfg.stealthMin, cfg.stealthMax) * 1000
    : rand(cfg.minDelay, cfg.maxDelay) * 1000;

  // 执行时长控制(两种模式共用):run/runCollect 启动时打点,循环内检查
  let runStartedAt = 0;
  const timeUp = () => cfg.maxMin > 0 && Date.now() - runStartedAt > cfg.maxMin * 60000;

  /* ===== 执行进度持久化 =====
   * 记录关键词队列、当前词下标、每词已投/已跳、总投递数、轮次;
   * 手动停止后下次启动(关键词队列未变)自动从断点续跑 */
  const Progress = {
    data: null,
    load() { this.data = _gmGet('progress', null); return this.data; },
    reset(kws) {
      this.data = { kws: kws.join('|'), idx: 0, perKw: {}, totalSent: 0, round: 1, done: false, started: Date.now(), updated: Date.now() };
      this.save();
    },
    save() {
      if (!this.data) return;
      this.data.updated = Date.now();
      _gmSet('progress', this.data);
      try { renderProgress(); } catch (e) {}
    },
    kw(k) {
      if (!this.data.perKw[k]) this.data.perKw[k] = { sent: 0, skip: 0 };
      return this.data.perKw[k];
    },
    matches(kws) { return !!(this.data && this.data.kws === kws.join('|') && !this.data.done); },
  };
  function renderProgress() {
    const el = $('bag-progress');
    if (!el) return;
    const d = Progress.data;
    if (!d) { el.textContent = ''; return; }
    const kws = d.kws.split('|');
    const cur = kws[d.idx] || '-';
    const curSent = d.perKw[cur] ? d.perKw[cur].sent : 0;
    el.textContent = `进度:第${d.idx + 1}/${kws.length}词[${cur}] 本词已投${curSent}${cfg.perKwQuota ? '/' + cfg.perKwQuota : ''} | 总投${d.totalSent} | 第${d.round}轮${d.done ? '(已完成)' : '(未完成)'}`;
  }

  // 模拟真人阅读:随机小幅滚动页面与详情区+不规则停顿,偶发合成鼠标挪动(挂机模式或采集模式强制)
  async function simulateReading(force) {
    if (!cfg.stealth && !force) return;
    const rounds = 1 + Math.floor(Math.random() * 3); // 1-3 轮
    for (let i = 0; i < rounds; i++) {
      await pauseableSleep(rand(700, 2200));
      const dir = Math.random() < 0.7 ? 1 : -1; // 大部分向下,偶尔回滚
      const px = Math.round(rand(120, 480)) * dir;
      try {
        window.scrollBy({ top: px, behavior: 'smooth' });
        const box = document.querySelector(SEL.detailBox);
        if (box) box.scrollTop = Math.max(0, box.scrollTop + px);
      } catch (e) {}
      if (Math.random() < 0.5) {
        try {
          document.body.dispatchEvent(new MouseEvent('mousemove', {
            bubbles: true, clientX: Math.round(rand(200, 900)), clientY: Math.round(rand(200, 600)),
          }));
        } catch (e) {}
      }
    }
  }

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
    stealth: false,       // 挂机模式:低频+拟人行为(长间隔/随机阅读滚动/定时休息),降低风控命中
    stealthMin: 30,       // 挂机模式每岗间隔下限(秒)
    stealthMax: 75,       // 挂机模式每岗间隔上限(秒)
    exportPath: 'boss-jobs.csv', // 采集数据导出路径(经本地服务写入;相对路径存到脚本目录,可填绝对路径)
    collectSync: false,   // 投递时同步采集(全字段写库+逐条追加导出表格;采集与投递同频,共享同一随机节奏)
    pace: 'normal',       // 反爬策略:slow慢速/normal常规/fast快速/custom自定义(两种模式共用)
    custMin: 15, custMax: 45, custHuman: true, // 自定义策略:间隔区间+拟人轨迹
    maxMin: 0,            // 执行时长上限(分钟,0不限;两种模式共用)
    perKwQuota: 0,        // 每个关键词投递配额(0不限);达到后自动换下一个关键词
    loopRounds: false,    // 全部关键词跑完后,继续新一轮关键词循环
    maxFail: 3,           // 连续失败N条即熔断停止
    cooldownMin: 30,      // 熔断后冷却(分钟)
    aiEnabled: false, aiBase: 'https://api.deepseek.com/v1', aiModel: 'deepseek-chat', aiThreshold: 60,
    realClick: true,   // 合成点击无效时，升级系统级真实鼠标点击(需本地服务 127.0.0.1:8901)
  };
  const cfg = Object.assign({}, DEFAULTS, _gmGet('cfg', {}));

  // 选择器集中放这里,BOSS 改版后只需改这里
  const SEL = {
    card: '.job-card-wrapper, .job-card-box, li.job-card-wrapper',
    cardTitle: '.job-name, .job-title',
    cardCompany: '.company-name, .boss-name',
    detail: '.job-detail-box, .job-detail',
    detailBox: '#job-detail, .job-detail-box, .job-detail-container, .job-detail, .job-detail-wrap',
    chatBtn: '.job-detail-box .btn-startchat, .job-detail-box .op-btn-chat, .job-detail .btn-startchat, [ka*="job-detail-chat"], .job-detail-op .btn, .job-detail-container .btn-startchat, .job-detail-op .btn-startchat',
    nextPage: '.options-pages a.next, .options-pages .next',
    dialog: '.dialog-container, .greet-boss-dialog',
    jdText: '.job-sec-text, .job-detail-section .text, .job-detail .job-sec-text, .job-detail-box .job-sec-text, [class*="job-sec"] [class*="text"], .job-detail-content, .detail-content, [class*="job-description"]',
  };

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
      return { score: old.s, reason: old.r || '', fit: old.f !== false };
    }

    // 全局限速：两次调用间隔 ≥1000ms
    const gap = _aiLastAt + 1000 - Date.now();
    if (gap > 0) await sleep(gap);
    _aiLastAt = Date.now();

    const prompt = [
      '你是技术招聘匹配专家。判断下列岗位与候选人简历的匹配程度。',
      '评估重点:1)岗位职责是否在候选人能力范围内(IT运维/系统运维/桌面运维/网络/服务器/IDC/技术支持/AI工程);',
      '2)任职要求(学历/经验/技能)候选人是否基本满足;',
      '3)明显不相关的方向(销售/开发/设计/金融/行政等)直接判不匹配。',
      '评分标准:80-100=高度匹配;60-79=基本匹配可投递;40-59=部分匹配;0-39=不匹配。fit=是否值得投递。',
      '【简历】',
      RESUME_TEXT,
      '【岗位】' + title + ' @ ' + company,
      '【岗位描述】',
      (jd || '').slice(0, 1800),
      '只输出 JSON：{"score":0-100,"fit":true|false,"reason":"30字内"}',
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
      const fit = o.fit === false ? false : (o.fit === true ? true : score >= 60);

      // 写缓存：清理过期项；超过 500 条清空重建
      const now = Date.now();
      const next = {};
      for (const k of Object.keys(cache)) {
        const v = cache[k];
        if (v && v.t && now - v.t < AI_CACHE_TTL) next[k] = v;
      }
      next[ck] = { s: score, r: reason, f: fit, t: now };
      const cnt = Object.keys(next).length;
      _gmSet('ai_cache', cnt > 500 ? { [ck]: next[ck] } : next);

      return { score, reason, fit };
    } catch (e) {
      return null;
    }
  }

  /* ===== 挂机模式专用:深度 AI 评估(岗位职责+公司信息+行业前景) ===== */
  async function aiDeepEval(title, company, jd, companyInfo) {
    const key = _gmGet('aiKey', '');
    if (!key) return null;

    const ck = 'deep|' + title + '|' + company;
    const cache = _gmGet('ai_cache', {}) || {};
    const old = cache[ck];
    if (old && typeof old.s === 'number' && old.t && Date.now() - old.t < AI_CACHE_TTL) {
      return { score: old.s, reason: old.r || '', fit: old.f !== false, summary: old.e || '' };
    }

    // 全局限速：两次调用间隔 ≥1000ms
    const gap = _aiLastAt + 1000 - Date.now();
    if (gap > 0) await sleep(gap);
    _aiLastAt = Date.now();

    const prompt = [
      '你是资深职业规划师兼行业分析师。对下列岗位做深度评估，分两步:',
      '1)岗位匹配:职责是否在候选人能力范围内(IT运维/系统运维/桌面运维/网络/服务器/IDC/技术支持/AI工程)，任职要求(学历/经验/技能)是否基本满足;',
      '2)公司与行业:结合公司信息判断其所处行业的前景、业务可持续性，以及这份工作对候选人职业发展的价值。',
      '评分标准:80-100=高度匹配值得投递;60-79=基本匹配可投递;40-59=部分匹配;0-39=不匹配。fit=是否建议投递。',
      '【简历】',
      RESUME_TEXT,
      '【岗位】' + title + ' @ ' + company,
      '【公司信息】' + (companyInfo || '未获取到'),
      '【岗位描述】',
      (jd || '').slice(0, 1800),
      '只输出 JSON：{"score":0-100,"fit":true|false,"reason":"30字内","summary":"80字内,岗位匹配度+公司行业前景的综合评估"}',
    ].join('\n');

    const res = await _gmPost(cfg.aiBase.replace(/\/+$/, '') + '/chat/completions', {
      model: cfg.aiModel,
      temperature: 0,
      messages: [
        { role: 'system', content: '你是资深职业规划师兼行业分析师，只输出JSON' },
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
      const summary = String(o.summary || '').replace(/\s+/g, ' ').slice(0, 80);
      const fit = o.fit === false ? false : (o.fit === true ? true : score >= 60);

      const now = Date.now();
      const next = {};
      for (const k of Object.keys(cache)) {
        const v = cache[k];
        if (v && v.t && now - v.t < AI_CACHE_TTL) next[k] = v;
      }
      next[ck] = { s: score, r: reason, f: fit, e: summary, t: now };
      const cnt = Object.keys(next).length;
      _gmSet('ai_cache', cnt > 500 ? { [ck]: next[ck] } : next);

      return { score, reason, fit, summary };
    } catch (e) {
      return null;
    }
  }

  // 读取详情区的公司信息(行业/规模/融资阶段等),供深度评估使用
  function readCompanyInfo() {
    const sels = ['.company-info', '.job-detail-company', '.company-detail', '.detail-company', '[class*="company-info"]'];
    for (const s of sels) {
      const el = document.querySelector(s);
      if (el && el.getClientRects().length) {
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (t.length > 10) return t.slice(0, 300);
      }
    }
    return '';
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
    if (act === 'abort') { Task.set('STOPPED', 'AI判定停止'); return false; }
    if (act === 'close_dialog') return await closeDialog();
    if (act === 'scroll_bottom') { await loadMore(); return true; }
    if (act === 'scroll_top') { window.scrollTo({ top: 0, behavior: 'smooth' }); await sleep(rand(800, 1200)); return true; }
    if (act === 'retry' || act === 'search_again') { await sleep(rand(1500, 2500)); return true; }
    return true;
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

  // 模拟真实点击：滚动到可视区 + 完整鼠标事件序列，兼容 React 合成事件
  // 在元素自身、最近可点击祖先(a/button)、内部子元素三层同时派发，提高命中率
  function humanClick(el) {
    if (!el) return false;
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
    const r = el.getBoundingClientRect();
    // 注意:Firefox+Tampermonkey 沙箱中 view:window 会抛 "does not implement interface Window",不传 view
    const opt = {
      bubbles: true, cancelable: true, button: 0,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
    };
    const targets = [el];
    const link = el.closest('a,button,[role="button"]');
    if (link && link !== el && !targets.includes(link)) targets.push(link);
    const inner = el.querySelector('span,div,i,em');
    if (inner && !targets.includes(inner)) targets.push(inner);
    for (const t of targets) {
      try {
        t.dispatchEvent(new PointerEvent('pointerdown', opt));
        t.dispatchEvent(new MouseEvent('mousedown', opt));
        t.dispatchEvent(new PointerEvent('pointerup', opt));
        t.dispatchEvent(new MouseEvent('mouseup', opt));
        t.dispatchEvent(new MouseEvent('click', opt));
      } catch (e) {
        try { t.click(); } catch (e2) {}
      }
    }
    return true;
  }

  /* ===== 系统级真实点击：坐标发给本地服务，由 Windows 移动真实鼠标 ===== */
  // 把元素中心点的视口坐标换算成物理屏幕坐标（含浏览器窗口偏移与 DPI）
  function elScreenPos(el) {
    const r = el.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const sx = window.screenX + (window.outerWidth - window.innerWidth) / 2 + r.left + r.width / 2;
    const sy = window.screenY + (window.outerHeight - window.innerHeight) + r.top + r.height / 2;
    return { x: Math.round(sx * dpr), y: Math.round(sy * dpr) };
  }

  // 真实鼠标点击兜底：合成事件被页面忽略时使用。true=已派发
  // 坐标与窗口参数全部入日志,点没点准可以从导出日志直接核对
  async function sysClick(el, label) {
    if (!cfg.realClick || !el) return false;
    if (!document.hasFocus()) { log(`跳过系统点击[${label}]:浏览器窗口不在前台(需保持BOSS窗口可见)`); return false; }
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
    await sleep(350);
    const p = elScreenPos(el);
    alog('SYS_CLICK', `系统级点击[${label}] 屏幕坐标(${p.x},${p.y})`, {
      action_type: 'CLICK', target: label, execution_method: 'system', pos: p,
      win: { sx: window.screenX, sy: window.screenY, ow: window.outerWidth, oh: window.outerHeight, iw: window.innerWidth, ih: window.innerHeight, dpr: window.devicePixelRatio || 1 },
    });
    const res = await _gmPost('http://127.0.0.1:8901/click', p, {});
    if (res && res.ok) return true;
    log(`系统级点击失败[${label}]:本地服务未响应`);
    return false;
  }

  function detectRisk() {
    if (RISK.url.test(location.pathname + location.search)) return '网址疑似验证/登录/错误页:' + location.pathname;
    if (RISK.title.test(document.title)) return '页面标题异常:' + document.title;
    let ov = null;
    try { ov = [...document.querySelectorAll(RISK.overlay)].find(visible); } catch (e) {}
    if (ov) return '检测到验证类弹窗或滑块控件';

    // 短语扫描:排除岗位卡片与详情区——运维类 JD 常含"访问异常/故障/频繁"等词,扫全文会误报熔断
    // 只扫描通知/toast/标题等非岗位区域的可见文本
    const skipSel = SEL.card + ',' + SEL.detailBox;
    let pageText = '';
    try {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => {
          const p = n.parentElement;
          if (!p) return NodeFilter.FILTER_REJECT;
          if (p.closest('#bag-panel') || p.closest(skipSel)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      let node;
      while ((node = walker.nextNode())) pageText += (node.nodeValue || '') + '\n';
    } catch (e) {}
    const hit = RISK.phrases.find((p) => pageText.includes(p));
    if (hit) return '页面出现风控/限制提示:' + hit;

    return '';
  }

  function trip(reason, silent) {
    Task.set('NEEDS_HUMAN', reason);
    _gmSet('bag_hb', 0);
    _gmSet('bag_lock', { until: Date.now() + cfg.cooldownMin * 60000, reason, at: Date.now() });
    panel.style.borderColor = '#e55';
    log('⛔ 已自动停止:' + reason);
    log(`安全冷却 ${cfg.cooldownMin} 分钟。请先在页面手动完成验证/处理异常，不要立刻重试。`);
    updateStatus();
    $('bag-start').disabled = false;
    if (!silent) setTimeout(() => alert(`海投助手已安全熔断\n原因:${reason}\n已进入冷却期 ${cfg.cooldownMin} 分钟`), 50);
  }

  /* ============================================================
   * 模块2：页面识别（P1）
   * 先知道页面处于什么状态，再决定下一步做什么
   * ============================================================ */
  function detectPage() {
    if (RISK.url.test(location.pathname + location.search)) return { type: 'verify', detail: location.pathname };
    if (RISK.title.test(document.title)) return { type: 'verify', detail: document.title };
    let ov = null;
    try { ov = [...document.querySelectorAll(RISK.overlay)].find(visible); } catch (e) {}
    if (ov) return { type: 'captcha', detail: String(ov.className || ov.tagName).slice(0, 40) };
    const hasCard = !!document.querySelector(SEL.card);
    const bodyHead = (document.body.innerText || '').slice(0, 2000);
    if (!hasCard && /扫码登录|请先登录|登录后查看|登录已过期/.test(bodyHead)) return { type: 'login' };
    if (document.readyState !== 'complete') return { type: 'loading' };
    if (hasCard) return { type: 'list', detail: document.querySelectorAll(SEL.card).length + '张卡片' };
    if ([...document.querySelectorAll(SEL.detailBox)].some(visible)) return { type: 'detail' };
    return { type: 'unknown' };
  }

  /* ============================================================
   * 模块3：元素定位辅助（P2）
   * 定位后检查：存在/可见/禁用/遮挡/位置尺寸，全部入日志
   * ============================================================ */
  function elInfo(el) {
    const r = el.getBoundingClientRect();
    let occluded = false;
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (cx >= 0 && cy >= 0 && cx <= window.innerWidth && cy <= window.innerHeight) {
      const top = document.elementFromPoint(cx, cy);
      occluded = !!(top && top !== el && !el.contains(top) && !top.contains(el));
    }
    return {
      tag: el.tagName.toLowerCase(),
      cls: String(el.className || '').trim().slice(0, 50),
      text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24),
      rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      visible: el.getClientRects().length > 0,
      disabled: !!(el.disabled || el.getAttribute('aria-disabled') === 'true' || /disabled/.test(String(el.className || ''))),
      occluded,
    };
  }

  /* ============================================================
   * 模块4：交互执行 + 模块5：结果验证（P3）
   * 操作分两阶段：执行（合成点击→系统级点击兜底）与验证（DOM/弹窗/指纹变化）
   * 没有验证通过,一律记为失败,绝不把"点了"当"成了"
   * ============================================================ */
  async function doAction(opts) {
    const { name, find, verify, timeout = 4000, sys = true, verifyDesc = '' } = opts;
    const safeVerify = () => { try { return verify(); } catch (e) { return null; } };
    const urlBefore = location.href;

    // 定位（含短暂等待,元素可能是异步渲染的）
    const el = await waitFor(() => { const e = find(); return e && e.getClientRects && e.getClientRects().length ? e : null; }, 2500, 150);
    if (!el) {
      alog('ACTION_FAILED', `${name}:元素未找到`, { action_type: 'LOCATE', target: name, result: 'not_found' });
      return { ok: false, error: 'not_found' };
    }
    const info = elInfo(el);
    alog('ELEMENT_FOUND', `${name}:<${info.tag}>「${info.text}」可见=${info.visible} 遮挡=${info.occluded} 禁用=${info.disabled} rect=(${info.rect.x},${info.rect.y},${info.rect.w}x${info.rect.h})`,
      { action_type: 'LOCATE', target: name, element: info });
    if (info.disabled) {
      alog('ACTION_FAILED', `${name}:元素被禁用`, { action_type: 'CLICK', target: name, result: 'disabled', element: info });
      return { ok: false, error: 'disabled', el };
    }

    // 执行：先合成点击
    alog('CLICK_ATTEMPT', `${name}:合成点击`, { action_type: 'CLICK', target: name, execution_method: 'synthetic', url_before: urlBefore });
    humanClick(el);
    let ok = await waitFor(safeVerify, timeout, 150);
    let method = 'synthetic';

    // 第二档：原生 click()(部分处理器只挂 onclick)
    if (!ok) {
      alog('CLICK_ATTEMPT', `${name}:合成点击未通过验证,尝试原生click()`, { action_type: 'CLICK', target: name, execution_method: 'native' });
      try { el.click(); } catch (e) {}
      ok = await waitFor(safeVerify, Math.min(timeout, 2500), 150);
      if (ok) method = 'native';
    }

    // 第三档：系统级真实点击
    if (!ok && sys && cfg.realClick) {
      alog('CLICK_ATTEMPT', `${name}:升级系统级点击`, { action_type: 'CLICK', target: name, execution_method: 'system' });
      if (await sysClick(el, name)) {
        method = 'system';
        ok = await waitFor(safeVerify, timeout, 150);
      }
    }

    if (ok) {
      alog('ACTION_SUCCESS', `${name}:验证通过(${method}${verifyDesc ? ',' + verifyDesc : ''})`,
        { action_type: 'CLICK', target: name, execution_method: method, result: 'success', state_changed: true, url_after: location.href });
    } else {
      // 失败诊断：抓取浮层快照 + 成功提示词 + 焦点状态,导出日志即可定位卡在哪一环
      const diag = { overlays: dumpOverlays(), sent_hint: sentHint(), focus: document.hasFocus() };
      alog('ACTION_TIMEOUT', `${name}:执行后未检测到预期变化(${method}${diag.sent_hint ? ',但页面出现成功提示词' : ''})`,
        { action_type: 'CLICK', target: name, execution_method: method, result: 'timeout', state_changed: false, url_after: location.href, diag });
    }
    return { ok, el, method };
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
    #bag-panel button:disabled{opacity:.5;cursor:not-allowed}
    #bag-start{background:#00bebd}#bag-stop{background:#e55}#bag-unlock{background:#888}
    #bag-count{margin-top:6px;font-weight:600;color:#00bebd}
    #bag-log{margin-top:8px;height:120px;overflow:auto;background:#f6f6f6;border-radius:4px;padding:4px 6px;
      font-size:11px;white-space:pre-wrap}
  `);

  const panel = document.createElement('div');
  panel.id = 'bag-panel';
  panel.innerHTML = `
    <header><span>海投助手 v3.7.0(进度记忆)</span><span id="bag-toggle">收起</span></header>
    <div id="bag-body">
      <label>职位关键词(每行一个，按顺序搜索)</label><textarea id="bag-keywords" rows="3"></textarea>
      <label>职位名包含(逗号分隔,留空不限;AI模式下不生效)</label><input id="bag-include">
      <label>职位名排除</label><input id="bag-exclude">
      <label>公司名排除</label><input id="bag-excomp">
      <div class="row">
        <div><label>数量上限(0不限)</label><input id="bag-max" type="number" min="0"></div>
        <div><label>时长上限(分钟,0不限)</label><input id="bag-maxmin" type="number" min="0"></div>
        <div><label>每关键词配额(0不限)</label><input id="bag-perkw" type="number" min="0"></div>
      </div>
      <label style="display:flex;align-items:center;gap:6px;color:#333">
        <input id="bag-looprounds" type="checkbox" style="width:auto">全部关键词跑完后继续新一轮循环
      </label>
      <div class="row">
        <div><label>最低匹配度</label><input id="bag-minScore" type="number" min="1" max="100"></div>
      </div>
      <label>反爬策略(投递/采集共用;决定每岗间隔与拟人行为,遇风控/连续失败自动熔断停止)</label>
      <select id="bag-pace">
        <option value="slow">慢速随机(45-120s/岗,拟人轨迹,最稳)</option>
        <option value="normal">常规随机(20-50s/岗,拟人轨迹,推荐)</option>
        <option value="fast">快速随机(8-20s/岗,无拟人,风险高)</option>
        <option value="custom">自定义策略</option>
      </select>
      <div id="bag-pacecustom" style="display:none">
        <div class="row">
          <div><label>间隔最低(s)</label><input id="bag-custmin" type="number" min="3"></div>
          <div><label>间隔最长(s)</label><input id="bag-custmax" type="number" min="3"></div>
        </div>
        <label style="display:flex;align-items:center;gap:6px;color:#333">
          <input id="bag-custhuman" type="checkbox" style="width:auto">模拟真人轨迹(随机滚动阅读/点击前犹豫/定时休息)
        </label>
      </div>
      <label style="display:flex;align-items:center;gap:6px;margin-top:8px;color:#333">
        <input id="bag-aiEnabled" type="checkbox" style="width:auto">启用AI匹配
      </label>
      <label style="display:flex;align-items:center;gap:6px;margin-top:4px;color:#333">
        <input id="bag-realClick" type="checkbox" style="width:auto">系统级真实点击(合成点击无效时升级,需本地服务)
      </label>
      <label>接口地址</label><input id="bag-aiBase">
      <div class="row">
        <div><label>模型名</label><input id="bag-aiModel"></div>
        <div><label>AI 匹配阈值</label><input id="bag-aiThreshold" type="number" min="1" max="100"></div>
      </div>
      <label>API Key（仅存本地）</label><input id="bag-aiKey" type="password" autocomplete="off">
      <div class="row">
        <button id="bag-start">开始投递</button>
        <button id="bag-pause" style="background:#e8a33d">暂停</button>
        <button id="bag-stop">停止</button>
      </div>
      <div class="row">
        <button id="bag-collect" style="background:#2e8b57">开始采集(不投递)</button>
      </div>
      <label style="display:flex;align-items:center;gap:6px;color:#333">
        <input id="bag-collectsync" type="checkbox" style="width:auto">投递时同步采集(与投递同频,逐条写入导出表格)
      </label>
      <label>导出路径(经本地服务写入;可手输或点浏览图形化选择目录)</label>
      <div class="row">
        <input id="bag-exportpath" placeholder="如 boss-jobs.csv 或 D:\data\jobs.csv" style="flex:1">
        <button id="bag-browse" style="flex:0 0 auto">浏览…</button>
      </div>
      <div class="row">
        <button id="bag-unlock" style="background:#888; margin-top:4px;">解除冷却(已手动处理)</button>
      </div>
      <div class="row">
        <button id="bag-diag" style="background:#00bebd; margin-top:4px;">界面自检</button>
        <button id="bag-test" style="background:#e8a33d; margin-top:4px;">单卡闭环测试</button>
      </div>
      <div class="row">
        <button id="bag-exportlog" style="background:#36c; margin-top:4px;">导出诊断日志</button>
        <button id="bag-exportjobs" style="background:#36c; margin-top:4px;">导出岗位CSV</button>
        <button id="bag-resetprog" style="background:#888; margin-top:4px;">重置进度</button>
      </div>
      <div id="bag-count"></div>
      <div id="bag-progress" style="font-size:11px;color:#1a7f37;margin-top:2px"></div>
      <div id="bag-log"></div>
    </div>`;
  document.body.appendChild(panel);

  const $ = (id) => document.getElementById(id);
  $('bag-keywords').value = _gmGet('bag_cfg', cfg).keywords;
  $('bag-include').value = cfg.include;
  $('bag-exclude').value = cfg.exclude;
  $('bag-excomp').value = cfg.excludeCompany;
  $('bag-max').value = cfg.max;
  $('bag-maxmin').value = cfg.maxMin || 0;
  $('bag-perkw').value = cfg.perKwQuota || 0;
  $('bag-looprounds').checked = !!cfg.loopRounds;
  $('bag-pace').value = cfg.pace || 'normal';
  $('bag-custmin').value = cfg.custMin;
  $('bag-custmax').value = cfg.custMax;
  $('bag-custhuman').checked = cfg.custHuman !== false;
  $('bag-pacecustom').style.display = $('bag-pace').value === 'custom' ? 'block' : 'none';
  $('bag-pace').onchange = () => { $('bag-pacecustom').style.display = $('bag-pace').value === 'custom' ? 'block' : 'none'; };
  $('bag-exportpath').value = cfg.exportPath;
  $('bag-collectsync').checked = !!cfg.collectSync;
  $('bag-minScore').value = cfg.minScore;
  $('bag-aiEnabled').checked = !!cfg.aiEnabled;
  $('bag-realClick').checked = !!cfg.realClick;
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
    const pauseBtn = $('bag-pause');
    if (pauseBtn) {
      pauseBtn.textContent = Task.state === 'PAUSED' ? '继续' : '暂停';
      pauseBtn.disabled = !Task.working;
    }
    $('bag-count').textContent = l
      ? `⛔ 冷却中,剩余约${Math.ceil((l.until - Date.now()) / 60000)}分钟`
      : `状态:${STATE_NAMES[Task.state] || Task.state}｜日志 ${Logger.size()}条`;
  }
  updateStatus();
  setInterval(updateStatus, 30000);

  function log(msg) {
    const box = $('bag-log');
    if (!box) return;
    const t = new Date().toTimeString().slice(0, 8);
    box.textContent += `[${t}] ${msg}\n`;
    box.scrollTop = box.scrollHeight;
  }

  function readCfg() {
    cfg.keywords = $('bag-keywords').value;
    cfg.include = $('bag-include').value;
    cfg.exclude = $('bag-exclude').value;
    cfg.excludeCompany = $('bag-excomp').value;
    const _mv = $('bag-max').value.trim();
    cfg.max = _mv === '' ? DEFAULTS.max : Math.max(0, +_mv || 0); // 0=不限数量
    cfg.maxMin = Math.max(0, +$('bag-maxmin').value || 0);          // 0=不限时长
    cfg.perKwQuota = Math.max(0, +$('bag-perkw').value || 0);       // 每关键词配额,0=不限
    cfg.loopRounds = $('bag-looprounds').checked;                   // 跑完一轮后继续新一轮
    cfg.pace = $('bag-pace').value || 'normal';
    cfg.custMin = Math.max(3, +$('bag-custmin').value || DEFAULTS.custMin);
    cfg.custMax = Math.max(cfg.custMin, +$('bag-custmax').value || DEFAULTS.custMax);
    cfg.custHuman = $('bag-custhuman').checked;
    // 由反爬策略推导统一节奏参数,投递/采集共用同一套间隔与拟人行为(速率天然一致)
    const _p = paceCfg();
    cfg.stealth = _p.human;
    cfg.stealthMin = _p.min; cfg.stealthMax = _p.max;
    cfg.minDelay = _p.min; cfg.maxDelay = _p.max;
    cfg.exportPath = $('bag-exportpath').value.trim() || DEFAULTS.exportPath;
    cfg.collectSync = $('bag-collectsync').checked;
    cfg.minScore = Math.min(100, Math.max(1, +$('bag-minScore').value || DEFAULTS.minScore));
    cfg.aiEnabled = !!$('bag-aiEnabled').checked;
    cfg.realClick = !!$('bag-realClick').checked;
    cfg.aiBase = $('bag-aiBase').value.trim() || DEFAULTS.aiBase;
    cfg.aiModel = $('bag-aiModel').value.trim() || DEFAULTS.aiModel;
    cfg.aiThreshold = Math.min(100, Math.max(1, +$('bag-aiThreshold').value || DEFAULTS.aiThreshold));
    _gmSet('aiKey', $('bag-aiKey').value.trim()); // Key 单独存储，不进 cfg
    _gmSet('cfg', cfg);
  }

  /* ===================== 核心逻辑 ===================== */
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

  /* ============ AI 按钮定位 ============ */
  // 通用「AI 找按钮」引擎：常规选择器找不到时，把页面可见按钮提取成候选清单
  // 交给 AI 选序号，按序号直接操作真实 DOM 元素（AI 不生成选择器，杜绝瞎编）
  const AI_BTN_SELECTOR = 'a,button,div[role="button"],span[role="button"],input[type="button"],input[type="submit"],.btn,.op-btn,[class*="btn"],[class*="button"],[class*="chat"],[class*="send"],[class*="resume"]';
  const AI_BTN_MAX = 40;        // 候选上限，控制 token
  const AI_BTN_COOLDOWN = 4000; // 两次 AI 定位之间的最小间隔（单并发保护）

  let _aiBtnCache = {}; // key: 按钮类型+页面指纹 → {el, ts}
  let _aiBtnAt = 0;     // 限频时间戳

  // 各类按钮的识别提示词：告诉 AI 按什么特征挑
  const AI_BTN_HINTS = {
    chat: {
      label: '立即沟通',
      hint: '高亮/主色按钮，class常含 chat/op-btn/startchat，文字含"沟通"，通常 inDetail=true（右侧详情面板顶部）；排除"继续沟通"以外的非沟通按钮',
      keyword: '沟通',
    },
    stay: {
      label: '留在此页',
      hint: '出现在投递成功弹窗中，inDialog=true，文字含"留在此"；若文字被图标截断，可选弹窗内文字含"留"的小按钮',
      keyword: '留在此',
    },
    resume: {
      label: '发送简历',
      hint: '在聊天窗口工具区，文字含"简历"（如 发简历/发送简历/附件简历）；不是"求简历"也不是简历文件链接',
      keyword: '简历',
    },
    confirm: {
      label: '发送/确定',
      hint: '出现在简历发送确认弹窗中，inDialog=true，文字是 发送/确定/确认发送，是主按钮（通常高亮）',
      keyword: '',
    },
    close: {
      label: '关闭弹窗',
      hint: '弹窗右上角关闭按钮，inDialog=true，class常含 close/icon-close，文字可能是 × 或为空',
      keyword: '',
    },
  };

  // 提取页面可见按钮候选；每个候选自带 el 引用（不随 JSON 发给 AI，避免循环引用）
  function extractBtnCandidates() {
    const els = [...document.querySelectorAll(AI_BTN_SELECTOR)]
      .filter((el) => isShown(el))
      .map((el) => {
        const r = el.getBoundingClientRect();
        return {
          el,
          tag: el.tagName.toLowerCase(),
          class: String(el.className || '').trim().slice(0, 60),
          text: (el.textContent || '').replace(/\s+/g, '').slice(0, 20),
          role: el.getAttribute('role') || '',
          x: Math.round(r.left), y: Math.round(r.top),
          w: Math.round(r.width), h: Math.round(r.height),
          inDialog: !!el.closest(SEL.dialog),
          inDetail: !!el.closest(SEL.detailBox),
          inCard: !!el.closest(SEL.card),
        };
      })
      .filter((c) => c.text || /close|btn/.test(c.class)) // 保留有文字的 + 明显的按钮
      .slice(0, AI_BTN_MAX);
    els.forEach((c, i) => { c.idx = i; });
    return els;
  }

  // 把候选转成发给 AI 的纯文本（剥离 el，防止 JSON 循环引用）
  function candidatesToJson(candidates) {
    return JSON.stringify(
      candidates.map(({ el, ...rest }) => rest),
      null, 1
    );
  }

  // 让 AI 从候选中挑一个；返回 {cand, reason} 或 null
  async function aiPickBtn(type, candidates) {
    const hint = AI_BTN_HINTS[type];
    if (!hint || !cfg.aiEnabled) return null;
    const key = _gmGet('aiKey', '');
    if (!key) return null;
    if (Date.now() - _aiBtnAt < AI_BTN_COOLDOWN) return null;
    _aiBtnAt = Date.now();

    const prompt = [
      `你是网页UI元素识别助手。BOSS直聘页面，从候选元素列表中找出「${hint.label}」按钮。`,
      '',
      '【识别特征】' + hint.hint,
      '',
      '【候选元素】',
      candidatesToJson(candidates),
      '',
      '只输出 JSON：{"idx":候选序号, 找不到填-1, "reason":"20字内"}',
    ].join('\n');

    const res = await _gmPost(cfg.aiBase.replace(/\/+$/, '') + '/chat/completions', {
      model: cfg.aiModel, temperature: 0, max_tokens: 150,
      messages: [{ role: 'system', content: '你是UI元素识别助手，只输出JSON' }, { role: 'user', content: prompt }],
    }, { Authorization: 'Bearer ' + key });
    if (!res) return null;
    try {
      let txt = (((res.choices || [])[0] || {}).message || {}).content || '';
      txt = String(txt).replace(/```json/gi, '').replace(/```/g, '');
      const m = txt.match(/\{[\s\S]*\}/);
      if (!m) return null;
      const o = JSON.parse(m[0]);
      const idx = parseInt(o.idx, 10);
      if (isNaN(idx) || idx < 0 || idx >= candidates.length) return null;
      const cand = candidates[idx];
      // 安全校验：AI 选的元素文字与目标关键词毫无关联时拒绝（防止误点危险按钮）
      if (hint.keyword && cand.text && !cand.text.includes(hint.keyword)) {
        log(`AI找「${hint.label}」被安全拦截：候选[${idx}]文字"${cand.text.slice(0, 10)}"不含"${hint.keyword}"`);
        return null;
      }
      log(`AI找「${hint.label}」→候选[${idx}]<${cand.tag} class="${cand.class.slice(0, 30)}">"${cand.text.slice(0, 10)}" ${o.reason || ''}`);
      return cand;
    } catch (e) { return null; }
  }

  // 缓存键：按钮类型 + 详情区指纹（同结构页面不重复调 AI）
  function _btnCacheKey(type) {
    return type + '|' + detailFingerprint().slice(0, 40);
  }

  // 通用入口：先查缓存 → 提取候选 → AI 挑 → 缓存结果
  async function aiLocateButton(type) {
    const ck = _btnCacheKey(type);
    const hit = _aiBtnCache[ck];
    if (hit && Date.now() - hit.ts < 60000 && hit.el && isShown(hit.el)) {
      log(`AI按钮缓存命中:「${AI_BTN_HINTS[type].label}」`);
      return hit.el;
    }
    delete _aiBtnCache[ck];
    log(`常规选择器未命中「${AI_BTN_HINTS[type].label}」，尝试AI识别...`);
    const candidates = extractBtnCandidates();
    if (!candidates.length) { log('AI识别失败:页面无可见按钮候选'); return null; }
    const cand = await aiPickBtn(type, candidates);
    if (!cand) return null;
    if (type === 'chat') _aiBtnCache[ck] = { el: cand.el, ts: Date.now() }; // 只有立即沟通做缓存（结构稳定）
    return cand.el;
  }

  function clickStay(btn) {
    // Firefox+Tampermonkey 沙箱中 view:window 会抛错,不传 view;构造失败降级原生 click
    try {
      ['mousedown', 'mouseup', 'click'].forEach((type) =>
        btn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }))
      );
    } catch (e) {
      try { btn.click(); } catch (e2) {}
    }
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

  // 详情区指纹：标题 + JD 长度 + JD 前 30 字，用于判断详情是否真的切换了岗位
  function detailFingerprint() {
    let t = '';
    for (const b of document.querySelectorAll(SEL.detailBox)) {
      if (!visible(b)) continue;
      const el = b.querySelector(SEL.cardTitle);
      if (el && (el.textContent || '').trim()) { t = (el.textContent || '').trim(); break; }
    }
    const jd = [...document.querySelectorAll(SEL.jdText)]
      .filter(visible).map((e) => (e.textContent || '').trim()).join('');
    return `${t}|${jd.length}|${jd.slice(0, 30)}`;
  }

  // 读取 JD 文本:优先精确选择器;选择器失效时回退到可见详情容器整体文本
  function readJd() {
    const el = [...document.querySelectorAll(SEL.jdText)]
      .find((e) => visible(e) && (e.textContent || '').trim().length > 30);
    if (el) return (el.textContent || '').trim();
    const box = [...document.querySelectorAll(SEL.detailBox)].filter(visible)
      .sort((a, b) => (b.innerText || '').length - (a.innerText || '').length)[0];
    const t = box ? (box.innerText || '').trim() : '';
    return t.length > 80 ? t : '';
  }

  // 打开岗位详情：点标题后等「指纹变化」，避免读到上一个岗位残留的 JD
  async function openDetail(card) {
    const before = detailFingerprint();
    const hasJd = () => readJd().length > 30;
    const switched = () => hasJd() && detailFingerprint() !== before;

    card.scrollIntoView({ block: 'center' });
    await sleep(rand(250, 450));
    const titleEl = card.querySelector(SEL.cardTitle);
    humanClick(titleEl || card);
    if (await waitFor(switched, 2800, 150)) {
      alog('DETAIL_DETECTED', '详情区已切换(指纹变化)', { action_type: 'CLICK', target: '岗位卡片', result: 'success', state_changed: true });
      return true;
    }
    humanClick(card);
    if (await waitFor(switched, 2800, 150)) {
      alog('DETAIL_DETECTED', '详情区已切换(第二次点击)', { action_type: 'CLICK', target: '岗位卡片', result: 'success', state_changed: true });
      return true;
    }
    // 指纹没变但页面本来就有 JD（首个岗位默认已展开），也算可用
    const ok = hasJd();
    alog(ok ? 'DETAIL_DETECTED' : 'DETAIL_TIMEOUT',
      ok ? '详情区已有JD(首岗默认展开)' : '详情区已切换但未读到JD(选择器失效或JD未加载)',
      { action_type: 'CLICK', target: '岗位卡片', result: ok ? 'success' : 'timeout', state_changed: detailFingerprint() !== before });
    return ok;
  }

  // 找「立即沟通」按钮：详情容器 → 整页 → 当前卡片内，共三级兜底
  const CHAT_TEXT = /^(立即沟通|继续沟通|马上沟通|打招呼)$/;

  function findChatBtn(card) {
    const boxes = [...document.querySelectorAll(SEL.detailBox)].filter(visible);
    for (const b of boxes) {
      const el = b.querySelector(SEL.chatBtn) || btnByText(b, CHAT_TEXT);
      if (el) return el;
    }
    // 兜底:详情区内任何文字含"沟通"的可点元素
    for (const b of boxes) {
      const el = [...b.querySelectorAll('a,button,div,span')].find((e) => {
        if (!isShown(e)) return false;
        const t = (e.textContent || '').replace(/\s+/g, '');
        return t.length <= 10 && /沟通/.test(t) && (e.closest('a,button,[role="button"]') || /btn/i.test(String(e.className || '')));
      });
      if (el) return el.closest('a,button,[role="button"]') || el;
    }
    const loose = btnByText(document.body, CHAT_TEXT);
    if (loose && !loose.closest(SEL.card)) return loose;
    if (card) {
      const inCard = card.querySelector(SEL.chatBtn) || btnByText(card, CHAT_TEXT);
      if (inCard) return inCard;
    }
    return null;
  }

  // 找不到按钮时，把页面上疑似沟通类按钮的 class 打出来，方便定位改版
  function logChatCandidates() {
    const els = [...document.querySelectorAll('a,button,div,span')]
      .filter((e) => visible(e) && /沟通|打招呼/.test((e.textContent || '').trim().slice(0, 8)));
    if (!els.length) { log('候选:页面无任何"沟通"类按钮'); return; }
    const desc = els.slice(0, 6).map((e) => `<${e.tagName.toLowerCase()} class="${String(e.className || '').slice(0, 34)}">${(e.textContent || '').trim().slice(0, 8)}`);
    log('候选:' + desc.join(' | '));
  }

  function anyDialog() {
    return [...document.querySelectorAll(SEL.dialog)].find(isShown) || null;
  }

  async function waitDialogGone(timeout) {
    return await waitFor(() => !anyDialog(), timeout, 120);
  }

  // 通用浮层检测：不依赖具体类名,任何可见的 dialog/modal/popup 类容器
  function anyOverlay() {
    const cands = document.querySelectorAll('[role="dialog"], [role="alertdialog"], [class*="dialog"], [class*="Dialog"], [class*="modal"], [class*="Modal"], [class*="popup"], [class*="Popup"]');
    for (const el of cands) {
      if (!isShown(el)) continue;
      if (el.closest('#bag-panel')) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 100 || r.height < 60) continue;
      return el;
    }
    return null;
  }

  // 失败诊断：抓取页面上所有大尺寸 fixed/absolute 浮层的类名/文字/位置
  function dumpOverlays() {
    const out = [];
    const all = document.querySelectorAll('body *');
    for (const el of all) {
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed' && cs.position !== 'absolute') continue;
      if (!isShown(el) || el.closest('#bag-panel')) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 150 || r.height < 100) continue;
      out.push({
        tag: el.tagName.toLowerCase(),
        cls: String(el.className || '').slice(0, 60),
        text: (el.textContent || '').replace(/\s+/g, '').slice(0, 40),
        rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        z: cs.zIndex,
      });
      if (out.length >= 10) break;
    }
    return out;
  }

  // 成功提示词检测(点击后页面可能出现"已向BOSS发送消息"等提示)
  function sentHint() {
    const t = (document.body.innerText || '').slice(0, 8000);
    return /已向BOSS发送消息|发送成功|已打招呼|沟通已发送/.test(t);
  }

  // 点「留在此页」关掉弹窗；true=已清空，false=关不掉
  async function closeDialog() {
    for (let i = 0; i < 3; i++) {
      const btn = await waitFor(() => findStayBtn(), 2500, 100);
      if (btn) {
        clickStay(btn);
        alog('CLICK_ATTEMPT', '弹窗:点击「留在此页」', { action_type: 'CLICK', target: '留在此页', execution_method: 'synthetic', element: elInfo(btn) });
        await sleep(rand(400, 700));
        if (await waitDialogGone(1500)) {
          alog('ACTION_SUCCESS', '弹窗已关闭(留在此页)', { action_type: 'CLICK', target: '留在此页', result: 'success', state_changed: true });
          return true;
        }
        // 合成点击关不掉弹窗 → 升级系统级真实点击
        if (await sysClick(btn, '留在此页')) {
          await sleep(rand(400, 700));
          if (await waitDialogGone(1500)) {
            alog('ACTION_SUCCESS', '弹窗已关闭(系统级点击)', { action_type: 'CLICK', target: '留在此页', execution_method: 'system', result: 'success', state_changed: true });
            return true;
          }
        }
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
      // 通用浮层关闭按钮兜底(不依赖具体弹窗类名)
      const ov = anyOverlay();
      const ovClose = ov && [...ov.querySelectorAll('[class*="close"], [class*="Close"], [aria-label*="关闭"], [aria-label="Close"]')].find(isShown);
      if (ovClose) {
        humanClick(ovClose);
        log('已点击浮层关闭按钮');
        await sleep(rand(400, 700));
        if (await waitDialogGone(1200)) return true;
        continue;
      }
      // 常规关闭按钮也没有 → 让 AI 找关闭按钮
      const aiClose = await aiLocateButton('close');
      if (aiClose) {
        aiClose.click();
        log('AI找到关闭按钮,已点击');
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
    alog('ACTION_FAILED', '弹窗无法关闭,已终止', { action_type: 'CLICK', target: '关闭弹窗', result: 'timeout' });
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
    let btn = await waitFor(() => findResumeBtn(chat || document), 2500, 150);
    if (!btn) btn = await aiLocateButton('resume'); // AI 兜底
    if (!btn) {
      log('未找到"发送简历"入口，跳过附件发送');
      return false;
    }
    btn.click();
    await sleep(rand(600, 1000));
    let ok = findConfirmBtn();
    if (!ok) ok = await aiLocateButton('confirm'); // AI 兜底
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
    if (!Task.active) return;
    if (Date.now() - lastStayClick < 1500) return;
    const btn = findStayBtn();
    if (btn) {
      lastStayClick = Date.now();
      setTimeout(() => { try { clickStay(btn); } catch (e) {} }, 200);
    }
  }).observe(document.body, { childList: true, subtree: true });

  /* ============================================================
   * 模块6：岗位数据管理（P4）
   * IndexedDB 存岗位记录(按 key 去重),可导出 CSV；IDB 不可用时回退 GM
   * ============================================================ */
  const JobStore = (() => {
    let dbp = null;
    function open() {
      if (dbp) return dbp;
      dbp = new Promise((res) => {
        let rq;
        try { rq = indexedDB.open('boss_helper', 1); } catch (e) { return res(null); }
        rq.onupgradeneeded = () => {
          const db = rq.result;
          if (!db.objectStoreNames.contains('jobs')) db.createObjectStore('jobs', { keyPath: 'key' });
        };
        rq.onsuccess = () => res(rq.result);
        rq.onerror = () => res(null);
      });
      return dbp;
    }
    async function put(job) {
      const db = await open();
      if (!db) {
        const arr = _gmGet('job_store', []);
        const i = arr.findIndex((j) => j.key === job.key);
        if (i >= 0) arr[i] = job; else arr.push(job);
        _gmSet('job_store', arr.slice(-1000));
        return true;
      }
      return new Promise((res) => {
        try {
          const tx = db.transaction('jobs', 'readwrite');
          tx.objectStore('jobs').put(job);
          tx.oncomplete = () => res(true);
          tx.onerror = () => res(false);
        } catch (e) { res(false); }
      });
    }
    async function all() {
      const db = await open();
      if (!db) return _gmGet('job_store', []);
      return new Promise((res) => {
        try {
          const rq = db.transaction('jobs', 'readonly').objectStore('jobs').getAll();
          rq.onsuccess = () => res(rq.result || []);
          rq.onerror = () => res([]);
        } catch (e) { res([]); }
      });
    }
    const HEAD = ['岗位', '公司', '薪资', '地区', '经验/学历', '公司信息', 'HR', '匹配度', '状态', '评估理由', 'AI综合评估', 'JD摘要', '时间', '链接'];
    const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const lineOf = (j) => [j.title, j.company, j.salary, j.area, j.tags, j.companyInfo, j.hr, j.score, j.status, j.reason, j.aiEval, (j.jd || '').slice(0, 120), j.ts, j.url].map(esc).join(',');
    function toCsv(rows) {
      return '﻿' + [HEAD.join(',')].concat(rows.map(lineOf)).join('\n');
    }
    async function exportCsv() {
      const rows = await all();
      const blob = new Blob([toCsv(rows)], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'boss-jobs-' + new Date().toISOString().slice(0, 10) + '.csv';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      return rows.length;
    }
    return { put, all, toCsv, exportCsv, csvHeader: () => '﻿' + HEAD.join(',') + '\r\n', csvLine: lineOf };
  })();

  // 卡片去重键（DOM 节点会重渲染，用字符串键）
  function cardKey(card) {
    const a = card.querySelector('a[href*="/job_detail/"]');
    const href = a ? a.getAttribute('href') : '';
    const t = (card.querySelector(SEL.cardTitle)?.textContent || '').trim();
    const c = (card.querySelector(SEL.cardCompany)?.textContent || '').trim();
    return href || (t + '|' + c);
  }

  // 提取一条岗位记录（P4）
  function extractJob(card, meta) {
    const q = (sel) => (card.querySelector(sel)?.textContent || '').trim();
    const a = card.querySelector('a[href*="/job_detail/"]');
    return {
      key: cardKey(card),
      title: q(SEL.cardTitle),
      company: q(SEL.cardCompany),
      salary: q('.salary'),
      area: q('.job-area'),
      jd: readJd().slice(0, 800),
      url: a ? a.href : '',
      score: meta && meta.score != null ? meta.score : null,
      reason: (meta && meta.reason) || '',
      aiEval: (meta && meta.aiEval) || '',
      status: (meta && meta.status) || 'seen',
      ts: new Date().toISOString(),
    };
  }

  // 采集模式:全字段提取(卡片标签+详情区公司信息+完整JD)
  function extractFull(card, meta) {
    const base = extractJob(card, meta);
    const q = (sel) => (card.querySelector(sel)?.textContent || '').trim();
    base.tags = (q('.tag-list') || q('.job-card-footer') || '').replace(/\s+/g, ' ');
    base.hr = (q('.info-public') || q('.boss-name') || '').replace(/\s+/g, ' ');
    base.companyInfo = readCompanyInfo();
    base.jd = readJd().slice(0, 2000);
    return base;
  }

  /* ===== 投递时同步采集 =====
   * 关闭(默认):投递模式不做任何采集写库,纯投递。
   * 开启:每个处理过的岗位全字段写库并逐条追加到导出表格。
   * 采集与投递天然同频——在同一次卡片处理流程内完成,共享同一套随机间隔与拟人节奏,
   * 不存在速率不对称问题。 */
  let syncCtx = null;
  async function storeJob(card, meta) {
    if (!cfg.collectSync) return;
    const rec = extractFull(card, meta);
    await JobStore.put(rec);
    if (syncCtx && syncCtx.fileOk) {
      const ok = await serverSave(cfg.exportPath, JobStore.csvLine(rec) + '\r\n', true);
      if (!ok) { syncCtx.fileOk = false; log('表格写入失败,转内存暂存,结束后统一导出'); }
    }
  }

  async function processCard(card) {
    await checkpoint();
    const title = (card.querySelector(SEL.cardTitle)?.textContent || '').trim();
    const company = (card.querySelector(SEL.cardCompany)?.textContent || '').trim();

    // AI 模式下不做关键词预筛:每个岗位都打开详情交给 AI 逐岗评估(用户要求:逐个读取,不跳过)
    if (!cfg.aiEnabled) {
      const reason = passFilter(title, company);
      if (reason) {
        alog('JOB_SKIPPED', `跳过:${title} @ ${company}(${reason})`,
          { action_type: 'SKIP', target: title + ' @ ' + company, reason });
        await storeJob(card, { status: 'skipped', reason });
        return 'skip';
      }
    }

    // 每次点击前先过一遍风控检测
    const r = detectRisk();
    if (r) {
      trip(r);
      return 'halt';
    }

    let opened = await openDetail(card);
    // 校验详情区标题是否真的切到了这张卡对应的岗位，不一致说明点击没生效
    const detailTitle = () => {
      for (const b of document.querySelectorAll(SEL.detailBox)) {
        if (!visible(b)) continue;
        const el = b.querySelector(SEL.cardTitle);
        if (el && (el.textContent || '').trim()) return (el.textContent || '').trim();
      }
      return '';
    };
    const dTitle = detailTitle();
    if (dTitle && title && !dTitle.includes(title.slice(0, 6)) && !title.includes(dTitle.slice(0, 6))) {
      log(`详情未切换(卡片:${title} 详情:${dTitle})，重试一次`);
      humanClick(card);
      await sleep(rand(700, 1100));
      opened = await openDetail(card);
    }
    const jd = opened ? readJd() : '';
    if (!jd) log(`未读到JD，改按标题与卡片标签打分:${title}`);
    await simulateReading(); // 挂机模式:模拟真人阅读JD(随机滚动+停顿)

    const jobText = `${title} ${card.textContent || ''} ${jd}`;

    // 硬性排除：命中即跳过（先于任何打分）。只扫职位名+公司名,JD 正文不扫
    // (JD 里提到"销售"类词汇会把纯运维岗误杀)
    const hit = HARD_BLOCK.find((k) => (title + company).includes(k));
    if (hit) {
      alog('JOB_SKIPPED', '跳过(硬性排除:' + hit + '):' + title + ' @ ' + company,
        { action_type: 'SKIP', target: title + ' @ ' + company, reason: '硬性排除:' + hit });
      await storeJob(card, { status: 'skipped', reason: '硬性排除:' + hit });
      return 'skip';
    }

    // 先查沟通按钮:已沟通过的岗位直接跳过,不再浪费 AI 调用
    let btn = await waitFor(() => findChatBtn(card), 3000);
    if (!btn) btn = await aiLocateButton('chat');
    if (!btn) {
      alog('ACTION_FAILED', `未找到沟通按钮:${title}`, { action_type: 'LOCATE', target: '立即沟通', result: 'not_found' });
      logChatCandidates();
      return 'fail';
    }
    const text = btn.textContent.trim();
    if (!/立即沟通|马上沟通|打招呼/.test(text)) {
      alog('JOB_SKIPPED', `已沟通过,跳过:${title} @ ${company}`,
        { action_type: 'SKIP', target: title + ' @ ' + company, reason: '已沟通过' });
      await storeJob(card, { status: 'skipped', reason: '已沟通过' });
      return 'skip';
    }

    // AI 逐岗评估(AI 开启时)或本地规则打分。AI 调用失败回退规则分,阈值也回退本地阈值
    // 挂机模式:先把采集到的岗位信息存本地(status=analyzing),再做深度AI分析(含公司/行业前景),分析后才决定投递
    let score = null, hits = [], why = '', aiUsed = false, aiEvalText = '';
    if (cfg.aiEnabled) {
      let ai = null;
      if (cfg.stealth) {
        await storeJob(card, { status: 'analyzing' });
        ai = await aiDeepEval(title, company, jd, readCompanyInfo());
        if (ai) aiEvalText = ai.summary || '';
      } else {
        ai = await aiScore(title, company, jd);
      }
      if (ai) {
        aiUsed = true; score = ai.score; why = ai.reason;
        if (ai.fit === false) {
          alog('JOB_SKIPPED', `跳过(AI判定不匹配${why ? ':' + why : ''}):${title} @ ${company}`,
            { action_type: 'SKIP', target: title + ' @ ' + company, reason: 'AI不匹配:' + why, score });
          await storeJob(card, { status: 'skipped', reason: 'AI不匹配:' + why, score, aiEval: aiEvalText });
          return 'skip';
        }
      }
      else log('AI 调用失败，回退本地匹配');
    }
    if (score == null) { const r = scoreJob(jobText, title); score = r.score; hits = r.hits; }
    const threshold = aiUsed ? Number(cfg.aiThreshold || 60) : Number(cfg.minScore || 45);
    if (score < threshold) {
      alog('JOB_SKIPPED', `跳过(匹配度${score}<${threshold})${why ? ' AI:' + why : ''}:${title} @ ${company}`,
        { action_type: 'SKIP', target: title + ' @ ' + company, reason: `匹配度${score}<${threshold}`, score });
      await storeJob(card, { status: 'skipped', reason: `匹配度${score}<${threshold}`, score, aiEval: aiEvalText });
      return 'skip';
    }
    alog('JOB_SCORED', `匹配度${score}${why ? '(AI:' + why + ')' : '(命中:' + (hits.slice(0, 6).join('/') || '无') + ')'}:${title} @ ${company}`,
      { action_type: 'SCORE', target: title + ' @ ' + company, score, reason: why || hits.slice(0, 6).join('/') });

    // 执行点击 + 验证弹窗（doAction:定位检查→合成点击→验证→系统级兜底→结构化日志）
    // 成功判据:出现「留在此页」按钮,或出现点击前不存在的新浮层
    // 挂机模式:点击前拟人犹豫(真人点沟通前会停顿确认)
    if (cfg.stealth) await pauseableSleep(rand(1200, 3200));
    const overlayBefore = anyOverlay();
    const clickRes = await doAction({
      name: '立即沟通',
      find: () => (isShown(btn) ? btn : findChatBtn(card)),
      verify: () => {
        if (findStayBtn()) return true;
        const ov = anyDialog() || anyOverlay();
        return ov && ov !== overlayBefore ? ov : null;
      },
      timeout: 4000,
      verifyDesc: '弹窗出现',
    });
    if (!clickRes.ok) {
      await storeJob(card, { status: 'click_failed', score });
      return 'fail';
    }

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
    alog('JOB_SENT', `✔ 已投递(${sent}/${cfg.max}):${title} @ ${company}${resumeSent ? '｜含简历附件' : ''}`,
      { action_type: 'SEND', target: title + ' @ ' + company, result: 'success', score });
    await storeJob(card, { status: 'sent', score, reason: why, aiEval: aiEvalText });
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
    alog('ACTION_ATTEMPT', `搜索「${kw}」`, { action_type: 'INPUT', target: '搜索框', value: kw });
    const box = await waitFor(() => [...document.querySelectorAll(SEARCH_SEL)].find(visible), 8000, 200);
    if (!box) {
      alog('ACTION_FAILED', '未找到搜索框', { action_type: 'INPUT', target: '搜索框', result: 'not_found' });
      return false;
    }
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
    alog(changed ? 'ACTION_SUCCESS' : 'ACTION_TIMEOUT',
      changed ? `已搜索「${kw}」` : `未检测到列表刷新:「${kw}」`,
      { action_type: 'INPUT', target: '搜索框', result: changed ? 'success' : 'timeout', state_changed: !!changed });
    return true;
  }

  async function loadMore() {
    const before = document.querySelectorAll(SEL.card).length;
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    const listEl = document.querySelector(SEL.card)?.closest('.job-list-box, .job-list-container, .job-list') || document.querySelector(SEL.card)?.parentElement;
    if (listEl) listEl.scrollTop = listEl.scrollHeight;
    await sleep(rand(1500, 2500));
    const after = document.querySelectorAll(SEL.card).length;
    alog('SCROLL', `滚动加载:卡片 ${before} → ${after}`, { action_type: 'SCROLL', target: '岗位列表', state_changed: after > before });
    if (after > before) return true;

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
    const pg = detectPage();
    log(`自检:页面类型 = ${pg.type}${pg.detail ? ' (' + pg.detail + ')' : ''}`);
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
    log(`自检:AI已启用 = ${cfg.aiEnabled}, Key已填 = ${!!_gmGet('aiKey', '')}`);
    log('===== 界面自检结束 =====');
  }

  /* ============================================================
   * 单卡闭环测试（P0~P4 验收入口）
   * 定位第一张卡片 → 点开详情并验证 → 提取岗位记录存库 →
   * 点击立即沟通并验证弹窗 → 点留在此页并验证弹窗关闭 → 全程结构化日志
   * ============================================================ */
  async function testLoop() {
    if (Task.working) { log('任务运行中,请先停止再测试'); return; }
    log('===== 单卡闭环测试开始 =====');
    Logger.newTask({ mode: 'single_card_test' });
    try {
      // 1) 页面识别
      const pg = detectPage();
      alog('PAGE_DETECTED', `页面类型:${pg.type}${pg.detail ? '(' + pg.detail + ')' : ''}`, { page: pg });
      if (pg.type === 'verify' || pg.type === 'captcha' || pg.type === 'login') {
        log('页面状态不允许测试(需登录/验证),请先人工处理');
        return;
      }

      // 2) 定位第一张岗位卡片
      const card = await waitFor(() => document.querySelector(SEL.card), 5000, 200);
      if (!card) {
        alog('ACTION_FAILED', '未找到岗位卡片', { action_type: 'LOCATE', target: '岗位卡片', result: 'not_found' });
        return;
      }
      alog('ELEMENT_FOUND', `岗位卡片:${(card.querySelector(SEL.cardTitle)?.textContent || '').trim()}`,
        { action_type: 'LOCATE', target: '岗位卡片', element: elInfo(card) });

      // 3) 打开详情 + 验证详情切换
      const fpBefore = detailFingerprint();
      const okOpen = await openDetail(card);
      if (!okOpen) {
        log('闭环测试:详情区未能加载,请导出日志');
        return;
      }
      alog('PAGE_STATE', `详情指纹:${fpBefore.slice(0, 30)} → ${detailFingerprint().slice(0, 30)}`,
        { state_changed: detailFingerprint() !== fpBefore });

      // 4) 数据提取 + 存库
      const job = extractJob(card, { status: 'test' });
      await JobStore.put(job);
      alog('DATA_EXTRACTED', `提取岗位:${job.title} @ ${job.company}｜薪资:${job.salary || '-'}｜地区:${job.area || '-'}｜JD:${job.jd.length}字`,
        { action_type: 'EXTRACT', target: job.title, job: { key: job.key, title: job.title, company: job.company, salary: job.salary, area: job.area, jd_len: job.jd.length } });

      // 5) 定位 + 点击「立即沟通」+ 验证弹窗出现
      let btn = findChatBtn(card);
      if (!btn) btn = await aiLocateButton('chat');
      if (!btn) {
        alog('ACTION_FAILED', '立即沟通按钮定位失败', { action_type: 'LOCATE', target: '立即沟通', result: 'not_found' });
        logChatCandidates();
        return;
      }
      const chatBtn = btn;
      const overlayBefore = anyOverlay();
      const r1 = await doAction({
        name: '立即沟通',
        find: () => (isShown(chatBtn) ? chatBtn : findChatBtn(card)),
        verify: () => {
          if (findStayBtn()) return true;
          const ov = anyDialog() || anyOverlay();
          return ov && ov !== overlayBefore ? ov : null;
        },
        timeout: 4000,
        verifyDesc: '弹窗出现',
      });
      if (!r1.ok) {
        log('闭环测试:沟通按钮点击未通过验证,请导出日志分析');
        return;
      }

      // 6) 点击「留在此页」+ 验证弹窗关闭
      const stay = await waitFor(() => findStayBtn(), 3000, 150);
      if (stay) {
        const r2 = await doAction({
          name: '留在此页',
          find: () => (isShown(stay) ? stay : findStayBtn()),
          verify: () => !anyDialog(),
          timeout: 2000,
          verifyDesc: '弹窗关闭',
        });
        if (!r2.ok) await closeDialog();
      } else {
        alog('ELEMENT_NOT_FOUND', '弹窗中未找到「留在此页」,走通用关弹窗流程', { action_type: 'LOCATE', target: '留在此页', result: 'not_found' });
        await closeDialog();
      }
      log('===== 单卡闭环测试结束(点「导出诊断日志」查看完整记录) =====');
    } finally {
      Logger.endTask('test_done');
    }
  }

  // 单个关键词：从第一张卡到最后一张，滚动加载直到无新增
  async function runKeyword(kw) {
    let idx = 0, emptyRounds = 0, dryRounds = 0, failStreak = 0, aiTries = 0;
    let sinceBreak = 0, breakAt = 8 + Math.floor(Math.random() * 8); // 挂机模式:每8-15岗休息一次
    while (Task.working) {
      await checkpoint();
      _gmSet('bag_hb', Date.now());
      if (timeUp()) { log(`已达执行时长上限(${cfg.maxMin}分钟),结束`); return; }

      const r = detectRisk();
      if (r) { trip(r); return; }
      if (cfg.max > 0 && sent >= cfg.max) return;
      // 每关键词配额:本词已投达到配额即换下一个关键词
      if (cfg.perKwQuota > 0 && Progress.data && Progress.kw(kw).sent >= cfg.perKwQuota) {
        log(`「${kw}」已达每词配额 ${cfg.perKwQuota} 份,换下一个关键词`);
        return;
      }

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
          if (act === 'abort') { Task.set('STOPPED', 'AI判定'); return; }
          if (act === 'search_again') return;
          if (act === 'scroll_bottom') { await loadMore(); continue; }
          // 注意:必须用独立的 dryRounds,不能用 emptyRounds——上方每轮都会重置 emptyRounds,
          // 用它会导致"已无新岗位"永远达不到阈值,卡在列表底部无限滚动
          if (++dryRounds >= 2) { log(`「${kw}」已无新岗位，共 ${idx} 个`); return; }
          await sleep(1500);
          continue;
        }
        dryRounds = 0;
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
      catch (e) {
        if (e && e.name === 'StopError') throw e;
        log('出错:' + e.message); st = 'fail';
      }

      if (st === 'halt') return;
      if (st === 'ok') {
        failStreak = 0;
        // 进度:本词已投+1,总投+1,立即持久化(手动停止后下次可续跑)
        if (Progress.data) { const p = Progress.kw(kw); p.sent++; Progress.data.totalSent++; Progress.save(); }
      } else if (st === 'fail') {
        if (++failStreak >= cfg.maxFail) {
          const act = await aiDecide('连续失败', { kw, failStreak });
          if (act && !(await applyAiAction(act))) return;
          if (failStreak >= cfg.maxFail + 2) { trip(`连续失败 ${failStreak} 次，触发熔断保护机制`); return; }
        }
      } else if (st === 'skip' && Progress.data) {
        Progress.kw(kw).skip++;
      }
      // 统一节奏:无论投递/跳过/失败,都按反爬策略间隔进入下一岗(速率一致,无信息不对称)
      await pauseableSleep(actDelayMs());

      // 挂机模式:每处理 8-15 个岗位休息 2-5 分钟,模拟真人疲劳节奏
      if (cfg.stealth && ++sinceBreak >= breakAt) {
        sinceBreak = 0;
        breakAt = 8 + Math.floor(Math.random() * 8);
        const rest = Math.round(rand(120, 300));
        log(`挂机模式:已连续处理一批岗位,休息 ${rest}s 模拟真人`);
        await pauseableSleep(rest * 1000);
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

    // 进度恢复:关键词队列与上次一致且未跑完则断点续跑,否则开新进度
    Progress.load();
    if (!Progress.matches(kws)) Progress.reset(kws);

    Logger.newTask({ keywords: kws, max: cfg.max, aiEnabled: cfg.aiEnabled, include: cfg.include, exclude: cfg.exclude, excludeCompany: cfg.excludeCompany, minScore: cfg.minScore });
    const pg = detectPage();
    alog('PAGE_DETECTED', `页面类型:${pg.type}${pg.detail ? '(' + pg.detail + ')' : ''}`, { page: pg });

    sent = 0;
    seen.clear();
    $('bag-start').disabled = true;
    panel.style.borderColor = '#00bebd';
    Task.set('RUNNING', '任务启动');
    runStartedAt = Date.now();
    log(`开始运行：${kws.length} 个关键词，数量上限 ${cfg.max || '不限'}`);
    if (cfg.aiEnabled) log(`评估模式:AI逐岗评估(阈值${cfg.aiThreshold || 60}分,包含/排除预筛不生效,已沟通过自动跳过)`);
    else log(`过滤配置:包含[${cfg.include || '空(不限)'}] 排除[${cfg.exclude || '空'}] 排除公司[${cfg.excludeCompany || '空'}] 最低分[${cfg.minScore}]`);
    {
      const p = paceCfg();
      const names = { slow: '慢速随机', normal: '常规随机', fast: '快速随机', custom: '自定义' };
      log(`反爬策略:${names[cfg.pace] || '常规随机'}(${p.min}-${p.max}s/岗${p.human ? ',拟人轨迹+定时休息' : ',无拟人动作'}),数量上限${cfg.max || '不限'},时长上限${cfg.maxMin ? cfg.maxMin + '分钟' : '不限'}`);
    }
    if (cfg.stealth && !cfg.aiEnabled) log('提示:挂机模式未启用AI,按本地规则打分,无深度分析(公司/行业评估)');
    if (Progress.data.totalSent > 0 || Progress.data.idx > 0) {
      log(`恢复上次进度:第 ${Progress.data.idx + 1}/${kws.length} 词,总已投 ${Progress.data.totalSent} 份(未完成;点「重置进度」可清零重跑)`);
    }
    // 投递时同步采集:启动即创建表格,与投递同频逐条写入
    syncCtx = null;
    if (cfg.collectSync) {
      const created = await serverSave(cfg.exportPath, JobStore.csvHeader(), false);
      syncCtx = { fileOk: !!created };
      log(created ? `采集同步:已创建表格 ${created},与投递同频逐条写入` : '采集同步:本地服务离线,数据内存暂存,结束后统一导出');
    }

    try {
      let roundStart = Progress.data.idx; // 断点续跑:从上次停在的关键词继续
      while (Task.working) {
        // 每词配额全部达标则结束,避免轮空循环
        if (cfg.perKwQuota > 0 && kws.every((k) => Progress.kw(k).sent >= cfg.perKwQuota)) {
          log(`所有关键词均已达每词配额 ${cfg.perKwQuota} 份,结束`);
          break;
        }
        for (let i = roundStart; i < kws.length && Task.working; i++) {
          await checkpoint();
          if (timeUp()) { log(`已达执行时长上限(${cfg.maxMin}分钟),结束`); break; }
          if (cfg.max > 0 && sent >= cfg.max) { log(`已达数量上限(${cfg.max}),结束`); break; }
          const kw = kws[i];
          Progress.data.idx = i; Progress.save();
          if (cfg.perKwQuota > 0 && Progress.kw(kw).sent >= cfg.perKwQuota) {
            log(`=== (${i + 1}/${kws.length})「${kw}」已达配额 ${cfg.perKwQuota} 份,跳过 ===`);
            continue;
          }
          log(`=== (${i + 1}/${kws.length}) 搜索「${kw}」(本词已投 ${Progress.kw(kw).sent}${cfg.perKwQuota ? '/' + cfg.perKwQuota : ''}) ===`);
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
          if (!Task.working) break;
          log(`「${kw}」处理完成，本词已投 ${Progress.kw(kw).sent} 份，累计投递 ${sent} 个`);
        }
        if (!Task.working) break;
        if (timeUp()) break;
        if (cfg.max > 0 && sent >= cfg.max) break;
        // 一轮跑完:轮次+1,判断是否开启新一轮循环
        Progress.data.round++; Progress.data.idx = 0; Progress.save();
        if (!cfg.loopRounds) { log('所有关键词已跑完一轮'); break; }
        log(`第 ${Progress.data.round} 轮关键词循环开始(此前已投 ${Progress.data.totalSent} 份)`);
        roundStart = 0;
      }
      // 正常跑完(非手动停止/熔断)标记进度完成,下次启动开新进度
      if (Task.working) { Progress.data.done = true; Progress.save(); }
      if (Task.working) Task.set('COMPLETED', `投递${sent}个`);
    } catch (e) {
      if (e && e.name === 'StopError') {
        log('已停止');
      } else {
        log('任务异常:' + e.message);
        Task.set('FAILED', e.message);
      }
    }

    Logger.endTask(Task.state, { sent });
    _gmSet('bag_hb', 0);
    $('bag-start').disabled = false;
    updateStatus();
    if (cfg.collectSync) {
      if (syncCtx && syncCtx.fileOk) log(`采集同步结束,表格已保存:${cfg.exportPath}`);
      else await exportJobsSmart();
    }
    log(`结束，本次共投递 ${sent} 个`);
  }

  /* ===================== 采集模式:不投递,拟人节奏逐卡全字段采集 ===================== */
  // 经本地服务把内容写入指定路径;失败返回 null(服务离线或路径非法)
  async function serverSave(filePath, content, append) {
    const r = await _gmPost('http://127.0.0.1:8901/save', { path: filePath, content, append: !!append }, {});
    return r && r.ok ? (r.saved || filePath) : null;
  }

  // 智能导出:优先写到面板配置的导出路径(需本地服务),服务离线回退浏览器下载
  async function exportJobsSmart() {
    const rows = await JobStore.all();
    if (!rows.length) { log('岗位库为空,没有可导出的数据'); return 0; }
    const saved = await serverSave(cfg.exportPath, JobStore.toCsv(rows));
    if (saved) { log(`已导出岗位数据 ${rows.length} 条 → ${saved}`); return rows.length; }
    const n = await JobStore.exportCsv();
    log(`本地服务离线,已改用浏览器下载 CSV(${n} 条)`);
    return n;
  }

  // 单个关键词:从首卡走到列表底部,逐卡打开详情,全字段提取入库并追加表格
  async function collectKeyword(kw, ctx) {
    let idx = 0, dryRounds = 0, got = 0;
    while (Task.working) {
      await checkpoint();
      if (timeUp()) { log(`已达执行时长上限(${cfg.maxMin}分钟),结束`); return; }
      if (cfg.max > 0 && ctx.total >= cfg.max) { log(`已达数量上限(${cfg.max}),结束`); return; }
      const r = detectRisk();
      if (r) { trip(r); return; }

      const cards = [...document.querySelectorAll(SEL.card)];
      if (!cards.length) {
        if (++dryRounds >= 3) { log(`「${kw}」列表为空,跳过`); return; }
        await sleep(1500);
        continue;
      }
      if (idx >= cards.length) {
        const more = await loadMore();
        if (more) { dryRounds = 0; continue; }
        if (++dryRounds >= 2) { log(`「${kw}」采集完成,共 ${got} 条`); return; }
        await sleep(1500);
        continue;
      }
      dryRounds = 0;

      const card = cards[idx];
      idx++;
      const ck = cardKey(card);
      if (seen.has(ck)) continue;
      seen.add(ck);

      const opened = await openDetail(card);
      await simulateReading(true); // 采集模式强制拟人阅读节奏
      const rec = extractFull(card, { status: 'collected' });
      if (!opened) rec.reason = '详情未打开,仅卡片字段';
      await JobStore.put(rec);
      got++;
      ctx.total++;
      // 逐条追加到采集表格;写失败转内存暂存
      if (ctx.fileOk) {
        const okApp = await serverSave(cfg.exportPath, JobStore.csvLine(rec) + '\r\n', true);
        if (!okApp) { ctx.fileOk = false; log('表格写入失败,转内存暂存,结束后统一导出'); }
      }
      alog('JOB_COLLECTED', `采集(${got}):${rec.title} @ ${rec.company}`,
        { action_type: 'COLLECT', target: rec.title + ' @ ' + rec.company, result: 'saved' });
      // 统一节奏:按反爬策略间隔进入下一岗(与投递模式同一套参数)
      await pauseableSleep(actDelayMs());
    }
  }

  async function runCollect() {
    readCfg();
    if (Task.working) { log('任务运行中,请先停止'); return; }
    const kws = String(cfg.keywords || '').split(/\r?\n|,|，/).map((s) => s.trim()).filter(Boolean);
    if (!kws.length) { log('请先填写职位关键词'); return; }

    Logger.newTask({ mode: 'collect', keywords: kws, exportPath: cfg.exportPath });
    Task.set('RUNNING', '采集启动');
    runStartedAt = Date.now();
    seen.clear();
    $('bag-collect').disabled = true;
    $('bag-start').disabled = true;
    log(`采集模式:${kws.length} 个关键词,拟人间隔${cfg.stealthMin}-${cfg.stealthMax}s/岗,完成后导出到[${cfg.exportPath}]`);
    // 启动即创建采集表格(写入表头),之后每采一条追加一行;中途停止表格也是最新的
    const ctx = { fileOk: false, total: 0 };
    const created = await serverSave(cfg.exportPath, JobStore.csvHeader(), false);
    if (created) { ctx.fileOk = true; log(`已创建采集表格:${created},逐条写入中`); }
    else log('本地服务离线,采集数据先存内存,结束后统一导出');

    try {
      for (let i = 0; i < kws.length && Task.working; i++) {
        await checkpoint();
        if (timeUp()) { log(`已达执行时长上限(${cfg.maxMin}分钟),结束`); break; }
        const kw = kws[i];
        log(`=== 采集 (${i + 1}/${kws.length})「${kw}」 ===`);
        window.scrollTo({ top: 0, behavior: 'smooth' });
        await sleep(rand(600, 1000));
        const okSearch = await doSearch(kw);
        if (!okSearch) { log(`「${kw}」搜索失败,跳过`); continue; }
        await collectKeyword(kw, ctx);
        if (cfg.max > 0 && ctx.total >= cfg.max) { log(`已达数量上限(${cfg.max}),结束`); break; }
      }
      if (Task.working) Task.set('COMPLETED', '采集完成');
    } catch (e) {
      if (e && e.name === 'StopError') log('已停止');
      else { Task.set('FAILED', e.message); log('采集异常:' + e.message); }
    }

    Logger.endTask(Task.state, {});
    _gmSet('bag_hb', 0);
    $('bag-collect').disabled = false;
    $('bag-start').disabled = false;
    if (ctx.fileOk) log(`采集结束,表格已保存:${cfg.exportPath}`);
    else { const n = await exportJobsSmart(); log(`采集结束,已统一导出 ${n} 条`); }
  }

  /* ===================== 按钮绑定 ===================== */
  $('bag-start').onclick = () => !Task.working && run();
  $('bag-pause').onclick = () => {
    if (Task.state === 'PAUSED') {
      Task.set('RUNNING', '手动继续');
      log('已继续');
    } else if (Task.active) {
      Task.set('PAUSED', '手动暂停');
      log('已暂停,点击「继续」恢复');
    }
  };
  $('bag-stop').onclick = () => {
    if (Task.working) log('正在手动停止…');
    Task.set('STOPPED', '手动停止');
  };
  $('bag-diag').onclick = () => runDiag();
  $('bag-resetprog').onclick = () => {
    const kws = String(cfg.keywords || '').split(/\r?\n|,|，/).map((s) => s.trim()).filter(Boolean);
    Progress.reset(kws);
    log('进度已重置,下次启动从头开始');
  };
  Progress.load();
  renderProgress();
  $('bag-test').onclick = () => testLoop();
  $('bag-exportlog').onclick = () => {
    const n = Logger.exportFile();
    log(`已导出诊断日志 JSON(${n} 条)`);
  };
  $('bag-collect').onclick = () => !Task.working && runCollect();
  // 浏览…:经本地服务调起 Windows 图形化目录选择框,选中的目录拼上当前文件名
  $('bag-browse').onclick = async () => {
    log('正在打开目录选择框(可能被浏览器挡住,留意任务栏)');
    const r = await _gmPost('http://127.0.0.1:8901/pickdir', {}, {}, 120000);
    if (r && r.ok && r.path) {
      const fname = ($('bag-exportpath').value.split(/[\\/]/).pop() || '').trim() || 'boss-jobs.csv';
      $('bag-exportpath').value = r.path.replace(/[\\/]+$/, '') + '\\' + fname;
      readCfg(); // 保存到配置
      log('导出路径已设为:' + $('bag-exportpath').value);
    } else {
      log(r ? ('未选择目录' + (r.err ? ':' + r.err : '')) : '本地服务离线,无法打开选择框');
    }
  };
  $('bag-exportjobs').onclick = async () => {
    readCfg();
    await exportJobsSmart();
  };
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
