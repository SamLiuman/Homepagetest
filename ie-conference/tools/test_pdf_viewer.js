/* pdf-viewer.html 的回归测试：在 Node 里用最小 DOM + 假的 pdf.js 跑一遍渲染状态机。
   验证：首屏自适应 / 翻页 / 缩放 / 并发取消 / dpr 只应用一次 / 兜底链接。

   不依赖网络和真实浏览器，改完阅读器直接跑：
       node ie-conference/tools/test_pdf_viewer.js
   也可以指定别的页面：
       node ie-conference/tools/test_pdf_viewer.js path/to/pdf-viewer.html

   历史背景：首版曾因渲染布尔锁在首屏自适应分支里 return 时未复位，
   导致锁永远不解开，翻页与缩放全部失效 —— 本测试的第 2、3 组专门盯这个回归。 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const target = process.argv[2] || path.join(__dirname, '..', 'pdf-viewer.html');
const HTML = fs.readFileSync(target, 'utf8');

// 取最后一个 <script> 块
const blocks = [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)];
if (!blocks.length) { console.error('没找到 script 块'); process.exit(1); }
const code = blocks[blocks.length - 1][1];

const PAGE_W = 595, PAGE_H = 842;
const DPR = 2;                 // 故意用 2，检验 dpr 是否被重复应用
const STAGE_W = 900, STAGE_H = 700, PAD = 20;

const renderLog = [];          // 每次真实 render 调用的记录

function makeEl(id) {
  const el = {
    id, textContent: '', innerHTML: '', title: '', href: '', src: '', hidden: false, disabled: false, onclick: null,
    style: {}, src2: null,
    _cls: new Set(),
    classList: {
      add(c) { el._cls.add(c); },
      remove(c) { el._cls.delete(c); },
      contains(c) { return el._cls.has(c); },
      toggle(c, on) { if (on === undefined) { el._cls.has(c) ? el._cls.delete(c) : el._cls.add(c); } else { on ? el._cls.add(c) : el._cls.delete(c); } }
    },
    appendChild() {},
    getContext() { return { clearRect() {}, setTransform() {} }; }
  };
  if (id === 'stage') { el.clientWidth = STAGE_W; el.clientHeight = STAGE_H; }
  return el;
}

const els = {};
const ids = ['stage','msg','fallbackFrame','toolbar','docName','openBtn','dlBtn','rawTip',
             'firstBtn','prevBtn','pageInd','nextBtn','lastBtn','outBtn','zoomInd','inBtn','fitBtn'];
for (const id of ids) els[id] = makeEl(id);

let canvasEl = null;
const created = [];

const sandbox = {};
const win = sandbox;

Object.assign(sandbox, {
  console,
  URLSearchParams,
  URL,
  setTimeout, clearTimeout,
  Promise, Math, JSON, Date, Error, isFinite, parseFloat, parseInt, String, Number,
  devicePixelRatio: DPR,
  location: {
    href: 'http://127.0.0.1:8765/ie-conference/pdf-viewer.html?file=' +
          encodeURIComponent('./教学科研竞赛委员会/【测试】三页样张.pdf') +
          '&name=' + encodeURIComponent('三页样张'),
    search: '?file=' + encodeURIComponent('./教学科研竞赛委员会/【测试】三页样张.pdf') +
            '&name=' + encodeURIComponent('三页样张'),
    protocol: 'http:',
    origin: 'http://127.0.0.1:8765'
  },
  history: { length: 3 },
  addEventListener() {},
  getComputedStyle() {
    return { paddingLeft: PAD + 'px', paddingRight: PAD + 'px',
             paddingTop: PAD + 'px', paddingBottom: PAD + 'px' };
  },
  document: {
    getElementById(id) { return els[id] || null; },
    createElement(tag) {
      const el = makeEl('created:' + tag);
      if (tag === 'canvas') {
        canvasEl = el;
        el.getContext = () => ({ clearRect() {}, setTransform() {} });
      }
      created.push({ tag, el });
      return el;
    },
    addEventListener() {},
    head: {
      appendChild(el) {
        // 模拟脚本加载成功：先把 pdfjsLib 挂上，再异步触发 onload
        if (el && /pdf\.min\.js/.test(el.src || '')) win.pdfjsLib = fakeLib();
        setTimeout(() => { el && el.onload && el.onload(); }, 0);
      }
    }
  }
});
sandbox.window = sandbox;

function fakeLib() {
  return {
    GlobalWorkerOptions: {},
    getDocument() {
      return { promise: Promise.resolve(makePdf(3)) };
    }
  };
}

function makePdf(numPages) {
  return {
    numPages,
    getPage(n) {
      return Promise.resolve({
        getViewport({ scale }) {
          return { width: PAGE_W * scale, height: PAGE_H * scale };
        },
        render(opts) {
          const rec = { page: n, scale: opts.viewport.width / PAGE_W,
                        transform: opts.transform, cancelled: false };
          renderLog.push(rec);
          let rej;
          const task = {
            cancel() { rec.cancelled = true; rej({ name: 'RenderingCancelledException' }); },
            promise: null
          };
          // 故意给 30ms 渲染耗时，这样才能测「渲染进行中被打断」的取消路径
          task.promise = new Promise((res, r) => {
            rej = r;
            setTimeout(() => res(), 30);
          });
          return task;
        }
      });
    }
  };
}

vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'pdf-viewer.html' });

/* ---------------- 断言 ---------------- */
let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  [通过] ' + label); }
  else { fail++; console.log('  [失败] ' + label + (extra ? '  → ' + extra : '')); }
}
const tick = (n = 5) => new Promise(r => setTimeout(r, n));

