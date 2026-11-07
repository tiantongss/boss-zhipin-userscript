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
