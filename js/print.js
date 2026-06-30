/* =========================================================================
 * print.js — 提出用の印刷 / PDF 出力(ブラウザの「PDFに保存」を利用)。
 * 用紙枠内だけをオフスクリーン描画し、window.print() を呼ぶ。
 * 1枚ずつの出力(printCurrent)と、届出に必要な全図面の一括出力(printAll)。
 * ========================================================================= */
(function (global) {
  'use strict';

  function tableHtml(title, table) {
    // 柱の控除行(area が負)は「△0.0900 ㎡」のように差し引きとして表示する
    let rows = table.rows.map((r) => {
      const area = r.area < 0 ? `△${Math.abs(r.area).toFixed(4)}` : r.area.toFixed(4);
      return `<tr><td>${r.code}</td><td>${escapeHtml(r.label)}</td><td>${r.expr}</td><td class="num">${area} ㎡</td></tr>`;
    }).join('');
    return `
      <table class="kyuseki">
        <caption>${escapeHtml(title)}</caption>
        <thead><tr><th>符号</th><th>区画</th><th>計算式</th><th>面積(㎡)</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><td colspan="3">合計(総面積)</td><td class="num">${table.total.toFixed(2)} ㎡</td></tr></tfoot>
      </table>`;
  }

  /* 照明・音響設備一覧表(照明・音響設備図に添付) */
  function fixtureTableHtml(project) {
    const list = global.Geometry.fixtureSummary(project);
    let rows = list.map((g) =>
      `<tr><td>${escapeHtml(g.symbol)}</td><td>${escapeHtml(g.label)}</td><td class="num">${g.count}</td><td>${escapeHtml(g.watt || '—')}</td></tr>`
    ).join('');
    if (!rows) rows = '<tr><td colspan="4">設備なし</td></tr>';
    return `
      <table class="kyuseki">
        <caption>照明・音響設備一覧表</caption>
        <thead><tr><th>記号</th><th>設備</th><th>数量</th><th>W数</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  /* 多角形の座標求積表(頂点番号は図面の P1, P2 … と対応) */
  function coordTablesHtml(project, filterTypes) {
    const polys = project.regions.filter((r) => r.shape === 'polygon' &&
      !global.Geometry.isPillarRegion(r) &&
      r.boundaryOnly !== true &&
      global.Geometry.areaUseForRegion(r) !== 'display' &&
      (!filterTypes || filterTypes.indexOf(global.Geometry.areaUseForRegion(r)) >= 0));
    return polys.map((r) => {
      const c = global.Geometry.polygonCalc(r);
      const rows = c.rows.map((row) =>
        `<tr><td>P${row.no}</td><td class="num">${row.x.toFixed(2)}</td><td class="num">${row.y.toFixed(2)}</td>
         <td class="num">${row.dy.toFixed(2)}</td><td class="num">${row.prod.toFixed(4)}</td></tr>`).join('');
      return `
      <table class="kyuseki">
        <caption>座標求積表(${escapeHtml(r.label)})</caption>
        <thead><tr><th>点</th><th>X(m)</th><th>Y(m)</th><th>Y次−Y前</th><th>X×(Y次−Y前)</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr><td colspan="4">倍面積</td><td class="num">${c.doubleArea.toFixed(4)}</td></tr>
          <tr><td colspan="4">面積(倍面積÷2)</td><td class="num">${c.area4.toFixed(4)} ㎡</td></tr>
        </tfoot>
      </table>`;
    }).join('');
  }

  /* 壁芯外周の求積表(座標法)。画面の求積表と同じ内容をPDFにも載せる。 */
  function premiseTableHtml(project) {
    if (!project.premise) {
      return '<table class="kyuseki"><caption>営業所求積表(壁芯)</caption>' +
             '<tbody><tr><td>営業所外周が未作成です</td></tr></tbody></table>';
    }
    const c = global.Geometry.premiseCalc(project.premise);
    const rows = c.rows.map((row) =>
      `<tr><td>P${row.no}</td><td class="num">${row.x.toFixed(2)}</td><td class="num">${row.y.toFixed(2)}</td>
       <td class="num">${row.dy.toFixed(2)}</td><td class="num">${row.prod.toFixed(4)}</td></tr>`).join('');
    return `
      <table class="kyuseki">
        <caption>営業所求積表(壁芯・座標法)</caption>
        <thead><tr><th>点</th><th>X(m)</th><th>Y(m)</th><th>Y次−Y前</th><th>X×(Y次−Y前)</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr><td colspan="4">倍面積</td><td class="num">${c.doubleArea.toFixed(4)}</td></tr>
          <tr><td colspan="4">面積(倍面積÷2)</td><td class="num">${c.area4.toFixed(4)} ㎡</td></tr>
          <tr><td colspan="4">営業所面積(壁芯)</td><td class="num">${c.total.toFixed(2)} ㎡</td></tr>
        </tfoot>
      </table>`;
  }

  /* 備品一覧表(備品姿図に添付) */
  function furnTableHtml(project) {
    const groups = global.Geometry.furnitureGroups(project);
    let rows = groups.map((g) => {
      return `<tr><td>${escapeHtml(g.label)}${global.Geometry.code(g.number)}</td><td class="num">${g.w}×${g.h}</td>
        <td class="num">${g.height}</td><td class="num">${g.count}</td>
        <td>${g.over ? '高さ1m超' : '—'}</td></tr>`;
    }).join('');
    if (!rows) rows = '<tr><td colspan="5">備品なし</td></tr>';
    return `
      <table class="kyuseki">
        <caption>備品一覧表</caption>
        <thead><tr><th>品名(番号)</th><th>幅×奥行(mm)</th><th>高さ(mm)</th><th>数量</th><th>備考</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  /* レイヤーに応じた添付表のHTML */
  function tablesForLayer(project, layer) {
    const vis = global.Render.visibility(layer);
    if (vis.table === 'all') {
      // 営業所求積: 方式(区画合計/壁芯/両方)に応じて出し分ける
      const method = project.meta.premisesMethod || 'regions';
      const parts = [];
      if (method !== 'regions') parts.push(premiseTableHtml(project));
      if (method !== 'centerline') {
        parts.push(tableHtml(
          method === 'both' ? '営業所求積表(内法・区画合計)' : '営業所求積表',
          global.Geometry.buildTable(project, null)) + coordTablesHtml(project, null));
      }
      return parts.join('');
    }
    if (vis.table === 'kyakuchubo') {
      return tableHtml('客室求積表', global.Geometry.buildTable(project, ['kyakushitsu'])) +
             tableHtml('調理場求積表', global.Geometry.buildTable(project, ['chubo'])) +
             coordTablesHtml(project, ['kyakushitsu', 'chubo']);
    }
    if (vis.table === 'fixtures') {
      return fixtureTableHtml(project);
    }
    if (vis.table === 'furniture') {
      return furnTableHtml(project);
    }
    return '';
  }

  function titleBlockHtml(project, drawingName) {
    const m = project.meta;
    return `
      <table class="titleblock">
        <tr><th>店舗名</th><td>${escapeHtml(m.storeName || '—')}</td>
            <th>図面名</th><td>${escapeHtml(drawingName)}</td></tr>
        <tr><th>所在地</th><td>${escapeHtml(m.address || '—')}</td>
            <th>縮尺</th><td>1/${m.scale}</td></tr>
        <tr><th>作成日</th><td>${escapeHtml(m.date || '—')}</td>
            <th>作成者</th><td>${escapeHtml(m.author || '—')}</td></tr>
      </table>`;
  }

  /* 日付文字列(YYYY-MM-DD)から「西暦末尾2桁+月2桁」を作る。
   * 例: 2026-07-01 → 2607。値が不正なら今日の日付から作る。 */
  function dateCode(dateStr) {
    let y, mo;
    const mt = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
    if (mt) { y = mt[1]; mo = mt[2]; }
    else {
      const d = new Date();
      y = String(d.getFullYear());
      mo = String(d.getMonth() + 1).padStart(2, '0');
    }
    return y.slice(-2) + mo;
  }

  /* PDFのファイル名(印刷ウィンドウのタイトル=保存時の初期ファイル名)を組み立てる。
   * 形式: 2607_店舗名_図面名(2607 = 西暦末尾2桁+月)。
   * 店舗名が空のときは省いて 2607_図面名 とする。 */
  function fileTitle(project, drawingName) {
    const store = (project.meta.storeName || '').trim();
    return [dateCode(project.meta.date), store, drawingName].filter(Boolean).join('_');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function pageSizeMm(project) {
    const m = project.meta;
    const p = global.Model.PAPER_SIZES[m.paper] || global.Model.PAPER_SIZES.A4;
    const landscape = m.orientation !== 'portrait';
    return { w: landscape ? p.w : p.h, h: landscape ? p.h : p.w };
  }

  /* 用紙の印刷可能サイズ(mm)。実寸縮尺のはみ出し判定に使う。 */
  function printableSize(project) {
    const m = project.meta;
    const p = global.Model.PAPER_SIZES[m.paper] || global.Model.PAPER_SIZES.A4;
    const landscape = m.orientation !== 'portrait';
    const margin = 8; // @page の余白(mm)と揃える
    return { w: (landscape ? p.w : p.h) - margin * 2, h: (landscape ? p.h : p.w) - margin * 2 };
  }

  /* 1枚分の図面シート(図 + 求積表 + 表題欄)。
   * img は renderLayerImage の戻り値 {dataURL, wMm, hMm}。
   * wMm が入っていれば実寸縮尺(その物理サイズで貼り付け)。 */
  function sheetHtml(project, layer, img) {
    const drawingName = global.Render.LAYERS[layer].label;
    let imgTag, warn = '';
    if (img.wMm) {
      // 実寸縮尺: 画像をミリ指定の物理サイズで貼る(印刷倍率100%で1/縮尺になる)
      imgTag = `<img class="scaled" src="${img.dataURL}" style="width:${img.wMm.toFixed(1)}mm;height:${img.hMm.toFixed(1)}mm">`;
      const ps = printableSize(project);
      if (img.wMm > ps.w + 1 || img.hMm > ps.h + 1) {
        warn = `<p class="scale-warn">⚠ この縮尺(1/${project.meta.scale})では図面が用紙(${project.meta.paper})に収まりません
          (必要 ${img.wMm.toFixed(0)}×${img.hMm.toFixed(0)}mm / 印刷可能 ${ps.w}×${ps.h}mm)。
          用紙をA3にするか、縮尺を1/100にしてください。</p>`;
      }
    } else {
      imgTag = `<img src="${img.dataURL}">`;
    }
    return `
<div class="sheet">
  <div class="head">
    <h1>${escapeHtml(drawingName)}</h1>
    <div class="scale">縮尺 1/${project.meta.scale}${img.wMm ? '(実寸)' : ''}</div>
  </div>
  ${warn}
  <div class="drawing">${imgTag}</div>
  <div class="bottom">
    <div style="flex:1">${tablesForLayer(project, layer)}</div>
    <div style="flex:1">${titleBlockHtml(project, drawingName)}</div>
  </div>
</div>`;
  }

  /* 用紙枠だけを1ページとして出す。表や表題欄はここでは追加しない。 */
  function frameSheetHtml(project, layer, img) {
    const drawingName = global.Render.LAYERS[layer].label;
    return `
<div class="sheet">
  <img src="${img.dataURL}" alt="${escapeHtml(drawingName)}">
  ${frameScaleBarHtml(project, layer)}
</div>`;
  }

  function frameScaleBarHtml(project, layer) {
    if (['plan', 'premises', 'kyakushitsu'].indexOf(layer) < 0) return '';
    const scale = project.meta.scale || 50;
    const mm = (worldMm) => (worldMm / scale).toFixed(2);
    return `<svg class="frame-scale-bar" style="width:${mm(1000)}mm;height:${mm(840)}mm;right:${mm(280)}mm;bottom:${mm(200)}mm"
      viewBox="0 0 1000 840" overflow="visible" aria-label="縮尺 1/${scale}">
      <line x1="0" y1="420" x2="1000" y2="420"></line>
      <line x1="0" y1="290" x2="0" y2="550"></line>
      <line x1="1000" y1="290" x2="1000" y2="550"></line>
      <line x1="500" y1="355" x2="500" y2="485"></line>
      <text x="0" y="600" text-anchor="middle" dominant-baseline="hanging">0</text>
      <text x="1000" y="600" text-anchor="middle" dominant-baseline="hanging">1m</text>
      <text x="1000" y="240" text-anchor="end">縮尺 1/${scale}</text>
    </svg>`;
  }

  /* 印刷用ウィンドウの共通ガワ */
  function openWindow(project, title, bodyHtml) {
    const win = window.open('', '_blank');
    if (!win) {
      alert('ポップアップがブロックされました。ポップアップを許可してください。');
      return null;
    }
    const landscape = project.meta.orientation === 'landscape';
    const size = project.meta.paper + (landscape ? ' landscape' : ' portrait');
    const page = pageSizeMm(project);
    const scaleNotice = '<div class="noprint scale-note">用紙枠内だけをPDF出力します。印刷する場合は倍率を「100%(実際のサイズ/拡大縮小なし)」にしてください。定規で測ると図面が1/' +
      project.meta.scale + 'になります。</div>';

    win.document.write(`<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  @page { size: ${size}; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; color: #111; }
  body { font-family: -apple-system, "Hiragino Sans", sans-serif; }
  .sheet { width: ${page.w}mm; height: ${page.h}mm; overflow: hidden; break-after: page; page-break-after: always; position: relative; }
  .sheet:last-child { break-after: auto; page-break-after: auto; }
  .sheet img { display: block; width: 100%; height: 100%; }
  .frame-scale-bar { position: absolute; z-index: 2; overflow: visible; pointer-events: none; }
  .frame-scale-bar line { stroke: #111; stroke-width: 20; stroke-linecap: square; }
  .frame-scale-bar text { fill: #111; font: 700 240px -apple-system, "Hiragino Sans", sans-serif; }
  @media print { .noprint { display: none; } }
  .noprint { text-align: center; padding: 8px; }
  .noprint button { font-size: 13px; padding: 6px 16px; cursor: pointer; }
  .scale-note { background: #fff8e1; border-left: 4px solid #f59e0b; color: #7c4a03;
    text-align: left; font-size: 12px; line-height: 1.6; padding: 8px 12px; margin: 0 8px 8px; }
</style></head><body>
<div class="noprint">
  <button onclick="window.print()">印刷 / PDFに保存</button>
  <button onclick="window.close()">閉じる</button>
</div>
${scaleNotice}
${bodyHtml}
</body></html>`);
    win.document.close();
    return win;
  }

  /* 指定レイヤーをオフスクリーンの canvas に描画して画像にする。
   * Render のビュー・レイヤーは共有状態なので、描画後に元へ戻す。
   * 戻り値 {dataURL, wMm, hMm}。実寸縮尺のときだけ wMm/hMm に物理サイズ(mm)が入る。 */
  function renderLayerImage(project, layer) {
    const R = global.Render;
    const prevLayer = R.getLayer();
    const v = R.view;
    const prev = { zoom: v.zoom, offsetX: v.offsetX, offsetY: v.offsetY };
    R.setLayer(layer);

    // 備品姿図は実寸の図面ではない(模式図)ので、実寸縮尺の対象外
    const trueScale = project.meta.printTrueScale && layer !== 'furnviews';
    let out;
    if (trueScale) {
      // 用紙枠は実寸計算に含めない(枠の分だけ余計に大きくならないように一時的に消す)
      const savedFrame = project.meta.showPaperFrame;
      project.meta.showPaperFrame = false;
      const bb0 = global.Geometry.boundingBox(project);
      const mg = 400; // 図面まわりの余白(mm)
      const bb = { x: bb0.x - mg, y: bb0.y - mg, w: bb0.w + mg * 2, h: bb0.h + mg * 2 };
      const longPx = 2400; // 画素の長辺(印刷の鮮明さ)
      const cw = bb.w >= bb.h ? longPx : Math.round(longPx * bb.w / bb.h);
      const ch = bb.w >= bb.h ? Math.round(longPx * bb.h / bb.w) : longPx;
      const cv = document.createElement('canvas');
      cv.width = cw; cv.height = ch;
      const ctx = cv.getContext('2d');
      // 矩形 bb をキャンバスにぴったり対応させる(余白なし=実寸が正確になる)
      v.zoom = cw / bb.w;
      v.offsetX = -bb.x * v.zoom;
      v.offsetY = -bb.y * v.zoom;
      R.render(ctx, cv, project, { selectedId: null }, { print: true });
      project.meta.showPaperFrame = savedFrame;
      const scale = project.meta.scale || 50;
      out = { dataURL: cv.toDataURL('image/png'), wMm: bb.w / scale, hMm: bb.h / scale };
    } else {
      const cv = document.createElement('canvas');
      cv.width = 1600; cv.height = 1100;
      const ctx = cv.getContext('2d');
      R.fitToView(project, cv);
      // print: true … 下絵(トレース用画像)は提出書類に含めない
      R.render(ctx, cv, project, { selectedId: null }, { print: true });
      out = { dataURL: cv.toDataURL('image/png'), wMm: null, hMm: null };
    }

    R.setLayer(prevLayer);
    v.zoom = prev.zoom; v.offsetX = prev.offsetX; v.offsetY = prev.offsetY;
    return out;
  }

  /* 用紙枠のワールド座標だけを切り出して、用紙と同じ縦横比の画像にする。 */
  function renderPaperFrameImage(project, layer) {
    const R = global.Render;
    const prevLayer = R.getLayer();
    const v = R.view;
    const prev = { zoom: v.zoom, offsetX: v.offsetX, offsetY: v.offsetY };
    const savedFrame = project.meta.showPaperFrame;
    try {
      R.setLayer(layer);
      project.meta.showPaperFrame = true;

      const page = pageSizeMm(project);
      const pxPerMm = 240 / 25.4;
      const maxLong = 4200;
      let cw = Math.round(page.w * pxPerMm);
      let ch = Math.round(page.h * pxPerMm);
      const long = Math.max(cw, ch);
      if (long > maxLong) {
        const ratio = maxLong / long;
        cw = Math.round(cw * ratio);
        ch = Math.round(ch * ratio);
      }

      const frame = R.paperFrameWorld(project);
      const cv = document.createElement('canvas');
      cv.width = Math.max(1, cw);
      cv.height = Math.max(1, ch);
      const ctx = cv.getContext('2d');
      v.zoom = cv.width / frame.w;
      v.offsetX = -frame.x * v.zoom;
      v.offsetY = -frame.y * v.zoom;
      R.render(ctx, cv, project, { selectedId: null }, { print: true, hidePaperFrame: true });
      return { dataURL: cv.toDataURL('image/png') };
    } finally {
      project.meta.showPaperFrame = savedFrame;
      R.setLayer(prevLayer);
      v.zoom = prev.zoom; v.offsetX = prev.offsetX; v.offsetY = prev.offsetY;
    }
  }

  /* 現在の図面(レイヤー)を印刷する。
   * 画面のキャンバスではなくオフスクリーンで描き直すことで、
   * 下絵(トレース画像)や画面のパン・ズーム状態に左右されない出力にする。 */
  function printCurrent(project, canvas) {
    const layer = global.Render.getLayer();
    const drawingName = global.Render.LAYERS[layer].label;
    const img = renderPaperFrameImage(project, layer);
    const title = fileTitle(project, drawingName);
    openWindow(project, title, frameSheetHtml(project, layer, img));
  }

  /* 届出に必要な全図面(平面図・営業所求積図・客室・調理場求積図・照明音響設備図)を
   * 1ファイルにまとめて出力する。1レイヤー = 1ページ。 */
  function printAll(project) {
    const layers = Object.keys(global.Render.LAYERS);
    const body = layers
      .map((layer) => frameSheetHtml(project, layer, renderPaperFrameImage(project, layer)))
      .join('\n');
    const title = fileTitle(project, '図面一式');
    openWindow(project, title, body);
  }

  global.Printer = { printCurrent, printAll };
})(window);
