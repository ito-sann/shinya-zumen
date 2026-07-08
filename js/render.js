/* =========================================================================
 * render.js — Canvas 描画。座標は mm(ワールド)→ px(画面)に変換する。
 * 図面の種類(レイヤー)ごとに表示内容を切り替える。
 * ========================================================================= */
(function (global) {
  'use strict';

  /* ビュー(パン・ズーム)。zoom = px/mm */
  const view = { zoom: 0.05, offsetX: 40, offsetY: 40 };

  /* レイヤー(図面の種類)。届出に添付する図面の単位と一致させている。 */
  const LAYERS = {
    plan:      { label: '平面図' },
    kyuseki:   { label: '求積図' },
    lighting:  { label: '照明・音響設備図' },
    plumbing:  { label: '給排水図' },
    furnviews: { label: '備品姿図' },
  };
  const DEFAULT_FITTING_LAYERS = ['plan', 'kyuseki'];
  let currentLayer = 'plan';
  let currentSelectedId = null;
  let sheetTableBoxes = new Map();
  const SHEET_TABLE_PREFIX = 'sheet-table:';
  const DEFAULT_SHEET_TABLE_SCALE = 0.8;

  function setLayer(name) { if (LAYERS[name]) currentLayer = name; }
  function getLayer() { return currentLayer; }

  function fittingLayers(g) {
    return Array.isArray(g && g.layers) && g.layers.length ? g.layers : DEFAULT_FITTING_LAYERS;
  }

  function fittingVisibleOnLayer(g, layer) {
    if (!g || layer === 'furnviews') return false;
    return fittingLayers(g).indexOf(layer) >= 0;
  }

  function worldToScreen(x, y) {
    return { x: x * view.zoom + view.offsetX, y: y * view.zoom + view.offsetY };
  }

  /* 実寸(mm)を画面pxに変換する。文字や記号の大きさを「図面に対して固定」に
   * するために使う。ズームしても部屋との比率が変わらず、PDFでも常に同じ大きさになる。 */
  function wpx(mm) {
    return mm * view.zoom;
  }

  /* 文字サイズの倍率(図面情報の「文字サイズ」設定)。render() の最初に更新する。 */
  let fontScale = 1;

  /* ラベル文字のサイズ(px)を求める。
   *   defaultMm … 既定の実寸(mm)
   *   el        … 要素。el.fontSize(サイズ番号: 15=標準)が指定されていれば
   *               全体設定より優先する。 */
  function fontPx(defaultMm, el) {
    if (el && el.fontSize > 0) return wpx(defaultMm * el.fontSize / 15);
    return wpx(defaultMm * fontScale);
  }
  function screenToWorld(px, py) {
    return { x: (px - view.offsetX) / view.zoom, y: (py - view.offsetY) / view.zoom };
  }

  /* 全要素が収まるようにビューを合わせる(用紙枠の表示中は枠も含める) */
  function fitToView(project, canvas) {
    let bb = currentLayer === 'furnviews'
      ? furnViewLayout(project).bounds
      : global.Geometry.boundingBox(project);
    if (project.meta.showPaperFrame) {
      const f = paperFrameWorld(project);
      const minX = Math.min(bb.x, f.x), minY = Math.min(bb.y, f.y);
      const maxX = Math.max(bb.x + bb.w, f.x + f.w);
      const maxY = Math.max(bb.y + bb.h, f.y + f.h);
      bb = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }
    const margin = 60;
    const pad = Math.max(bb.w, bb.h) * 0.12 + 500;
    const w = bb.w + pad * 2, h = bb.h + pad * 2;
    const zx = (canvas.width - margin * 2) / w;
    const zy = (canvas.height - margin * 2) / h;
    view.zoom = Math.min(zx, zy);
    view.offsetX = margin - (bb.x - pad) * view.zoom;
    view.offsetY = margin - (bb.y - pad) * view.zoom;
  }

  function clear(ctx, canvas) {
    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
  }

  /* 10cm(100mm)グリッド */
  function drawGrid(ctx, canvas) {
    const step = 1000; // 1m ごとに線、太線
    const sub = 100;    // 10cm
    const tl = screenToWorld(0, 0);
    const br = screenToWorld(canvas.width, canvas.height);
    ctx.save();
    ctx.lineWidth = 1;
    // 10cm 細線(ズームが十分なときだけ)
    if (view.zoom > 0.03) {
      ctx.strokeStyle = '#e8e8e8';
      for (let x = Math.floor(tl.x / sub) * sub; x < br.x; x += sub) {
        const s = worldToScreen(x, 0);
        ctx.beginPath(); ctx.moveTo(s.x, 0); ctx.lineTo(s.x, canvas.height); ctx.stroke();
      }
      for (let y = Math.floor(tl.y / sub) * sub; y < br.y; y += sub) {
        const s = worldToScreen(0, y);
        ctx.beginPath(); ctx.moveTo(0, s.y); ctx.lineTo(canvas.width, s.y); ctx.stroke();
      }
    }
    // 1m 太線
    ctx.strokeStyle = '#d6d6d6';
    for (let x = Math.floor(tl.x / step) * step; x < br.x; x += step) {
      const s = worldToScreen(x, 0);
      ctx.beginPath(); ctx.moveTo(s.x, 0); ctx.lineTo(s.x, canvas.height); ctx.stroke();
    }
    for (let y = Math.floor(tl.y / step) * step; y < br.y; y += step) {
      const s = worldToScreen(0, y);
      ctx.beginPath(); ctx.moveTo(0, s.y); ctx.lineTo(canvas.width, s.y); ctx.stroke();
    }
    ctx.restore();
  }

  /* ---- 下絵(間取り図のトレース用画像) ----
   * 画像の読み込みは非同期なので、読み込み完了時に再描画してもらうための
   * コールバックを main.js から登録する。 */
  let redrawCb = null;
  function setRedrawCallback(fn) { redrawCb = fn; }
  const ulCache = { src: null, img: null, ready: false };
  function underlayImage(src) {
    if (ulCache.src !== src) {
      ulCache.src = src;
      ulCache.ready = false;
      const img = new Image();
      img.onload = () => { ulCache.ready = true; if (redrawCb) redrawCb(); };
      img.src = src;
      ulCache.img = img;
    }
    return ulCache.ready ? ulCache.img : null;
  }

  /* 下絵をグリッドの上・図面要素の下に薄く描く。印刷(PDF)には含めない。 */
  function drawUnderlay(ctx, project) {
    const u = project.underlay;
    if (!u || !u.src || u.visible === false) return;
    const img = underlayImage(u.src);
    if (!img) return;
    const tl = worldToScreen(u.x, u.y);
    ctx.save();
    ctx.globalAlpha = Math.min(1, Math.max(0.05, u.opacity != null ? u.opacity : 0.5));
    ctx.drawImage(img, tl.x, tl.y, u.w * view.zoom, u.h * view.zoom);
    ctx.restore();
  }

  /* 形ごとの頂点(中心原点・画面px)。w,h,w2 は px。 */
  function shapePoints(shape, w, h, w2) {
    if (shape === 'triangle') {
      // 直角三角形(直角=左下)。底辺=下、高さ=左。
      return [[-w / 2, h / 2], [w / 2, h / 2], [-w / 2, -h / 2]];
    }
    if (shape === 'trapezoid') {
      const t = w2 / 2; // 上底の半幅
      return [[-w / 2, h / 2], [w / 2, h / 2], [t, -h / 2], [-t, -h / 2]];
    }
    return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
  }

  function tracePoly(ctx, pts) {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
  }

  function counterLPoints(w, h, t, mirror) {
    if (mirror) {
      return [
        [-w / 2, -h / 2],
        [w / 2, -h / 2],
        [w / 2, h / 2],
        [w / 2 - t, h / 2],
        [w / 2 - t, -h / 2 + t],
        [-w / 2, -h / 2 + t],
      ];
    }
    return [
      [-w / 2, -h / 2],
      [w / 2, -h / 2],
      [w / 2, -h / 2 + t],
      [-w / 2 + t, -h / 2 + t],
      [-w / 2 + t, h / 2],
      [-w / 2, h / 2],
    ];
  }

  /* 多角形区画の頂点を画面座標で返す */
  function polygonScreenPts(r) {
    return global.Geometry.polygonAbsPoints(r).map((p) => worldToScreen(p.x, p.y));
  }

  function shouldDrawRegionLabel(r) {
    return r.showLabel === true;
  }

  function isPillarRegion(r) {
    return global.Geometry.isPillarRegion && global.Geometry.isPillarRegion(r);
  }

  function isAreaBoundaryLine(r) {
    if (!r || r.boundaryOnly !== true) return false;
    if (r.boundaryArea === true) return true;
    return ['営業所囲い', '客室囲い', '調理場囲い'].indexOf(r.label || '') >= 0;
  }

  function hiddenEdgeSet(r) {
    return new Set((r.hiddenEdges || [])
      .map((n) => parseInt(n, 10))
      .filter((n) => Number.isFinite(n) && n >= 0));
  }

  /* 辺iに設定された壁厚(mm)。0(未設定)なら普通の1本線のまま。 */
  function edgeWallThicknessMm(r, i) {
    const t = (r.edgeWallThickness || {})[i];
    return Number.isFinite(t) && t > 0 ? t : 0;
  }

  /* 区画の1辺(a-b)を、壁厚ぶん離した黒い2本線(閉じた帯)で描く。
   * 内壁・営業所外周と同じ「厚みを持つ壁」の見た目に揃える。 */
  function strokeRegionWallEdge(ctx, a, b, thicknessPx, selected) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    const hx = nx * thicknessPx / 2, hy = ny * thicknessPx / 2;
    ctx.save();
    ctx.setLineDash([]);
    ctx.strokeStyle = selected ? '#d32f2f' : '#000';
    ctx.beginPath();
    ctx.moveTo(a.x + hx, a.y + hy);
    ctx.lineTo(b.x + hx, b.y + hy);
    ctx.lineTo(b.x - hx, b.y - hy);
    ctx.lineTo(a.x - hx, a.y - hy);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }

  function strokeVisibleEdges(ctx, pts, r, selected) {
    const hidden = hiddenEdgeSet(r);
    for (let i = 0; i < pts.length; i++) {
      if (hidden.has(i)) continue;
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const t = edgeWallThicknessMm(r, i);
      if (t > 0) {
        strokeRegionWallEdge(ctx, a, b, t * view.zoom, selected);
        continue;
      }
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }

  function drawSelectedEdgeLabels(ctx, pts, hidden) {
    ctx.save();
    ctx.setLineDash([]);
    ctx.font = `${fontPx(180)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const x = (a.x + b.x) / 2;
      const y = (a.y + b.y) / 2;
      ctx.fillStyle = hidden.has(i) ? '#fff' : '#fff7ed';
      ctx.strokeStyle = hidden.has(i) ? '#94a3b8' : '#f97316';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.rect(x - 16, y - 9, 32, 18);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = hidden.has(i) ? '#64748b' : '#c2410c';
      ctx.fillText('辺' + (i + 1), x, y);
    }
    ctx.restore();
  }

  /* 多角形区画を描く(塗り・輪郭・ラベル・選択時は頂点ハンドル) */
  function drawPolygonRegion(ctx, r, opts) {
    const pts = polygonScreenPts(r);
    if (pts.length < 3) return;
    const boundaryOnly = r.boundaryOnly === true;
    const muted = boundaryOnly ? false : opts.muted;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    if (opts.fill && !boundaryOnly) {
      ctx.globalAlpha = muted ? 0.15 : 0.55; // 強調対象外は薄く塗る
      ctx.fillStyle = r.color;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.lineWidth = opts.selected ? 3 : 2;
    const customStroke = r.boundaryColor || null;
    ctx.strokeStyle = opts.selected ? '#d32f2f'
      : (opts.neutralStroke || customStroke || (boundaryOnly ? (r.color || '#333') : (muted ? '#9aa0a6' : (opts.stroke || '#333'))));
    ctx.setLineDash(lineDashFor(r.boundaryLineStyle || 'solid'));
    strokeVisibleEdges(ctx, pts, r, opts.selected);
    if (shouldDrawRegionLabel(r)) {
      // ラベルは重心に置く(既定320mm相当・全体設定・個別指定で調整可)
      const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
      const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
      ctx.fillStyle = muted ? '#8a8f94' : '#222';
      ctx.font = `${fontPx(320, r)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText((opts.code ? opts.code + ' ' : '') + r.label, cx, cy);
    }
    // 選択中は頂点ハンドル(ドラッグで形を修正できる)
    if (opts.selected) {
      drawSelectedEdgeLabels(ctx, pts, hiddenEdgeSet(r));
      ctx.setLineDash([]);
      for (const p of pts) {
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = '#d32f2f';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.rect(p.x - 4, p.y - 4, 8, 8);
        ctx.fill(); ctx.stroke();
      }
    }
    ctx.restore();
  }

  /* 多角形の寸法表示: 各辺の長さ(m)を描く。
   * P1, P2 … の頂点番号は図面が混みやすいため、明示指定がある場合だけ描く。 */
  function drawPolygonDims(ctx, r, opts) {
    const pts = polygonScreenPts(r);
    if (pts.length < 3) return;
    const edges = global.Geometry.polygonEdgesM(r);
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    const showPointLabels = opts && opts.showPointLabels === true;
    ctx.save();
    ctx.font = `${fontPx(240)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      // 辺の中点から重心の反対側(外側)に少し離して辺長を書く
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const ox = mx - cx, oy = my - cy;
      const d = Math.hypot(ox, oy) || 1;
      ctx.fillStyle = '#1565c0';
      ctx.fillText(edges[i].toFixed(2) + 'm', mx + (ox / d) * wpx(300), my + (oy / d) * wpx(300));
      if (showPointLabels) {
        // 頂点番号は頂点の外側に
        const vx = a.x - cx, vy = a.y - cy;
        const vd = Math.hypot(vx, vy) || 1;
        ctx.fillStyle = '#6a1b9a';
        ctx.fillText('P' + (i + 1), a.x + (vx / vd) * wpx(260), a.y + (vy / vd) * wpx(260));
      }
    }
    ctx.restore();
  }

  /* 作図中の多角形(下書き)を描く */
  function drawDraft(ctx, draft) {
    const pts = draft.points.map((p) => worldToScreen(p.x, p.y));
    if (!pts.length) return;
    ctx.save();
    ctx.strokeStyle = '#2563eb';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    if (draft.cursor) {
      const c = worldToScreen(draft.cursor.x, draft.cursor.y);
      ctx.lineTo(c.x, c.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    // 置いた頂点(最初の点は閉じる目印として大きめ)
    pts.forEach((p, i) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, i === 0 ? 6 : 4, 0, Math.PI * 2);
      ctx.fillStyle = i === 0 ? '#fff' : '#2563eb';
      ctx.strokeStyle = '#2563eb';
      ctx.lineWidth = 2;
      ctx.fill(); ctx.stroke();
    });
    ctx.restore();
  }

  function drawRegion(ctx, r, opts) {
    if (r.shape === 'polygon') { drawPolygonRegion(ctx, r, opts); return; }
    const sc = worldToScreen(r.x + r.w / 2, r.y + r.h / 2); // 中心
    const w = r.w * view.zoom, h = r.h * view.zoom;
    const w2 = (r.w2 != null ? r.w2 : r.w) * view.zoom;
    const ptsRaw = shapePoints(r.shape || 'rect', w, h, w2);
    const pts = ptsRaw.map(([x, y]) => ({ x, y }));
    const boundaryOnly = r.boundaryOnly === true;
    const muted = boundaryOnly ? false : opts.muted;
    ctx.save();
    ctx.translate(sc.x, sc.y);
    ctx.rotate((r.rotation || 0) * Math.PI / 180);
    tracePoly(ctx, ptsRaw);
    if (opts.fill && !boundaryOnly) {
      ctx.globalAlpha = muted ? 0.15 : 0.55; // 強調対象外は薄く塗る
      ctx.fillStyle = r.color;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.lineWidth = opts.selected ? 3 : 2;
    const customStroke = r.boundaryColor || null;
    ctx.strokeStyle = opts.selected ? '#d32f2f'
      : (opts.neutralStroke || customStroke || (boundaryOnly ? (r.color || '#333') : (muted ? '#9aa0a6' : (opts.stroke || '#333'))));
    ctx.setLineDash(lineDashFor(r.boundaryLineStyle || 'solid'));
    strokeVisibleEdges(ctx, pts, r, opts.selected);
    if (opts.selected) {
      drawSelectedEdgeLabels(ctx, pts, hiddenEdgeSet(r));
      ctx.setLineDash([]);
    }
    if (shouldDrawRegionLabel(r)) {
      // ラベル(符号つき)。既定は実寸320mm相当(全体設定・個別指定で調整可)
      ctx.fillStyle = muted ? '#8a8f94' : '#222';
      ctx.font = `${fontPx(320, r)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const label = (opts.code ? opts.code + ' ' : '') + r.label;
      ctx.fillText(label, 0, 0);
    }
    ctx.restore();
  }

  /* 寸法線(底辺=下、高さ=左、台形は上底=上)。区画の回転に追従する。 */
  function drawDimension(ctx, r) {
    if (r.shape === 'polygon') {
      drawPolygonDims(ctx, r, {
        showPointLabels: false,
      });
      return;
    }
    const sc = worldToScreen(r.x + r.w / 2, r.y + r.h / 2);
    const w = r.w * view.zoom, h = r.h * view.zoom;
    const shape = r.shape || 'rect';
    const off = wpx(300); // 寸法線の離れ(実寸300mm相当)
    ctx.save();
    ctx.translate(sc.x, sc.y);
    ctx.rotate((r.rotation || 0) * Math.PI / 180);
    ctx.strokeStyle = '#1565c0';
    ctx.fillStyle = '#1565c0';
    ctx.lineWidth = 1;
    ctx.font = `${fontPx(240)}px sans-serif`;
    ctx.textAlign = 'center';
    // 底辺/幅(下辺の外側)
    const by = h / 2 + off;
    ctx.textBaseline = 'top';
    ctx.beginPath(); ctx.moveTo(-w / 2, by); ctx.lineTo(w / 2, by); ctx.stroke();
    tick(ctx, -w / 2, by); tick(ctx, w / 2, by);
    ctx.fillText(global.Geometry.fmtM(r.w) + 'm', 0, by + wpx(50));
    // 高さ/奥行(左辺の外側)
    const wx = -w / 2 - off;
    ctx.textBaseline = 'bottom';
    ctx.beginPath(); ctx.moveTo(wx, -h / 2); ctx.lineTo(wx, h / 2); ctx.stroke();
    tick(ctx, wx, -h / 2); tick(ctx, wx, h / 2);
    ctx.save();
    ctx.translate(wx - wpx(50), 0);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(global.Geometry.fmtM(r.h) + 'm', 0, 0);
    ctx.restore();
    // 台形のみ:上底(上辺の外側)
    if (shape === 'trapezoid') {
      const w2 = (r.w2 != null ? r.w2 : r.w) * view.zoom;
      const ty = -h / 2 - off;
      ctx.textBaseline = 'bottom';
      ctx.beginPath(); ctx.moveTo(-w2 / 2, ty); ctx.lineTo(w2 / 2, ty); ctx.stroke();
      tick(ctx, -w2 / 2, ty); tick(ctx, w2 / 2, ty);
      ctx.fillText(global.Geometry.fmtM(r.w2 != null ? r.w2 : r.w) + 'm', 0, ty - wpx(50));
    }
    ctx.restore();
  }
  function tick(ctx, x, y) {
    const t = wpx(70); // 目盛の長さ(実寸70mm相当)
    ctx.beginPath(); ctx.moveTo(x, y - t); ctx.lineTo(x, y + t); ctx.stroke();
  }

  /* 自由な形(多角形)の備品を上から見た図として描く。区画の多角形と同じ要領。 */
  function drawPolygonFurniture(ctx, f, opts) {
    const pts = polygonScreenPts(f);
    if (pts.length < 3) return;
    const over = typeof f.height === 'number' && f.height > global.Model.SIGHTLINE_LIMIT;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.fillStyle = over ? 'rgba(255,205,210,0.7)' : 'rgba(255,255,255,0.85)';
    ctx.fill();
    ctx.lineWidth = opts.selected ? 3 : 1.5;
    ctx.strokeStyle = opts.selected ? '#d32f2f' : (over ? '#c62828' : '#555');
    ctx.stroke();
    // ラベル + 番号(①②…)を重心に置く
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    const fpx = fontPx(200, f);
    const num = opts.num ? global.Geometry.code(opts.num) : '';
    ctx.fillStyle = '#333';
    ctx.font = `${fpx}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(f.label + num, cx, cy);
    // 選択中は頂点ハンドル(ドラッグで形を修正できる)
    if (opts.selected) {
      for (const p of pts) {
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = '#d32f2f';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.rect(p.x - 4, p.y - 4, 8, 8);
        ctx.fill(); ctx.stroke();
      }
    }
    ctx.restore();
  }

  function drawFurniture(ctx, f, opts) {
    if (f.shape === 'polygon') { drawPolygonFurniture(ctx, f, opts); return; }
    const p = worldToScreen(f.x, f.y);
    const w = f.w * view.zoom, h = f.h * view.zoom;
    ctx.save();
    ctx.translate(p.x + w / 2, p.y + h / 2);
    ctx.rotate((f.rotation || 0) * Math.PI / 180);
    const over = typeof f.height === 'number' && f.height > global.Model.SIGHTLINE_LIMIT;
    ctx.fillStyle = over ? 'rgba(255,205,210,0.7)' : 'rgba(255,255,255,0.85)';
    ctx.lineWidth = opts.selected ? 3 : 1.5;
    ctx.strokeStyle = opts.selected ? '#d32f2f' : (over ? '#c62828' : '#555');
    const isL = f.kind === 'counterL';
    if (isL) {
      // L字: 上辺が横の腕。mirrorL で縦の腕を左右反転する。
      const t = Math.min(f.t || 600, f.w, f.h) * view.zoom;
      tracePoly(ctx, counterLPoints(w, h, t, f.mirrorL === true));
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.strokeRect(-w / 2, -h / 2, w, h);
    }
    // ラベルは既定200mm相当(調整可)。文字より小さい備品(つい立て等)には描かない
    // 番号(①②…)はサイズ違いの区別用(同じ種類・同じ寸法なら同じ番号)
    const fpx = fontPx(200, f);
    // L字はくり抜き部分を避けて上の腕の中央にラベルを置く
    const labelY = isL ? -h / 2 + Math.min(f.t || 600, f.w, f.h) * view.zoom / 2 : 0;
    const fitH = isL ? Math.min(f.t || 600, f.w, f.h) * view.zoom : h;
    if (Math.min(w, fitH) > fpx * 1.7) {
      const num = opts.num ? global.Geometry.code(opts.num) : '';
      ctx.fillStyle = '#333';
      ctx.font = `${fpx}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(f.label + num, 0, labelY);
    }
    ctx.restore();
  }

  /* 扉・戸の製図記号を「基準向き」で描く(片開き=ヒンジ左・上開き)。
   * 左右/内外の反転は呼び出し側の ctx.scale で行う。w,h は画面px。 */
  function drawDoorSymbol(ctx, kind, w, h) {
    const pt = Math.max(1.5, h * 0.55);  // 引戸パネルの厚み
    const off = h * 0.5;                  // 引戸の軌道のずらし量(壁線から)
    // 片開きの葉(ヒンジ hx・閉位置の向き toRight)を描く。開いた向きは上(-y)
    const swingLeaf = (hx, len, toRight) => {
      ctx.beginPath(); ctx.moveTo(hx, 0); ctx.lineTo(hx, -len); ctx.stroke(); // 開いた葉
      ctx.beginPath();
      if (toRight) ctx.arc(hx, 0, len, -Math.PI / 2, 0);          // 上→右(上開き・ヒンジ左)
      else ctx.arc(hx, 0, len, Math.PI, 1.5 * Math.PI);          // 左→上(上開き・ヒンジ右)
      ctx.stroke();
    };
    // 引戸パネル(矩形)+スライド方向の矢印。trackY は軌道のy、x0..x1がパネル
    const slidePanel = (x0, x1, trackY, dir) => {
      ctx.beginPath();
      ctx.rect(Math.min(x0, x1), trackY - pt / 2, Math.abs(x1 - x0), pt);
      ctx.fill(); ctx.stroke();
      if (dir && Math.abs(x1 - x0) > 14) { // スライド方向の小さな矢印
        const my = trackY, mx = (x0 + x1) / 2, a = 6;
        const tx = mx + dir * Math.min(Math.abs(x1 - x0) / 2 - 3, 16);
        ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo(tx, my);
        ctx.moveTo(tx, my); ctx.lineTo(tx - dir * a, my - a * 0.7);
        ctx.moveTo(tx, my); ctx.lineTo(tx - dir * a, my + a * 0.7);
        ctx.stroke();
      }
    };
    if (kind === 'door') {
      swingLeaf(-w / 2, w, true); // 片開き: ヒンジ左、全幅
    } else if (kind === 'doorDouble') {
      swingLeaf(-w / 2, w / 2, true);  // 左の葉
      swingLeaf(w / 2, w / 2, false);  // 右の葉
    } else if (kind === 'slideSingle') {
      slidePanel(-w / 2, w / 2, -off, -1); // 1枚・全幅、左へ引く
    } else if (kind === 'slideSplit') {
      slidePanel(-w / 2, 0, -off, -1);     // 左半分→左へ
      slidePanel(0, w / 2, -off, 1);       // 右半分→右へ
    } else if (kind === 'slidePass') {
      const L = w * 0.55;                  // 重なるよう半分より長め
      slidePanel(-w / 2, -w / 2 + L, -off, -1); // 奥の建具(上の軌道)
      slidePanel(w / 2 - L, w / 2, off, 1);     // 手前の建具(下の軌道)
    }
  }

  function drawCurtainSymbol(ctx, w, h, g, line) {
    const amp = Math.max(2, Math.min(h * 0.34, wpx(70)));
    const wave = Math.max(10, wpx(220));
    ctx.strokeStyle = line;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-w / 2, 0);
    for (let x = -w / 2; x < w / 2; x += wave) {
      const x1 = Math.min(x + wave / 2, w / 2);
      const x2 = Math.min(x + wave, w / 2);
      ctx.quadraticCurveTo(x + wave / 4, -amp, x1, 0);
      ctx.quadraticCurveTo(x + wave * 0.75, amp, x2, 0);
    }
    ctx.stroke();
    ctx.setLineDash([wpx(80), wpx(55)]);
    ctx.beginPath();
    ctx.moveTo(-w / 2, -h / 2);
    ctx.lineTo(w / 2, -h / 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(-w / 2, -h / 2); ctx.lineTo(-w / 2, h / 2);
    ctx.moveTo(w / 2, -h / 2);  ctx.lineTo(w / 2, h / 2);
    ctx.stroke();
    ctx.fillStyle = line;
    ctx.font = `${fontPx(180, g)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(g.label || 'カーテン', 0, h / 2 + wpx(45));
  }

  /* 建具・設備(出入口・扉・戸・窓・壁・柱)を製図記号で描く */
  function drawFitting(ctx, g, opts) {
    const sc = worldToScreen(g.x + g.w / 2, g.y + g.h / 2);
    const w = g.w * view.zoom, h = g.h * view.zoom;
    const sel = opts.selected;
    ctx.save();
    ctx.translate(sc.x, sc.y);
    ctx.rotate((g.rotation || 0) * Math.PI / 180);
    ctx.lineWidth = sel ? 3 : 1.5;
    const line = sel ? '#d32f2f' : '#37474f';

    if (g.kind === 'wall') {
      ctx.fillStyle = sel ? 'rgba(211,47,47,.85)' : '#546e7a';
      ctx.fillRect(-w / 2, -h / 2, w, h);
    } else if (g.kind === 'pillar') {
      ctx.fillStyle = sel ? 'rgba(211,47,47,.85)' : '#455a64';
      ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.strokeStyle = '#263238';
      ctx.strokeRect(-w / 2, -h / 2, w, h);
    } else if (g.kind === 'window') {
      // 枠 + 二重線(ガラス)
      ctx.strokeStyle = sel ? '#d32f2f' : '#1565c0';
      ctx.strokeRect(-w / 2, -h / 2, w, h);
      ctx.beginPath();
      ctx.moveTo(-w / 2, -h * 0.16); ctx.lineTo(w / 2, -h * 0.16);
      ctx.moveTo(-w / 2, h * 0.16);  ctx.lineTo(w / 2, h * 0.16);
      ctx.stroke();
    } else if (g.kind === 'curtain') {
      // 仕切り用カーテン。波線で、壁や扉と区別しやすく表示する。
      drawCurtainSymbol(ctx, w, h, g, sel ? '#d32f2f' : '#6d4c41');
    } else if (global.Model.DOOR_KINDS.indexOf(g.kind) >= 0) {
      // 扉・戸の製図記号。開き勝手は flip(左右) / swing(内外) で反転する
      ctx.strokeStyle = line;
      ctx.fillStyle = sel ? 'rgba(211,47,47,.12)' : 'rgba(255,255,255,0.9)';
      // 開口の両端(ジャム)
      ctx.beginPath();
      ctx.moveTo(-w / 2, -h / 2); ctx.lineTo(-w / 2, h / 2);
      ctx.moveTo(w / 2, -h / 2);  ctx.lineTo(w / 2, h / 2);
      ctx.stroke();
      ctx.save();
      ctx.scale(g.flip ? -1 : 1, g.swing ? -1 : 1); // 開き勝手
      drawDoorSymbol(ctx, g.kind, w, h);
      ctx.restore();
    } else if (g.kind === 'entrance') {
      // 開口(両端のジャム)+ 出入りの両矢印 + ラベル
      ctx.strokeStyle = line;
      ctx.beginPath();
      ctx.moveTo(-w / 2, -h / 2); ctx.lineTo(-w / 2, h / 2);
      ctx.moveTo(w / 2, -h / 2);  ctx.lineTo(w / 2, h / 2);
      ctx.stroke();
      arrow(ctx, -w / 2 + 2, 0, w / 2 - 2, 0); // 両矢印
      ctx.fillStyle = line;
      ctx.font = `${fontPx(200, g)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText('出入口', 0, h / 2 + wpx(50));
    } else if (g.kind === 'toilet') {
      // 洋式便器: 奥にタンク(角丸)+上面中央のフラッシュボタン、手前に便座(座面の輪を二重楕円で表現)
      ctx.strokeStyle = line;
      ctx.fillStyle = sel ? 'rgba(211,47,47,.12)' : 'rgba(255,255,255,0.9)';
      const tankH = h * 0.24;
      roundRectPath(ctx, -w / 2, -h / 2, w, tankH, Math.min(w, tankH) * 0.25);
      ctx.fill(); ctx.stroke();
      const nubW = w * 0.18, nubH = tankH * 0.45;
      ctx.fillRect(-nubW / 2, -h / 2 - nubH * 0.45, nubW, nubH);
      ctx.strokeRect(-nubW / 2, -h / 2 - nubH * 0.45, nubW, nubH);
      const bowlCy = -h / 2 + tankH + (h - tankH) / 2;
      const bowlRx = w / 2 * 0.86, bowlRy = (h - tankH) / 2 * 0.92;
      ctx.beginPath();
      ctx.ellipse(0, bowlCy, bowlRx, bowlRy, 0, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(0, bowlCy + bowlRy * 0.06, bowlRx * 0.66, bowlRy * 0.7, 0, 0, Math.PI * 2);
      ctx.stroke();
      labelBelow(ctx, g, h, line, '便器');
    } else if (g.kind === 'washbasin') {
      // 手洗い器: 角丸の四角いボウル + 中央に排水口 + 奥に水栓の丸2つ
      ctx.strokeStyle = line;
      ctx.fillStyle = sel ? 'rgba(211,47,47,.12)' : 'rgba(255,255,255,0.9)';
      roundRectPath(ctx, -w / 2, -h / 2, w, h, Math.min(w, h) * 0.22);
      ctx.fill(); ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(0, h * 0.14, w * 0.1, h * 0.08, 0, 0, Math.PI * 2);
      ctx.stroke();
      const fr = Math.max(wpx(20), Math.min(w, h) * 0.07);
      ctx.beginPath();
      ctx.arc(-w * 0.16, -h / 2 * 0.6, fr, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(w * 0.16, -h / 2 * 0.6, fr, 0, Math.PI * 2);
      ctx.stroke();
      labelBelow(ctx, g, h, line, '手洗い器');
    } else if (g.kind === 'microwave') {
      // 電子レンジ: 本体(角丸) + 扉窓(メッシュ線) + 操作パネル(ボタン2つ)
      ctx.strokeStyle = line;
      ctx.fillStyle = sel ? 'rgba(211,47,47,.12)' : 'rgba(255,255,255,0.9)';
      roundRectPath(ctx, -w / 2, -h / 2, w, h, Math.min(w, h) * 0.08);
      ctx.fill(); ctx.stroke();
      const panelW = w * 0.24;
      const pad = Math.min(w, h) * 0.12;
      const doorX0 = -w / 2 + pad, doorX1 = w / 2 - panelW - pad * 0.6;
      const doorY0 = -h / 2 + pad, doorY1 = h / 2 - pad;
      ctx.strokeRect(doorX0, doorY0, doorX1 - doorX0, doorY1 - doorY0);
      for (let i = 1; i <= 3; i++) {
        const my = doorY0 + (doorY1 - doorY0) * (i / 4);
        ctx.beginPath();
        ctx.moveTo(doorX0 + wpx(20), my);
        ctx.lineTo(doorX1 - wpx(20), my);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.moveTo(w / 2 - panelW, -h / 2);
      ctx.lineTo(w / 2 - panelW, h / 2);
      ctx.stroke();
      const bw = panelW * 0.55, bh = h * 0.13;
      ctx.strokeRect(w / 2 - panelW / 2 - bw / 2, -h * 0.24, bw, bh);
      ctx.strokeRect(w / 2 - panelW / 2 - bw / 2, h * 0.1, bw, bh);
      labelBelow(ctx, g, h, line, '電子レンジ');
    } else if (g.kind === 'gasstove') {
      // ガスコンロ: 本体(角丸) + 五徳つきバーナー2つ
      ctx.strokeStyle = line;
      ctx.fillStyle = sel ? 'rgba(211,47,47,.12)' : 'rgba(255,255,255,0.9)';
      roundRectPath(ctx, -w / 2, -h / 2, w, h, Math.min(w, h) * 0.06);
      ctx.fill(); ctx.stroke();
      const r = Math.min(w, h) * 0.24;
      const burner = (cx, cy) => {
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx, cy, r * 0.4, 0, Math.PI * 2);
        ctx.stroke();
        for (const a of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
          ctx.beginPath();
          ctx.moveTo(cx + Math.cos(a) * r * 0.55, cy + Math.sin(a) * r * 0.55);
          ctx.lineTo(cx + Math.cos(a) * r * 0.95, cy + Math.sin(a) * r * 0.95);
          ctx.stroke();
        }
      };
      burner(-w * 0.24, 0);
      burner(w * 0.24, 0);
      labelBelow(ctx, g, h, line, 'ガスコンロ');
    } else if (g.kind === 'choritai') {
      // 調理台: 天板のふち取り(二重線)で厚みを表現
      ctx.strokeStyle = line;
      ctx.fillStyle = sel ? 'rgba(211,47,47,.12)' : 'rgba(255,255,255,0.9)';
      ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.strokeRect(-w / 2, -h / 2, w, h);
      const inset = Math.min(w, h) * 0.1;
      ctx.strokeRect(-w / 2 + inset, -h / 2 + inset, w - inset * 2, h - inset * 2);
      labelBelow(ctx, g, h, line, '調理台');
    } else if (g.kind === 'rangehood') {
      // 換気扇・レンジフード: 天井付けなので破線の枠 + ベントの斜めスリット
      ctx.strokeStyle = line;
      ctx.setLineDash([wpx(90), wpx(60)]);
      roundRectPath(ctx, -w / 2, -h / 2, w, h, Math.min(w, h) * 0.1);
      ctx.stroke();
      ctx.setLineDash([]);
      const n = 4;
      for (let i = 1; i <= n; i++) {
        const t = i / (n + 1);
        const x0 = -w / 2 + w * t, y0 = h / 2 * 0.6;
        ctx.beginPath();
        ctx.moveTo(x0 - w * 0.08, y0);
        ctx.lineTo(x0 + w * 0.08, -y0);
        ctx.stroke();
      }
      labelBelow(ctx, g, h, line, '換気扇');
    } else if (g.kind === 'extinguisher') {
      // 消火器: 円筒形の本体(上から見て丸) + 上部にレバー・ホースの小さい突起
      ctx.strokeStyle = line;
      ctx.fillStyle = sel ? 'rgba(211,47,47,.12)' : 'rgba(255,255,255,0.9)';
      const r = Math.min(w, h) / 2 * 0.82;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.55, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(r * 0.5, -r * 0.5);
      ctx.lineTo(r * 1.3, -r * 1.3);
      ctx.stroke();
      labelBelow(ctx, g, h, line, '消火器');
    } else if (g.kind === 'exit') {
      // 非常口: 案内サインの枠 + 扉 + 逃げる方向の矢印
      ctx.strokeStyle = line;
      ctx.fillStyle = sel ? 'rgba(211,47,47,.12)' : 'rgba(255,255,255,0.9)';
      roundRectPath(ctx, -w / 2, -h / 2, w, h, Math.min(w, h) * 0.14);
      ctx.fill(); ctx.stroke();
      const doorW = w * 0.16;
      ctx.strokeRect(-w / 2 + w * 0.12, -h * 0.32, doorW, h * 0.64);
      arrow(ctx, -w / 2 + w * 0.12 + doorW + w * 0.06, 0, w / 2 - w * 0.12, 0);
      labelBelow(ctx, g, h, line, '非常口');
    } else if (g.kind === 'greasetrap') {
      // グリストラップ・排水口: ふた(角丸四角)に格子状のスリット
      ctx.strokeStyle = line;
      ctx.fillStyle = sel ? 'rgba(211,47,47,.12)' : 'rgba(255,255,255,0.9)';
      roundRectPath(ctx, -w / 2, -h / 2, w, h, Math.min(w, h) * 0.12);
      ctx.fill(); ctx.stroke();
      const pad = Math.min(w, h) * 0.18;
      const n = 4;
      for (let i = 1; i <= n; i++) {
        const x = -w / 2 + pad + (w - pad * 2) * (i / (n + 1));
        ctx.beginPath();
        ctx.moveTo(x, -h / 2 + pad);
        ctx.lineTo(x, h / 2 - pad);
        ctx.stroke();
      }
      labelBelow(ctx, g, h, line, 'グリストラップ');
    }
    ctx.restore();
  }

  /* 角丸四角のパス(中心原点の座標系。x,yは左上、w,hは正の値) */
  function roundRectPath(ctx, x, y, w, h, r) {
    const rr = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  /* 設備アイコンの下にラベルを1行表示する(共通処理) */
  function labelBelow(ctx, g, h, color, fallback) {
    ctx.fillStyle = color;
    ctx.font = `${fontPx(180, g)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(g.label || fallback, 0, h / 2 + wpx(45));
  }

  /* 簡易の両矢印(始点・終点に三角) */
  function arrow(ctx, x1, y1, x2, y2) {
    const a = Math.atan2(y2 - y1, x2 - x1);
    const head = 5;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    const tip = (x, y, dir) => {
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - head * Math.cos(a - 0.4) * dir, y - head * Math.sin(a - 0.4) * dir);
      ctx.moveTo(x, y);
      ctx.lineTo(x - head * Math.cos(a + 0.4) * dir, y - head * Math.sin(a + 0.4) * dir);
      ctx.stroke();
    };
    tip(x2, y2, 1); tip(x1, y1, -1);
  }

  function drawFixture(ctx, x, opts) {
    const p = worldToScreen(x.x, x.y);
    const r = wpx(220); // アイコン半径(実寸220mm相当・図面に対して固定)
    const sym = (global.Model.FIXTURE_CATALOG[x.kind] || {}).symbol || '?';
    ctx.save();
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = opts.selected ? '#ffe082' : '#fff8e1';
    ctx.fill();
    ctx.lineWidth = opts.selected ? 3 : 1.5;
    ctx.strokeStyle = opts.selected ? '#d32f2f' : '#f9a825';
    ctx.stroke();
    ctx.fillStyle = '#5d4037';
    ctx.font = `bold ${wpx(170)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(sym, p.x, p.y);
    // 名称は図面下部の凡例にまとめるため、アイコンには記号だけを表示する
    ctx.restore();
  }

  /* 照明・音響設備図の右下: 設備一覧表(記号・設備・数量・W数)と
   * 自由記入のコメント(meta.lightingNote)を、求積表と同じ白枠の表で描く。 */
  function drawFixtureLegend(ctx, canvas, project) {
    const list = global.Geometry.fixtureSummary(project);
    const note = (project.meta.lightingNote || '').trim();
    if (!list.length && !note) return;
    const table = list.length ? {
      title: '照明・音響設備一覧表',
      cols: ['記号', '設備', '数量', 'W数'],
      align: ['center', 'left', 'right', 'right'],
      rows: list.map((g) => [g.symbol, g.label, String(g.count), g.watt ? g.watt : '—']),
    } : null;
    drawCornerTables(ctx, canvas, project, table ? [table] : [], note ? note.split('\n') : [], 'lighting');
  }

  /* 図面そのものに重ねる求積表のデータを組み立てる(求積図のみ)。
   * 営業所(方式に応じて内法/壁芯)・客室・調理場の求積表をまとめて載せる。
   * 行は { code, label, expr(計算式), area } を持つ。 */
  function kyusekiSheetTables(project, layer) {
    const G = global.Geometry;
    const tables = [];
    if (layer !== 'kyuseki') return tables;
    const regionTable = (title, t) => ({
      title,
      cols: ['符号', '区画', '計算式', '面積(㎡)'],
      align: ['center', 'left', 'left', 'right'],
      rows: t.rows.map((r) => [
        r.code, r.label, r.expr,
        r.area < 0 ? '△' + Math.abs(r.area).toFixed(4) : r.area.toFixed(4),
      ]),
      foot: ['合計', '', '', t.total.toFixed(2) + ' ㎡'],
    });
    const method = project.meta.premisesMethod || 'regions';
    if (method !== 'centerline') {
      tables.push(regionTable(
        method === 'both' ? '営業所求積表(内法・区画合計)' : '営業所求積表',
        G.buildTable(project, null)));
    }
    // 壁芯(座標法)の方式では座標求積表を載せる
    if (method !== 'regions' && project.premise) {
      const c = G.premiseCalc(project.premise);
      tables.push({
        title: '営業所求積表(壁芯・座標法)',
        cols: ['点', 'X(m)', 'Y(m)', 'Y次−Y前', 'X×(Y次−Y前)'],
        align: ['center', 'right', 'right', 'right', 'right'],
        rows: c.rows.map((r) => [
          'P' + r.no, r.x.toFixed(2), r.y.toFixed(2), r.dy.toFixed(2), r.prod.toFixed(4),
        ]),
        foot: ['倍面積', '', '', c.doubleArea.toFixed(4), c.total.toFixed(2) + ' ㎡'],
      });
    }
    tables.push(regionTable('客室求積表', G.buildTable(project, ['kyakushitsu'])));
    tables.push(regionTable('調理場求積表', G.buildTable(project, ['chubo'])));
    return tables;
  }

  /* 1つの求積表を罫線つきで描く。x,y は左上(px)、s は全体縮小係数。 */
  function drawOneKyusekiTable(ctx, l, x, y, s, base) {
    const t = l.t;
    const fp = base.fp * s, tp = base.tp * s, rowH = base.rowH * s,
          titleH = base.titleH * s, cpx = base.cpx * s;
    const colW = l.colW.map((c) => c * s);
    const bodyW = colW.reduce((a, b) => a + b, 0);
    const nrow = 1 + t.rows.length + (t.foot ? 1 : 0);
    const top = y + titleH;
    const tableH = rowH * nrow;

    // タイトル
    ctx.fillStyle = '#111';
    ctx.font = `bold ${tp}px sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(t.title, x, y + titleH / 2);

    // ヘッダ・合計行の薄い背景
    ctx.fillStyle = '#eef2f7';
    ctx.fillRect(x, top, bodyW, rowH);
    if (t.foot) {
      ctx.fillStyle = '#f3f4f6';
      ctx.fillRect(x, top + rowH * (nrow - 1), bodyW, rowH);
    }

    // 罫線(外枠・横・縦)
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 1;
    ctx.strokeRect(x, top, bodyW, tableH);
    for (let i = 1; i < nrow; i++) {
      const yy = top + rowH * i;
      ctx.beginPath(); ctx.moveTo(x, yy); ctx.lineTo(x + bodyW, yy); ctx.stroke();
    }
    let cx = x;
    for (let i = 0; i < colW.length - 1; i++) {
      cx += colW[i];
      ctx.beginPath(); ctx.moveTo(cx, top); ctx.lineTo(cx, top + tableH); ctx.stroke();
    }

    // セルの文字
    const drawRow = (cells, ry, bold) => {
      ctx.font = `${bold ? 'bold ' : ''}${fp}px sans-serif`;
      ctx.fillStyle = '#111';
      let colX = x;
      cells.forEach((c, i) => {
        const a = (t.align && t.align[i]) || 'left';
        let tx = colX + cpx;
        ctx.textAlign = 'left';
        if (a === 'right') { ctx.textAlign = 'right'; tx = colX + colW[i] - cpx; }
        else if (a === 'center') { ctx.textAlign = 'center'; tx = colX + colW[i] / 2; }
        ctx.fillText(String(c), tx, ry + rowH / 2);
        colX += colW[i];
      });
    };
    let ry = top;
    drawRow(t.cols, ry, true); ry += rowH;
    for (const r of t.rows) { drawRow(r, ry, false); ry += rowH; }
    if (t.foot) drawRow(t.foot, ry, true);
  }

  function sheetTableId(layer) {
    return SHEET_TABLE_PREFIX + layer;
  }

  function sheetTableLabel(layer) {
    return {
      kyuseki: '求積図の表',
      lighting: '照明・音響設備一覧表',
    }[layer] || '図面上の表';
  }

  function clampTableScale(v) {
    return Math.max(0.45, Math.min(2.4, parseFloat(v) || 1));
  }

  function sheetTableAt(project, sx, sy) {
    for (const box of Array.from(sheetTableBoxes.values()).reverse()) {
      if (sx >= box.x && sx <= box.x + box.w && sy >= box.y && sy <= box.y + box.h) {
        const layout = ((project.meta && project.meta.sheetTableLayouts) || {})[box.layer] || {};
        return {
          id: box.id,
          kind: 'sheetTable',
          layer: box.layer,
          label: sheetTableLabel(box.layer),
          x: box.worldX,
          y: box.worldY,
          scale: layout.scale || DEFAULT_SHEET_TABLE_SCALE,
          _box: box,
          _resize: sx >= box.handle.x && sx <= box.handle.x + box.handle.size &&
                   sy >= box.handle.y && sy <= box.handle.y + box.handle.size,
        };
      }
    }
    return null;
  }

  function setSheetTableLayout(project, layer, patch) {
    project.meta.sheetTableLayouts = project.meta.sheetTableLayouts || {};
    const cur = project.meta.sheetTableLayouts[layer] || {};
    const next = Object.assign({}, cur, patch);
    if (next.scale != null) next.scale = clampTableScale(next.scale);
    project.meta.sheetTableLayouts[layer] = next;
    return next;
  }

  /* 表(と任意のコメント行)を、図面の右下に白枠で重ねて描く共通処理。
   * 用紙枠(無ければ画面)に収まるよう、はみ出す場合は全体を自動縮小する。
   * 求積表(計算過程)と照明・音響設備一覧表で共用する。 */
  function drawCornerTables(ctx, canvas, project, tables, noteLines, layoutKey) {
    tables = tables || [];
    noteLines = noteLines || [];
    if (!tables.length && !noteLines.length) return;
    layoutKey = layoutKey || currentLayer;

    // 基準サイズ(実寸mm→px)。収まらなければ係数 s を掛けて縮める。
    const base = {
      fp: wpx(230), tp: wpx(270), rowH: wpx(360), titleH: wpx(470), cpx: wpx(140),
    };
    const padIn = wpx(150), gap = wpx(260), noteGap = wpx(160);

    ctx.save();
    // 各表の列幅・高さを測る
    const layout = tables.map((t) => {
      const colW = new Array(t.cols.length).fill(0);
      const measure = (cells, bold) => {
        ctx.font = `${bold ? 'bold ' : ''}${base.fp}px sans-serif`;
        cells.forEach((c, i) => {
          colW[i] = Math.max(colW[i], ctx.measureText(String(c)).width + base.cpx * 2);
        });
      };
      measure(t.cols, true);
      t.rows.forEach((r) => measure(r, false));
      if (t.foot) measure(t.foot, true);
      const bodyW = colW.reduce((a, b) => a + b, 0);
      const nrow = 1 + t.rows.length + (t.foot ? 1 : 0);
      return { t, colW, bodyW, h: base.titleH + base.rowH * nrow };
    });

    // コメント行の幅も測る
    ctx.font = `${base.fp}px sans-serif`;
    let noteW = 0;
    for (const ln of noteLines) noteW = Math.max(noteW, ctx.measureText(ln).width);
    const noteH = noteLines.length ? noteGap + base.rowH * noteLines.length : 0;

    const tablesW = layout.length ? Math.max.apply(null, layout.map((l) => l.bodyW)) : 0;
    const tablesH = layout.reduce((a, l) => a + l.h, 0) + gap * Math.max(0, layout.length - 1);
    const W = Math.max(tablesW, noteW) + padIn * 2;
    const H = tablesH + noteH + padIn * 2;

    // 収める範囲(用紙枠があれば枠、なければ画面全体)
    let avX, avY, avW, avH;
    if (project.meta.showPaperFrame) {
      const f = paperFrameWorld(project);
      const tl = worldToScreen(f.x, f.y), br = worldToScreen(f.x + f.w, f.y + f.h);
      avX = tl.x; avY = tl.y; avW = br.x - tl.x; avH = br.y - tl.y;
    } else {
      avX = 0; avY = 0; avW = canvas.width; avH = canvas.height;
    }
    const margin = wpx(250);
    const fitScale = Math.min(1, (avW - margin * 2) / W, (avH - margin * 2) / H);
    const saved = ((project.meta && project.meta.sheetTableLayouts) || {})[layoutKey] || {};
    const userScale = clampTableScale(saved.scale == null ? DEFAULT_SHEET_TABLE_SCALE : saved.scale);
    const s = fitScale * userScale;

    const w = W * s, h = H * s;
    const defaultX0 = avX + avW - margin - w;
    const defaultY0 = avY + avH - margin - h;
    const savedHasPos = Number.isFinite(saved.x) && Number.isFinite(saved.y);
    const savedPt = savedHasPos ? worldToScreen(saved.x, saved.y) : null;
    const x0 = savedPt ? savedPt.x : defaultX0;
    const y0 = savedPt ? savedPt.y : defaultY0;
    const worldPt = screenToWorld(x0, y0);
    const id = sheetTableId(layoutKey);
    const handleSize = Math.max(10, Math.min(18, wpx(260)));
    sheetTableBoxes.set(id, {
      id, layer: layoutKey, x: x0, y: y0, w, h,
      worldX: worldPt.x, worldY: worldPt.y,
      fitScale, userScale,
      handle: { x: x0 + w - handleSize, y: y0 + h - handleSize, size: handleSize },
    });

    // 背景の白枠
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1.5;
    ctx.fillRect(x0, y0, w, h);
    ctx.strokeRect(x0, y0, w, h);

    const x = x0 + padIn * s;
    let y = y0 + padIn * s;
    for (const l of layout) {
      drawOneKyusekiTable(ctx, l, x, y, s, base);
      y += l.h * s + gap * s;
    }
    // コメント行(設備図の自由記入)。表の下に左そろえで並べる
    if (noteLines.length) {
      let ty = y0 + padIn * s + tablesH * s + noteGap * s;
      ctx.font = `${base.fp * s}px sans-serif`;
      ctx.fillStyle = '#444';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      for (const ln of noteLines) { ctx.fillText(ln, x, ty); ty += base.rowH * s; }
    }
    if (currentSelectedId === id) {
      ctx.strokeStyle = '#2563eb';
      ctx.lineWidth = 2;
      ctx.setLineDash([7, 4]);
      ctx.strokeRect(x0 - 3, y0 - 3, w + 6, h + 6);
      ctx.setLineDash([]);
      ctx.fillStyle = '#2563eb';
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.fillRect(x0 + w - handleSize, y0 + h - handleSize, handleSize, handleSize);
      ctx.strokeRect(x0 + w - handleSize, y0 + h - handleSize, handleSize, handleSize);
    }
    ctx.restore();
  }

  /* 求積表(計算過程)を図面そのものに白枠で重ねて描く(求積図のみ)。 */
  function drawKyusekiTable(ctx, canvas, project) {
    drawCornerTables(ctx, canvas, project, kyusekiSheetTables(project, currentLayer), null, currentLayer);
  }

  /* 用紙枠(用紙サイズ×縮尺がカバーする実寸範囲)をワールド座標で返す。
   * 例: A4横・1/50 → 297mm×50 = 14850mm ×、210mm×50 = 10500mm。原点は(0,0)。 */
  function paperFrameWorld(project) {
    const m = project.meta;
    const p = global.Model.PAPER_SIZES[m.paper] || global.Model.PAPER_SIZES.A4;
    const landscape = m.orientation !== 'portrait';
    return {
      x: 0, y: 0,
      w: (landscape ? p.w : p.h) * m.scale,
      h: (landscape ? p.h : p.w) * m.scale,
    };
  }

  /* 用紙枠ガイドを描く。枠の右下に縮尺を自動表示する。 */
  function drawPaperFrame(ctx, project) {
    const f = paperFrameWorld(project);
    const tl = worldToScreen(f.x, f.y);
    const br = worldToScreen(f.x + f.w, f.y + f.h);
    const m = project.meta;
    ctx.save();
    // 枠(青の破線)
    ctx.strokeStyle = '#1d4ed8';
    ctx.lineWidth = 2;
    ctx.setLineDash([10, 6]);
    ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
    ctx.setLineDash([]);
    // 左上: 用紙の説明(実寸240mm相当の固定サイズ)
    ctx.fillStyle = '#1d4ed8';
    ctx.font = `${wpx(240)}px sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    const orient = m.orientation === 'portrait' ? '縦' : '横';
    ctx.fillText(
      `用紙枠 ${m.paper}${orient}(この枠内 = ${(f.w / 1000).toFixed(2)} × ${(f.h / 1000).toFixed(2)} m)`,
      tl.x, tl.y - wpx(90));
    // 右下: スケールバー(黒線の長さ = 図面上の1m)と縮尺表示。各部も実寸基準。
    // 備品姿図・照明音響設備図は右下に一覧表を置くため、縮尺バーは非表示にする。
    if (currentLayer !== 'furnviews' && currentLayer !== 'lighting') {
      const barLen = wpx(1000); // 1m分の画面上の長さ
      const bx2 = br.x - wpx(280), bx1 = bx2 - barLen;
      const by = br.y - wpx(620); // 下のラベルが枠線にかからない高さ
      ctx.strokeStyle = '#111';
      ctx.fillStyle = '#111';
      ctx.lineWidth = 2;
      // 本体の線
      ctx.beginPath(); ctx.moveTo(bx1, by); ctx.lineTo(bx2, by); ctx.stroke();
      // 両端の目盛(縦線)と中央(0.5m)の小さい目盛
      const tk = wpx(130), tkS = wpx(65);
      ctx.beginPath();
      ctx.moveTo(bx1, by - tk); ctx.lineTo(bx1, by + tk);
      ctx.moveTo(bx2, by - tk); ctx.lineTo(bx2, by + tk);
      ctx.moveTo((bx1 + bx2) / 2, by - tkS); ctx.lineTo((bx1 + bx2) / 2, by + tkS);
      ctx.stroke();
      // ラベル: 線の両端に 0 / 1m、上に縮尺
      ctx.font = `bold ${wpx(240)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText('0', bx1, by + wpx(180));
      ctx.fillText('1m', bx2, by + wpx(180));
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.fillText(`縮尺 1/${m.scale}`, bx2, by - wpx(180));
    }
    ctx.restore();
  }

  /* 方位記号の中心位置(画面px)。用紙枠の表示中は枠内右上に置き、
   * 非表示なら従来どおり画面の右上に固定する。 */
  function northMarkCenter(canvas, project) {
    if (project.meta.showPaperFrame) {
      const f = paperFrameWorld(project);
      const s = worldToScreen(f.x + f.w, f.y);
      return { x: s.x - wpx(950), y: s.y + wpx(1100) };
    }
    return { x: canvas.width - 40, y: 46 };
  }

  /* 方位記号の形状(中心・半径・Nの先端位置)。当たり判定にも使う。
   * 大きさは実寸基準(半径400mm相当)で、図面に対して固定サイズ。 */
  function getNorthMark(canvas, project) {
    const c = northMarkCenter(canvas, project);
    const r = wpx(400);
    const a = (project.meta.northAngle || 0) * Math.PI / 180;
    // 角度0で真上。先端は円の外側(r+220mm相当)あたり。
    const tipR = r + wpx(220);
    const tip = { x: c.x + Math.sin(a) * tipR, y: c.y - Math.cos(a) * tipR };
    return { cx: c.x, cy: c.y, r, tip, angle: a };
  }

  /* 方位記号(北マーク)。Nの先端をドラッグすると360度回転できる。 */
  function drawNorthMark(ctx, canvas, project) {
    const n = getNorthMark(canvas, project);
    const { cx, cy, r } = n;
    ctx.save();
    ctx.strokeStyle = '#333'; ctx.fillStyle = '#333'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    // 矢印(角度に追従して回転。各部は半径に比例)
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(n.angle);
    ctx.beginPath();
    ctx.moveTo(0, -r * 1.33);
    ctx.lineTo(-r * 0.33, r * 0.22);
    ctx.lineTo(0, -r * 0.11);
    ctx.lineTo(r * 0.33, r * 0.22);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    // N の文字は先端の少し外側(文字自体は回転させず読みやすく)
    const lr = r + wpx(380);
    const lx = cx + Math.sin(n.angle) * lr;
    const ly = cy - Math.cos(n.angle) * lr;
    ctx.font = `bold ${wpx(280)}px sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('N', lx, ly);
    ctx.restore();
  }

  /* ---- 営業所外周(壁)の描画 ---- */

  /* 平面系のレイヤーに壁を二重線で描く。壁厚ぶんの帯を塗り、内外の輪郭線を引く。
   * 選択中は赤くし、入力した頂点(ドラッグで編集できる点)にハンドルを出す。 */
  function drawPremiseWalls(ctx, project, opts) {
    const pr = project.premise;
    if (!pr || (pr.points || []).length < 3) return;
    const wp = global.Geometry.premiseWallPolysAbs(pr);
    const inner = wp.inner.map((p) => worldToScreen(p.x, p.y));
    const outer = wp.outer.map((p) => worldToScreen(p.x, p.y));
    ctx.save();
    // 壁の厚み分だけ離した黒い実線2本(二重線)。塗りつぶしはしない。
    ctx.globalAlpha = opts.muted ? 0.35 : 1;
    ctx.lineWidth = opts.selected ? 2.5 : 1.5;
    ctx.strokeStyle = opts.selected ? '#d32f2f' : '#000';
    for (const poly of [outer, inner]) {
      ctx.beginPath();
      ctx.moveTo(poly[0].x, poly[0].y);
      for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
      ctx.closePath();
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // 選択中: 入力頂点のハンドル(ドラッグで形を修正できる)
    if (opts.selected) {
      for (const p of pr.points) {
        const s = worldToScreen(pr.x + p.x, pr.y + p.y);
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = '#d32f2f';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.rect(s.x - 4, s.y - 4, 8, 8);
        ctx.fill(); ctx.stroke();
      }
    }
    ctx.restore();
  }

  /* 内壁(部屋を仕切る壁)を、厚み分だけ離した黒い実線2本(二重線)で描く。
   * 塗りつぶしはしない。見た目だけの壁で、営業所外周の壁芯とは違い
   * 求積(面積計算)には使わない。 */
  function drawWall(ctx, w, opts) {
    if (!w || (w.points || []).length < 2) return;
    const outline = global.Geometry.wallOutlineAbs(w);
    const left = outline.left.map((p) => worldToScreen(p.x, p.y));
    const right = outline.right.map((p) => worldToScreen(p.x, p.y));
    ctx.save();
    ctx.globalAlpha = opts.muted ? 0.35 : 1;
    ctx.lineWidth = opts.selected ? 2.5 : 1.5;
    ctx.strokeStyle = opts.selected ? '#d32f2f' : '#000';
    // 左右のオフセット線を1本の閉じたパスにする(左→端→右を逆順→端を閉じる)ことで、
    // 両端が切れずに四角くつながった帯の輪郭になる。
    ctx.beginPath();
    ctx.moveTo(left[0].x, left[0].y);
    for (let i = 1; i < left.length; i++) ctx.lineTo(left[i].x, left[i].y);
    for (let i = right.length - 1; i >= 0; i--) ctx.lineTo(right[i].x, right[i].y);
    ctx.closePath();
    ctx.stroke();
    ctx.globalAlpha = 1;
    if (opts.selected) {
      const abs = global.Geometry.polygonAbsPoints(w);
      for (const p of abs) {
        const s = worldToScreen(p.x, p.y);
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = '#d32f2f';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.rect(s.x - 4, s.y - 4, 8, 8);
        ctx.fill(); ctx.stroke();
      }
    }
    ctx.restore();
  }

  /* 求積図: 壁芯線(実線)と辺長・頂点番号を描く。
   * 頂点番号(P1, P2 …)は壁芯の座標求積表と対応する。 */
  function drawPremiseCenterline(ctx, project) {
    const pr = project.premise;
    if (!pr || (pr.points || []).length < 3) return;
    const rl = global.Geometry.premiseRegionLike(pr);
    const pts = rl.points.map((p) => worldToScreen(rl.x + p.x, rl.y + p.y));
    const color = pr.lineColor || '#111'; // 壁芯線の色(営業所外周のプロパティで変更可)
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }

  /* ---- 備品姿図(正面図・側面図) ---- */

  /* 同寸法グループごとのセル配置を計算する(ワールドmm)。
   * 全セルを同じ大きさの「カード」にそろえ、用紙の幅に収まる列数で
   * きれいに格子状(グリッド)に並べる。間隔は詰めて、用紙からはみ出しにくくする。 */
  function furnViewLayout(project) {
    const groups = global.Geometry.furnitureGroups(project);
    // 余白・間隔(ワールドmm) — 旧版より大幅に詰めた
    const PAD = 350;       // カード内側の余白
    const LABEL_H = 650;   // 品名ラベルの高さ
    const CAP_H = 1500;    // 図の下: 正面/側面ラベル + 寸法(幅・奥行・高さ)の領域
    const INNER_GAP = 600; // 正面図と側面図のすき間
    const CAP_MIN_W = 3000; // 寸法行(幅 ◯m × 奥行 ◯m)が収まる最小カード幅
    const COL_GAP = 900, ROW_GAP = 900; // カード同士のすき間
    const MARGIN = 900;    // 用紙枠の内側に取る余白
    const TITLE_H = 1500;  // 上部タイトルのための余白

    if (!groups.length) {
      return { cells: [], pad: PAD, innerGap: INNER_GAP, capH: CAP_H,
               labelH: LABEL_H, bounds: { x: 0, y: 0, w: 8000, h: 4000 } };
    }

    // 用紙の使える幅(枠表示中は枠の内側、非表示なら既定値)
    const frame = project.meta.showPaperFrame ? paperFrameWorld(project) : null;
    const originX = (frame ? frame.x : 0) + MARGIN;
    const originY = (frame ? frame.y : 0) + TITLE_H;
    // 1行に詰め込める右端。1品が単独で超える場合はその品の幅を許容
    const cardW = (g) => PAD * 2 + Math.max(g.w + INNER_GAP + g.h, CAP_MIN_W);
    const figH = (g) => Math.max(g.height || 0, 400);          // 図の高さ
    const cardH1 = (g) => PAD * 2 + LABEL_H + figH(g) + CAP_H;  // カード単体の高さ
    const maxCardW = groups.reduce((m, g) => Math.max(m, cardW(g)), 0);
    const availW = frame ? Math.max(maxCardW, frame.w - MARGIN * 2) : 14000;

    const cells = [];
    let maxRight = originX, maxBottom = originY;
    const manualPos = project.meta.furnViewPos || {};

    // 1) ドラッグで動かしたカードは手動位置に置き、自動整列からは外す
    const autoGroups = [];
    for (const g of groups) {
      const p = manualPos[g.key];
      if (p) {
        const h = cardH1(g);
        cells.push({ g, x: p.x, y: p.y, cellW: cardW(g), cellH: h,
                     contentW: g.w + INNER_GAP + g.h,
                     floorY: p.y + PAD + LABEL_H + figH(g), manual: true });
        maxRight = Math.max(maxRight, p.x + cardW(g));
        maxBottom = Math.max(maxBottom, p.y + h);
      } else {
        autoGroups.push(g);
      }
    }

    // 2) 残りは横に流し込み、用紙幅を超えたら折り返す(フロー配置)。
    // 行内は床(ベースライン)をそろえ、カード高さも行内で統一する。
    let x = originX, rowTop = originY, rowMaxFigH = 0, row = [];
    const flushRow = () => {
      if (!row.length) return;
      const cardH = PAD * 2 + LABEL_H + rowMaxFigH + CAP_H;
      const floorY = rowTop + PAD + LABEL_H + rowMaxFigH;
      for (const c of row) { c.y = rowTop; c.cellH = cardH; c.floorY = floorY; }
      maxRight = Math.max(maxRight, x - COL_GAP);
      rowTop += cardH + ROW_GAP;
      x = originX; rowMaxFigH = 0; row = [];
    };
    for (const g of autoGroups) {
      const cw = cardW(g);
      if (row.length && x + cw > originX + availW) flushRow();
      const cell = { g, x, cellW: cw, contentW: g.w + INNER_GAP + g.h };
      row.push(cell); cells.push(cell);
      x += cw + COL_GAP;
      rowMaxFigH = Math.max(rowMaxFigH, g.height || 0, 400);
    }
    flushRow();
    maxBottom = Math.max(maxBottom, rowTop - ROW_GAP);

    const bounds = {
      x: 0, y: 0,
      w: Math.max(maxRight + MARGIN, frame ? frame.x + frame.w : 0) + (frame ? MARGIN : 0),
      h: Math.max(maxBottom + MARGIN, frame ? frame.y + frame.h : 0) + (frame ? MARGIN : 0),
    };
    return { cells, pad: PAD, innerGap: INNER_GAP, capH: CAP_H,
             labelH: LABEL_H, bounds };
  }

  /* 備品姿図のカードの当たり判定。世界座標(wx,wy)上にあるカードのグループキーと
   * 枠の位置を返す。ドラッグ移動に使う。後から描いたカードを優先する。 */
  function furnCardAt(project, wx, wy) {
    if (currentLayer !== 'furnviews') return null;
    const layout = furnViewLayout(project);
    for (let i = layout.cells.length - 1; i >= 0; i--) {
      const c = layout.cells[i];
      if (wx >= c.x && wx <= c.x + c.cellW && wy >= c.y && wy <= c.y + c.cellH) {
        return { key: c.g.key, x: c.x, y: c.y, cellW: c.cellW, cellH: c.cellH };
      }
    }
    return null;
  }

  /* 姿図のシルエットを描く。prof は1多角形({x,y}の配列)でも、
   * 複数部品(多角形の配列)でもよい。x0=左端, floorY=床のpx。 */
  function drawProfileShape(ctx, prof, x0, floorY) {
    const drawPoly = (poly) => {
      ctx.beginPath();
      poly.forEach((pt, i) => {
        const s = worldToScreen(x0 + pt.x, floorY - pt.y);
        if (i) ctx.lineTo(s.x, s.y); else ctx.moveTo(s.x, s.y);
      });
      ctx.closePath();
      ctx.fill(); ctx.stroke();
    };
    if (Array.isArray(prof[0])) prof.forEach(drawPoly); // 複数部品
    else drawPoly(prof);                                // 1多角形
  }

  /* prof が描ける形を持っているか(1多角形=2点以上 / 複数部品=1つ以上) */
  function hasProfile(prof) {
    if (!prof || !prof.length) return false;
    return Array.isArray(prof[0]) ? prof[0].length >= 2 : prof.length >= 2;
  }

  /* 備品姿図を描く。グループごとに正面図と側面図を並べ、寸法と番号を付ける。
   * 床から1mの位置に基準線を引き、見通し規制(高さ1m)と見比べられるようにする。 */
  function drawFurnViews(ctx, canvas, project) {
    const layout = furnViewLayout(project);
    const G = global.Geometry;
    ctx.save();
    // タイトル
    const t0 = worldToScreen(900, 450);
    ctx.fillStyle = '#222';
    ctx.font = `bold ${fontPx(360)}px sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('備品姿図(正面図・側面図) — 赤の破線は床から1m(見通し規制)', t0.x, t0.y);
    if (!layout.cells.length) {
      ctx.font = `${fontPx(300)}px sans-serif`;
      ctx.fillStyle = '#777';
      ctx.fillText('備品がありません。平面図で備品を追加してください。', t0.x, t0.y + wpx(700));
      ctx.restore();
      return;
    }
    const pad = layout.pad, innerGap = layout.innerGap;
    for (const c of layout.cells) {
      const g = c.g;
      const over = g.over;
      const line = over ? '#c62828' : '#37474f';
      const fill = over ? 'rgba(255,205,210,0.55)' : 'rgba(236,239,241,0.85)';
      // --- カード枠(うっすら背景) ---
      const ctl = worldToScreen(c.x, c.y);
      const cbr = worldToScreen(c.x + c.cellW, c.y + c.cellH);
      ctx.fillStyle = over ? 'rgba(255,235,238,0.6)' : 'rgba(255,255,255,0.55)';
      ctx.strokeStyle = over ? '#ef9a9a' : '#cfd8dc';
      ctx.lineWidth = 1;
      roundRect(ctx, ctl.x, ctl.y, cbr.x - ctl.x, cbr.y - ctl.y, wpx(180));
      ctx.fill(); ctx.stroke();

      const left = c.x + pad;
      // --- 品名ラベル(品名 + サイズ番号 + 台数) ---
      const name = `${g.label}${G.code(g.number)}(${g.count}台)` + (over ? ' ⚠高さ1m超' : '');
      const lp = worldToScreen(left, c.y + pad);
      ctx.fillStyle = over ? '#c62828' : '#222';
      ctx.font = `bold ${fontPx(250)}px sans-serif`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(name, lp.x, lp.y);

      // --- 床線(ベースライン) と 1m 基準線(カード内のみ) ---
      const spanR = left + c.contentW;
      const f1 = worldToScreen(left, c.floorY), f2 = worldToScreen(spanR, c.floorY);
      ctx.strokeStyle = '#455a64';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(f1.x, f1.y); ctx.lineTo(f2.x, f2.y); ctx.stroke();
      const m1 = worldToScreen(left, c.floorY - 1000), m2 = worldToScreen(spanR, c.floorY - 1000);
      ctx.strokeStyle = '#c62828';
      ctx.lineWidth = 1.2;
      ctx.setLineDash([8, 5]);
      ctx.beginPath(); ctx.moveTo(m1.x, m1.y); ctx.lineTo(m2.x, m2.y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#c62828';
      ctx.font = `${fontPx(200)}px sans-serif`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.fillText('1m', m2.x - wpx(60), m2.y - wpx(40));

      // --- 正面図(幅 × 高さ) と 側面図(奥行 × 高さ) ---
      // なぞって描いた形(prof)があればそのシルエットを、なければ外形の四角を描く
      const views = [
        { x0: left, w: g.w, name: '正面', prof: g.front },
        { x0: left + g.w + innerGap, w: g.h, name: '側面', prof: g.side },
      ];
      for (const v of views) {
        ctx.fillStyle = fill;
        ctx.strokeStyle = line;
        ctx.lineWidth = 1.5;
        if (hasProfile(v.prof)) {
          // シルエット(床からの高さ y を floorY から上に取る)。部品ごとに描く
          drawProfileShape(ctx, v.prof, v.x0, c.floorY);
        } else {
          const tl = worldToScreen(v.x0, c.floorY - g.height);
          const br = worldToScreen(v.x0 + v.w, c.floorY);
          ctx.fillRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
          ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
        }
        // 図の真下には「正面 / 側面」だけ(短いので隣と重ならない)
        const capX = worldToScreen(v.x0 + v.w / 2, c.floorY);
        ctx.fillStyle = '#1565c0';
        ctx.font = `${fontPx(190)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(v.name, capX.x, capX.y + wpx(150));
      }
      // --- 寸法(幅・奥行・高さ)はカード左下にまとめて左そろえで書く ---
      // 図の真下に重ねると正面・側面のキャプションどうしが重なるため、行で分ける。
      const dim1 = worldToScreen(left, c.floorY + 620);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.font = `${fontPx(185)}px sans-serif`;
      ctx.fillStyle = '#37474f';
      ctx.fillText(`幅 ${G.fmtM(g.w)}m  ×  奥行 ${G.fmtM(g.h)}m`, dim1.x, dim1.y);
      const dim2 = worldToScreen(left, c.floorY + 620 + 470);
      ctx.fillStyle = over ? '#c62828' : '#37474f';
      ctx.fillText(`高さ ${G.fmtM(g.height)}m${over ? '(⚠1m超)' : ''}`, dim2.x, dim2.y);
    }
    ctx.restore();
  }

  /* 角丸の長方形パスを作る(塗り/線は呼び出し側で) */
  function roundRect(ctx, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* ---- メモ・引き出し線 ---- */

  /* 文字の箱の大きさ(ワールドmm)。当たり判定用に描画のたびに覚えておく。 */
  const noteBoxes = {};
  function noteBox(id) { return noteBoxes[id] || { w: 1000, h: 500 }; }

  /* メモを描く: メモは白い箱+引き出し線、コメントは囲いなしの文字だけ。
   * 選択中のメモは赤くし、矢印の先端にドラッグ用ハンドルを出す。 */
  function drawNote(ctx, n, opts) {
    const fpx = fontPx(240, n);
    const lines = String(n.text || '').split('\n');
    ctx.save();
    ctx.font = `${fpx}px sans-serif`;
    let wMax = fpx; // 空文字でもつかめる最小幅
    for (const l of lines) wMax = Math.max(wMax, ctx.measureText(l).width);
    const lineH = fpx * 1.35, pad = fpx * 0.4;
    const p = worldToScreen(n.x, n.y);
    const bw = wMax + pad * 2, bh = lineH * lines.length + pad * 2;
    noteBoxes[n.id] = { w: bw / view.zoom, h: bh / view.zoom };
    const line = opts.selected ? '#d32f2f' : '#37474f';
    const hasLeader = n.leader !== false; // コメント(自由テキスト)は引き出し線なし
    // 引き出し線(箱の中心から。箱の塗りで内側は隠れる)と先端の矢印
    if (hasLeader) {
      const tip = worldToScreen(n.tx, n.ty);
      const cx = p.x + bw / 2, cy = p.y + bh / 2;
      ctx.strokeStyle = line;
      ctx.fillStyle = line;
      ctx.lineWidth = opts.selected ? 2 : 1.5;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(tip.x, tip.y); ctx.stroke();
      const a = Math.atan2(tip.y - cy, tip.x - cx);
      const head = Math.max(6, fpx * 0.45);
      ctx.beginPath();
      ctx.moveTo(tip.x, tip.y);
      ctx.lineTo(tip.x - head * Math.cos(a - 0.45), tip.y - head * Math.sin(a - 0.45));
      ctx.lineTo(tip.x - head * Math.cos(a + 0.45), tip.y - head * Math.sin(a + 0.45));
      ctx.closePath();
      ctx.fill();
    }
    // 文字の箱。コメント(自由テキスト)は通常時は囲いを出さず、
    // 選択中だけドラッグ対象が分かるよう薄い点線を出す。
    if (hasLeader) {
      ctx.strokeStyle = line;
      ctx.lineWidth = opts.selected ? 2 : 1.5;
      ctx.fillStyle = 'rgba(255,255,255,0.94)';
      ctx.fillRect(p.x, p.y, bw, bh);
      ctx.strokeRect(p.x, p.y, bw, bh);
    } else if (opts.selected) {
      ctx.strokeStyle = 'rgba(37,99,235,0.65)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.strokeRect(p.x, p.y, bw, bh);
      ctx.setLineDash([]);
    }
    // 本文
    ctx.fillStyle = '#222';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    lines.forEach((l, i) => ctx.fillText(l, p.x + pad, p.y + pad + lineH * i + fpx * 0.12));
    // 選択中: 引き出し線つきメモだけ先端ハンドル(ドラッグで指す場所を変えられる)
    if (opts.selected && hasLeader) {
      const tip = worldToScreen(n.tx, n.ty);
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#d32f2f';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.rect(tip.x - 4, tip.y - 4, 8, 8);
      ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  }

  /* 今の図面に属するメモをまとめて描く */
  function drawNotes(ctx, project, state) {
    for (const n of (project.notes || [])) {
      if (!noteVisibleOnLayer(n, currentLayer)) continue;
      drawNote(ctx, n, { selected: state.selectedId === n.id });
    }
  }

  function noteVisibleOnLayer(note, layer) {
    if (Array.isArray(note.layers) && note.layers.length) {
      return note.layers.indexOf(layer) >= 0;
    }
    return (note.layer || 'plan') === layer;
  }

  /* ---- 手動の寸法線(任意の2点間) ---- */

  /* 寸法線を1本描く: 両端に矢羽根(目盛)、中央の少し外側に長さ(m)。
   * 選択中は赤くし、両端にドラッグ用ハンドルを出す。 */
  function drawManualDim(ctx, d, opts) {
    const a = worldToScreen(d.x1, d.y1);
    const b = worldToScreen(d.x2, d.y2);
    const lenM = global.Geometry.mmToM(Math.hypot(d.x2 - d.x1, d.y2 - d.y1));
    const line = opts.selected ? '#d32f2f' : '#1565c0';
    ctx.save();
    ctx.strokeStyle = line;
    ctx.fillStyle = line;
    ctx.lineWidth = opts.selected ? 2.5 : 1.5;
    // 本体の線
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    // 両端の目盛(線に直交する短い線)
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const t = Math.max(6, wpx(120));
    const nx = Math.cos(ang + Math.PI / 2), ny = Math.sin(ang + Math.PI / 2);
    for (const p of [a, b]) {
      ctx.beginPath();
      ctx.moveTo(p.x - nx * t, p.y - ny * t);
      ctx.lineTo(p.x + nx * t, p.y + ny * t);
      ctx.stroke();
    }
    // 長さ(m)を中点の少し外側(線の上側)に
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const off = Math.max(8, wpx(220));
    ctx.font = `${fontPx(240, d)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    // 文字が線で隠れないよう白フチを敷く
    const label = lenM.toFixed(2) + 'm';
    ctx.save();
    ctx.translate(mx - nx * off, my - ny * off);
    let rot = ang;
    if (rot > Math.PI / 2 || rot < -Math.PI / 2) rot += Math.PI; // 文字が逆さまにならないように
    ctx.rotate(rot);
    ctx.lineWidth = 3; ctx.strokeStyle = '#fff';
    ctx.strokeText(label, 0, 0);
    ctx.fillStyle = line;
    ctx.fillText(label, 0, 0);
    ctx.restore();
    // 選択中: 両端ハンドル
    if (opts.selected) {
      for (const p of [a, b]) {
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = '#d32f2f';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.rect(p.x - 4, p.y - 4, 8, 8);
        ctx.fill(); ctx.stroke();
      }
    }
    ctx.restore();
  }

  function drawManualDims(ctx, project, state) {
    for (const d of (project.dimensions || [])) {
      if (!dimVisibleOnLayer(d, currentLayer)) continue;
      drawManualDim(ctx, d, { selected: state.selectedId === d.id });
    }
  }

  function dimVisibleOnLayer(dim, layer) {
    if (Array.isArray(dim.layers) && dim.layers.length) {
      return dim.layers.indexOf(layer) >= 0;
    }
    const l = dim.layer || 'drawings';
    const drawingLayers = ['plan', 'kyuseki'];
    if (l === 'drawings') return drawingLayers.indexOf(layer) >= 0;
    if (drawingLayers.indexOf(l) >= 0) return drawingLayers.indexOf(layer) >= 0; // 旧データ互換
    return l === layer;
  }

  /* 寸法線の作図プレビュー(1点目を置いた後、カーソルまでの仮の線) */
  function drawMeasureDraft(ctx, measure) {
    if (!measure || !measure.p1) return;
    const a = worldToScreen(measure.p1.x, measure.p1.y);
    ctx.save();
    ctx.fillStyle = '#d32f2f';
    ctx.beginPath(); ctx.arc(a.x, a.y, 4, 0, Math.PI * 2); ctx.fill();
    if (measure.cursor) {
      const b = worldToScreen(measure.cursor.x, measure.cursor.y);
      ctx.strokeStyle = '#d32f2f';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.setLineDash([]);
      const lenM = global.Geometry.mmToM(Math.hypot(measure.cursor.x - measure.p1.x, measure.cursor.y - measure.p1.y));
      ctx.fillStyle = '#d32f2f';
      ctx.font = `${fontPx(240)}px sans-serif`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText(lenM.toFixed(2) + 'm', b.x + wpx(150), b.y);
    }
    ctx.restore();
  }

  /* どのレイヤーで何を表示するか */
  function visibility(layer) {
    switch (layer) {
      case 'plan':
        return { regionsFill: false, allRegions: true, regionTypes: null,
                 furniture: true, fittings: true, fixtures: false, dims: false, table: false };
      case 'kyuseki':
        // 求積図: 全区画を表示し、営業所(壁芯線)・客室・調理場の求積をまとめて示す
        return { regionsFill: false, allRegions: true, regionTypes: null,
                 furniture: false, counterFurniture: true, fittings: false, fixtures: false, dims: true, table: 'kyuseki' };
      case 'lighting':
        return { regionsFill: false, allRegions: true, regionTypes: null,
                 furniture: false, fittings: false, fixtures: true, dims: false, table: 'fixtures' };
      case 'plumbing':
        // 給排水図: 間取りを下地にして、便器・手洗い器等の設備アイコンだけを示す
        return { regionsFill: false, allRegions: true, regionTypes: null,
                 furniture: false, fittings: true, fixtures: false, dims: false, table: false };
      case 'furnviews':
        // 備品姿図: 間取りは描かず、備品の正面図・側面図だけを並べる
        return { regionsFill: false, allRegions: false, regionTypes: [],
                 furniture: false, fittings: false, fixtures: false, dims: false, table: 'furniture' };
      default:
        return { regionsFill: false, allRegions: true, regionTypes: null,
                 furniture: true, fittings: true, fixtures: true, dims: true, table: false };
    }
  }

  /* 区画の線種(実線・点線・破線)を Canvas の破線パターンに変換する。
   * 線の色は区画ごとの boundaryColor で指定する(全体設定は廃止)。 */
  function lineDashFor(style) {
    if (style === 'dotted') return [wpx(80), wpx(120)];
    if (style === 'dashed') return [wpx(360), wpx(180)];
    return [];
  }

  function isCounterFurniture(f) {
    return f && (f.kind === 'counter' || f.kind === 'counterL' || /カウンター/.test(f.label || ''));
  }

  function render(ctx, canvas, project, state, opts) {
    const vis = visibility(currentLayer);
    fontScale = (project.meta.fontScale || 100) / 100; // 全体の文字サイズ設定を反映
    currentSelectedId = opts && opts.print ? null : (state && state.selectedId);
    sheetTableBoxes = new Map();
    clear(ctx, canvas);
    drawGrid(ctx, canvas);
    if (project.meta.showPaperFrame && !(opts && opts.hidePaperFrame)) {
      drawPaperFrame(ctx, project);
    }

    // 備品姿図は間取りを描かず、姿図シートとメモだけを描いて終わる
    if (currentLayer === 'furnviews') {
      drawFurnViews(ctx, canvas, project);
      drawManualDims(ctx, project, state);
      drawNotes(ctx, project, state);
      // 正面・側面の形をなぞる作図中プレビュー
      if (state.draft && state.draft.points) drawDraft(ctx, state.draft);
      return;
    }

    // 下絵(トレース用)。画面での作図補助なので、印刷・PDF出力には含めない
    if (!(opts && opts.print)) {
      drawUnderlay(ctx, project);
    }

    // 営業所外周(壁)。平面図・求積図でははっきり、その他では薄く描く
    if (project.premise) {
      drawPremiseWalls(ctx, project, {
        muted: currentLayer !== 'plan' && currentLayer !== 'kyuseki',
        selected: state.selectedId === 'premise',
      });
    }

    const regions = project.regions.filter((r) => {
      // 面積計算のための囲い線は、照明・音響設備図・給排水図には出さない。
      // 設備図では部屋の下地だけ見せ、求積用の赤/緑/青線で混乱しないようにする。
      if ((currentLayer === 'lighting' || currentLayer === 'plumbing') && isAreaBoundaryLine(r)) return false;
      return vis.allRegions || (vis.regionTypes && vis.regionTypes.indexOf(r.type) >= 0);
    });

    // highlightTypes がある図面では、対象の区画だけ強調し、他は薄く描いて間取りを示す
    const isMain = (r) => !vis.highlightTypes || vis.highlightTypes.indexOf(global.Geometry.areaUseForRegion(r)) >= 0;

    const regionCodeMap = new Map();
    let regionCodeNo = 0;
    for (const r of project.regions) {
      if (!isPillarRegion(r) && global.Geometry.areaUseForRegion(r) !== 'display') {
        regionCodeMap.set(r.id, global.Geometry.code(++regionCodeNo));
      }
    }
    const visibleRegionIds = new Set(regions.map((r) => r.id));
    const furnitureNums = global.Geometry.furnitureNumberMap(project);
    const drawVisibleRegion = (el) => {
      const code = regionCodeMap.get(el.id) || ''; // 柱は求積符号を振らない
      drawRegion(ctx, el, {
        fill: vis.regionsFill,
        muted: !isMain(el),
        selected: state.selectedId === el.id,
        stroke: null,
        neutralStroke: (currentLayer === 'lighting' || currentLayer === 'plumbing') ? '#333' : null,
        code,
      });
      const showRegionDims = el.showDims !== false;
      if (vis.dims && showRegionDims && (vis.dimsAllRegions || isMain(el))) {
        // 区画の自動辺長は求積図だけに出す。任意の寸法線は別機能として各図面に表示できる。
        drawDimension(ctx, el);
      }
    };

    if (currentLayer === 'lighting' || currentLayer === 'plumbing') {
      // 照明・音響設備図・給排水図では、区画を設備記号の下地として必ず先に描く。
      // 重なり順の影響で多角形区画が設備図から抜けて見えるのを防ぐ。
      for (const r of regions) drawVisibleRegion(r);
    }

    for (const item of global.Model.sortedOrderableItems(project)) {
      const el = item.element;
      if (item.kind === 'regions') {
        if (currentLayer === 'lighting' || currentLayer === 'plumbing') continue;
        if (!visibleRegionIds.has(el.id)) continue;
        drawVisibleRegion(el);
      } else if (item.kind === 'walls') {
        drawWall(ctx, el, {
          selected: state.selectedId === el.id,
          muted: currentLayer !== 'plan' && currentLayer !== 'kyuseki' && currentLayer !== 'plumbing',
        });
      } else if (item.kind === 'fittings') {
        if (fittingVisibleOnLayer(el, currentLayer)) drawFitting(ctx, el, { selected: state.selectedId === el.id });
      } else if (item.kind === 'furniture') {
        if (vis.furniture || (vis.counterFurniture && isCounterFurniture(el))) {
          drawFurniture(ctx, el, { selected: state.selectedId === el.id, num: furnitureNums[el.id] });
        }
      } else if (item.kind === 'fixtures') {
        if (vis.fixtures) drawFixture(ctx, el, { selected: state.selectedId === el.id });
      } else if (item.kind === 'dimensions') {
        if (dimVisibleOnLayer(el, currentLayer)) drawManualDim(ctx, el, { selected: state.selectedId === el.id });
      } else if (item.kind === 'notes') {
        if (noteVisibleOnLayer(el, currentLayer)) drawNote(ctx, el, { selected: state.selectedId === el.id });
      }
    }
    if (vis.fixtures) drawFixtureLegend(ctx, canvas, project);
    // 求積図では壁芯線(営業所求積の根拠になる線)を最前面側に描く
    if (currentLayer === 'kyuseki' && project.premise) {
      drawPremiseCenterline(ctx, project);
    }
    // 求積表(計算過程)を図面そのものに重ねる(求積図のみ・設定で切替)
    if (currentLayer === 'kyuseki' && project.meta.showKyusekiTable !== false) {
      drawKyusekiTable(ctx, canvas, project);
    }
    // 手動の寸法線・メモは上の重なり順に含めて描く
    // 寸法線の作図中プレビュー
    if (state.measure) drawMeasureDraft(ctx, state.measure);
    // 多角形の作図中なら下書きを最前面に描く
    if (state.draft && state.draft.points) {
      drawDraft(ctx, state.draft);
    }
    if (project.meta.showNorthMark) {
      drawNorthMark(ctx, canvas, project);
    }
  }

  global.Render = {
    view, LAYERS, setLayer, getLayer, visibility,
    worldToScreen, screenToWorld, fitToView, render,
    paperFrameWorld, getNorthMark, setRedrawCallback, noteBox, noteVisibleOnLayer, furnViewLayout, furnCardAt,
    sheetTableAt, setSheetTableLayout,
    fittingLayers, fittingVisibleOnLayer,
  };
})(window);
