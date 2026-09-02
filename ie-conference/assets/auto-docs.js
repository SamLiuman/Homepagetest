/*!
 * auto-docs.js v1.0 —— 静态站「目录自动列表」引擎
 *
 * 用法：给列表 <ul class="notice-list"> 加上属性即可
 *   data-auto-dir="教学科研竞赛委员会"          必填，目录名（相对当前页面）
 *   data-auto-manifest="data/committee-docs.json"  可选，静态清单（由 GitHub Actions 生成，作兜底）
 *   data-auto-badge="文件"                      可选，统一徽标文字（默认按扩展名自动：PDF / 文件）
 *   data-auto-new-days="30"                     可选，多少天内算「最新」，默认 30 天
 *   data-auto-sort="date-desc"                  可选，date-desc（默认）| name
 *   data-auto-viewer="pdf-viewer.html"          可选，PDF 站内阅读页；留空（data-auto-viewer=""）则直链文件
 *
 * 仓库信息默认从 GitHub Pages 域名自动推断；若使用自定义域名，请在页面 <head> 里声明：
 *   window.IE_SITE_CONFIG = { owner:'用户名', repo:'仓库名', branch:'main', base:'/' }
 *   base = 站点 URL 中「仓库根目录」对应的路径前缀，例如项目站是 '/仓库名/'
 *
 * 数据源优先级：静态清单（秒开） → GitHub API（实时） → 页面内写死的条目（最终兜底）
 */
