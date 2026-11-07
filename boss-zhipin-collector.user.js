// ==UserScript==
// @name         BOSS直聘 岗位信息采集助手 (完整增强版)
// @namespace    https://github.com/tiantongss/boss-zhipin-userscript
// @version      1.4.1
// @description  在职位推荐/搜索页逐个读取岗位详情，采集岗位、薪资、学历经验、福利、公司行业/规模/融资/简介/工商信息、发布人、地点、JD；深度挖掘合同性质、试用期、工作时间、证书要求、核心技能；支持安全熔断、去重、本地保存、导出 CSV/JSON、选择器诊断。
// @updateURL    https://raw.githubusercontent.com/tiantongss/boss-zhipin-userscript/main/boss-zhipin-collector.user.js
// @downloadURL  https://raw.githubusercontent.com/tiantongss/boss-zhipin-userscript/main/boss-zhipin-collector.user.js
// @match        https://*.zhipin.com/*
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        GM_setClipboard
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';
  console.log('[%s] 脚本已加载 v1.4.1', 'BOSS采集助手');

  const VER = 3; // 记录版本。低于此版本的旧记录会在开启刷新时进行补采

  /* ===================== 配置 ===================== */
  const DEFAULTS = {
    max: 100,
    minDelay: 3,
    maxDelay: 6,
    titles: 'IT技术支持工程师,系统运维工程师,云平台技术支持工程师,云平台运维工程师,网络工程师,虚拟化运维工程师,IDC运维工程师,数据中心运维工程师,服务器运维工程师,桌面运维工程师,驻场运维工程师,现场技术支持工程师,系统集成工程师,IT基础设施工程师,企业IT工程师,云计算技术支持工程师,云计算运维工程师,网络技术支持工程师,网络实施工程师,系统实施工程师,IT交付工程师,售后技术支持工程师,服务器技术支持工程师,存储技术支持工程师,备份容灾工程师,虚拟化技术支持工程师,机房工程师,弱电工程师,计算机设备维护工程师,信息化运维工程师,工厂IT工程师,MES运维工程师,MES技术支持工程师,工业互联网技术支持工程师,自动化设备技术支持工程师',
    exclude: '销售,客服,运营,推广,主播,直播,电商,招聘,实习,兼职,前端,后端,Java,算法,产品经理',
    mode: 'loose',
    descInclude: '',
    refresh: true, // 已有记录版本过旧时，重新采集并合并
    maxFail: 3,       // 连续失败N条即熔断停止
    dailyMax: 300,    // 每日累计采集上限
    cooldownMin: 30,  // 熔断后冷却(分钟)
  };
  const cfg = Object.assign({}, DEFAULTS, GM_getValue('cfg', {}));
  let store = GM_getValue('jobs', {});

  /* ===================== 选择器配置 ===================== */
  const SEL = {
    // 列表卡片
    card: '.job-card-wrapper, .job-card-box',
    cardLink: 'a.job-card-left, a[href*="job_detail"]',
    cardTitle: '.job-name, .job-title',
    cardCompany: '.company-name a, .company-name, .boss-name',
    cardCompanyLink: '.company-name a[href], a[href*="/gongsi/"]',
    cardArea: '.job-area, .company-location',
    cardSalary: '.salary, .job-salary',
    cardInfoTags: '.job-info .tag-list li',            // 经验/学历
    cardSkillTags: '.job-card-footer .tag-list li',    // 技能标签
    cardBenefit: '.job-card-footer .info-desc',        // 福利文案
    cardCompanyTags: '.company-tag-list li',           // 行业/融资/规模

    // 右侧详情
    detail: '.job-detail-box, .job-detail-container, .job-detail',
    dTitle: '.job-detail-header .job-name, .info-primary .name, .job-name',
    dSalary: '.job-detail-header .salary, .job-detail-info .salary, .info-primary .salary, .salary',
    dHeader: '.job-detail-header, .info-primary, .job-detail-info',
    dInfoTags: '.job-detail-header .tag-list li, .job-detail-info .tag-list li, .job-detail-header .text-desc',
    dSkillTags: '.job-keyword-list li, .job-detail-body .tag-list li',
    dBenefit: '.job-tags span, .job-welfare li, .welfare-list li, .tag-all span',
    dBoss: '.job-boss-info .name, .boss-info .name, .detail-figure + .name',
    dBossAttr: '.boss-info-attr, .job-boss-info .boss-info-attr',
    dBossActive: '.boss-active-time',
    dDate: '.job-boss-info .gray, .update-time, .time-desc, .job-detail-info .gray',
    dDesc: '.job-detail-body .job-sec-text, .job-sec-text',
    dAddr: '.job-address-desc, .location-address, .job-location .location-address',
    dSider: '.sider-company, .company-info-box',
    dSiderItems: '.sider-company p, .company-info-box p',
    dCompany: '.sider-company .company-info a, .company-info .name',
    dCompanyLink: '.sider-company a[href*="/gongsi/"], a[href*="/gongsi/"]',
    nextPage: '.options-pages a.next, .options-pages .next',
  };

  /* ===================== 工具函数 ===================== */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => a + Math.random() * (b - a);
  const txt = (el) => ((el && (el.innerText || el.textContent)) || '').trim();
  const q = (root, sel) => (root || document).querySelector(sel);
  const qa = (root, sel) => [...(root || document).querySelectorAll(sel)];
  const uniq = (arr) => [...new Set(arr.map((x) => x.trim()).filter(Boolean))];
  const splitList = (str) => str.split(/[,\uff0c\u3001;\uff1b\n\s]+/).map((x) => x.trim()).filter(Boolean);

  async function waitFor(fn, timeout = 5000, step = 150) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const v = fn();
      if (v) return v;
      await sleep(step);
    }
    return null;
  }

  function ownText(el) {
    if (!el) return '';
    const c = el.cloneNode(true);
    c.querySelectorAll('*').forEach((n) => n.remove());
    return c.textContent.trim();
  }

  function sectionText(roots, heading, maxLen = 1500) {
    for (const root of roots) {
      if (!root) continue;
      const cands = qa(root, 'h1,h2,h3,h4,h5,.title,.job-sec-title,.sec-title,.name,div,p,span').filter((n) => {
        const t = ownText(n) || txt(n);
        return t.length > 0 && t.length <= heading.length + 6 && t.includes(heading) && n.children.length <= 2;
      });
      for (const h of cands) {
        let s = h.nextElementSibling ? txt(h.nextElementSibling) : '';
        if (!s && h.parentElement) s = txt(h.parentElement).replace(txt(h), '').trim();
        if (s) return s.slice(0, maxLen);
      }
    }
    return '';
  }

  function kv(text, key) {
    if (!text) return '';
    const m = text.match(new RegExp(key + '[::\\s]*\\n?([^\\n]+)'));
    return m ? m[1].trim() : '';
  }

  /* ===================== 字段提取与识别 ===================== */
  const RE_EXP = /经验不限|不限经验|应届|在校|1年以内|\d+\s*[-~]\s*\d+\s*年|\d+\s*年以上|\d+\s*年/;
  const RE_EDU = /初中|中专|中技|高中|大专|本科|硕士|博士|学历不限/;
  const RE_SCALE = /\d+\s*[-~]\s*\d+人|\d+人以上|少于\d+人|\d+人/;
  const RE_STAGE = /未融资|天使轮|[A-F]轮|Pre-?[AB]|已上市|不需要融资|战略投资|上市公司/;

  function classify(list) {
    const r = { exp: '', edu: '', scale: '', stage: '', rest: [] };
    for (const raw of list) {
      const t = (raw || '').trim();
      if (!t) continue;
      if (!r.edu && t.length <= 8 && RE_EDU.test(t)) r.edu = t;
      else if (!r.exp && t.length <= 10 && RE_EXP.test(t)) r.exp = t;
      else if (!r.scale && t.length <= 12 && RE_SCALE.test(t)) r.scale = t;
      else if (!r.stage && t.length <= 10 && RE_STAGE.test(t)) r.stage = t;
      else r.rest.push(t);
    }
    return r;
  }

  function parseSalary(s) {
    const out = { text: '', min: '', max: '', unit: '', months: '', note: '' };
    s = (s || '').replace(/\s+/g, '');
    if (!s) return out;
    if (/[\uE000-\uF8FF]/.test(s)) {
      out.note = '薪资显示为混淆字体,未读取';
      return out;
    }
    out.text = s;
    const m = s.match(/(\d+(?:\.\d+)?)\s*[-~]\s*(\d+(?:\.\d+)?)\s*(K|k|万|元\/天|元\/时|元\/月)?/);
    if (m) {
      out.min = m[1];
      out.max = m[2];
      out.unit = m[3] || '';
    } else if (/面议/.test(s)) out.note = '面议';
    const mm = s.match(/[·.](\d+)薪/);
    if (mm) out.months = mm[1];
    return out;
  }

  // 从福利/JD文本派生基础福利字段
  function derive(t) {
    const T = (t || '').replace(/(无|不|没有|不存在)\s*大小周/g, '');
    const has = (re) => re.test(T);
    const flag = (re) => (has(re) ? '是' : '未提及');
    return {
      双休: has(/单休|大小周|做六休|六天工作/) ? '单休或大小周' : has(/双休|五休二/) ? '是' : '未提及',
      五险一金: flag(/五险一金|六险一金|五险二金|五险|社保|公积金/),
      包吃: flag(/包吃|供餐|免费午餐|提供午餐|工作餐|食堂|包餐/),
      包住: flag(/包住|宿舍|住宿|提供住房|人才公寓/),
      餐补: flag(/餐补|餐饮补贴|伙食补|饭补|午餐补|用餐补/),
      交通补贴: flag(/交通补|车补|通勤补|交通费|班车/),
      年终奖多薪: flag(/年终奖|13薪|14薪|15薪|十三薪|年底双薪/),
      年假体检节日: flag(/带薪年假|年假|体检|节日福利|生日福利|团建/),
      补充保险股权: flag(/商业保险|补充医疗|补充保险|期权|股票|股权/),
      加班说明: has(/不加班|无加班|无需加班|很少加班|基本不加班/)
        ? '不加班/很少'
        : has(/加班/)
        ? has(/加班补助|加班费|加班补贴|调休/) ? '提及加班(有补贴/调休)' : '提及加班'
        : '未提及',
      轮班夜班: flag(/倒班|轮班|夜班|值班|7\*24|7x24|7×24|24小时|三班/),
      出差: has(/不需要出差|无需出差|不出差|不用出差/) ? '不出差' : has(/出差|外派/) ? '需出差' : '未提及',
      驻场现场: flag(/驻场|甲方|现场/),
      全日制统招: flag(/全日制|统招/),
      英语要求: flag(/英文|英语|English|CET/),
    };
  }

  // 高级深度挖掘（技术白名单、合同性质、试用期、工作时间、证书等）
  const TECH_WHITELIST = [
    'Linux', 'Windows Server', 'VMware', 'ESXi', 'Docker', 'Kubernetes', 'K8s', 'Nginx', 'Zabbix', 'Prometheus',
    'MySQL', 'Oracle', 'SQL Server', 'Redis', 'TCP/IP', 'VPN', 'VLAN', '交换机', '路由器', '防火墙',
    'HCIP', 'HCIE', 'CCNP', 'CCIE', 'CISP', '软考', 'PMP', 'ITIL', 'CISAW', 'RHCE'
  ];

  function deriveAdvanced(desc, benefitsText) {
    const fullText = desc + '\n' + benefitsText;
    
    // 1. 合同性质
    let contract = '未提及';
    if (/劳务派遣|第三方派遣|外包|驻场外包/.test(fullText)) contract = '外包/派遣';
    else if (/正式编制|全职|签订劳动合同|五险一金/.test(fullText)) contract = '正式编/全职';

    // 2. 试用期
    const probationM = fullText.match(/试用期\s*([1-6]个月|[1-6]个半月)/);
    const probation = probationM ? probationM[1] : (/无试用期/.test(fullText) ? '无试用期' : '未提及');

    // 3. 工作时间
    const timeM = fullText.match(/(\d{1,2}[:点]\d{0,2}\s*[-~到至]\s*\d{1,2}[:点]\d{0,2}|早\s*\d+[点:]\s*晚\s*\d+|大小周|单休|双休)/g);
    const workTime = timeM ? [...new Set(timeM)].join(' / ') : '未提及';

    // 4. 证书要求
    const certs = TECH_WHITELIST.filter(w => /HCIP|HCIE|CCNP|CCIE|CISP|软考|PMP|ITIL|CISAW|RHCE/.test(w) && fullText.includes(w));

    // 5. 核心技能_JD
    const coreSkillsJD = TECH_WHITELIST.filter(w => fullText.includes(w));

    // 6. 专业要求
    const majorM = fullText.match(/(?:计算机|软件工程|网络工程|通信工程|信息安全|电子信息|自动化|理工科|不限专业)[^，。\n]{0,6}/g);
    const major = majorM ? [...new Set(majorM)].join('、') : '未提及';

    return {
      合同性质: contract,
      试用期: probation,
      工作时间: workTime,
      证书要求: certs.join('、') || '未提及',
      核心技能_JD: coreSkillsJD.join('、'),
      专业要求: major,
    };
  }

  /* ===================== UI 界面构建 ===================== */
  GM_addStyle(`
    #bjc-panel{position:fixed;left:16px;bottom:16px;width:310px;z-index:99999;background:#fff;
      border:1px solid #4a7cff;border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.18);
      font:12px/1.5 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#333}
    #bjc-panel header{background:#4a7cff;color:#fff;padding:6px 10px;border-radius:9px 9px 0 0;
      display:flex;justify-content:space-between;cursor:pointer;font-weight:600}
    #bjc-body{padding:8px 10px;max-height:72vh;overflow:auto}
    #bjc-panel label{display:block;margin:4px 0 2px;color:#666}
    #bjc-panel textarea,#bjc-panel select{width:100%;box-sizing:border-box;padding:3px 6px;border:1px solid #ccc;border-radius:4px;font:inherit}
    #bjc-panel input[type=text],#bjc-panel input[type=number],#bjc-panel input:not([type]){width:100%;box-sizing:border-box;padding:3px 6px;border:1px solid #ccc;border-radius:4px}
    #bjc-panel .row{display:flex;gap:6px}
    #bjc-panel .chk{display:flex;align-items:center;gap:4px;margin-top:6px}
    #bjc-panel button{flex:1;margin-top:8px;padding:5px;border:0;border-radius:4px;color:#fff;cursor:pointer;background:#4a7cff}
    #bjc-panel button.red{background:#e55}#bjc-panel button.gray{background:#888}
    #bjc-panel button:disabled{opacity:.5;cursor:not-allowed}
    #bjc-count{margin-top:6px;font-weight:600;color:#4a7cff}
    #bjc-log{margin-top:6px;height:130px;overflow:auto;background:#f6f6f6;border-radius:4px;padding:4px 6px;
      font-size:11px;white-space:pre-wrap}
  `);

  const panel = document.createElement('div');
  panel.id = 'bjc-panel';
  panel.innerHTML = `
    <header><span>岗位采集助手 v1.4.1</span><span id="bjc-toggle">收起</span></header>
    <div id="bjc-body">
      <label>目标岗位(逗号分隔)</label><textarea id="bjc-titles" rows="3"></textarea>
      <label>职位名排除词</label><input id="bjc-exclude">
      <label>匹配方式</label>
      <select id="bjc-mode"><option value="loose">宽松(含核心词,如"系统运维")</option><option value="strict">严格(含完整岗位名)</option></select>
      <label>岗位描述需命中其一(可选)</label><input id="bjc-desc" placeholder="例:Linux,VMware,交换机">
      <div class="row">
        <div><label>本次数量</label><input id="bjc-max" type="number" min="1"></div>
        <div><label>间隔下限(s)</label><input id="bjc-min" type="number" min="1"></div>
        <div><label>间隔上限(s)</label><input id="bjc-maxd" type="number" min="1"></div>
      </div>
      <label class="chk"><input id="bjc-refresh" type="checkbox"> 补采缺少新字段的旧记录</label>
      <div class="row">
        <div><label>连续失败熔断(条)</label><input id="bjc-maxfail" type="number" min="1"></div>
        <div><label>每日上限(条)</label><input id="bjc-daily" type="number" min="1"></div>
        <div><label>冷却(分钟)</label><input id="bjc-cool" type="number" min="1"></div>
      </div>
      <div class="row"><button id="bjc-start">开始采集</button><button id="bjc-stop" class="red">停止</button></div>
      <div class="row"><button id="bjc-csv" class="gray">导出CSV</button><button id="bjc-json" class="gray">导出JSON</button><button id="bjc-clear" class="gray">清空</button></div>
      <div class="row"><button id="bjc-import" class="gray">导入JSON(合并)</button></div>
      <div class="row"><button id="bjc-diag" class="gray">诊断选择器</button><button id="bjc-struct" class="gray">复制页面结构</button></div>
      <div class="row"><button id="bjc-unlock" class="gray">解除冷却(须已手动处理验证)</button></div>
      <input id="bjc-file" type="file" accept=".json,application/json" style="display:none">
      <div id="bjc-count"></div>
      <div id="bjc-log"></div>
    </div>`;
  document.body.appendChild(panel);

  const $ = (id) => document.getElementById(id);
  $('bjc-titles').value = cfg.titles;
  $('bjc-exclude').value = cfg.exclude;
  $('bjc-mode').value = cfg.mode;
  $('bjc-desc').value = cfg.descInclude;
  $('bjc-max').value = cfg.max;
  $('bjc-min').value = cfg.minDelay;
  $('bjc-maxd').value = cfg.maxDelay;
  $('bjc-refresh').checked = !!cfg.refresh;
  $('bjc-maxfail').value = cfg.maxFail;
  $('bjc-daily').value = cfg.dailyMax;
  $('bjc-cool').value = cfg.cooldownMin;

  panel.querySelector('header').onclick = () => {
    const b = $('bjc-body');
    const hide = b.style.display !== 'none';
    b.style.display = hide ? 'none' : '';
    $('bjc-toggle').textContent = hide ? '展开' : '收起';
  };

  const updateCount = () => {
    const l = getLock();
    $('bjc-count').textContent =
      `已保存岗位:${Object.keys(store).length} 条 | 今日已采:${getQuota()}/${cfg.dailyMax}` +
      (l ? ` | ⛔冷却中,剩余${Math.ceil((l.until - Date.now()) / 60000)}分钟` : '');
  };
  updateCount();
  setInterval(updateCount, 30000);

  function log(msg) {
    const box = $('bjc-log');
    const t = new Date().toTimeString().slice(0, 8);
    box.textContent += `[${t}] ${msg}\n`;
    box.scrollTop = box.scrollHeight;
  }

  function readCfg() {
    cfg.titles = $('bjc-titles').value;
    cfg.exclude = $('bjc-exclude').value;
    cfg.mode = $('bjc-mode').value;
    cfg.descInclude = $('bjc-desc').value;
    cfg.max = Math.max(1, +$('bjc-max').value || DEFAULTS.max);
    cfg.minDelay = Math.max(1, +$('bjc-min').value || DEFAULTS.minDelay);
    cfg.maxDelay = Math.max(cfg.minDelay, +$('bjc-maxd').value || DEFAULTS.maxDelay);
    cfg.refresh = $('bjc-refresh').checked;
    cfg.maxFail = Math.max(1, +$('bjc-maxfail').value || DEFAULTS.maxFail);
    cfg.dailyMax = Math.max(1, +$('bjc-daily').value || DEFAULTS.dailyMax);
    cfg.cooldownMin = Math.max(1, +$('bjc-cool').value || DEFAULTS.cooldownMin);
    GM_setValue('cfg', cfg);
  }

  /* ===================== 风控检测与熔断机制 ===================== */
  const RISK = {
    url: /\/web\/user\/(\?|$)|safe\/verify|verify-slider|captcha|security-check|\/error/i,
    title: /安全验证|访问异常|异常访问|请稍候/,
    phrases: [
      '安全验证', '访问异常', '异常访问', '请完成验证', '拖动滑块', '拖动下方滑块', '点击验证',
      '账号异常', '账号存在异常', '暂时无法访问', '操作过于频繁', '访问过于频繁', '请稍后再试',
      '请先登录', '登录后查看', '登录已过期', '被限制',
    ],
    overlay: '[class*="captcha"], [class*="geetest"], [class*="slider-verify"], [class*="verify-wrap"], [class*="verify-dialog"], iframe[src*="captcha"], iframe[src*="geetest"]',
  };

  function todayKey() { return new Date().toLocaleDateString(); }
  function getQuota() {
    const d = GM_getValue('quota', {});
    return d.date === todayKey() ? d.count || 0 : 0;
  }
  function addQuota() {
    GM_setValue('quota', { date: todayKey(), count: getQuota() + 1 });
    updateCount();
  }
  function getLock() {
    const l = GM_getValue('lock', null);
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
    try { ov = qa(document, RISK.overlay).find(visible); } catch (e) {}
    if (ov) return '检测到验证类弹窗或控件';
    const bodyText = [...document.body.children].filter((c) => c !== panel).map(txt).join('\n');
    const hit = RISK.phrases.find((p) => bodyText.includes(p));
    if (hit) return '页面出现风控/登录提示:' + hit;
    return '';
  }

  function trip(reason, silent) {
    running = false;
    GM_setValue('hb', 0);
    GM_setValue('lock', { until: Date.now() + cfg.cooldownMin * 60000, reason, at: Date.now() });
    panel.style.borderColor = '#e55';
    log('⛔ 已自动停止:' + reason);
    log(`冷却 ${cfg.cooldownMin} 分钟。请先在页面手动完成验证/登录，不要立刻重试。`);
    updateCount();
    $('bjc-start').disabled = false;
    if (!silent) setTimeout(() => alert(`采集已自动停止\n原因:${reason}\n冷却 ${cfg.cooldownMin} 分钟`), 50);
  }

  /* ===================== 岗位匹配 ===================== */
  function titleMatch(title) {
    const t = title.toLowerCase();
    if (splitList(cfg.exclude).some((k) => t.includes(k.toLowerCase()))) return '命中排除词';
    const names = splitList(cfg.titles);
    if (!names.length) return null;
    for (const n of names) {
      const nl = n.toLowerCase();
      if (t.includes(nl)) return null;
      if (cfg.mode === 'loose') {
        const core = nl.replace(/工程师$/, '');
        if (core.length >= 3 && t.includes(core)) return null;
        if (core.length >= 2 && t.includes(core) && /工程师|运维|技术支持|实施|维护/.test(t)) return null;
      }
    }
    return '不在目标岗位列表';
  }

  function descMatch(desc) {
    const kws = splitList(cfg.descInclude);
    if (!kws.length) return true;
    const d = desc.toLowerCase();
    return kws.some((k) => d.includes(k.toLowerCase()));
  }

  /* ===================== 数据提取核心 ===================== */
  function cardKey(card) {
    const href = q(card, SEL.cardLink)?.href || '';
    const m = href.match(/job_detail\/([^./?]+)/);
    if (m) return { key: m[1], url: href.split('?')[0] };
    const t = txt(q(card, SEL.cardTitle));
    const c = txt(q(card, SEL.cardCompany));
    return { key: `${t}@${c}`, url: href };
  }

  function extract(card, key, url) {
    const d = q(document, SEL.detail);
    if (!d) return null;
    const full = txt(d);
    const roots = [d, document.body];

    const title = txt(q(d, SEL.dTitle)) || txt(q(card, SEL.cardTitle));

    // 薪资
    const salaryRaw = txt(q(d, SEL.dSalary)) || txt(q(card, SEL.cardSalary));
    const sal = parseSalary(salaryRaw);

    // 经验 / 学历
    let info = classify(qa(d, SEL.dInfoTags).map(txt));
    if (!info.exp && !info.edu) {
      const header = txt(q(d, SEL.dHeader)).slice(0, 300);
      info = classify(header.split(/[\s\n|·]+/));
    }
    const cardInfo = classify(qa(card, SEL.cardInfoTags).map(txt));
    const exp = info.exp || cardInfo.exp;
    const edu = info.edu || cardInfo.edu;

    // 标签与福利
    const skills = uniq([...qa(d, SEL.dSkillTags).map(txt), ...qa(card, SEL.cardSkillTags).map(txt)]);
    const benefitDetail = qa(d, SEL.dBenefit).map(txt);
    const benefitCard = splitList(txt(q(card, SEL.cardBenefit)));
    const benefits = uniq([...benefitDetail, ...benefitCard]);

    // 企业属性
    const attr = txt(q(d, SEL.dBossAttr));
    let company = txt(q(card, SEL.cardCompany));
    if (!company && attr.includes('·')) company = attr.split('·')[0].trim();
    if (!company) company = txt(q(d, SEL.dCompany));
    const companyLink = (q(card, SEL.cardCompanyLink) || q(document, SEL.dCompanyLink))?.href?.split('?')[0] || '';

    const co = classify(qa(card, SEL.cardCompanyTags).map(txt));
    const sider = classify(qa(document, SEL.dSiderItems).map(txt));
    let industry = co.rest[0] || '';
    if (!industry) industry = sider.rest.find((x) => x.length <= 20 && !/公司|地址|查看|更多/.test(x)) || '';
    const scale = co.scale || sider.scale;
    const stage = co.stage || sider.stage;

    // 公司简介与工商信息
    const intro = sectionText(roots, '公司介绍', 800);
    const biz = sectionText(roots, '工商信息', 800);
    const fullName = kv(biz, '公司名称') || kv(biz, '企业名称');
    const bizScope = kv(biz, '经营范围');

    // 发布人
    let bossName = ownText(q(d, SEL.dBoss)) || txt(q(d, SEL.dBoss));
    bossName = bossName.replace(/(在线|刚刚活跃|今日活跃|本周活跃|.{0,4}活跃).*$/s, '').trim();
    const bossTitle = attr.includes('·') ? attr.split('·').pop().trim() : '';
    const bossActive = txt(q(d, SEL.dBossActive));

    // 发布日期
    let date = txt(q(d, SEL.dDate));
    const dm = (date || full).match(
      /(?:更新于|发布于|发布时间[::]?)\s*([0-9]{4}[-年./][0-9]{1,2}[-月./][0-9]{1,2}日?|[0-9]{1,2}月[0-9]{1,2}日|今天|昨天|前天|\d+\s*(?:分钟|小时|天|周|个月)前)/
    );
    date = dm ? dm[1] : date.replace(/^(更新于|发布于)[::]?\s*/, '');

    // 地址与正文 JD
    const area = txt(q(card, SEL.cardArea));
    const address = txt(q(d, SEL.dAddr)) || sectionText([d], '工作地址', 200);
    const desc = txt(q(d, SEL.dDesc)) || sectionText([d], '职位描述', 5000);

    // 派生计算
    const dv = derive([benefits.join('、'), skills.join('、'), desc].join('\n'));
    const dvAdv = deriveAdvanced(desc, benefits.join('、'));

    return Object.assign(
      {
        岗位: title,
        企业: company,
        企业全称: fullName,
        公司行业: industry,
        公司规模: scale,
        融资阶段: stage,
        公司简介: intro,
        经营范围: bizScope,
        企业类型: kv(biz, '企业类型') || kv(biz, '公司类型'),
        成立日期: kv(biz, '成立日期'),
        注册资金: kv(biz, '注册资金') || kv(biz, '注册资本'),
        经营状态: kv(biz, '经营状态'),
        公司主页: companyLink,
        薪资: sal.text,
        薪资下限: sal.min,
        薪资上限: sal.max,
        薪资单位: sal.unit,
        几薪: sal.months,
        薪资备注: sal.note,
        经验要求: exp,
        学历要求: edu,
        技能标签: skills.join('、'),
        福利标签: benefits.join('、'),
      },
      dv,
      dvAdv,
      {
        发布人: bossName,
        发布人职务: bossTitle,
        发布日期: date,
        HR活跃状态: bossActive,
        区域: area,
        工作地址: address,
        岗位描述: desc,
        链接: url,
        采集时间: new Date().toLocaleString(),
        _v: VER,
      }
    );
  }

  function mergeRec(oldRec, rec) {
    if (!oldRec) return rec;
    const out = Object.assign({}, oldRec);
    for (const [k, v] of Object.entries(rec)) {
      if (v !== '' && v != null) out[k] = v;
      else if (!(k in out)) out[k] = v;
    }
    return out;
  }

  /* ===================== 流程控制 ===================== */
  let running = false;
  const seen = new WeakSet();
  let lastDesc = '';

  async function collectCard(card) {
    const { key, url } = cardKey(card);
    const old = store[key];
    if (old && (old._v >= VER || !cfg.refresh)) {
      log(`已采集,跳过:${key.slice(0, 20)}`);
      return 'skip';
    }

    const listTitle = txt(q(card, SEL.cardTitle));
    const miss = titleMatch(listTitle);
    if (miss) {
      log(`跳过:${listTitle}(${miss})`);
      return 'skip';
    }

    let risk = detectRisk();
    if (risk) { trip(risk); return 'halt'; }

    card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await sleep(rand(400, 800));
    card.click();
    await sleep(rand(700, 1200));

    const cardTitle = txt(q(card, SEL.cardTitle));
    const ok = await waitFor(() => {
      const d = q(document, SEL.detail);
      if (!d) return false;
      const t = txt(q(d, SEL.dTitle));
      const desc = txt(q(d, SEL.dDesc));
      return t && desc && (!cardTitle || t.includes(cardTitle) || cardTitle.includes(t)) && desc !== lastDesc;
    }, 5000, 200);

    risk = detectRisk();
    if (risk) { trip(risk); return 'halt'; }

    const rec = extract(card, key, url);
    if (!rec || !rec.岗位) {
      log('详情未加载成功,不入库');
      return 'fail';
    }
    const titleOk = cardTitle && (rec.岗位.includes(cardTitle) || cardTitle.includes(rec.岗位));
    if (!ok && !titleOk) {
      log('详情未切换到当前岗位,不入库');
      return 'fail';
    }
    if (!ok) log('⚠ JD与上一条相同,可能是同公司重复岗位');
    if (!rec.岗位描述) {
      log('岗位描述为空,不入库');
      return 'fail';
    }
    lastDesc = rec.岗位描述;

    if (!descMatch(rec.岗位描述)) {
      log(`跳过:${rec.岗位}(描述未命中技能词)`);
      return 'skip';
    }

    store[key] = mergeRec(old, rec);
    GM_setValue('jobs', store);
    addQuota();
    log(`✔ ${rec.岗位} @ ${rec.企业} | ${rec.薪资 || rec.薪资备注 || '无薪资'} | ${rec.学历要求 || '-'} ${rec.经验要求 || '-'}${old ? ' (补采)' : ''}`);
    return 'ok';
  }

  async function loadMore() {
    const before = qa(document, SEL.card).length;
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    const wrap = q(document, SEL.card)?.parentElement;
    if (wrap) wrap.scrollTop = wrap.scrollHeight;
    await sleep(rand(1500, 2500));
    if (qa(document, SEL.card).length > before) return true;

    const next = q(document, SEL.nextPage);
    if (next && !/disabled/.test(next.className)) {
      log('翻到下一页…');
      next.click();
      await sleep(rand(2500, 3500));
      return true;
    }
    return false;
  }

  async function run() {
    readCfg();
    const lock = getLock();
    if (lock) {
      log(`冷却中,剩余约${Math.ceil((lock.until - Date.now()) / 60000)}分钟。原因:${lock.reason}`);
      return;
    }
    const risk0 = detectRisk();
    if (risk0) { trip(risk0); return; }

    const quotaLeft = cfg.dailyMax - getQuota();
    if (quotaLeft <= 0) {
      log(`今日累计已达上限 ${cfg.dailyMax} 条,今天不再采集。`);
      return;
    }
    const target = Math.min(cfg.max, quotaLeft);

    running = true;
    let got = 0;
    let failStreak = 0;
    let emptyRounds = 0;
    $('bjc-start').disabled = true;
    panel.style.borderColor = '#4a7cff';
    log(`开始采集,本次目标 ${target} 条(今日剩余额度 ${quotaLeft});连续失败 ${cfg.maxFail} 条将自动停止`);

    while (running && got < target) {
      GM_setValue('hb', Date.now());
      const r = detectRisk();
      if (r) { trip(r); break; }

      const cards = qa(document, SEL.card).filter((c) => !seen.has(c));
      if (!cards.length) {
        const more = await loadMore();
        if (!more && ++emptyRounds >= 2) {
          log('没有更多岗位了');
          break;
        }
        continue;
      }
      emptyRounds = 0;

      for (const card of cards) {
        if (!running || got >= target) break;
        seen.add(card);
        GM_setValue('hb', Date.now());
        let st;
        try { st = await collectCard(card); } catch (e) { log('出错:' + e.message); st = 'fail'; }
        if (st === 'halt') break;
        if (st === 'ok') {
          got++;
          failStreak = 0;
          await sleep(rand(cfg.minDelay, cfg.maxDelay) * 1000);
        } else if (st === 'fail') {
          if (++failStreak >= cfg.maxFail) {
            trip(`连续 ${failStreak} 条详情加载失败(可能页面改版、被限制或网络异常)`);
            break;
          }
          await sleep(rand(2000, 4000));
        }
      }
    }

    if (running && got >= target && target < cfg.max) log(`已达今日额度上限(${cfg.dailyMax}),停止`);
    running = false;
    GM_setValue('hb', 0);
    $('bjc-start').disabled = false;
    log(`采集完成,本次新增/补采 ${got} 条`);
  }

  /* ===================== 诊断与工具 ===================== */
  function diagnose() {
    log('--- 选择器诊断 ---');
    for (const [k, s] of Object.entries(SEL)) {
      let n = 0;
      let f = '';
      try {
        n = document.querySelectorAll(s).length;
        f = txt(document.querySelector(s)).slice(0, 24).replace(/\n/g, ' ');
      } catch (e) { f = '选择器语法错误'; }
      log(`${n ? '✔' : '✘'} ${k}: ${n}个 ${f}`);
    }
  }

  function outline(el, depth = 0) {
    if (!el || depth > 7) return '';
    const cls = el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : '';
    const own = ownText(el).slice(0, 12);
    let s = '  '.repeat(depth) + el.tagName.toLowerCase() + cls + (own ? ` "${own}"` : '') + '\n';
    [...el.children].slice(0, 14).forEach((c) => (s += outline(c, depth + 1)));
    return s;
  }

  function copyStructure() {
    const card = q(document, SEL.card);
    const d = q(document, SEL.detail);
    let out = '--- CARD ---\n' + outline(card) + '\n--- DETAIL ---\n' + outline(d);
    out = out.slice(0, 15000);
    GM_setClipboard(out);
    log(`已复制页面结构(${out.length}字符)到剪贴板。`);
  }

  /* ===================== 导出功能与字段列表 ===================== */
  const FIELDS = [
    // 岗位与企业信息
    '岗位', '企业', '企业全称', '公司行业', '公司规模', '融资阶段', '公司简介', '经营范围', '企业类型', '成立日期', '注册资金', '经营状态', '公司主页',
    // 薪资与门槛
    '薪资', '薪资下限', '薪资上限', '薪资单位', '几薪', '薪资备注', '经验要求', '学历要求', '技能标签', '福利标签',
    // 福利与工时派生
    '双休', '五险一金', '包吃', '包住', '餐补', '交通补贴', '年终奖多薪', '年假体检节日', '补充保险股权', '加班说明', '轮班夜班', '出差', '驻场现场', '全日制统招', '英语要求',
    // 深度解析派生字段
    '合同性质', '试用期', '工作时间', '证书要求', '核心技能_JD', '专业要求',
    // 基础信息与元数据
    '发布人', '发布人职务', '发布日期', 'HR活跃状态', '区域', '工作地址', '岗位描述', '链接', '采集时间'
  ];

  function download(name, content, mime) {
    const blob = new Blob([content], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

  function exportCSV() {
    const rows = Object.values(store);
    if (!rows.length) return log('没有数据可导出');
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [FIELDS.map(esc).join(',')];
    rows.forEach((r) => lines.push(FIELDS.map((f) => esc(r[f])).join(',')));
    download(`boss_jobs_${stamp()}.csv`, '\ufeff' + lines.join('\r\n'), 'text/csv;charset=utf-8');
    log(`已导出 CSV,共 ${rows.length} 条`);
  }

  function exportJSON() {
    const rows = Object.values(store);
    if (!rows.length) return log('没有数据可导出');
    download(`boss_jobs_${stamp()}.json`, JSON.stringify(rows, null, 2), 'application/json');
    log(`已导出 JSON,共 ${rows.length} 条`);
  }

  /* ===================== 事件绑定 ===================== */
  $('bjc-start').onclick = () => !running && run();
  $('bjc-stop').onclick = () => { if (running) log('正在停止…'); running = false; };
  $('bjc-csv').onclick = exportCSV;
  $('bjc-json').onclick = exportJSON;
  $('bjc-diag').onclick = diagnose;
  $('bjc-struct').onclick = copyStructure;
  $('bjc-import').onclick = () => $('bjc-file').click();
  $('bjc-file').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const arr = JSON.parse(await file.text());
      if (!Array.isArray(arr)) throw new Error('文件格式不对,需要是导出的 JSON 数组');
      let added = 0, upgraded = 0;
      arr.forEach((r) => {
        const m = (r.链接 || '').match(/job_detail\/([^./?]+)/);
        const key = m ? m[1] : `${r.岗位}@${r.企业}`;
        if (!store[key]) {
          store[key] = r;
          added++;
        } else if ((r._v || 0) > (store[key]._v || 0)) {
          store[key] = mergeRec(store[key], r);
          upgraded++;
        }
      });
      GM_setValue('jobs', store);
      updateCount();
      log(`导入完成:新增 ${added} 条,升级 ${upgraded} 条`);
    } catch (err) {
      log('导入失败:' + err.message);
    }
    e.target.value = '';
  };

  $('bjc-unlock').onclick = () => {
    const l = GM_getValue('lock', null);
    if (!l || l.until <= Date.now()) return log('当前没有冷却');
    if (!confirm(`上次熔断原因:${l.reason}\n请确认已在页面手动完成验证/登录且页面恢复正常。\n确定解除冷却吗?`)) return;
    GM_setValue('lock', null);
    panel.style.borderColor = '#4a7cff';
    updateCount();
    log('已解除冷却');
  };

  $('bjc-clear').onclick = () => {
    if (!confirm('确定清空所有已保存的岗位数据吗?')) return;
    store = {};
    GM_setValue('jobs', store);
    updateCount();
    log('已清空');
  };

  // 页面启动自检
  setTimeout(() => {
    const l = getLock();
    if (l) {
      panel.style.borderColor = '#e55';
      log(`⛔ 冷却中(原因:${l.reason}),剩余约${Math.ceil((l.until - Date.now()) / 60000)}分钟`);
      return;
    }
    const hb = GM_getValue('hb', 0);
    if (hb && Date.now() - hb < 60000) {
      const r = detectRisk();
      if (r) trip('采集过程中页面被刷新或跳转:' + r, true);
      else log('检测到上次采集被中断(页面刷新),已停止,如需继续请手动点开始。');
    }
    GM_setValue('hb', 0);
  }, 2000);
})();