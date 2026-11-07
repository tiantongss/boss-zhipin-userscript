// ==UserScript==
// @name         BOSS直聘 自动打招呼(海投助手安全增强版)
// @namespace    https://github.com/tiantongss/boss-zhipin-userscript
// @version      1.2.1
// @description  在职位搜索页自动逐个点击"立即沟通",支持关键词过滤、随机长间隔、安全熔断机制、防风控冷却锁、弹窗自动处理与异常强行停止
// @updateURL    https://cdn.jsdelivr.net/gh/tiantongss/boss-zhipin-userscript@main/boss-zhipin-auto-greeter.user.js
// @downloadURL  https://cdn.jsdelivr.net/gh/tiantongss/boss-zhipin-userscript@main/boss-zhipin-auto-greeter.user.js
// @match        https://www.zhipin.com/web/geek/job*
// @match        https://www.zhipin.com/web/geek/jobs*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';
  console.log('[%s] 脚本已加载 v1.2.0 (安全增强版)', 'BOSS海投助手');

  /* ===================== 配置 ===================== */
  const DEFAULTS = {
    include: '',          // 职位名必须包含其一(逗号分隔,留空不限)
    exclude: '外包,销售,实习', // 职位名含其一则跳过
    excludeCompany: '',   // 公司名含其一则跳过
    max: 50,              // 本次最多投递数量
    minDelay: 8,          // 每次投递最小间隔(秒)
    maxDelay: 20,         // 每次投递最大间隔(秒)
    maxFail: 3,           // 连续失败N条即熔断停止
    cooldownMin: 30,      // 熔断后冷却(分钟)
  };
  const cfg = Object.assign({}, DEFAULTS, GM_getValue('cfg', {}));

  // 选择器集中放这里,BOSS 改版后只需改这里
  const SEL = {
    card: '.job-card-wrapper, .job-card-box',
    cardTitle: '.job-name, .job-title',
    cardCompany: '.company-name, .boss-name',
    detail: '.job-detail-box, .job-detail',
    chatBtn: '.job-detail-box .btn-startchat, .job-detail-box .op-btn-chat, .job-detail .btn-startchat',
    nextPage: '.options-pages a.next, .options-pages .next',
    dialog: '.dialog-container, .greet-boss-dialog',
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
    const l = GM_getValue('bag_lock', null);
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
    GM_setValue('bag_hb', 0);
    GM_setValue('bag_lock', { until: Date.now() + cfg.cooldownMin * 60000, reason, at: Date.now() });
    panel.style.borderColor = '#e55';
    log('⛔ 已自动停止:' + reason);
    log(`安全冷却 ${cfg.cooldownMin} 分钟。请先在页面手动完成验证/处理异常，不要立刻重试。`);
    updateStatus();
    $('bag-start').disabled = false;
    if (!silent) setTimeout(() => alert(`海投助手已安全熔断\n原因:${reason}\n已进入冷却期 ${cfg.cooldownMin} 分钟`), 50);
  }

  /* ===================== UI 界面 ===================== */
  GM_addStyle(`
    #bag-panel{position:fixed;right:16px;bottom:16px;width:300px;z-index:99999;background:#fff;
      border:1px solid #00bebd;border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.18);
      font:12px/1.5 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#333}
    #bag-panel header{background:#00bebd;color:#fff;padding:6px 10px;border-radius:9px 9px 0 0;
      display:flex;justify-content:space-between;cursor:pointer;font-weight:600}
    #bag-body{padding:8px 10px}
    #bag-panel label{display:block;margin:4px 0 2px;color:#666}
    #bag-panel input{width:100%;box-sizing:border-box;padding:3px 6px;border:1px solid #ccc;border-radius:4px}
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
      <label>职位名包含(逗号分隔,留空不限)</label><input id="bag-include">
      <label>职位名排除</label><input id="bag-exclude">
      <label>公司名排除</label><input id="bag-excomp">
      <div class="row">
        <div><label>最大数量</label><input id="bag-max" type="number" min="1"></div>
        <div><label>间隔下限(s)</label><input id="bag-min" type="number" min="3"></div>
        <div><label>间隔上限(s)</label><input id="bag-maxd" type="number" min="3"></div>
      </div>
      <div class="row">
        <button id="bag-start">开始投递</button>
        <button id="bag-stop">停止</button>
      </div>
      <div class="row">
        <button id="bag-unlock" style="background:#888; margin-top:4px;">解除冷却(已手动处理)</button>
      </div>
      <div id="bag-count"></div>
      <div id="bag-log"></div>
    </div>`;
  document.body.appendChild(panel);

  const $ = (id) => document.getElementById(id);
  $('bag-include').value = cfg.include;
  $('bag-exclude').value = cfg.exclude;
  $('bag-excomp').value = cfg.excludeCompany;
  $('bag-max').value = cfg.max;
  $('bag-min').value = cfg.minDelay;
  $('bag-maxd').value = cfg.maxDelay;

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
    cfg.include = $('bag-include').value;
    cfg.exclude = $('bag-exclude').value;
    cfg.excludeCompany = $('bag-excomp').value;
    cfg.max = Math.max(1, +$('bag-max').value || DEFAULTS.max);
    cfg.minDelay = Math.max(3, +$('bag-min').value || DEFAULTS.minDelay);
    cfg.maxDelay = Math.max(cfg.minDelay, +$('bag-maxd').value || DEFAULTS.maxDelay);
    GM_setValue('cfg', cfg);
  }

  /* ===================== 核心逻辑 ===================== */
  let running = false;
  const seen = new WeakSet();
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

  // 寻找「留在此页」按钮
  function findStayBtn() {
    const els = document.querySelectorAll('a,button,span,div,p,li');
    for (const el of els) {
      if (el.offsetParent === null) continue;
      if (/^\s*留在此页面?\s*$/.test(el.textContent)) {
        const inner = [...el.querySelectorAll('*')].find((c) => /^\s*留在此页面?\s*$/.test(c.textContent));
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

  async function closeDialog() {
    const btn = await waitFor(findStayBtn, 2000, 100);
    if (btn) {
      clickStay(btn);
      log('已点击"留在此页"');
      await sleep(500);
      return;
    }
    const close = document.querySelector(`${SEL.dialog} .close, ${SEL.dialog} .icon-close, ${SEL.dialog} .cancel-btn`);
    if (close) {
      close.click();
      log('未找到"留在此页",已点关闭按钮');
      await sleep(500);
    }
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

    card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await sleep(rand(500, 900));
    card.click(); // 加载详情
    await sleep(rand(800, 1400));

    const btn = await waitFor(() => document.querySelector(SEL.chatBtn), 4000);
    if (!btn) {
      log(`未找到沟通按钮:${title}`);
      return 'fail';
    }
    const text = btn.textContent.trim();
    if (!/立即沟通/.test(text)) {
      log(`已沟通过,跳过:${title} @ ${company}`);
      return 'skip';
    }

    btn.click();
    await sleep(rand(900, 1500));

    // 投递后再次严格检测是否触发风控限制
    const riskAfter = detectRisk();
    if (riskAfter) {
      trip('投递后触发限制或风控: ' + riskAfter);
      return 'halt';
    }

    await closeDialog();
    sent++;
    log(`✔ 已投递(${sent}/${cfg.max}):${title} @ ${company}`);
    return 'ok';
  }

  async function loadMore() {
    const before = document.querySelectorAll(SEL.card).length;
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    const listEl = document.querySelector(SEL.card)?.parentElement;
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

  async function run() {
    readCfg();
    const lock = getLock();
    if (lock) {
      log(`⛔ 安全冷却中,剩余约${Math.ceil((lock.until - Date.now()) / 60000)}分钟。原因:${lock.reason}`);
      return;
    }

    const risk0 = detectRisk();
    if (risk0) {
      trip(risk0);
      return;
    }

    running = true;
    sent = 0;
    let failStreak = 0;
    $('bag-start').disabled = true;
    panel.style.borderColor = '#00bebd';
    log(`开始运行,上限 ${cfg.max} 个；连续失败 ${cfg.maxFail} 次将自动熔断`);
    let emptyRounds = 0;

    while (running && sent < cfg.max) {
      GM_setValue('bag_hb', Date.now());
      
      const r = detectRisk();
      if (r) {
        trip(r);
        break;
      }

      const cards = [...document.querySelectorAll(SEL.card)].filter((c) => !seen.has(c));
      if (!cards.length) {
        const more = await loadMore();
        if (!more && ++emptyRounds >= 2) {
          log('没有更多职位了');
          break;
        }
        continue;
      }
      emptyRounds = 0;

      for (const card of cards) {
        if (!running || sent >= cfg.max) break;
        seen.add(card);
        GM_setValue('bag_hb', Date.now());

        let st = 'skip';
        try {
          st = await processCard(card);
        } catch (e) {
          log('出错:' + e.message);
          st = 'fail';
        }

        if (st === 'halt') break;
        if (st === 'ok') {
          failStreak = 0;
          await sleep(rand(cfg.minDelay, cfg.maxDelay) * 1000);
        } else if (st === 'fail') {
          if (++failStreak >= cfg.maxFail) {
            trip(`连续失败 ${failStreak} 次，触发熔断保护机制`);
            break;
          }
          await sleep(rand(2000, 4000));
        }
      }
    }

    running = false;
    GM_setValue('bag_hb', 0);
    $('bag-start').disabled = false;
    log(`结束,本次共投递 ${sent} 个`);
  }

  /* ===================== 按钮绑定 ===================== */
  $('bag-start').onclick = () => !running && run();
  $('bag-stop').onclick = () => {
    if (running) log('正在手动停止…');
    running = false;
  };
  $('bag-unlock').onclick = () => {
    const l = GM_getValue('bag_lock', null);
    if (!l || l.until <= Date.now()) return log('当前没有处于冷却中');
    if (!confirm(`上次熔断原因:${l.reason}\n请确认已在页面手动完成验证/处理，确定解除冷却吗？`)) return;
    GM_setValue('bag_lock', null);
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