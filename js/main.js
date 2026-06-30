/* =========================================================================
 * main.js — 画面の組み立てと全体の配線。
 * ========================================================================= */
(function (global) {
  'use strict';
  const M = global.Model, G = global.Geometry, R = global.Render,
        I = global.Interactions, P = global.Printer;

  let project = M.defaultProject();
  const state = { selectedId: null, selectFilter: 'all' };

  const $ = (id) => document.getElementById(id);
  const canvas = $('canvas');
  const ctx = canvas.getContext('2d');

  /* ---- 案件ごとの自動保存(localStorage) ----
   * 案件(店舗)ごとに別の控えとしてブラウザ内へ自動保存し、左パネルの
   * 「案件」欄で切り替えられる。ファイルの「保存」ボタンとは別物。 */
  const CASES_KEY = 'shinya-zumen-cases';     // 案件の一覧(id・名前・更新日時)
  const CURRENT_KEY = 'shinya-zumen-current'; // 最後に開いていた案件のid
  const LEGACY_KEY = 'shinya-zumen-autosave'; // 旧版(1案件のみ)の控え
  const caseKey = (id) => `shinya-zumen-case-${id}`;
  let currentCaseId = null;
  let autosaveTimer = null;

  function readCases() {
    try { return JSON.parse(localStorage.getItem(CASES_KEY)) || []; }
    catch (e) { return []; }
  }
  function writeCases(list) {
    try { localStorage.setItem(CASES_KEY, JSON.stringify(list)); } catch (e) { /* 何もしない */ }
  }
  function newCaseId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }
  function caseName() {
    return (project.meta.storeName || '').trim() || '無題の案件';
  }
  function saveAutosave() {
    if (!currentCaseId) return;
    try {
      localStorage.setItem(caseKey(currentCaseId), M.serialize(project));
      localStorage.setItem(CURRENT_KEY, currentCaseId);
      const list = readCases();
      const it = list.find((c) => c.id === currentCaseId);
      if (it) { it.name = caseName(); it.updatedAt = Date.now(); }
      else list.push({ id: currentCaseId, name: caseName(), updatedAt: Date.now() });
      writeCases(list);
      buildCaseSelect();
    } catch (e) { /* プライベートモードや容量超過では保存できないが、操作は止めない */ }
  }
  function scheduleAutosave() {
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(saveAutosave, 800);
  }
  function loadCase(id) {
    try {
      const text = localStorage.getItem(caseKey(id));
      return text ? M.deserialize(text) : null;
    } catch (e) { return null; } // 壊れた控えは無視する
  }
  /* 旧版(案件1つだけの自動保存)の控えを、案件形式に引っ越す */
  function migrateLegacy() {
    try {
      const text = localStorage.getItem(LEGACY_KEY);
      if (!text) return;
      const id = newCaseId();
      localStorage.setItem(caseKey(id), text);
      let name = '前回の図面';
      try { name = (JSON.parse(text).meta || {}).storeName || name; } catch (e) { /* 既定名のまま */ }
      const list = readCases();
      list.push({ id, name, updatedAt: Date.now() });
      writeCases(list);
      localStorage.setItem(CURRENT_KEY, id);
      localStorage.removeItem(LEGACY_KEY);
    } catch (e) { /* 引っ越せなければ何もしない */ }
  }
  /* 案件セレクトの中身を作り直す(更新が新しい順) */
  function buildCaseSelect() {
    const sel = $('caseSelect');
    if (!sel || document.activeElement === sel) return; // 操作中は作り直さない
    const list = readCases().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    sel.innerHTML = '';
    for (const c of list) sel.add(new Option(c.name, c.id));
    sel.value = currentCaseId;
  }

  /* ---- 元に戻す / やり直す(操作履歴) ----
   * 操作が一段落するたびに図面全体の写しを積み、Cmd/Ctrl+Z で1つ前に戻す。
   * 案件の切り替え・読み込み・新規では履歴を仕切り直す。 */
  const history = { stack: [], index: -1, timer: null };
  const HISTORY_LIMIT = 60;
  function recordHistory() {
    const snap = M.serialize(project);
    if (history.stack[history.index] === snap) return; // 見た目だけの変更(パン等)は積まない
    history.stack = history.stack.slice(0, history.index + 1);
    history.stack.push(snap);
    if (history.stack.length > HISTORY_LIMIT) history.stack.shift();
    history.index = history.stack.length - 1;
    updateUndoButtons();
  }
  function scheduleHistory() {
    clearTimeout(history.timer);
    history.timer = setTimeout(recordHistory, 400);
  }
  function flushHistory() {
    clearTimeout(history.timer);
    recordHistory();
  }
  function resetHistory() {
    clearTimeout(history.timer);
    history.stack = [M.serialize(project)];
    history.index = 0;
    updateUndoButtons();
  }
  function undo() {
    flushHistory();
    if (history.index <= 0) return;
    history.index--;
    adoptProject(M.deserialize(history.stack[history.index]), { keepView: true });
    updateUndoButtons();
  }
  function redo() {
    flushHistory();
    if (history.index >= history.stack.length - 1) return;
    history.index++;
    adoptProject(M.deserialize(history.stack[history.index]), { keepView: true });
    updateUndoButtons();
  }
  function updateUndoButtons() {
    const u = $('btnUndo'), r = $('btnRedo');
    if (u) u.disabled = history.index <= 0;
    if (r) r.disabled = history.index >= history.stack.length - 1;
  }
  /* キーボードショートカット:
   *   Cmd/Ctrl+Z=元に戻す, Shift+Cmd/Ctrl+Z(または Ctrl+Y)=やり直す, Cmd/Ctrl+D=複製。
   * 入力欄の中ではブラウザ標準の動きを邪魔しない。 */
  function onUndoKeys(e) {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
    } else if (e.ctrlKey && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      redo();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      duplicateSelected();
    }
  }

  /* 選択中の要素を複製して、複製のほうを選択する */
  function duplicateSelected() {
    if (!state.selectedId) return;
    const copy = M.duplicateElement(project, state.selectedId);
    if (!copy) return;
    state.selectedId = copy.id;
    refresh();
    showProps(copy);
  }

  function changeZOrder(action) {
    if (!state.selectedId) return;
    if (!M.setZOrder(project, state.selectedId, action)) return;
    const found = M.findById(project, state.selectedId);
    refresh();
    showProps(found ? found.element : null);
  }

  /* 図面オブジェクトを差し替えて画面全体を作り直す(読み込み・案件切替・元に戻す共通) */
  function adoptProject(p, opts) {
    project = p;
    state.selectedId = null;
    I.attach(canvas, ctx, project, state, draw, selectElement);
    bindMeta();
    if (!(opts && opts.keepView)) R.fitToView(project, canvasCss());
    refresh();
    showProps(null);
  }

  /* ---- 初期化 ---- */
  function init() {
    migrateLegacy();
    // 前回の続き(自動保存)があれば、最後に開いていた案件を復元する
    let saved = null;
    const cases = readCases();
    if (cases.length) {
      let lastId = null;
      try { lastId = localStorage.getItem(CURRENT_KEY); } catch (e) { /* 既定のまま */ }
      const pick = cases.find((c) => c.id === lastId) ||
        cases.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
      currentCaseId = pick.id;
      saved = loadCase(pick.id);
    }
    if (saved) project = saved;
    if (!currentCaseId) currentCaseId = newCaseId();

    buildSelects();
    buildLayerTabs();
    bindToolbar();
    bindMeta();
    buildCaseSelect();
    resizeCanvas();
    window.addEventListener('resize', () => { resizeCanvas(); draw(); });
    // タブを閉じる・リロードする瞬間は待たずに即保存する
    window.addEventListener('pagehide', saveAutosave);
    // 下絵画像の読み込み完了時に描き直してもらう
    R.setRedrawCallback(draw);
    // Cmd/Ctrl+Z で元に戻す(Shift付きでやり直す)
    window.addEventListener('keydown', onUndoKeys);

    I.attach(canvas, ctx, project, state, draw, selectElement);

    if (!saved) {
      // サンプルの最小構成を1つ置いておく(手応え確認用)
      const r = M.addRegion(project, 'kyakushitsu', 4500, 3200);
      r.x = 1000; r.y = 1000;
      const k = M.addRegion(project, 'chubo', 2000, 3200);
      k.x = 5500; k.y = 1000;
    }
    resetHistory();

    // レイアウト確定後に全体表示へ合わせる(初回描画のサイズ取りこぼし対策)
    requestAnimationFrame(() => {
      resizeCanvas();
      R.fitToView(project, canvasCss());
      refresh();
    });
    refresh();
  }

  function resizeCanvas() {
    const wrap = canvas.parentElement;
    const ratio = global.devicePixelRatio || 1;
    canvas.width = wrap.clientWidth * ratio;
    canvas.height = wrap.clientHeight * ratio;
    canvas.style.width = wrap.clientWidth + 'px';
    canvas.style.height = wrap.clientHeight + 'px';
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    // ※ 描画座標は CSS px 基準にしたいので、render 側の canvas.width 参照を補正
    canvas._cssW = wrap.clientWidth;
    canvas._cssH = wrap.clientHeight;
  }

  /* ---- セレクトボックスの中身 ---- */
  function buildSelects() {
    const rt = $('regionType');
    for (const [key, v] of Object.entries(M.REGION_TYPES)) {
      rt.add(new Option(v.label, key));
    }
    const fk = $('furnKind');
    for (const [key, v] of Object.entries(M.FURNITURE_CATALOG)) {
      fk.add(new Option(`${v.label}(${v.w}×${v.h})`, key));
    }
    populateFurnStyles(); // 選択中の種類に応じた姿図スタイルを並べる
    const gk = $('fittingKind');
    for (const [key, v] of Object.entries(M.FITTING_CATALOG)) {
      gk.add(new Option(v.label, key));
    }
    const xk = $('fixKind');
    for (const [key, v] of Object.entries(M.FIXTURE_CATALOG)) {
      xk.add(new Option(v.label, key));
    }
  }

  function buildLayerTabs() {
    const box = $('layerTabs');
    box.innerHTML = '';
    for (const [key, v] of Object.entries(R.LAYERS)) {
      const b = document.createElement('button');
      b.className = 'layer-tab' + (R.getLayer() === key ? ' active' : '');
      b.textContent = v.label;
      b.onclick = () => {
        R.setLayer(key);
        buildLayerTabs();
        refresh();
      };
      box.appendChild(b);
    }
  }

  /* ---- ツールバー配線 ---- */
  function bindToolbar() {
    $('btnUndo').onclick = () => undo();
    $('btnRedo').onclick = () => redo();
    $('selectFilter').onchange = (e) => {
      state.selectFilter = e.target.value;
      renderElementList();
      draw();
    };

    // 案件の切り替え・追加・削除(自動保存はブラウザ内に案件ごと)
    $('caseSelect').onchange = (e) => {
      const id = e.target.value;
      if (id === currentCaseId) return;
      saveAutosave(); // 切り替える前に今の案件を確実に保存する
      const p = loadCase(id);
      if (!p) {
        alert('この案件の控えを読み込めませんでした。');
        buildCaseSelect();
        return;
      }
      currentCaseId = id;
      try { localStorage.setItem(CURRENT_KEY, id); } catch (err) { /* 何もしない */ }
      adoptProject(p);
      resetHistory();
      buildCaseSelect();
    };
    $('btnCaseNew').onclick = () => {
      saveAutosave(); // 今の案件を保存してから白紙の案件を作る
      currentCaseId = newCaseId();
      adoptProject(M.defaultProject());
      resetHistory();
      saveAutosave(); // 一覧に登録してセレクトを更新
    };
    $('btnCaseDel').onclick = () => {
      const list = readCases();
      if (list.length <= 1) {
        alert('案件が1件しかないため削除できません。\n中身を消したいときは「新規(クリア)」を使ってください。');
        return;
      }
      if (!confirm(`案件「${caseName()}」を削除します。よろしいですか?\n(この案件の自動保存の控えも消えます)`)) return;
      try { localStorage.removeItem(caseKey(currentCaseId)); } catch (e) { /* 何もしない */ }
      const rest = readCases().filter((c) => c.id !== currentCaseId);
      writeCases(rest);
      const next = rest.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
      currentCaseId = next.id;
      adoptProject(loadCase(next.id) || M.defaultProject());
      resetHistory();
      buildCaseSelect();
    };

    // 全案件のバックアップ(書き出し/取り込み)
    $('btnBackup').onclick = exportBackup;
    $('btnRestore').onclick = () => $('backupInput').click();
    $('backupInput').onchange = importBackupFile;

    // 寸法線(任意の2点間に長さを記入)
    $('btnAddDim').onclick = () => {
      if (state.measure) { I.cancelMeasure(state); draw(); return; }
      // 図面系のレイヤーで使う(設備図・姿図では扱わない)
      if (R.getLayer() === 'lighting' || R.getLayer() === 'furnviews') {
        R.setLayer('plan'); buildLayerTabs();
      }
      I.beginMeasure(state, (x1, y1, x2, y2) => {
        const dim = M.addDimension(project, x1, y1, x2, y2, 'drawings');
        state.selectedId = dim.id;
        refresh(); showProps(dim);
      });
      draw();
    };

    // 届出者・営業所情報(届出書に自動転記する内容)
    $('btnTodokede').onclick = openTodokede;
    $('btnTodokedeClose').onclick = () => { $('todokedeModal').hidden = true; };
    $('todokedeModal').onclick = (e) => {
      if (e.target.id === 'todokedeModal') $('todokedeModal').hidden = true;
    };

    // メモ・引き出し線(いま開いている図面に追加)
    $('btnAddNote').onclick = () => {
      const n = M.addNote(project, R.getLayer());
      const c = canvasCss();
      const center = R.screenToWorld(c.width / 2, c.height / 2);
      const d = cascade();
      n.x = I.snap(center.x + d);
      n.y = I.snap(center.y - 600 + d);
      n.tx = I.snap(n.x - 1500);
      n.ty = I.snap(n.y + 1500);
      state.selectedId = n.id;
      refresh();
      showProps(n);
    };
    // コメント(引き出し線なしの自由テキスト。ドラッグで自由に動かせる)
    $('btnAddComment').onclick = () => {
      const n = M.addNote(project, R.getLayer(), false);
      const c = canvasCss();
      const center = R.screenToWorld(c.width / 2, c.height / 2);
      const d = cascade();
      n.x = I.snap(center.x + d);
      n.y = I.snap(center.y - 600 + d);
      state.selectedId = n.id;
      refresh();
      showProps(n);
    };

    // 下絵(間取り図のトレース)
    $('btnUnderlay').onclick = () => $('underlayFile').click();
    $('underlayFile').onchange = loadUnderlayFile;
    $('underlayW').onchange = (e) => {
      const u = project.underlay;
      if (!u) return;
      const w = Math.max(500, parseInt(e.target.value, 10) || 0);
      u.h = Math.round(w * (u.h / u.w)); // 縦横の比率は変えない
      u.w = w;
      e.target.value = w;
      refresh();
    };
    $('underlayOpacity').oninput = (e) => {
      if (project.underlay) {
        project.underlay.opacity = parseInt(e.target.value, 10) / 100;
        draw();
      }
    };
    $('underlayShow').onchange = (e) => {
      if (project.underlay) {
        project.underlay.visible = e.target.checked;
        draw();
      }
    };
    $('underlayMove').onchange = (e) => { state.underlayMove = e.target.checked; };
    $('btnUnderlayDel').onclick = () => {
      if (!project.underlay) return;
      if (!confirm('下絵を削除します。よろしいですか?')) return;
      project.underlay = null;
      state.underlayMove = false;
      syncUnderlayUi();
      refresh();
    };

    $('btnAddRegion').onclick = () => {
      const type = $('regionType').value;
      const shape = $('regionShape').value;
      const w = clampSize($('regionW').value);
      const h = clampSize($('regionH').value);
      const w2 = shape === 'trapezoid' ? clampSize($('regionW2').value) : undefined;
      ensureRegionVisible(type); // 今のレイヤーで見えない種類なら平面図へ切り替え
      const r = M.addRegion(project, type, w, h, shape, w2);
      placeAtViewCenter(r);
      state.selectedId = r.id;
      refresh(); showProps(r);
    };
    $('regionType').onchange = applyRegionTypeDefaults;
    // 台形のときだけ「上底」入力欄を表示
    $('regionShape').onchange = (e) => {
      $('regionW2Row').style.display = e.target.value === 'trapezoid' ? '' : 'none';
    };
    // 多角形の作図モード(クリックで頂点を置いて囲う)。
    // 作図中にもう一度押すと: 3点以上なら確定、未満なら中止。
    $('btnDrawPoly').onclick = () => {
      if (state.draft) {
        if (state.draftKind !== 'region') return; // 外周の作図中は区画ボタンを無効に
        if (state.draft.points.length >= 3) I.finishPolygon(state);
        else I.cancelPolygon(state);
        draw();
        return;
      }
      const type = $('regionType').value;
      ensureRegionVisible(type); // 今のレイヤーで見えない種類なら平面図へ切り替え
      state.draftKind = 'region';
      I.beginPolygon(state, (pts) => {
        const r = M.addPolygonRegion(project, type, pts);
        state.selectedId = r.id;
        refresh(); showProps(r);
      });
      draw();
    };
    // 営業所外周(壁芯)の作図。区画の多角形と同じ操作で外周をなぞる。
    $('btnDrawPremise').onclick = () => {
      if (state.draft) {
        if (state.draftKind !== 'premise') return; // 区画の作図中は外周ボタンを無効に
        if (state.draft.points.length >= 3) I.finishPolygon(state);
        else I.cancelPolygon(state);
        draw();
        return;
      }
      if (project.premise && !confirm('営業所外周はすでにあります。描き直しますか?')) return;
      if (R.getLayer() !== 'plan' && R.getLayer() !== 'premises') {
        R.setLayer('plan');
        buildLayerTabs();
      }
      state.draftKind = 'premise';
      I.beginPolygon(state, (pts) => {
        const pr = M.setPremise(project, pts,
          parseInt($('premWall').value, 10) || 100, $('premMeasured').value);
        state.selectedId = pr.id;
        refresh(); showProps(pr);
      });
      draw();
    };
    // 区画全体を囲う長方形で外周を自動作成(内法入力扱い)。あとから頂点で修正できる。
    $('btnPremAuto').onclick = () => {
      if (!project.regions.length) {
        alert('区画がありません。先に客室・厨房などの区画を置いてください。');
        return;
      }
      if (project.premise && !confirm('営業所外周はすでにあります。作り直しますか?')) return;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const r of project.regions) {
        minX = Math.min(minX, r.x); minY = Math.min(minY, r.y);
        maxX = Math.max(maxX, r.x + r.w); maxY = Math.max(maxY, r.y + r.h);
      }
      const pr = M.setPremise(project,
        [{ x: minX, y: minY }, { x: maxX, y: minY }, { x: maxX, y: maxY }, { x: minX, y: maxY }],
        parseInt($('premWall').value, 10) || 100, $('premMeasured').value);
      state.selectedId = pr.id;
      R.fitToView(project, canvasCss());
      refresh(); showProps(pr);
    };
    // 壁厚・測り方の変更は、作成済みの外周にも即時反映する
    $('premWall').onchange = (e) => {
      if (project.premise) {
        project.premise.wallThickness = Math.max(10, parseInt(e.target.value, 10) || 100);
        refresh();
      }
    };
    $('premMeasured').onchange = (e) => {
      if (project.premise) {
        project.premise.measuredAt = e.target.value;
        refresh();
      }
    };
    // 種類を変えたら、その種類で選べる姿図スタイルに並べ替える
    $('furnKind').onchange = populateFurnStyles;
    // 備品姿図のカードを自動整列に戻す(手動で動かした位置をすべて消す)
    $('btnFurnReset').onclick = () => { project.meta.furnViewPos = {}; refresh(); };
    $('btnAddFurn').onclick = () => {
      if (R.getLayer() === 'furnviews') { R.setLayer('plan'); buildLayerTabs(); } // 姿図では配置できない
      const f = M.addFurniture(project, $('furnKind').value, $('furnStyle').value || undefined);
      placeAtViewCenter(f);
      state.selectedId = f.id;
      refresh(); showProps(f);
    };
    // 自由な形(多角形)の備品を描く。区画の多角形と同じ操作で上から見た形をなぞる。
    // 作図中にもう一度押すと: 3点以上なら確定、未満なら中止。
    $('btnDrawFurnPoly').onclick = () => {
      if (state.draft) {
        if (state.draftKind !== 'furniture') return; // 他の作図中は無効
        if (state.draft.points.length >= 3) I.finishPolygon(state);
        else I.cancelPolygon(state);
        draw();
        return;
      }
      if (R.getLayer() === 'furnviews') { R.setLayer('plan'); buildLayerTabs(); }
      state.draftKind = 'furniture';
      I.beginPolygon(state, (pts) => {
        const label = (prompt('備品の名前を入力してください(例: カウンター)', '備品') || '備品').trim() || '備品';
        const f = M.addPolygonFurniture(project, pts, { label });
        state.selectedId = f.id;
        refresh(); showProps(f);
      });
      draw();
    };
    $('btnAddFitting').onclick = () => {
      // 図面は切り替えない(勝手に平面図へ戻らないようにする)。
      // 建具・設備は平面図に描かれるが、求積図などで追加してもその図面のまま作業を続けられる。
      const g = M.addFitting(project, $('fittingKind').value);
      placeAtViewCenter(g);
      state.selectedId = g.id;
      refresh(); showProps(g);
      // いまの図面に描かれない種類のときだけ、どこで見えるかを一言だけ知らせる
      if (!R.visibility(R.getLayer()).fittings) {
        $('hint').textContent = `「${g.label}」を追加しました（平面図に表示されます）。`;
      }
    };
    $('btnAddFix').onclick = () => {
      const x = M.addFixture(project, $('fixKind').value);
      placeFixtureAtViewCenter(x);
      state.selectedId = x.id;
      refresh(); showProps(x);
    };
    $('btnFit').onclick = () => { R.fitToView(project, canvasCss()); draw(); };
    $('btnNew').onclick = () => {
      if (!confirm('この案件の図面を消して白紙にします。よろしいですか?\n(この案件の自動保存の控えも白紙になります)')) return;
      adoptProject(M.defaultProject());
      resetHistory();
      saveAutosave();
    };
    $('snapSelect').onchange = (e) => I.setSnap(parseInt(e.target.value, 10));
    $('btnSave').onclick = saveFile;
    $('btnLoad').onclick = () => $('fileInput').click();
    $('fileInput').onchange = loadFile;
    $('btnPdf').onclick = () => { draw(); P.printCurrent(project, canvas); };
    $('btnPdfAll').onclick = () => { P.printAll(project); draw(); };
    $('btnForms').onclick = () => global.Forms.openForms(project);
    $('btnChecklist').onclick = openChecklist;
    $('btnChecklistClose').onclick = closeChecklist;
    $('checklistModal').onclick = (e) => {
      if (e.target.id === 'checklistModal') closeChecklist(); // 背景クリックで閉じる
    };
    $('checkCorp').onchange = (e) => {
      project.checklist.corp = e.target.checked;
      renderChecklist();
    };
  }

  /* ---- 届出者・営業所情報(届出書に自動転記) ---- */
  // [保存キー, ラベル, 種類('text'|'area'), プレースホルダ]
  const TODOKEDE_FIELDS = [
    ['applicantAddress', '届出者の住所', 'text', '例: 岐阜県岐阜市○○町1-2-3'],
    ['applicantName', '届出者の氏名(法人は名称)', 'text', '例: 山田太郎 / 株式会社○○'],
    ['corpRepName', '法人の代表者氏名(法人のみ)', 'text', '例: 代表取締役 山田太郎'],
    ['phone', '電話番号', 'text', '例: 058-000-0000'],
    ['applicantKana', '営業所名称のふりがな', 'text', '例: すなっくなごみ'],
    ['addressee', '宛先(都道府県名)', 'text', '空欄なら所在地から自動。例: 岐阜県'],
    ['buildingStructure', '建物の構造', 'text', '例: 鉄筋コンクリート造3階建2階部分'],
    ['buildingPosition', '建物内の営業所の位置', 'text', '例: 2階南側'],
    ['businessHours', '営業時間', 'text', '例: 午後6時から翌日午前2時まで'],
    ['staffCount', '従事する者の数', 'text', '例: 3'],
    ['alcoholMethod', '酒類の提供方法', 'text', '例: 客の注文により座席で提供する'],
    ['minorRule', '18歳未満の立入りに関する事項', 'area', ''],
    ['licenseDate', '飲食店営業許可の年月日', 'text', '例: 令和6年4月1日'],
    ['licenseNumber', '飲食店営業許可の番号', 'text', '例: 第○○○号'],
  ];
  function openTodokede() {
    const t = project.meta.todokede;
    let html = '<div class="todokede-form">';
    for (const [key, label, type, ph] of TODOKEDE_FIELDS) {
      const v = esc(t[key] || '');
      const input = type === 'area'
        ? `<textarea data-todokede="${key}" rows="2" placeholder="${esc(ph)}">${v}</textarea>`
        : `<input type="text" data-todokede="${key}" value="${v}" placeholder="${esc(ph)}">`;
      html += `<label class="field">${esc(label)}${input}</label>`;
    }
    html += '</div>';
    const box = $('todokedeBody');
    box.innerHTML = html;
    box.querySelectorAll('[data-todokede]').forEach((inp) => {
      inp.oninput = (e) => {
        project.meta.todokede[e.target.dataset.todokede] = e.target.value;
        scheduleAutosave(); scheduleHistory();
      };
    });
    $('todokedeModal').hidden = false;
  }

  /* ---- 必要書類チェックリスト ---- */
  function openChecklist() {
    $('checkCorp').checked = !!project.checklist.corp;
    renderChecklist();
    $('checklistModal').hidden = false;
  }
  function closeChecklist() {
    $('checklistModal').hidden = true;
  }
  function renderChecklist() {
    const cl = project.checklist;
    const items = M.CHECKLIST_ITEMS.filter((it) => !it.corpOnly || cl.corp);
    const done = items.filter((it) => cl.items[it.id]).length;
    let html = `<p class="check-progress">${done} / ${items.length} 件 そろっています</p><ul class="checklist">`;
    for (const it of items) {
      const checked = cl.items[it.id] ? ' checked' : '';
      const corp = it.corpOnly ? '<span class="badge">法人</span>' : '';
      const note = it.note ? `<span class="muted">(${esc(it.note)})</span>` : '';
      html += `<li><label><input type="checkbox" data-check="${it.id}"${checked}> ${esc(it.label)} ${corp} ${note}</label></li>`;
    }
    html += '</ul>';
    const box = $('checklistBody');
    box.innerHTML = html;
    box.querySelectorAll('[data-check]').forEach((inp) => {
      inp.onchange = (e) => {
        cl.items[e.target.dataset.check] = e.target.checked;
        renderChecklist(); // 進捗表示を更新
      };
    });
  }

  /* 作図モード中のボタン表示とヒント文を切り替える。
   * 区画(btnDrawPoly)と営業所外周(btnDrawPremise)のどちらの作図かは state.draftKind で判定。 */
  const HINT_DEFAULT = '空きをドラッグで移動 / ホイールで拡大縮小 / 要素をドラッグで配置(既定1cm吸着・Shiftで自由)/ 矢印キーで微調整(Shiftで10倍)/ Cmd+Zで元に戻す / Cmd+Dで複製 / Deleteで削除';
  const HINT_DRAFT = '多角形の作図中: クリックで角を置く / 最初の点をクリック・ダブルクリック・Enterで確定 / Escで中止';
  function setDraftUi(draft) {
    const btnR = $('btnDrawPoly');
    const btnP = $('btnDrawPremise');
    const btnF = $('btnDrawFurnPoly');
    btnR.textContent = '多角形で描く';
    btnP.textContent = '外周を多角形で描く';
    btnF.textContent = '自由な形で描く(真上から)';
    btnR.classList.remove('danger');
    btnP.classList.remove('danger');
    btnF.classList.remove('danger');
    if (!draft) {
      state.draftKind = null;
      $('hint').textContent = HINT_DEFAULT;
      return;
    }
    // 正面・側面の形をなぞる作図は右パネルから操作するので、左のボタンは触らない
    if (state.draftKind === 'profile') {
      $('hint').textContent = (state.profileTarget && state.profileTarget.view === 'side' ? '側面' : '正面')
        + 'の形をなぞる: 姿図の四角に重ねてクリックで角を置く / Enter・最初の点クリックで確定 / Escで中止';
      return;
    }
    const btn = state.draftKind === 'premise' ? btnP
      : state.draftKind === 'furniture' ? btnF : btnR;
    if (draft.points.length >= 3) {
      btn.textContent = '作図を確定';
    } else {
      btn.textContent = '作図を中止(Esc)';
      btn.classList.add('danger');
    }
    $('hint').textContent = HINT_DRAFT;
  }

  /* 自由な形の備品の「横から見た形」(正面 front / 側面 side)を、備品姿図の画面で
   * なぞって作る。クリックした世界座標を、その備品の姿図カード内のローカル座標
   * (x=横位置, y=床からの高さ)に変換して保存する。 */
  function startProfile(id, view) {
    if (state.draft) return; // 別の作図中は不可
    if (R.getLayer() !== 'furnviews') { R.setLayer('furnviews'); buildLayerTabs(); }
    state.selectedId = id;
    state.profileTarget = { id, view };
    state.draftKind = 'profile';
    I.beginPolygon(state, (worldPts) => {
      const tgt = state.profileTarget || { id, view };
      state.profileTarget = null;
      const found = M.findById(project, id);
      if (!found) { refresh(); return; }
      const f = found.element;
      const layout = R.furnViewLayout(project);
      const cell = (layout.cells || []).find((c) => c.g.key === G.furnKey(f));
      if (!cell) { alert('対象の備品が姿図に見つかりませんでした。先に平面図で配置してください。'); refresh(); return; }
      const left = cell.x + layout.pad;
      const viewLeft = tgt.view === 'side' ? left + cell.g.w + layout.innerGap : left;
      const local = worldPts.map((p) => ({
        x: Math.round(p.x - viewLeft),
        y: Math.max(0, Math.round(cell.floorY - p.y)), // 床からの高さ(床より下は0)
      }));
      f[tgt.view === 'side' ? 'side' : 'front'] = local;
      // 輪郭の最大高さに高さを合わせる(見通し1m判定・カードの大きさのため)
      const maxY = local.reduce((m, p) => Math.max(m, p.y), 0);
      if (maxY > (f.height || 0)) f.height = maxY;
      state.selectedId = f.id;
      refresh(); showProps(f);
    });
    R.fitToView(project, canvasCss());
    refresh();
  }

  /* 区画の種類が今のレイヤーで非表示なら、平面図に切り替えて見えるようにする */
  function ensureRegionVisible(type) {
    const vis = R.visibility(R.getLayer());
    if (!vis.allRegions && vis.regionTypes && vis.regionTypes.indexOf(type) < 0) {
      R.setLayer('plan');
      buildLayerTabs();
    }
  }

  function applyRegionTypeDefaults() {
    const t = M.REGION_TYPES[$('regionType').value];
    if (!t || !t.defaultW || !t.defaultH) return;
    $('regionShape').value = 'rect';
    $('regionW').value = t.defaultW;
    $('regionH').value = t.defaultH;
    $('regionW2Row').style.display = 'none';
  }

  function clampSize(v) {
    let n = parseInt(v, 10);
    if (!isFinite(n) || n < 100) n = 100;
    return Math.round(n / 100) * 100;
  }

  // 追加するたびに少しずつ位置をずらし、要素どうしが完全に重ならないようにする
  let cascadeStep = 0;
  function cascade() {
    const d = (cascadeStep % 8) * 300; // 0〜2100mm を斜めに展開
    cascadeStep++;
    return d;
  }
  function placeAtViewCenter(el) {
    const c = canvasCss();
    const center = R.screenToWorld(c.width / 2, c.height / 2);
    const d = cascade();
    el.x = I.snap(center.x - el.w / 2 + d);
    el.y = I.snap(center.y - el.h / 2 + d);
  }
  function placeFixtureAtViewCenter(el) {
    const c = canvasCss();
    const center = R.screenToWorld(c.width / 2, c.height / 2);
    const d = cascade();
    el.x = I.snap(center.x + d);
    el.y = I.snap(center.y + d);
  }

  /* render は canvas.width(px)を見るので CSS px に差し替えた擬似オブジェクトを渡す */
  function canvasCss() {
    return { width: canvas._cssW || canvas.width, height: canvas._cssH || canvas.height };
  }

  /* ---- メタ情報 ---- */
  function bindMeta() {
    const m = project.meta;
    $('metaStore').value = m.storeName;
    $('metaAddr').value = m.address;
    $('metaScale').value = m.scale;
    $('metaPaper').value = m.paper;
    $('metaOrient').value = m.orientation;
    $('metaAuthor').value = m.author;
    $('fixNote').value = m.lightingNote || '';
    $('metaFrame').checked = m.showPaperFrame !== false;
    $('metaNorth').checked = m.showNorthMark === true;
    $('metaFontScale').value = String(m.fontScale || 100);
    $('metaColors').value = m.colorMode || 'mono';
    m.boundaryLineStyles = Object.assign({
      premises: 'solid',
      kyakushitsu: 'solid',
      chubo: 'solid',
    }, m.boundaryLineStyles || {});
    $('linePremises').value = m.boundaryLineStyles.premises;
    $('lineKyakushitsu').value = m.boundaryLineStyles.kyakushitsu;
    $('lineChubo').value = m.boundaryLineStyles.chubo;
    $('premMethod').value = m.premisesMethod || 'regions';
    $('premWall').value = project.premise ? project.premise.wallThickness : 100;
    $('premMeasured').value = project.premise ? project.premise.measuredAt : 'inner';
    $('deductPillars').checked = m.deductPillars === true;
    $('printTrueScale').checked = m.printTrueScale === true;
    $('metaKyusekiTable').checked = m.showKyusekiTable !== false;
    syncUnderlayUi();
    // 文字情報も自動保存と履歴の対象にする(店舗名は案件名にもなる)
    $('metaStore').oninput = (e) => { m.storeName = e.target.value; scheduleAutosave(); scheduleHistory(); };
    $('metaAddr').oninput  = (e) => { m.address = e.target.value; scheduleAutosave(); scheduleHistory(); };
    $('metaAuthor').oninput= (e) => { m.author = e.target.value; scheduleAutosave(); scheduleHistory(); };
    // 縮尺・用紙・向きは用紙枠ガイドの大きさに効くので、変更したら再描画する
    $('metaScale').onchange = (e) => { m.scale = parseInt(e.target.value, 10); draw(); };
    $('metaPaper').onchange = (e) => { m.paper = e.target.value; draw(); };
    $('metaOrient').onchange= (e) => { m.orientation = e.target.value; draw(); };
    $('metaFrame').onchange = (e) => { m.showPaperFrame = e.target.checked; draw(); };
    $('metaNorth').onchange = (e) => { m.showNorthMark = e.target.checked; draw(); };
    $('metaFontScale').onchange = (e) => { m.fontScale = parseInt(e.target.value, 10); draw(); };
    $('metaColors').onchange = (e) => { m.colorMode = e.target.value; draw(); };
    $('linePremises').onchange = (e) => { m.boundaryLineStyles.premises = e.target.value; draw(); };
    $('lineKyakushitsu').onchange = (e) => { m.boundaryLineStyles.kyakushitsu = e.target.value; draw(); };
    $('lineChubo').onchange = (e) => { m.boundaryLineStyles.chubo = e.target.value; draw(); };
    // 営業所求積の方式(署のローカルルール)。求積表とサマリーに反映する
    $('premMethod').onchange = (e) => { m.premisesMethod = e.target.value; refresh(); };
    // 柱の面積を区画(客室・調理場など)の面積から差し引くか
    $('deductPillars').onchange = (e) => { m.deductPillars = e.target.checked; refresh(); };
    // PDFを実寸の縮尺で印刷するか
    $('printTrueScale').onchange = (e) => { m.printTrueScale = e.target.checked; scheduleAutosave(); };
    // 設備図コメントは凡例に即時反映させるため、入力のたびに再描画する
    $('fixNote').oninput = (e) => { m.lightingNote = e.target.value; draw(); };
    // 求積表(計算過程)を図面に重ねるかの切替。求積図でだけ意味を持つ
    $('metaKyusekiTable').onchange = (e) => { m.showKyusekiTable = e.target.checked; draw(); };
  }

  /* ---- 描画と再計算 ---- */
  function draw() {
    R.render(ctx, canvasCss(), project, state);
    setDraftUi(state.draft); // 作図の進み具合に応じてボタン・ヒントを更新
    updateMeasureUi();       // 寸法線の作図中ボタン表示を更新
    scheduleAutosave();      // 変更が一段落したらブラウザ内に自動保存
    scheduleHistory();       // 「元に戻す」用の履歴も同じタイミングで積む
  }

  /* 寸法線の作図中はボタン表示とヒントを切り替える */
  function updateMeasureUi() {
    const b = $('btnAddDim');
    if (!b) return;
    if (state.measure) {
      b.textContent = '寸法の記入を中止(Esc)';
      b.classList.add('danger');
      $('hint').textContent = '寸法線: 1点目をクリック → 2点目をクリックで確定 / Escで中止';
    } else {
      b.textContent = '寸法を記入';
      b.classList.remove('danger');
    }
  }
  function refresh() {
    draw();
    applyPanelVisibility();
    renderSummary();
    renderElementList();
    renderKyuseki();
    renderWarnings();
  }

  /* サイドバーの各欄を、いま開いている図面に関係あるものだけ表示する。
   * 表示する図面は index.html 側の data-layers 属性で指定する(無印は常時表示)。 */
  /* 「備品を追加」の姿図スタイル選択肢を、選択中の種類に合わせて作り直す。
   * スタイルが1つもない種類では選択欄を隠す。 */
  function populateFurnStyles() {
    const sel = $('furnStyle');
    const row = $('furnStyleRow');
    if (!sel || !row) return;
    const kind = $('furnKind').value;
    const styles = M.FURNITURE_STYLES[kind];
    sel.innerHTML = '';
    if (!styles) { row.style.display = 'none'; return; }
    row.style.display = '';
    for (const [key, v] of Object.entries(styles)) sel.add(new Option(v.label, key));
  }

  function applyPanelVisibility() {
    const layer = R.getLayer();
    document.querySelectorAll('section[data-layers]').forEach((el) => {
      el.style.display = el.dataset.layers.split(' ').indexOf(layer) >= 0 ? '' : 'none';
    });
  }

  function selectElement(el) {
    showProps(el);
    renderElementList();
  }

  function dimLengthLabel(d) {
    return G.mmToM(Math.hypot(d.x2 - d.x1, d.y2 - d.y1)).toFixed(2) + 'm';
  }

  function elementListRows() {
    const rows = [];
    const push = (group, kind, el, label, sub) => rows.push({ group, kind, el, label, sub });
    if (project.premise) {
      push('外周', 'premise', project.premise, '営業所外周', project.premise.measuredAt === 'center' ? '壁芯寸法' : '内法寸法');
    }
    (project.dimensions || []).forEach((d, i) => {
      push('寸法線', 'dimensions', d, `寸法線 ${i + 1}`, dimLengthLabel(d));
    });
    (project.regions || []).forEach((r) => {
      push('区画', 'regions', r, r.label || (M.REGION_TYPES[r.type] || {}).label || '区画', shapeLabel(r.shape || 'rect'));
    });
    (project.furniture || []).forEach((f) => push('備品', 'furniture', f, f.label || (M.FURNITURE_CATALOG[f.kind] || {}).label || '備品', `${G.fmtM(f.w)}×${G.fmtM(f.h)}m`));
    (project.fittings || []).forEach((g) => push('建具・壁', 'fittings', g, g.label || (M.FITTING_CATALOG[g.kind] || {}).label || '建具', `${G.fmtM(g.w)}m`));
    (project.fixtures || []).forEach((x) => push('照明・音響', 'fixtures', x, (M.FIXTURE_CATALOG[x.kind] || {}).label || '設備', (M.FIXTURE_CATALOG[x.kind] || {}).symbol || ''));
    (project.notes || []).forEach((n) => push('メモ', 'notes', n, n.leader === false ? 'コメント' : 'メモ', (n.text || '').split('\n')[0] || ''));
    return rows;
  }

  function renderElementList() {
    const box = $('elementList');
    if (!box) return;
    const rows = elementListRows();
    if (!rows.length) {
      box.innerHTML = '<p class="muted">要素がありません。</p>';
      return;
    }
    let html = '';
    let group = '';
    for (const row of rows) {
      if (row.group !== group) {
        group = row.group;
        html += `<div class="element-group-title">${esc(group)}</div>`;
      }
      const active = state.selectedId === row.el.id ? ' active' : '';
      html += `<div class="element-row${active}" data-select-id="${esc(row.el.id)}">
        <button type="button" class="element-main" data-select-id="${esc(row.el.id)}">
          <span class="element-name">${esc(row.label)}</span>
          <span class="element-sub">${esc(row.sub || '')}</span>
        </button>
        <button type="button" class="element-delete" data-delete-id="${esc(row.el.id)}">削除</button>
      </div>`;
    }
    box.innerHTML = html;
    box.querySelectorAll('[data-select-id]').forEach((btn) => {
      btn.onclick = () => {
        const found = M.findById(project, btn.dataset.selectId);
        if (!found) return;
        state.selectedId = found.element.id;
        draw();
        showProps(found.element);
        renderElementList();
      };
    });
    box.querySelectorAll('[data-delete-id]').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const id = btn.dataset.deleteId;
        M.removeById(project, id);
        if (state.selectedId === id) {
          state.selectedId = null;
          showProps(null);
        }
        refresh();
      };
    });
  }

  function renderSummary() {
    const s = G.summary(project);
    const method = project.meta.premisesMethod || 'regions';
    const cl = project.premise ? G.premiseCalc(project.premise).total : null;
    const clText = cl != null ? `${cl.toFixed(2)} ㎡` : '<span class="muted">外周未作成</span>';
    let rows = '';
    if (method === 'centerline') {
      rows += `<tr><th>営業所面積(壁芯)</th><td>${clText}</td></tr>`;
    } else if (method === 'both') {
      rows += `<tr><th>営業所面積(壁芯)</th><td>${clText}</td></tr>
               <tr><th>営業所面積(内法合計)</th><td>${s.premises.toFixed(2)} ㎡</td></tr>`;
    } else {
      rows += `<tr><th>営業所面積</th><td>${s.premises.toFixed(2)} ㎡</td></tr>`;
    }
    $('summaryTable').innerHTML = rows + `
      <tr><th>客室面積</th><td>${s.kyakushitsu.toFixed(2)} ㎡</td></tr>
      <tr><th>厨房面積</th><td>${s.chubo.toFixed(2)} ㎡</td></tr>
      <tr><th>トイレ面積</th><td>${s.toilet.toFixed(2)} ㎡</td></tr>
      <tr><th>その他面積</th><td>${s.other.toFixed(2)} ㎡</td></tr>`;
  }

  function kyusekiTableHtml(title, t) {
    // 柱の控除行(面積が負)は「△0.0900」のように差し引きとして表示する
    let rows = t.rows.map((r) => {
      const area = r.area < 0 ? `△${Math.abs(r.area).toFixed(4)}` : r.area.toFixed(4);
      return `<tr><td>${r.code}</td><td>${esc(r.label)}</td><td>${r.expr}</td><td>${area}</td></tr>`;
    }).join('');
    if (!rows) rows = '<tr><td colspan="4" class="muted">区画がありません</td></tr>';
    return `
      <div class="kyuseki-title">${title}</div>
      <table class="kyuseki">
        <thead><tr><th>符号</th><th>区画</th><th>計算式</th><th>面積(㎡)</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><td colspan="3">合計(総面積)</td><td>${t.total.toFixed(2)} ㎡</td></tr></tfoot>
      </table>`;
  }

  /* 照明・音響設備一覧表(設備図に添える) */
  function fixtureTableHtml() {
    const list = G.fixtureSummary(project);
    let rows = list.map((g) => {
      const title = g.manualCount
        ? `手入力中。空欄にすると自動集計(${g.autoCount})へ戻ります`
        : `自動集計: ${g.autoCount}。数字を入れると手入力できます`;
      return `<tr><td>${esc(g.symbol)}</td><td>${esc(g.label)}</td>
        <td><input type="number" min="0" step="1" class="fixture-count-input"
          data-fixture-count="${esc(g.kind)}" value="${g.count}" title="${esc(title)}"></td>
        <td>${esc(g.watt || '—')}</td></tr>`;
    }).join('');
    if (!rows) rows = '<tr><td colspan="4" class="muted">設備がありません</td></tr>';
    return `
      <div class="kyuseki-title">照明・音響設備一覧表</div>
      <table class="kyuseki">
        <thead><tr><th>記号</th><th>設備</th><th>数量</th><th>W数</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  /* 多角形1つ分の座標求積表(頂点番号は図面の P1, P2 … と対応) */
  function coordTableHtml(r) {
    const c = G.polygonCalc(r);
    const rows = c.rows.map((row) =>
      `<tr><td>P${row.no}</td><td>${row.x.toFixed(2)}</td><td>${row.y.toFixed(2)}</td>
       <td>${row.dy.toFixed(2)}</td><td>${row.prod.toFixed(4)}</td></tr>`).join('');
    return `
      <div class="kyuseki-title">座標求積表(${esc(r.label)})</div>
      <table class="kyuseki coord">
        <thead><tr><th>点</th><th>X(m)</th><th>Y(m)</th><th>Y次−Y前</th><th>X×(Y次−Y前)</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr><td colspan="4">倍面積</td><td>${c.doubleArea.toFixed(4)}</td></tr>
          <tr><td colspan="4">面積(倍面積÷2)</td><td>${c.area4.toFixed(4)} ㎡</td></tr>
        </tfoot>
      </table>`;
  }

  /* 指定の種類に含まれる多角形すべての座標求積表 */
  function coordTablesHtml(filterTypes) {
    return project.regions
      .filter((r) => r.shape === 'polygon' &&
        !G.isPillarRegion(r) &&
        r.boundaryOnly !== true &&
        G.areaUseForRegion(r) !== 'display' &&
        (!filterTypes || filterTypes.indexOf(G.areaUseForRegion(r)) >= 0))
      .map(coordTableHtml).join('');
  }

  /* 壁芯外周の求積表(座標法)。外周が未作成なら案内を出す。 */
  function premiseKyusekiHtml() {
    if (!project.premise) {
      return `<div class="kyuseki-title">営業所求積表(壁芯)</div>
        <p class="muted">営業所外周が未作成です。左の「営業所外周(壁芯)」で作成してください。</p>`;
    }
    const c = G.premiseCalc(project.premise);
    const rows = c.rows.map((row) =>
      `<tr><td>P${row.no}</td><td>${row.x.toFixed(2)}</td><td>${row.y.toFixed(2)}</td>
       <td>${row.dy.toFixed(2)}</td><td>${row.prod.toFixed(4)}</td></tr>`).join('');
    return `
      <div class="kyuseki-title">営業所求積表(壁芯・座標法)</div>
      <table class="kyuseki coord">
        <thead><tr><th>点</th><th>X(m)</th><th>Y(m)</th><th>Y次−Y前</th><th>X×(Y次−Y前)</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr><td colspan="4">倍面積</td><td>${c.doubleArea.toFixed(4)}</td></tr>
          <tr><td colspan="4">面積(倍面積÷2)</td><td>${c.area4.toFixed(4)} ㎡</td></tr>
          <tr><td colspan="4">営業所面積(壁芯)</td><td>${c.total.toFixed(2)} ㎡</td></tr>
        </tfoot>
      </table>`;
  }

  /* 備品一覧表(備品姿図に添える)。同じ種類・寸法をまとめ、番号と高さを示す。 */
  function furnTableHtml() {
    const groups = G.furnitureGroups(project);
    let rows = groups.map((g) => {
      const warn = g.over ? '<span class="ng-text">高さ1m超</span>' : '—';
      return `<tr><td>${esc(g.label)}${G.code(g.number)}</td><td>${g.w}×${g.h}</td>
        <td>${g.height}</td><td>${g.count}</td><td>${warn}</td></tr>`;
    }).join('');
    if (!rows) rows = '<tr><td colspan="5" class="muted">備品がありません</td></tr>';
    return `
      <div class="kyuseki-title">備品一覧表</div>
      <table class="kyuseki">
        <thead><tr><th>品名(番号)</th><th>幅×奥行(mm)</th><th>高さ(mm)</th><th>数量</th><th>備考</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  function renderKyuseki() {
    const layer = R.getLayer();
    // 見出しもページに合わせる(照明音響図=設備一覧表 / 備品姿図=備品一覧表)
    $('kyusekiHead').textContent =
      layer === 'lighting' ? '設備一覧表' : (layer === 'furnviews' ? '備品一覧表' : '求積表');
    // 「計算過程を図面に載せる」ボタンは求積図(営業所/客室・調理場)でだけ出す
    $('kyusekiToggleRow').style.display =
      (layer === 'premises' || layer === 'kyakushitsu') ? '' : 'none';
    let html;
    if (layer === 'kyakushitsu') {
      // 客室・調理場求積図: 客室と調理場の求積表を別々に出す
      html = kyusekiTableHtml('客室求積表', G.buildTable(project, ['kyakushitsu'])) +
             kyusekiTableHtml('調理場求積表', G.buildTable(project, ['chubo'])) +
             coordTablesHtml(['kyakushitsu', 'chubo']);
    } else if (layer === 'lighting') {
      html = fixtureTableHtml();
    } else if (layer === 'furnviews') {
      html = furnTableHtml();
    } else {
      // 営業所求積: 方式(区画合計/壁芯/両方)に応じて出し分ける
      const method = project.meta.premisesMethod || 'regions';
      const parts = [];
      if (method !== 'regions') parts.push(premiseKyusekiHtml());
      if (method !== 'centerline') {
        parts.push(kyusekiTableHtml(
          method === 'both' ? '営業所求積表(内法・区画合計)' : '営業所求積表',
          G.buildTable(project, null)) + coordTablesHtml(null));
      }
      html = parts.join('');
    }
    $('kyusekiBox').innerHTML = html;
    if (layer === 'lighting') bindFixtureCountInputs();
  }

  function bindFixtureCountInputs() {
    $('kyusekiBox').querySelectorAll('[data-fixture-count]').forEach((inp) => {
      inp.addEventListener('input', (e) => {
        const kind = e.target.dataset.fixtureCount;
        project.meta.fixtureCountOverrides = project.meta.fixtureCountOverrides || {};
        if (e.target.value === '') {
          delete project.meta.fixtureCountOverrides[kind];
        } else {
          const n = Math.max(0, Math.round(parseFloat(e.target.value) || 0));
          project.meta.fixtureCountOverrides[kind] = n;
        }
        draw();
      });
      inp.addEventListener('change', (e) => {
        if (e.target.value === '') {
          renderKyuseki();
          return;
        }
        e.target.value = String(Math.max(0, Math.round(parseFloat(e.target.value) || 0)));
      });
    });
  }

  function renderWarnings() {
    const box = $('warnBox');
    let html = '';

    // 1) 見通し規制(高さ概ね1m以上の設備)
    const w = G.sightlineWarnings(project);
    if (w.length) {
      html += '<p class="ng">客室の見通しを妨げるおそれ(高さ1m超):</p><ul>' +
        w.map((x) => `<li>${esc(x.label)}(${(x.height / 1000).toFixed(2)}m)</li>`).join('') +
        '</ul>';
    } else {
      html += '<p class="ok">見通し: 高さ1mを超える設備はありません。</p>';
    }

    // 2) 客室の床面積要件(2室以上のとき各室9.5㎡以上)
    const rooms = project.regions.filter((r) => r.type === 'kyakushitsu');
    const small = G.kyakushitsuSizeWarnings(project);
    if (small.length) {
      html += `<p class="ng">客室が2室以上の場合、1室 ${G.KYAKUSHITSU_MIN_SQM}㎡ 以上が必要です:</p><ul>` +
        small.map((x) => `<li>${esc(x.label)}(${x.area.toFixed(4)}㎡)</li>`).join('') +
        '</ul>';
    } else if (rooms.length >= 2) {
      html += `<p class="ok">客室面積: 全室 ${G.KYAKUSHITSU_MIN_SQM}㎡ 以上を満たしています。</p>`;
    } else if (rooms.length === 1) {
      html += '<p class="ok">客室面積: 客室1室のみのため面積の下限はありません。</p>';
    }

    // 3) 構造・設備の固定リマインダー(図面からは判定できない要件)
    html += `
      <details class="reminder">
        <summary>構造・設備の要件メモ(クリックで開く)</summary>
        <ul class="muted-list">
          <li>客室の出入口に施錠設備を設けない(外部に直接面する出入口を除く)</li>
          <li>営業所内の照度を20ルクス以下としない(調光器(スライダック)は不可)</li>
          <li>騒音・振動は条例の数値基準に適合させる</li>
          <li>善良の風俗を害するおそれのある写真・装飾等を設けない</li>
        </ul>
      </details>`;

    box.innerHTML = html;
  }

  /* ---- プロパティ編集 ---- */
  function showProps(el) {
    const box = $('props');
    if (!el) { box.innerHTML = '<p class="muted">要素を選ぶと編集できます。</p>'; return; }
    if (el.kind === 'sheetTable' || (el.id || '').indexOf('sheet-table:') === 0) {
      const layer = el.layer || String(el.id).replace('sheet-table:', '');
      const layouts = project.meta.sheetTableLayouts || {};
      const cur = layouts[layer] || {};
      const x = Number.isFinite(cur.x) ? cur.x : el.x;
      const y = Number.isFinite(cur.y) ? cur.y : el.y;
      const scale = cur.scale || el.scale || 0.8;
      box.innerHTML = `<div class="prop-row"><span>種別</span><b>${esc(el.label || '図面上の表')}</b></div>
        <label class="prop-row"><span>X位置(mm)</span><input type="number" step="10" id="sheetTableX" value="${Math.round(x || 0)}"></label>
        <label class="prop-row"><span>Y位置(mm)</span><input type="number" step="10" id="sheetTableY" value="${Math.round(y || 0)}"></label>
        <label class="prop-row"><span>サイズ(%)</span><input type="number" step="5" min="45" max="240" id="sheetTableScale" value="${Math.round(scale * 100)}"></label>
        <p class="muted">表の中をドラッグで移動、右下の青い四角をドラッグでサイズ変更できます。</p>
        <button class="btn small" id="sheetTableReset">右下の自動位置に戻す</button>`;
      const apply = () => {
        const nx = parseFloat($('sheetTableX').value) || 0;
        const ny = parseFloat($('sheetTableY').value) || 0;
        const ns = (parseFloat($('sheetTableScale').value) || 100) / 100;
        R.setSheetTableLayout(project, layer, { x: nx, y: ny, scale: ns });
        draw();
      };
      ['sheetTableX', 'sheetTableY', 'sheetTableScale'].forEach((id) => {
        $(id).addEventListener('change', apply);
      });
      $('sheetTableReset').onclick = () => {
        if (project.meta.sheetTableLayouts) delete project.meta.sheetTableLayouts[layer];
        state.selectedId = null;
        draw();
        showProps(null);
      };
      return;
    }
    const found = M.findById(project, el.id);
    if (!found) { box.innerHTML = '<p class="muted">—</p>'; return; }
    const kind = found.kind;
    let html;
    if (kind === 'regions') {
      // 区画は種別(客室・厨房・トイレ…)をあとから変更できる
      const opts = Object.entries(M.REGION_TYPES).map(([k, v]) =>
        `<option value="${k}"${el.type === k ? ' selected' : ''}>${v.label}</option>`).join('');
      html = `<div class="prop-row"><span>種別</span><select id="propType">${opts}</select></div>`;
      const areaOpts = Object.entries(M.AREA_USES).map(([k, v]) =>
        `<option value="${k}"${(el.areaUse || 'auto') === k ? ' selected' : ''}>${v.label}</option>`).join('');
      html += `<div class="prop-row"><span>面積の扱い</span><select id="propAreaUse">${areaOpts}</select></div>`;
      html += `<div class="prop-row"><span>線種</span><select id="propBoundaryLineStyle">
        <option value="solid"${(el.boundaryLineStyle || 'solid') === 'solid' ? ' selected' : ''}>実線</option>
        <option value="dotted"${el.boundaryLineStyle === 'dotted' ? ' selected' : ''}>点線</option>
        <option value="dashed"${el.boundaryLineStyle === 'dashed' ? ' selected' : ''}>破線</option>
      </select></div>`;
      html += `<label class="prop-row"><span>線色</span>
        <input type="color" id="propBoundaryColor" value="${el.boundaryColor || '#333333'}"></label>`;
      html += `<label class="check-row"><input type="checkbox" data-fieldbool="showDims" ${el.showDims !== false ? 'checked' : ''}> 辺の長さを表示</label>`;
      const edgeCount = regionEdgeCount(el);
      const hiddenEdges = new Set((el.hiddenEdges || []).map((n) => parseInt(n, 10)));
      html += '<div class="prop-row"><span>輪郭線</span><div class="check-stack">';
      for (let i = 0; i < edgeCount; i++) {
        html += `<label class="check-row"><input type="checkbox" data-region-edge="${i}" ${hiddenEdges.has(i) ? '' : 'checked'}> 辺${i + 1}を表示</label>`;
      }
      html += '<button type="button" id="btnShowAllEdges" class="btn small">すべて表示</button></div></div>';
      html += `<label class="check-row"><input type="checkbox" data-fieldbool="showLabel" ${el.showLabel ? 'checked' : ''}> 区画名を図面に表示</label>`;
    } else {
      html = `<div class="prop-row"><span>種別</span><b>${kindLabel(el, kind)}</b></div>`;
    }
    if (kind === 'notes') {
      // メモは本文(複数行可)を直接編集する
      html += `<label class="prop-row"><span>本文</span>
        <textarea data-field="text" rows="3">${esc(el.text || '')}</textarea></label>`;
    } else if (kind !== 'dimensions') {
      html += propText('ラベル', 'label', el.label);
    }
    if (kind === 'regions') {
      const autoExpr = G.regionCalc(el).expr;
      html += propText('求積表の計算式', 'calcExpr', el.calcExpr || '');
      html += `<p class="muted">空欄なら自動: ${esc(autoExpr)}。面積の数値は図形から自動計算されます。</p>`;
    }
    // ラベルを持つ要素は文字サイズを個別に調整できる。
    // Googleドキュメント風のサイズ番号(15=標準)で、−/＋は段階リストを移動する。
    if (kind === 'regions' || kind === 'furniture' || kind === 'fittings' || kind === 'notes' || kind === 'dimensions') {
      const dMm = kind === 'regions' ? 320 : (kind === 'furniture' || kind === 'fittings' ? 200 : 240); // render.js の既定値と揃える
      const curSize = el.fontSize > 0 ? el.fontSize
        : (el.fontMm > 0 ? Math.round(el.fontMm / dMm * 15) : 15);
      html += `<div class="prop-row"><span>文字サイズ</span>
        <span class="font-ctrl">
          <button type="button" id="fontMinus" class="btn small">−</button>
          <input type="number" id="fontInput" step="1" min="6" max="96"
                 value="${curSize}" title="サイズ(15=標準)">
          <button type="button" id="fontPlus" class="btn small">＋</button>
          <button type="button" id="fontAuto" class="btn small">標準</button>
        </span></div>`;
    }
    if (kind === 'dimensions') {
      // 寸法線: 長さ(自動)と表示する図面、両端の座標(直接入力も可)
      const lenM = G.mmToM(Math.hypot(el.x2 - el.x1, el.y2 - el.y1));
      const dimLayers = Array.isArray(el.layers) && el.layers.length
        ? el.layers
        : ['plan', 'premises', 'kyakushitsu'];
      const dimLayerOptions = [
        ['plan', '平面図'],
        ['premises', '営業所求積図'],
        ['kyakushitsu', '客室・調理場求積図'],
        ['lighting', '照明・音響設備図'],
      ];
      html += `<div class="prop-row"><span>長さ</span><b id="propDimLen">${lenM.toFixed(2)} m</b></div>`;
      html += '<div class="prop-row"><span>表示する図面</span><div class="check-stack">';
      dimLayerOptions.forEach(([layer, label]) => {
        html += `<label class="check-row"><input type="checkbox" data-dim-layer="${layer}" ${dimLayers.indexOf(layer) >= 0 ? 'checked' : ''}> ${label}</label>`;
      });
      html += '</div></div>';
      html += propNum('始点X(mm)', 'x1', el.x1) + propNum('始点Y(mm)', 'y1', el.y1);
      html += propNum('終点X(mm)', 'x2', el.x2) + propNum('終点Y(mm)', 'y2', el.y2);
      html += '<p class="muted">両端の□はキャンバス上でドラッグでも動かせます。</p>';
    } else {
      html += propNum('X位置(mm)', 'x', el.x);
      html += propNum('Y位置(mm)', 'y', el.y);
    }
    if (kind === 'notes') {
      // どの図面に表示するかをあとから複数選べる(矢印の先端はドラッグで移動)
      const noteLayers = Array.isArray(el.layers) && el.layers.length
        ? el.layers
        : [el.layer || 'plan'];
      const noteHelp = el.leader === false
        ? '文字ブロックは本体をドラッグで好きな位置へ動かせます。'
        : '矢印の先端(□)はドラッグで指したい場所へ動かせます。';
      html += '<div class="prop-row"><span>表示する図面</span><div class="check-stack">';
      Object.entries(R.LAYERS).forEach(([layer, info]) => {
        html += `<label class="check-row"><input type="checkbox" data-note-layer="${layer}" ${noteLayers.indexOf(layer) >= 0 ? 'checked' : ''}> ${info.label}</label>`;
      });
      html += `</div></div><p class="muted">${noteHelp}</p>`;
    }
    if (kind === 'furniture' && el.shape === 'polygon') {
      // 自由な形の備品: 頂点の座標(絶対mm)を1点ずつ編集できる。ドラッグでも修正可
      html += '<div class="prop-row"><span>形</span><b>自由な形(多角形)</b></div>';
      html += '<p class="muted">頂点はキャンバス上でドラッグでも動かせます。</p>';
      el.points.forEach((p, i) => {
        html += `<div class="prop-row vertex-row"><span>P${i + 1}</span>
          <input type="number" step="10" data-vx="${i}" value="${el.x + p.x}" title="X(mm)">
          <input type="number" step="10" data-vy="${i}" value="${el.y + p.y}" title="Y(mm)"></div>`;
      });
    } else if (kind === 'furniture' || kind === 'fittings') {
      // (自由な形の備品はここを通らない。下の姿図ボタンへ続く)
      html += propNum(kind === 'fittings' ? '長さ(mm)' : '幅(mm)', 'w', el.w);
      html += propNum(kind === 'fittings' ? '厚み(mm)' : '奥行(mm)', 'h', el.h);
      if (el.kind === 'counterL') {
        // L字カウンターの腕の幅(天板の奥行)と、縦の腕を左右どちらに出すかを調整できる
        html += propNum('カウンター幅(mm)', 't', el.t || 600);
        html += `<label class="check-row"><input type="checkbox" data-fieldbool="mirrorL" ${el.mirrorL ? 'checked' : ''}> L字の突起を左右反転</label>`;
      }
      html += propNum('角度(度)', 'rotation', el.rotation || 0);
      // 扉・戸は開き勝手(開く方向)を切り替えられる
      if (M.DOOR_KINDS.indexOf(el.kind) >= 0) {
        const slide = el.kind !== 'door' && el.kind !== 'doorDouble';
        html += `<label class="check-row"><input type="checkbox" data-fieldbool="flip" ${el.flip ? 'checked' : ''}> ${slide ? '引く向きを左右反転' : '吊元(ヒンジ)を左右反転'}</label>`;
        html += `<label class="check-row"><input type="checkbox" data-fieldbool="swing" ${el.swing ? 'checked' : ''}> 開く向きを内・外で反転</label>`;
        html += '<p class="muted">壁に沿う向きは「角度」で、開く方向は上の2つのチェックで調整します。</p>';
      }
    }
    if (kind === 'furniture') {
      html += propNum('高さ(mm)', 'height', el.height || 0);
      // カタログ備品(自由な形でない)は姿図スタイル(正面図・側面図の形)を選べる
      if (el.shape !== 'polygon' && M.FURNITURE_STYLES[el.kind]) {
        const styles = M.FURNITURE_STYLES[el.kind];
        const cur = el.variant || M.defaultStyle(el.kind);
        const opts = Object.entries(styles).map(([k, v]) =>
          `<option value="${k}" ${k === cur ? 'selected' : ''}>${v.label}</option>`).join('');
        html += `<label class="field">姿図スタイル(正面図・側面図)
          <select id="furnVariantSel">${opts}</select></label>
          <p class="muted">備品姿図に出る正面図・側面図の形を選べます。寸法を変えると形も自動で拡大縮小します。</p>`;
      }
      // 番号はサイズ違いの区別用に自動で決まる(同じ種類・同じ寸法 = 同じ番号)
      const num = G.furnitureNumberMap(project)[el.id];
      html += `<div class="prop-row"><span>番号</span><b id="propFurnNum">${num ? G.code(num) : '—'}</b></div>
        <p class="muted">番号は自動: 同じ種類・同じ寸法は同じ番号。寸法を変えると振り直されます。</p>`;
    }
    if (kind === 'furniture' && el.shape === 'polygon') {
      // 備品姿図の正面・側面に出す「横から見た形」を、姿図画面でなぞって作る
      const hasF = el.front && el.front.length >= 2;
      const hasS = el.side && el.side.length >= 2;
      html += '<div class="prop-row"><span>姿図の形</span><b>'
        + (hasF ? '正面✓' : '正面—') + ' / ' + (hasS ? '側面✓' : '側面—') + '</b></div>';
      html += `<div class="add-row">
        <button class="btn small" id="btnProfFront">${hasF ? '正面を描き直す' : '正面の形を描く'}</button>
        <button class="btn small" id="btnProfSide">${hasS ? '側面を描き直す' : '側面の形を描く'}</button></div>`;
      if (hasF || hasS) {
        html += `<div class="add-row">
          ${hasF ? '<button class="btn small danger" id="btnProfClearF">正面を消す</button>' : ''}
          ${hasS ? '<button class="btn small danger" id="btnProfClearS">側面を消す</button>' : ''}</div>`;
      }
      html += '<p class="muted">押すと備品姿図に切り替わります。姿図の正面/側面の四角に重ねて、横から見た形をクリックでなぞってください(Enterで確定)。</p>';
    }
    if (kind === 'fixtures') {
      html += propText('ワット数', 'watt', el.watt || '');
      html += propText('型番メモ', 'model', el.model || '');
    }
    if (kind === 'premise') {
      // 壁厚・測り方は左の「営業所外周(壁芯)」欄から変更する(入力欄を1か所にまとめる)
      const c = G.premiseCalc(el);
      html += `<div class="prop-row"><span>壁厚</span><b>${el.wallThickness} mm</b></div>`;
      html += `<div class="prop-row"><span>測り方</span><b>${el.measuredAt === 'center' ? '壁芯の寸法' : '内側の寸法(内法)'}</b></div>`;
      html += `<div class="prop-row"><span>面積(壁芯)</span><b>${c.total.toFixed(2)} ㎡</b></div>`;
      html += '<p class="muted">壁厚・測り方は左の「営業所外周(壁芯)」欄で変更できます。頂点はキャンバス上でドラッグでも動かせます。</p>';
      el.points.forEach((p, i) => {
        html += `<div class="prop-row vertex-row"><span>P${i + 1}</span>
          <input type="number" step="10" data-vx="${i}" value="${el.x + p.x}" title="X(mm)">
          <input type="number" step="10" data-vy="${i}" value="${el.y + p.y}" title="Y(mm)"></div>`;
      });
    }
    if (kind === 'regions') {
      const shape = el.shape || 'rect';
      html += `<div class="prop-row"><span>形</span><b>${shapeLabel(shape)}</b></div>`;
      if (shape === 'polygon') {
        // 頂点の座標(絶対mm)を1点ずつ編集できる。キャンバス上のドラッグでも修正可。
        html += propNum('角度(度)', 'rotation', el.rotation || 0);
        html += '<p class="muted">頂点はキャンバス上でドラッグでも動かせます。</p>';
        const absPts = G.polygonAbsPoints(el);
        el.points.forEach((p, i) => {
          const abs = absPts[i] || { x: el.x + p.x, y: el.y + p.y };
          html += `<div class="prop-row vertex-row"><span>P${i + 1}</span>
            <input type="number" step="10" data-vx="${i}" value="${Math.round(abs.x)}" title="X(mm)">
            <input type="number" step="10" data-vy="${i}" value="${Math.round(abs.y)}" title="Y(mm)"></div>`;
        });
      } else {
        const wLabel = shape === 'rect' ? '幅(mm)' : shape === 'triangle' ? '底辺(mm)' : '下底(mm)';
        const hLabel = shape === 'rect' ? '奥行(mm)' : '高さ(mm)';
        html += propNum(wLabel, 'w', el.w);
        if (shape === 'trapezoid') {
          html += propNum('上底(mm)', 'w2', el.w2 != null ? el.w2 : el.w);
        }
        html += propNum(hLabel, 'h', el.h);
        html += propNum('角度(度)', 'rotation', el.rotation || 0);
      }
      const area = G.regionAreaSqm(el);
      html += `<div class="prop-row"><span>面積</span><b id="propArea">${area.toFixed(4)} ㎡</b></div>`;
    }
    if (kind === 'premise') {
      // 営業所外周は1つだけなので複製はなし
      html += `<button class="btn small danger" id="btnDel">この要素を削除</button>`;
    } else {
      html += `<div class="prop-row z-order-row"><span>重なり順</span>
        <div class="z-order-controls">
          <button type="button" class="btn small" id="btnZBack" title="最背面へ">最背面</button>
          <button type="button" class="btn small" id="btnZBackward" title="1つ背面へ">背面</button>
          <button type="button" class="btn small" id="btnZForward" title="1つ前面へ">前面</button>
          <button type="button" class="btn small" id="btnZFront" title="最前面へ">最前面</button>
        </div></div>`;
      html += `<div class="add-row">
        <button class="btn small" id="btnDup" title="複製 (Cmd/Ctrl+D)">複製</button>
        <button class="btn small danger" id="btnDel">この要素を削除</button></div>`;
    }
    box.innerHTML = html;

    box.querySelectorAll('[data-field]').forEach((inp) => {
      inp.addEventListener('input', (e) => {
        const f = e.target.dataset.field;
        let v = e.target.value;
        if (e.target.type === 'number') v = parseFloat(v) || 0;
        el[f] = v;
        refresh();
        // 面積表示を即時に更新(幅・奥行の変更に追従)
        const areaEl = box.querySelector('#propArea');
        if (areaEl) areaEl.textContent = G.regionAreaSqm(el).toFixed(4) + ' ㎡';
        // 備品の番号表示も即時に更新(寸法の変更で振り直されるため)
        const numEl = box.querySelector('#propFurnNum');
        if (numEl) {
          const n = G.furnitureNumberMap(project)[el.id];
          numEl.textContent = n ? G.code(n) : '—';
        }
        // 寸法線の長さ表示も即時に更新(始点・終点の変更に追従)
        const lenEl = box.querySelector('#propDimLen');
        if (lenEl) {
          lenEl.textContent = G.mmToM(Math.hypot(el.x2 - el.x1, el.y2 - el.y1)).toFixed(2) + ' m';
        }
      });
    });
    // チェックボックス式のプロパティ(扉の開き勝手 flip / swing など)
    box.querySelectorAll('[data-fieldbool]').forEach((inp) => {
      inp.addEventListener('change', (e) => {
        el[e.target.dataset.fieldbool] = e.target.checked;
        refresh();
      });
    });

    // カタログ備品: 姿図スタイル(正面図・側面図の形)を切り替える
    const vs = box.querySelector('#furnVariantSel');
    if (vs) vs.onchange = () => { el.variant = vs.value; refresh(); showProps(el); };

    // 自由な形の備品: 正面・側面の「横から見た形」をなぞる / 消す
    const bf = box.querySelector('#btnProfFront');
    if (bf) bf.onclick = () => startProfile(el.id, 'front');
    const bs = box.querySelector('#btnProfSide');
    if (bs) bs.onclick = () => startProfile(el.id, 'side');
    const cf = box.querySelector('#btnProfClearF');
    if (cf) cf.onclick = () => { el.front = null; refresh(); showProps(el); };
    const cs = box.querySelector('#btnProfClearS');
    if (cs) cs.onclick = () => { el.side = null; refresh(); showProps(el); };

    // 文字サイズ(Googleドキュメント風)。15が標準で、−/＋は段階リストの
    // 前後のサイズへ移動する。数値の直接入力も可能(6〜96)。標準=15に戻す。
    const fontInput = box.querySelector('#fontInput');
    if (fontInput) {
      const STEPS = [8, 9, 10, 11, 12, 14, 15, 18, 24, 30, 36, 48, 60, 72, 96];
      const defaultMm = kind === 'regions' ? 320 : 200; // render.js の既定値と揃える
      const current = () => (el.fontSize > 0 ? el.fontSize
        : (el.fontMm > 0 ? Math.round(el.fontMm / defaultMm * 15) : 15));
      const apply = (s) => {
        el.fontSize = Math.min(96, Math.max(6, Math.round(s)));
        el.fontMm = 0; // 旧形式の指定は新形式へ置き換える
        fontInput.value = el.fontSize;
        refresh();
      };
      box.querySelector('#fontMinus').onclick = () => {
        const c = current();
        const smaller = STEPS.filter((s) => s < c);
        apply(smaller.length ? smaller[smaller.length - 1] : c);
      };
      box.querySelector('#fontPlus').onclick = () => {
        const c = current();
        const bigger = STEPS.find((s) => s > c);
        apply(bigger != null ? bigger : c);
      };
      box.querySelector('#fontAuto').onclick = () => apply(15);
      // 入力中は値を書き戻さない(タイプの邪魔をしない)。確定時にだけ丸める。
      fontInput.addEventListener('input', (e) => {
        const v = parseFloat(e.target.value);
        if (v > 0) {
          el.fontSize = Math.min(96, Math.max(6, Math.round(v)));
          el.fontMm = 0;
          refresh();
        }
      });
      fontInput.addEventListener('change', () => apply(current()));
    }
    // 区画の種別変更: ラベル・色・通し番号を新しい種別に合わせて付け直す
    const typeSel = box.querySelector('#propType');
    if (typeSel) {
      typeSel.onchange = (e) => {
        const t = e.target.value;
        el.type = t;
        el.color = M.REGION_TYPES[t].color;
        el.number = M.nextRegionNumber(project, t);
        el.label = t === 'kyakushitsu' ? `客室${el.number}` : M.REGION_TYPES[t].label;
        el.areaUse = M.REGION_TYPES[t].defaultAreaUse || 'auto';
        ensureRegionVisible(t);
        refresh(); showProps(el);
      };
    }
    const areaUseSel = box.querySelector('#propAreaUse');
    if (areaUseSel) {
      areaUseSel.onchange = (e) => {
        el.areaUse = e.target.value;
        refresh(); showProps(el);
      };
    }
    const boundaryStyle = box.querySelector('#propBoundaryLineStyle');
    if (boundaryStyle) {
      boundaryStyle.onchange = (e) => {
        el.boundaryLineStyle = e.target.value;
        refresh(); showProps(el);
      };
    }
    const boundaryColor = box.querySelector('#propBoundaryColor');
    if (boundaryColor) {
      boundaryColor.oninput = (e) => {
        el.boundaryColor = e.target.value;
        refresh();
      };
    }
    const edgeChecks = Array.from(box.querySelectorAll('[data-region-edge]'));
    if (edgeChecks.length) {
      const syncHiddenEdges = () => {
        const hidden = edgeChecks
          .filter((inp) => !inp.checked)
          .map((inp) => parseInt(inp.dataset.regionEdge, 10))
          .filter((n) => Number.isFinite(n));
        el.hiddenEdges = hidden;
        refresh(); showProps(el);
      };
      edgeChecks.forEach((inp) => { inp.onchange = syncHiddenEdges; });
      const showAllEdges = box.querySelector('#btnShowAllEdges');
      if (showAllEdges) {
        showAllEdges.onclick = () => {
          el.hiddenEdges = [];
          refresh(); showProps(el);
        };
      }
    }
    // 多角形の頂点座標の編集(原点の取り直しがあるため change で確定時に反映)
    box.querySelectorAll('[data-vx], [data-vy]').forEach((inp) => {
      inp.addEventListener('change', (e) => {
        const isX = 'vx' in e.target.dataset;
        const i = parseInt(isX ? e.target.dataset.vx : e.target.dataset.vy, 10);
        const v = parseFloat(e.target.value) || 0;
        const abs = G.polygonAbsPoints(el)[i] || { x: el.x + el.points[i].x, y: el.y + el.points[i].y };
        const wx = isX ? v : abs.x;
        const wy = isX ? abs.y : v;
        const angle = -(el.rotation || 0) * Math.PI / 180;
        const cx = el.x + (el.w || 0) / 2;
        const cy = el.y + (el.h || 0) / 2;
        const dx = wx - cx;
        const dy = wy - cy;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        el.points[i].x = (cx + dx * cos - dy * sin) - el.x;
        el.points[i].y = (cy + dx * sin + dy * cos) - el.y;
        M.normalizePolygon(el);
        refresh(); showProps(el);
      });
    });
    // メモ・コメントの表示先の図面を変更(寸法線と同じく複数選択できる)
    const noteLayerChecks = Array.from(box.querySelectorAll('[data-note-layer]'));
    if (noteLayerChecks.length) {
      noteLayerChecks.forEach((inp) => {
        inp.onchange = () => {
          const layers = noteLayerChecks.filter((check) => check.checked).map((check) => check.dataset.noteLayer);
          if (!layers.length) {
            inp.checked = true;
            return;
          }
          el.layers = layers;
          el.layer = layers.length === 1 ? layers[0] : 'custom';
          if (layers.indexOf(R.getLayer()) < 0) {
            R.setLayer(layers[0]);
            buildLayerTabs();
          }
          refresh(); showProps(el);
        };
      });
    }
    const dimLayerChecks = Array.from(box.querySelectorAll('[data-dim-layer]'));
    if (dimLayerChecks.length) {
      dimLayerChecks.forEach((inp) => {
        inp.onchange = () => {
          const layers = dimLayerChecks.filter((check) => check.checked).map((check) => check.dataset.dimLayer);
          if (!layers.length) {
            inp.checked = true;
            return;
          }
          el.layers = layers;
          el.layer = 'custom';
          if (layers.indexOf(R.getLayer()) < 0) {
            R.setLayer(layers[0]);
            buildLayerTabs();
          }
          refresh(); showProps(el);
        };
      });
    }
    const dupBtn = box.querySelector('#btnDup');
    if (dupBtn) dupBtn.onclick = duplicateSelected;
    const zButtons = [
      ['btnZBack', 'back'],
      ['btnZBackward', 'backward'],
      ['btnZForward', 'forward'],
      ['btnZFront', 'front'],
    ];
    zButtons.forEach(([id, action]) => {
      const btn = box.querySelector('#' + id);
      if (btn) btn.onclick = () => changeZOrder(action);
    });
    $('btnDel').onclick = () => {
      M.removeById(project, el.id);
      state.selectedId = null;
      refresh(); showProps(null);
    };
  }

  function shapeLabel(shape) {
    return { rect: '長方形', triangle: '三角形', trapezoid: '台形', polygon: '多角形' }[shape] || '長方形';
  }

  function regionEdgeCount(region) {
    if (!region) return 0;
    if (region.shape === 'polygon') return (region.points || []).length;
    if (region.shape === 'triangle') return 3;
    return 4;
  }

  function kindLabel(el, kind) {
    if (kind === 'regions') return (M.REGION_TYPES[el.type] || {}).label || '区画';
    if (kind === 'premise') return '営業所外周(壁芯)';
    if (kind === 'furniture') return '備品';
    if (kind === 'fittings') return '建具・設備';
    if (kind === 'fixtures') return '照明・音響設備';
    if (kind === 'notes') return el.leader === false ? 'コメント(自由テキスト)' : 'メモ・引き出し線';
    if (kind === 'dimensions') return '寸法線';
    return '照明・音響';
  }
  function propText(label, field, val) {
    return `<label class="prop-row"><span>${label}</span>
      <input type="text" data-field="${field}" value="${esc(val)}"></label>`;
  }
  function propNum(label, field, val) {
    return `<label class="prop-row"><span>${label}</span>
      <input type="number" step="10" data-field="${field}" value="${val}"></label>`;
  }

  /* ---- 全案件の一括バックアップ ----
   * 案件はブラウザ内に保存されるため、パソコンの買い替えやデータ消去に備えて
   * 全案件を1つのJSONファイルへ書き出し/取り込みできるようにする。 */
  function exportBackup() {
    saveAutosave(); // いま開いている案件を最新の状態にしてから書き出す
    const list = readCases();
    const cases = [];
    for (const c of list) {
      try {
        const text = localStorage.getItem(caseKey(c.id));
        if (text) cases.push({ id: c.id, name: c.name, updatedAt: c.updatedAt, project: JSON.parse(text) });
      } catch (e) { /* 壊れた控えは飛ばす */ }
    }
    if (!cases.length) {
      alert('書き出せる案件がありません。');
      return;
    }
    const data = {
      app: 'shinya-zumen',
      type: 'backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      cases,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `深夜酒類図面_全案件バックアップ_${M.todayStr()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function importBackupFile(e) {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!data || data.type !== 'backup' || !Array.isArray(data.cases)) {
          alert('全案件バックアップのファイルではありません。\n(1案件だけのファイルは上の「読み込み」ボタンから開けます)');
          return;
        }
        const list = readCases();
        const overlap = data.cases.filter((c) => c && list.some((x) => x.id === c.id)).length;
        const msg = `${data.cases.length}件の案件を取り込みます。` +
          (overlap ? `\nうち${overlap}件は同じ案件がすでにあり、バックアップの内容で上書きされます。` : '') +
          '\nよろしいですか?';
        if (!confirm(msg)) return;
        let done = 0;
        for (const c of data.cases) {
          if (!c || !c.id || !c.project) continue;
          localStorage.setItem(caseKey(c.id), JSON.stringify(c.project));
          const it = list.find((x) => x.id === c.id);
          if (it) {
            it.name = c.name || it.name;
            it.updatedAt = c.updatedAt || Date.now();
          } else {
            list.push({ id: c.id, name: c.name || '無題の案件', updatedAt: c.updatedAt || Date.now() });
          }
          done++;
        }
        writeCases(list);
        // いま開いている案件が上書きされたら、取り込んだ内容で開き直す
        if (data.cases.some((c) => c && c.id === currentCaseId)) {
          adoptProject(loadCase(currentCaseId) || project);
          resetHistory();
        }
        buildCaseSelect();
        alert(`${done}件の案件を取り込みました。`);
      } catch (err) {
        alert('取り込みに失敗しました: ' + err.message);
      }
    };
    reader.readAsText(file);
  }

  /* ---- 下絵(間取り図のトレース用画像) ---- */

  /* 画像を読み込み、ブラウザ内保存に収まるよう長辺1600pxへ縮小してから下絵にする */
  function loadUnderlayFile(e) {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const MAX = 1600;
      const scale = Math.min(1, MAX / Math.max(img.width, img.height));
      const cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(img.width * scale));
      cv.height = Math.max(1, Math.round(img.height * scale));
      const c = cv.getContext('2d');
      c.fillStyle = '#fff';
      c.fillRect(0, 0, cv.width, cv.height); // 透過PNGは白地にしてJPEG化
      c.drawImage(img, 0, 0, cv.width, cv.height);
      const src = cv.toDataURL('image/jpeg', 0.8);
      const wMm = 10000; // 仮の横幅10m。「下絵の横幅」で実際の寸法に合わせてもらう
      project.underlay = {
        src,
        x: 0,
        y: 0,
        w: wMm,
        h: Math.round(wMm * cv.height / cv.width),
        opacity: 0.5,
        visible: true,
      };
      syncUnderlayUi();
      R.fitToView(project, canvasCss());
      refresh();
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      alert('画像を読み込めませんでした。JPEG・PNGなどの画像ファイルを選んでください。');
    };
    img.src = url;
  }

  /* 下絵の操作欄を、今の下絵の状態に合わせて表示し直す */
  function syncUnderlayUi() {
    const u = project.underlay;
    $('underlayCtrls').style.display = u ? '' : 'none';
    $('btnUnderlay').textContent = u ? '別の画像に差し替える' : '画像を読み込む';
    if (u) {
      $('underlayW').value = u.w;
      $('underlayOpacity').value = Math.round((u.opacity != null ? u.opacity : 0.5) * 100);
      $('underlayShow').checked = u.visible !== false;
    } else {
      state.underlayMove = false;
    }
    $('underlayMove').checked = !!state.underlayMove;
  }

  /* ---- 保存 / 読み込み ---- */
  function saveFile() {
    const text = M.serialize(project);
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const name = (project.meta.storeName || 'zumen').replace(/\s/g, '_');
    a.href = url; a.download = `${name}_${project.meta.date}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }
  function loadFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        // 開いた内容は今の案件の控えとして自動保存される
        adoptProject(M.deserialize(reader.result));
        resetHistory();
      } catch (err) {
        alert('読み込みに失敗しました: ' + err.message);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  document.addEventListener('DOMContentLoaded', init);
})(window);