(function () {
  'use strict';

  var CONFIG = window.IE_SITE_CONFIG || {};
  var ACCEPT_EXT = ['pdf', 'html', 'htm'];   // 收录的文件类型
  var BRANCHES = CONFIG.branch ? [CONFIG.branch] : ['main', 'master'];

  /* ---------------- 小工具 ---------------- */

  function encodeSegs(p) {
    return String(p).split('/').filter(function (s) { return s.length; })
      .map(encodeURIComponent).join('/');
  }

  function extOf(name) {
    var i = String(name).lastIndexOf('.');
    return i < 0 ? '' : String(name).slice(i + 1).toLowerCase();
  }

  function titleOf(name) {
    var i = String(name).lastIndexOf('.');
    return i < 0 ? name : String(name).slice(0, i);
  }

  function fmtSize(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return Math.round(n / 1024) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  function onlyDate(s) {
    if (!s) return '';
    var t = Date.parse(s);
    if (isNaN(t)) return String(s).slice(0, 10);
    var d = new Date(t);
    function pad(x) { return x < 10 ? '0' + x : '' + x; }
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function isNew(dateStr, days) {
    if (!dateStr) return false;
    var t = Date.parse(dateStr);
    if (isNaN(t)) return false;
    return (Date.now() - t) < days * 86400000;
  }

  /* ---------------- 仓库 / 路径推断 ---------------- */

  function detectRepo() {
    if (CONFIG.owner && CONFIG.repo) return { owner: CONFIG.owner, repo: CONFIG.repo };
    var host = location.hostname;
    if (!host || host.indexOf('github.io') < 0) return null;
    var owner = host.split('.')[0];
    var segs = location.pathname.split('/').filter(Boolean);
    var repo = segs.length ? segs[0] : owner + '.github.io';
    return { owner: owner, repo: repo };
  }

  // 站点 URL 里「仓库根」所在的前缀
  function contentBase(repo) {
    if (CONFIG.base != null) return CONFIG.base;
    if (!repo) return '/';
    var segs = location.pathname.split('/').filter(Boolean);
    if (segs.length && segs[0] === repo.repo) return '/' + repo.repo + '/';
    return '/';
  }

  // 当前页面所在目录（仓库根相对路径，无首尾斜杠）
  function pageRepoDir(base) {
    var p = location.pathname;
    var dir = p.slice(0, p.lastIndexOf('/') + 1);        // '/repo/ie-conference/'
    var rel = (base !== '/' && dir.indexOf(base) === 0) ? dir.slice(base.length)
                                                        : dir.replace(/^\//, '');
    return rel.replace(/\/$/, '');                        // 'ie-conference'
  }

  // 把「仓库根相对路径」转成「相对当前页面的路径」（未编码，中文保持原样）
  function pageRelPath(pageRelDir, repoRelPath) {
    var prefix = pageRelDir ? pageRelDir + '/' : '';
    var tail = (prefix && repoRelPath.indexOf(prefix) === 0)
      ? repoRelPath.slice(prefix.length)
      : repoRelPath;
    return './' + tail;
  }

  // 逐段编码，用于生成 <a href>
  function encodePath(p) {
    return String(p).split('/').map(function (s) {
      return s === '.' ? '.' : encodeURIComponent(s);
    }).join('/');
  }

  // 把「相对当前页面的目录名」转成「仓库根相对路径」
  function repoRelOf(pageRelDir, rel) {
    return pageRelDir ? pageRelDir + '/' + rel : rel;
  }

  /* ---------------- 数据源 1：静态清单 ---------------- */

  function loadManifest(url) {
    return fetch(url, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('manifest ' + r.status);
      return r.json();
    });
  }

  function itemsFromManifest(data, pageRelDir, dirName) {
    // 清单既可以是 { files:[...] }（单目录），也可以是 { dirs:{ 目录名:[...] } }（多目录共用一份）
    var files = (data && data.files) || [];
    if (data && data.dirs) {
      files = data.dirs[dirName] || data.dirs[repoRelOf(pageRelDir, dirName)] || [];
    }
    return files.filter(function (f) {
      return !f.hidden && ACCEPT_EXT.indexOf(extOf(f.name || f.path)) >= 0;
    }).map(function (f) {
      var path = f.path || f.name;
      return {
        name: f.name || path.split('/').pop(),
        title: f.title || titleOf(f.name || path),
        date: f.date || '',
        size: f.size,
        type: extOf(f.name || path),
        path: path,
        href: encodePath(pageRelPath(pageRelDir, path))
      };
    });
  }

  /* ---------------- 数据源 2：GitHub API ---------------- */

  function ghGET(url) {
    return fetch(url, { headers: { 'Accept': 'application/vnd.github+json' } })
      .then(function (r) {
        if (!r.ok) throw new Error('github ' + r.status);
        return r.json();
      });
  }

  function tryBranches(fn) {
    return BRANCHES.reduce(function (chain, b) {
      return chain.catch(function () { return fn(b); });
    }, Promise.reject(new Error('init')));
  }

  function fetchList(repo, repoDir, branch) {
    var url = 'https://api.github.com/repos/' + repo.owner + '/' + repo.repo +
              '/contents/' + encodeSegs(repoDir) + '?ref=' + encodeURIComponent(branch);
    return ghGET(url).then(function (arr) {
      if (!Array.isArray(arr)) throw new Error('not a directory');
      return arr.filter(function (f) {
        return f.type === 'file' && ACCEPT_EXT.indexOf(extOf(f.name)) >= 0;
      }).map(function (f) {
        return {
          name: f.name,
          title: titleOf(f.name),
          date: '',
          size: f.size,
          type: extOf(f.name),
          path: f.path,
          href: ''   // 稍后统一按页面相对路径生成
        };
      });
    });
  }

  // 兼容旧调用名（内部已改为 pageRelPath + encodePath）
  function hrefFromRepoRel(pageRelDir, repoRelPath) {
    return encodePath(pageRelPath(pageRelDir, repoRelPath));
  }

  function fetchDates(repo, repoDir, branch) {
    var url = 'https://api.github.com/repos/' + repo.owner + '/' + repo.repo +
              '/commits?path=' + encodeSegs(repoDir) +
              '&per_page=100&sha=' + encodeURIComponent(branch);
    return ghGET(url).then(function (list) {
      var map = {};
      (Array.isArray(list) ? list : []).forEach(function (c) {
        var d = c.commit && c.commit.author && c.commit.author.date;
        (c.files || []).forEach(function (f) {
          if (d && !map[f.filename]) map[f.filename] = d;   // 首次出现即最新
        });
      });
      return map;
    }).catch(function () { return {}; });   // 拿不到日期不影响列表本身
  }

  function itemsFromGitHub(repo, repoDir, pageRelDir) {
    return tryBranches(function (branch) {
      return fetchList(repo, repoDir, branch).then(function (items) {
        return fetchDates(repo, repoDir, branch).then(function (dates) {
          items.forEach(function (it) {
            it.date = onlyDate(dates[it.path] || '');
            it.href = hrefFromRepoRel(pageRelDir, it.path);
          });
          return { items: items, branch: branch };
        });
      });
    });
  }

  /* ---------------- 渲染 ---------------- */

  function sortItems(items, mode) {
    return items.slice().sort(function (a, b) {
      if (mode === 'name') return a.title.localeCompare(b.title, 'zh-Hans-CN');
      var ta = Date.parse(a.date || ''), tb = Date.parse(b.date || '');
      var na = isNaN(ta), nb = isNaN(tb);
      if (na && !nb) return 1;
      if (!na && nb) return -1;
      if (!na && !nb && ta !== tb) return tb - ta;
      return a.title.localeCompare(b.title, 'zh-Hans-CN');
    });
  }

  function buildItem(it, opt) {
    var li = document.createElement('li');
    li.className = 'notice-item';
    li.setAttribute('data-auto', '1');

    // PDF 走站内阅读器（微信/手机内置浏览器也能看），其余类型直链打开
    var openHref = it.href;
    if (it.type === 'pdf' && opt.viewer) {
      // it.href 已按段编码，这里先还原成中文原样，再整体编码一次，避免二次编码
      var rawRel = it.href;
      try { rawRel = './' + decodeURIComponent(rawRel.replace(/^\.\//, '')); } catch (e) { /* 保持原值 */ }
      openHref = './' + opt.viewer +
                 '?file=' + encodeURIComponent(rawRel) +
                 '&name=' + encodeURIComponent(it.title);
    }

    var a = document.createElement('a');
    a.className = 'notice-title';
    a.href = openHref;
    a.target = '_blank';
    a.rel = 'noopener';
    a.title = it.name + (it.size ? '（' + fmtSize(it.size) + '）' : '');

    var badge = document.createElement('span');
    badge.className = 'badge ' + (it.type === 'pdf' ? 'badge-pdf' : 'badge-doc');
    badge.textContent = opt.badge || (it.type === 'pdf' ? 'PDF' : '文件');
    a.appendChild(badge);

    if (isNew(it.date, opt.newDays)) {
      var tag = document.createElement('span');
      tag.className = 'tag tag-new';
      tag.textContent = '最新';
      a.appendChild(tag);
    }

    a.appendChild(document.createTextNode(it.title));

    var meta = document.createElement('span');
    meta.className = 'notice-date';
    var txt = onlyDate(it.date);
    if (it.size) txt += (txt ? ' · ' : '') + fmtSize(it.size);
    meta.textContent = txt;

    li.appendChild(a);
    li.appendChild(meta);
    return li;
  }

  /* ---------------- 主流程 ---------------- */

  function init(ul) {
    var dirName = ul.getAttribute('data-auto-dir');
    if (!dirName) return;

    var vAttr = ul.getAttribute('data-auto-viewer');
    var opt = {
      badge: ul.getAttribute('data-auto-badge') || '',
      newDays: parseInt(ul.getAttribute('data-auto-new-days') || '30', 10) || 30,
      sort: ul.getAttribute('data-auto-sort') || 'date-desc',
      viewer: vAttr === null ? 'pdf-viewer.html' : vAttr
    };

    var repo = detectRepo();
    var base = contentBase(repo);
    var pageRelDir = pageRepoDir(base);
    var repoDir = repoRelOf(pageRelDir, dirName);

    var originalHTML = ul.innerHTML;          // 最终兜底：页面里写死的条目
    var rendered = false;
    var statusEl = null;
    var curated = {};                         // 文件名 → 人工维护的标题 / 日期（来自静态清单）

    function setStatus(text, kind) {
      if (!statusEl) {
        statusEl = document.createElement('li');
        statusEl.className = 'notice-status';
        ul.appendChild(statusEl);
      }
      statusEl.textContent = text;
      statusEl.setAttribute('data-kind', kind || 'info');
      // 状态行始终排在最后
      ul.appendChild(statusEl);
    }

    // 实时 API 拿到的是原始文件列表，用它保证「新文件立刻出现」；
    // 标题与日期则优先采用静态清单里人工维护过的值（overrides.json）。
    function merge(items) {
      return items.map(function (it) {
        var c = curated[it.name];
        if (!c) return it;
        return {
          name: it.name,
          title: c.title || it.title,
          date: c.date || it.date,
          size: typeof it.size === 'number' ? it.size : c.size,
          type: it.type,
          path: it.path,
          href: it.href
        };
      });
    }

    function paint(items, note) {
      var sorted = sortItems(merge(items), opt.sort);
      var frag = document.createDocumentFragment();
      sorted.forEach(function (it) { frag.appendChild(buildItem(it, opt)); });
      ul.innerHTML = '';
      ul.appendChild(frag);
      rendered = true;
      statusEl = null;
      if (note) setStatus(note, 'info');
      else if (sorted.length === 0) setStatus('该目录下暂无 PDF / HTML 文件', 'empty');
    }

    // 1) 静态清单先秒开
    var manifestUrl = ul.getAttribute('data-auto-manifest');
    var manifestPromise = manifestUrl
      ? loadManifest(manifestUrl).then(function (data) {
          var items = itemsFromManifest(data, pageRelDir, dirName);
          items.forEach(function (it) { curated[it.name] = it; });
          paint(items);
          return true;
        }).catch(function () { return false; })
      : Promise.resolve(false);

    // 2) GitHub API 实时校正
    var apiPromise = repo
      ? itemsFromGitHub(repo, repoDir, pageRelDir).then(function (res) {
          paint(res.items, '共 ' + res.items.length + ' 份文件 · 已与仓库同步');
          return true;
        }).catch(function () { return false; })
      : Promise.resolve(false);

    Promise.all([manifestPromise, apiPromise]).then(function (r) {
      if (!r[0] && !r[1]) {
        ul.innerHTML = originalHTML;           // 两个数据源都失败 → 恢复写死条目
        statusEl = null;
        setStatus('自动同步暂不可用，当前显示的是页面内置列表', 'warn');
      }
    });

    // 首次加载时的轻微提示（仅在两者都还没出结果时出现）
    if (manifestUrl || repo) {
      setStatus('正在同步目录…', 'loading');
      window.setTimeout(function () {
        if (!rendered && statusEl) statusEl.setAttribute('data-kind', 'warn');
      }, 4000);
    }
  }

  function boot() {
    var lists = document.querySelectorAll('ul[data-auto-dir]');
    Array.prototype.forEach.call(lists, init);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
