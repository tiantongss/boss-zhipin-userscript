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