(async () => {
  await tick(90);

  console.log('\n=== 1. 首屏 ===');
  console.log('  页码=' + els.pageInd.textContent + '  缩放=' + els.zoomInd.textContent +
              '  canvas CSS=' + canvasEl.style.width + 'x' + canvasEl.style.height +
              '  bitmap=' + canvasEl.width + 'x' + canvasEl.height);
  ok(els.pageInd.textContent === '1 / 3', '页码显示 1 / 3', els.pageInd.textContent);
  ok(els.toolbar.hidden === false, '工具栏已显示');
  ok(renderLog.length >= 1, '发生了渲染调用', '次数=' + renderLog.length);

  const cssW = parseInt(canvasEl.style.width, 10);
  const bitW = canvasEl.width;
  ok(bitW === Math.floor(cssW * DPR), 'dpr 只应用一次（bitmap = CSS 宽 x dpr）',
     'bitmap=' + bitW + ' 期望=' + Math.floor(cssW * DPR));
  ok(!cssW || Math.abs(cssW - bitW / DPR) < 2, '没有被 dpr 平方放大',
     'CSS=' + cssW + ' bitmap=' + bitW);

  // 适应页面：宽高双向约束后的期望值
  const availW = STAGE_W - PAD * 2 - 4, availH = STAGE_H - PAD * 2 - 4;
  let expect = Math.min(availW / PAGE_W, availH / PAGE_H);
  expect = Math.round(expect * 100) / 100;
  ok(els.zoomInd.textContent === Math.round(expect * 100) + '%',
     '首屏按可视区自适应（期望 ' + Math.round(expect * 100) + '%）', els.zoomInd.textContent);

  console.log('\n=== 2. 翻页（旧版在这里死锁） ===');
  const before = renderLog.length;
  els.nextBtn.onclick();
  await tick(90);
  ok(els.pageInd.textContent === '2 / 3', '点「下一页」后页码变 2 / 3', els.pageInd.textContent);
  ok(renderLog.length > before, '确实重新渲染了', before + ' -> ' + renderLog.length);

  els.lastBtn.onclick();
  await tick(90);
  ok(els.pageInd.textContent === '3 / 3', '点「末页」后页码变 3 / 3', els.pageInd.textContent);
  ok(els.nextBtn.disabled === true, '末页时「下一页」被禁用');

  els.firstBtn.onclick();
  await tick(90);
  ok(els.pageInd.textContent === '1 / 3', '点「首页」回到 1 / 3', els.pageInd.textContent);
  ok(els.prevBtn.disabled === true, '首页时「上一页」被禁用');

  console.log('\n=== 3. 缩放 ===');
  const wBefore = parseInt(canvasEl.style.width, 10);
  const zBefore = els.zoomInd.textContent;
  els.inBtn.onclick();
  await tick(90);
  const wAfter = parseInt(canvasEl.style.width, 10);
  console.log('  放大前 CSS宽=' + wBefore + ' 缩放=' + zBefore +
              '  →  放大后 CSS宽=' + wAfter + ' 缩放=' + els.zoomInd.textContent);
  ok(wAfter > wBefore, '放大后画布 CSS 宽度变大（旧版被 max-width:100% 压住不变）',
     wBefore + ' -> ' + wAfter);
  ok(els.fitBtn.classList.contains('on') === false, '手动缩放后「适应页面」按钮取消高亮');

  els.outBtn.onclick();
  await tick(90);
  const wAfter2 = parseInt(canvasEl.style.width, 10);
  ok(wAfter2 < wAfter, '缩小后画布宽度变小', wAfter + ' -> ' + wAfter2);

  els.fitBtn.onclick();
  await tick(90);
  ok(els.fitBtn.classList.contains('on') === true, '点「适应页面」恢复高亮');
  ok(els.zoomInd.textContent === Math.round(expect * 100) + '%',
     '回到自适应比例', els.zoomInd.textContent);

  console.log('\n=== 4a. 连点（请求在渲染开始前就被令牌拦掉） ===');
  els.firstBtn.onclick();
  await tick(90);
  renderLog.length = 0;
  els.nextBtn.onclick();
  els.nextBtn.onclick();
  els.lastBtn.onclick();
  await tick(120);
  ok(els.pageInd.textContent === '3 / 3', '连点后停在最后请求的那一页', els.pageInd.textContent);
  ok(renderLog.length === 1, '只有最后一次真正渲染，中间请求未产生渲染',
     '渲染 ' + renderLog.length + ' 次');

  console.log('\n=== 4b. 渲染进行中被打断（走 cancel 路径） ===');
  els.firstBtn.onclick();
  await tick(90);
  renderLog.length = 0;
  els.nextBtn.onclick();      // 开始渲染第 2 页
  await tick(10);             // 已调用 page.render，但 30ms 未到，任务仍在飞行
  els.lastBtn.onclick();      // 打断它，请求第 3 页
  await tick(150);
  const cancelled = renderLog.filter(r => r.cancelled).length;
  console.log('  渲染调用 ' + renderLog.length + ' 次，其中被取消 ' + cancelled + ' 次');
  ok(cancelled === 1, '进行中的渲染被 cancel', '取消 ' + cancelled + ' 次');
  ok(els.pageInd.textContent === '3 / 3', '取消后最终显示正确的页', els.pageInd.textContent);
  ok(els.rawTip.style.display !== 'block',
     'RenderingCancelledException 未被误判成失败而降级');

  console.log('\n=== 5. 兜底降级 ===');
  ok(typeof els.dlBtn.href === 'string' && els.dlBtn.href.indexOf('.pdf') > 0,
     '下载链接指向 PDF', els.dlBtn.href.slice(0, 70));

  console.log('\n----------------------------');
  console.log(fail === 0 ? '全部通过（' + pass + ' 项）' : pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail === 0 ? 0 : 1);
})();
