/* =========================================================================
 * model.js — データモデル・カタログ・保存/読み込み
 * すべての寸法は「ミリメートル(mm)」を内部単位として扱う。
 * ========================================================================= */
(function (global) {
  'use strict';

  /* 区画(部屋)の種類 */
  const REGION_TYPES = {
    kyakushitsu: { label: '客室',   color: '#ffe0b2' },
    chubo:       { label: '厨房',   color: '#b2dfdb' },
    counter:     { label: 'カウンター', color: '#ffd180', defaultW: 3200, defaultH: 600, defaultAreaUse: 'kyakushitsu' },
    toilet:      { label: 'トイレ', color: '#c5cae9' },
    tsuro:       { label: '通路',   color: '#f0f4c3' },
    soko:        { label: '倉庫',   color: '#d7ccc8' },
    other:       { label: 'その他', color: '#eeeeee' },
    pillar:      { label: '柱',     color: '#b0bec5', defaultW: 300, defaultH: 300 },
  };

  /* 区画の見た目とは別に、求積上どの面積へ入れるかを選べる。 */
  const AREA_USES = {
    auto:        { label: '種類に合わせる' },
    kyakushitsu: { label: '客室に算入' },
    chubo:       { label: '調理場に算入' },
    premises:    { label: '営業所にのみ算入' },
    other:       { label: '客室・調理場以外に算入' },
    display:     { label: '表示のみ(面積に入れない)' },
  };

  /* 備品カタログ(mm)。height は見通し規制の判定に使う高さ。 */
  const FURNITURE_CATALOG = {
    table:    { label: 'テーブル',   w: 600,  h: 600, height: 700  },
    chair:    { label: '椅子',       w: 450,  h: 450, height: 800  },
    counter:  { label: 'カウンター', w: 3200, h: 600, height: 1000 },
    /* t = カウンターの厚み(腕の幅)。L字は外形 w×h から下側の片側を欠いた形。 */
    counterL: { label: 'L字カウンター', w: 2700, h: 1800, height: 1000, t: 600 },
    sofa:     { label: 'ソファ',     w: 1800, h: 700, height: 800  },
    shelf:    { label: '棚',         w: 900,  h: 400, height: 1800 },
    fridge:   { label: '冷蔵庫',     w: 600,  h: 600, height: 1800 },
    sink:     { label: 'シンク',     w: 600,  h: 600, height: 850  },
    tsuitate: { label: 'つい立て',   w: 900,  h: 40,  height: 1500 },
  };

  /* =====================================================================
   * 備品姿図のプリセット形(正面図・側面図のシルエット)
   * ---------------------------------------------------------------------
   * 各カタログ品ごとに「姿図スタイル(variant)」を用意し、椅子なら背もたれ有無、
   * テーブルなら角/丸 … のように、正面図・側面図の形を選べるようにする。
   * 形は寸法(幅w・奥行h・高さheight)から毎回その場で作るので、寸法を変えると
   * 自動で拡大縮小する。返り値は「多角形の配列」(部品ごとに1多角形)。
   * 座標は x=横位置(0〜幅/奥行), y=床からの高さ(0〜height)。 ===================== */

  /* 床から立つ四角の部品を1つ作る(x0<x1, y0=下端, y1=上端) */
  function _box(x0, x1, y0, y1) {
    return [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
  }

  /* 椅子(span=見えている幅, H=高さ, back=背もたれの有無)。正面・側面で共用。 */
  function _chair(span, H, back, rear) {
    const legW = Math.max(40, span * 0.12);
    const seatH = back ? Math.min(H * 0.55, 450) : H;
    const seatThk = Math.min(70, seatH * 0.2);
    const parts = [
      _box(0, legW, 0, seatH - seatThk),               // 手前/左の脚
      _box(span - legW, span, 0, seatH - seatThk),     // 奥/右の脚
      _box(0, span, seatH - seatThk, seatH),           // 座面
    ];
    if (back) {
      // 正面=背もたれは幅いっぱい / 側面=後方の縦バー
      parts.push(rear ? _box(span - legW, span, seatH, H) : _box(0, span, seatH, H));
    }
    return parts;
  }

  /* テーブル(角脚) */
  function _table(span, H) {
    const top = Math.min(80, H * 0.12), legW = Math.max(50, span * 0.08), in0 = span * 0.06;
    return [
      _box(0, span, H - top, H),                       // 天板
      _box(in0, in0 + legW, 0, H - top),               // 脚
      _box(span - in0 - legW, span - in0, 0, H - top), // 脚
    ];
  }

  /* テーブル(丸・1本脚) */
  function _tableRound(span, H) {
    const top = Math.min(80, H * 0.12), baseH = Math.min(90, H * 0.12);
    return [
      _box(0, span, H - top, H),                       // 天板
      _box(span / 2 - 60, span / 2 + 60, baseH, H - top), // 支柱
      _box(span * 0.28, span * 0.72, 0, baseH),        // 台座
    ];
  }

  /* キャビネット類(シンク等)。蹴込み付きの箱。 */
  function _cabinet(span, H) {
    const kick = Math.min(100, H * 0.12);
    return [
      _box(0, span, kick, H),                          // 本体
      _box(span * 0.04, span * 0.96, 0, kick),         // 台輪(蹴込み)
    ];
  }

  /* カウンター。天板は薄い板として表現し、本体・蹴込みと分ける。 */
  function _counter(span, H) {
    const top = Math.min(70, Math.max(45, H * 0.07));
    const kick = Math.min(100, H * 0.12);
    const inset = Math.max(25, Math.min(80, span * 0.08));
    return [
      _box(0, span, H - top, H),                        // 薄い天板
      _box(inset, span - inset, kick, H - top),         // カウンター本体
      _box(inset * 1.4, span - inset * 1.4, 0, kick),   // 蹴込み
    ];
  }

  /* ソファ(正面) */
  function _sofaFront(span, H) {
    const seatH = Math.min(H * 0.55, 420), arm = Math.max(120, span * 0.1);
    return [
      _box(0, span, 0, seatH),                         // 座面ベース
      _box(0, arm, seatH, H),                          // 左アーム
      _box(span - arm, span, seatH, H),                // 右アーム
      _box(arm, span - arm, seatH * 0.6 + seatH * 0.4, H), // 背もたれ
    ];
  }

  /* ソファ(側面) */
  function _sofaSide(depth, H) {
    const seatH = Math.min(H * 0.55, 420), backT = Math.max(150, depth * 0.18);
    return [
      _box(0, depth, 0, seatH),                        // 座面
      _box(depth - backT, depth, seatH, H),            // 背もたれ
      _box(0, backT, seatH * 0.5, seatH + (H - seatH) * 0.45), // アーム(手前)
    ];
  }

  /* 棚(正面=枠+棚板) */
  function _shelfFront(span, H) {
    const post = Math.max(40, span * 0.06), thk = Math.max(40, H * 0.04);
    const parts = [
      _box(0, post, 0, H), _box(span - post, span, 0, H),  // 左右の柱
      _box(0, span, H - thk, H), _box(0, span, 0, thk),    // 天板・底板
    ];
    for (let k = 1; k <= 2; k++) {
      const y = H * k / 3;
      parts.push(_box(post, span - post, y - thk / 2, y + thk / 2)); // 中棚
    }
    return parts;
  }

  /* 冷蔵庫(正面=本体+仕切り線+取っ手) */
  function _fridge(span, H) {
    const split = H * 0.66, hThk = Math.max(30, H * 0.015);
    return [
      _box(0, span, 0, H),                                  // 本体
      _box(0, span, split - hThk / 2, split + hThk / 2),    // 冷凍/冷蔵の仕切り
      _box(span * 0.8, span * 0.86, H * 0.4, H * 0.62),     // 取っ手
    ];
  }

  /* つい立て(正面=パネル+足) */
  function _tsuitateFront(span, H) {
    const foot = Math.max(50, H * 0.05);
    return [
      _box(span * 0.06, span * 0.94, foot, H),    // パネル
      _box(0, span * 0.18, 0, foot),              // 左足
      _box(span * 0.82, span, 0, foot),           // 右足
    ];
  }

  const _solid = (span, H) => [_box(0, span, 0, H)]; // ただの箱(側面など)
  const _none = () => null;                          // 省略(四角で描く)

  /* 種類ごとの姿図スタイル。先頭が既定スタイル。 */
  const FURNITURE_STYLES = {
    table: {
      square: { label: '角テーブル', front: (d) => _table(d.w, d.height), side: (d) => _table(d.h, d.height) },
      round:  { label: '丸テーブル(1本脚)', front: (d) => _tableRound(d.w, d.height), side: (d) => _tableRound(d.h, d.height) },
      plain:  { label: '四角(省略)', front: _none, side: _none },
    },
    chair: {
      back:  { label: '背もたれ付き', front: (d) => _chair(d.w, d.height, true, false), side: (d) => _chair(d.h, d.height, true, true) },
      stool: { label: '背もたれなし(スツール)', front: (d) => _chair(d.w, d.height, false, false), side: (d) => _chair(d.h, d.height, false, true) },
      plain: { label: '四角(省略)', front: _none, side: _none },
    },
    counter: {
      std:   { label: 'カウンター(薄い天板・蹴込み付き)', front: (d) => _counter(d.w, d.height), side: (d) => _counter(d.h, d.height) },
      plain: { label: '四角(省略)', front: _none, side: _none },
    },
    counterL: {
      std:   { label: 'L字カウンター(薄い天板・蹴込み付き)', front: (d) => _counter(d.w, d.height), side: (d) => _counter(d.h, d.height) },
      plain: { label: '四角(省略)', front: _none, side: _none },
    },
    sofa: {
      std:   { label: 'アーム付きソファ', front: (d) => _sofaFront(d.w, d.height), side: (d) => _sofaSide(d.h, d.height) },
      plain: { label: '四角(省略)', front: _none, side: _none },
    },
    shelf: {
      std:   { label: 'オープン棚', front: (d) => _shelfFront(d.w, d.height), side: (d) => _solid(d.h, d.height) },
      plain: { label: '四角(省略)', front: _none, side: _none },
    },
    fridge: {
      std:   { label: '冷蔵庫(扉・取っ手)', front: (d) => _fridge(d.w, d.height), side: (d) => _solid(d.h, d.height) },
      plain: { label: '四角(省略)', front: _none, side: _none },
    },
    sink: {
      std:   { label: 'シンク台(蹴込み付き)', front: (d) => _cabinet(d.w, d.height), side: (d) => _cabinet(d.h, d.height) },
      plain: { label: '四角(省略)', front: _none, side: _none },
    },
    tsuitate: {
      std:   { label: 'つい立て(足付き)', front: (d) => _tsuitateFront(d.w, d.height), side: (d) => _solid(d.h, d.height) },
      plain: { label: '四角(省略)', front: _none, side: _none },
    },
  };

  /* 種類の既定スタイル名(スタイル一覧の先頭)。 */
  function defaultStyle(kind) {
    const s = FURNITURE_STYLES[kind];
    return s ? Object.keys(s)[0] : null;
  }

  /* 備品 f の姿図プリセット形(view = 'front' | 'side')を作る。
   * 自由な形(polygon)やスタイル未定義の種類は null(=四角で描く)。 */
  function furniturePreset(f, view) {
    if (!f || f.shape === 'polygon') return null;
    const styles = FURNITURE_STYLES[f.kind];
    if (!styles) return null;
    const v = styles[f.variant] || styles[defaultStyle(f.kind)];
    if (!v) return null;
    const gen = view === 'side' ? v.side : v.front;
    const prof = gen ? gen({ w: f.w, h: f.h, height: f.height || 0 }) : null;
    return prof && prof.length ? prof : null;
  }

  /* 建具・設備カタログ(壁に沿って配置する線状の部品、および平面図に置くだけの設備アイコン。mm)
   * 扉・戸は開き勝手(flip=左右反転 / swing=内外反転)を持ち、製図記号で描く。
   * category: 'fitting'=建具(出入口・扉・窓・壁) / 'equipment'=設備アイコン(便器など)。
   * どちらも高さを持たず、備品姿図・見通し規制・備品一覧表の対象にはならない
   * (「どこに何があるか」を示すだけの平面図上のアイコン)。 */
  const FITTING_CATALOG = {
    entrance:    { label: '出入口',     w: 1200, h: 120, category: 'fitting' },
    door:        { label: '片開き扉',   w: 800,  h: 120, category: 'fitting' },
    doorDouble:  { label: '両開き扉',   w: 1600, h: 120, category: 'fitting' },
    slideSingle: { label: '片引き戸',   w: 900,  h: 120, category: 'fitting' },
    slideSplit:  { label: '引き分け戸', w: 1800, h: 120, category: 'fitting' },
    slidePass:   { label: '引き違い戸', w: 1700, h: 120, category: 'fitting' },
    window:      { label: '窓',         w: 1650, h: 120, category: 'fitting' },
    curtain:     { label: 'カーテン',   w: 1800, h: 80,  category: 'fitting' },
    wall:        { label: '壁',         w: 2000, h: 120, category: 'fitting' },
    toilet:      { label: '便器',       w: 400,  h: 700, category: 'equipment' },
    washbasin:   { label: '手洗い器',   w: 500,  h: 400, category: 'equipment' },
    microwave:   { label: '電子レンジ', w: 450,  h: 350, category: 'equipment' },
    gasstove:    { label: 'ガスコンロ', w: 560,  h: 450, category: 'equipment' },
    choritai:    { label: '調理台',     w: 900,  h: 600, category: 'equipment' },
    rangehood:   { label: '換気扇・レンジフード', w: 900, h: 600, category: 'equipment' },
    extinguisher:{ label: '消火器',     w: 150,  h: 150, category: 'equipment' },
    exit:        { label: '非常口',     w: 400,  h: 300, category: 'equipment' },
    greasetrap:  { label: 'グリストラップ', w: 400, h: 300, category: 'equipment' },
  };

  /* 扉・戸(開き勝手の設定を持つ建具)の種類 */
  const DOOR_KINDS = ['door', 'doorDouble', 'slideSingle', 'slideSplit', 'slidePass'];

  /* 照明・音響設備カタログ(点で配置)。symbol は図面上の記号(重複不可)。 */
  const FIXTURE_CATALOG = {
    downlight:   { label: 'ダウンライト',     symbol: 'DL' },
    pendant:     { label: 'ペンダントライト', symbol: 'PL' },
    ceiling:     { label: 'シーリングライト', symbol: 'CL' },
    spotlight:   { label: 'スポットライト',   symbol: 'SP' },
    floorstand:  { label: 'フロアスタンド',   symbol: 'FS' },
    footlight:   { label: 'フットライト',     symbol: 'FT' },
    chandelier:  { label: 'シャンデリア',     symbol: 'CH' },
    tablelight:  { label: 'テーブルライト',   symbol: 'TL' },
    bracket:     { label: 'ブラケット',       symbol: 'BR' },
    heatbulb:     { label: '熱電球',           symbol: 'HL' },
    fluorescent: { label: '蛍光灯',           symbol: 'FL' },
    speaker:     { label: 'スピーカー',       symbol: 'SPK' },
    monitor:     { label: 'モニター',         symbol: 'MON' },
    karaoke:     { label: 'カラオケ',         symbol: 'KAR' },
  };

  /* 用紙サイズ(mm) */
  const PAPER_SIZES = {
    A4: { w: 297, h: 210 }, // 横向き基準
    A3: { w: 420, h: 297 },
  };

  /* 見通しを妨げるおそれがあると判定する高さのしきい値(mm) = 1m */
  const SIGHTLINE_LIMIT = 1000;

  /* 深夜酒類提供飲食店営業開始届出の必要書類チェックリスト。
   * corpOnly: 法人の場合のみ必要。 note: 補足。
   * 提出先: 営業所所在地を管轄する警察署(公安委員会宛て)。
   * 期限: 営業開始の10日前まで。詳細は都道府県警により異なる。 */
  const CHECKLIST_ITEMS = [
    { id: 'todokede',  label: '営業開始届出書(様式第47号)' },
    { id: 'houhou',    label: '営業の方法(様式第48号)' },
    { id: 'annaizu',   label: '営業所周辺の略図(案内図)', note: '住宅地図の写し等。本ツール対象外' },
    { id: 'heimenzu',  label: '営業所平面図' },
    { id: 'kyuseki',   label: '求積図・求積表(営業所・客室・調理場)' },
    { id: 'shomei',    label: '照明・音響設備図(設備一覧表つき)' },
    { id: 'juminhyo',  label: '住民票の写し(本籍記載・マイナンバーなし)' },
    { id: 'teikan',    label: '定款の写し', corpOnly: true },
    { id: 'tokibo',    label: '登記事項証明書', corpOnly: true },
    { id: 'yakuin',    label: '役員全員の住民票の写し', corpOnly: true },
    { id: 'kyoka',     label: '飲食店営業許可証の写し', note: '署により' },
    { id: 'chintai',   label: '賃貸借契約書の写し・使用承諾書等', note: '署により' },
    { id: 'menu',      label: 'メニュー表の写し', note: '署により' },
    { id: 'ininjo',    label: '委任状', note: '行政書士が代理提出する場合' },
  ];

  function todayStr() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function defaultProject() {
    return {
      meta: {
        storeName: '',
        address: '',
        scale: 50,            // 1/50
        paper: 'A4',
        orientation: 'landscape',
        date: todayStr(),
        author: '',
        lightingNote: '', // 照明・音響設備図の凡例に添える自由記入コメント
        fixtureCountOverrides: {}, // 照明・音響設備一覧表の数量手入力(kind → 数量)
        showPaperFrame: true, // 用紙枠ガイド(用紙サイズ×縮尺の範囲)を表示するか
        northAngle: 0,        // 方位記号の角度(度)。0 = 真上が北
        showNorthMark: false, // 方位記号(N)を表示するか。既定は非表示
        /* 求積図(営業所/客室・調理場)の図面そのものに、求積表(計算過程)を
         * 白枠で重ねて印字するか。右サイドバーのボタンで切り替える。 */
        showKyusekiTable: true,
        /* 備品姿図でカードをドラッグして動かした位置(グループキー → {x, y})。
         * 空なら自動整列。ドラッグした備品だけ自動整列から外れて手動配置になる。 */
        furnViewPos: {},
        /* 図面上に重ねる表(求積表・設備一覧表)の手動配置。
         * layer → {x, y, scale}。x/y は表の左上(mm)、scale は自動サイズに対する倍率。 */
        sheetTableLayouts: {},
        fontScale: 100,       // 図面内ラベルの文字サイズ(%)。要素ごとの fontSize(サイズ番号)が優先
        /* 営業所求積の方式(警察署のローカルルールに合わせて選ぶ):
         *   'regions'    … 区画の合計(内法)
         *   'centerline' … 壁芯の外周(座標法)
         *   'both'       … 両方を併記 */
        premisesMethod: 'regions',
        /* 柱の面積を、柱が立っている区画(客室・調理場など)の面積から差し引くか */
        deductPillars: false,
        /* PDFを実寸の縮尺(定規で測って正確に1/縮尺)で印刷するか。
         * false のときは従来どおり用紙に収まるよう自動調整して印刷する。 */
        printTrueScale: false,
        /* 届出書(様式第47号・第48号)の下書きに自動転記する情報。
         * 図面から導けない項目(届出者・建物・営業の方法など)をここに保存して、
         * 入力すれば両様式へ自動で埋まる。案件ごとに自動保存される。 */
        todokede: {
          applicantAddress: '',  // 届出者の住所
          applicantName: '',     // 届出者の氏名(法人なら名称)
          applicantKana: '',     // 営業所名称のふりがな
          corpRepName: '',       // 法人の代表者氏名
          phone: '',             // 電話番号
          addressee: '',         // ○○公安委員会(空なら所在地から自動推定)
          buildingStructure: '', // 建物の構造
          buildingPosition: '',  // 建物内の営業所の位置
          businessHours: '午後6時から翌日午前2時まで',
          staffCount: '',        // 従事者数
          alcoholMethod: '客の注文により座席で提供する',
          minorRule: '18歳未満の者は午後10時以降立ち入らせない',
          licenseDate: '',       // 飲食店営業許可の年月日
          licenseNumber: '',     // 飲食店営業許可の番号
        },
      },
      /* 下絵(間取り図などの画像をなぞる用)。未設定なら null。
       *   src=画像(dataURL), x,y=左上(mm), w,h=実寸(mm), opacity=不透明度(0〜1) */
      underlay: null,
      /* 営業所外周(壁芯求積用)。多角形1つ + 壁厚。未作成なら null。
       *   measuredAt: 'inner'=内側の寸法で入力(壁芯線は壁厚/2だけ外側に自動生成)
       *               'center'=壁芯の寸法で入力(そのまま壁芯線になる) */
      premise: null,
      regions: [],
      walls: [],
      furniture: [],
      fittings: [],
      fixtures: [],
      /* メモ・引き出し線。x,y=文字の箱の左上(mm)、tx,ty=矢印の先端(mm)。
       * layer=表示する図面(作成時の図面にだけ出る)。図面・PDFにそのまま印字される。 */
      notes: [],
      /* 手動の寸法線。任意の2点(x1,y1)-(x2,y2)間に寸法線と長さ(m)を描く。
       * layer=表示する図面。図面・PDFにそのまま印字される。 */
      dimensions: [],
      /* 必要書類チェックリストの状態。corp=法人かどうか, items={id: true} */
      checklist: { corp: false, items: {} },
      _seq: 1,
    };
  }

  function nextId(project, prefix) {
    return `${prefix}-${project._seq++}`;
  }

  /* 種類ごとの通し番号(客室1, 客室2 ...)を採番 */
  function nextRegionNumber(project, type) {
    let max = 0;
    for (const r of project.regions) {
      if (r.type === type && typeof r.number === 'number') {
        max = Math.max(max, r.number);
      }
    }
    return max + 1;
  }

  function addRegion(project, type, w, h, shape, w2) {
    const number = nextRegionNumber(project, type);
    const t = REGION_TYPES[type];
    const region = {
      id: nextId(project, 'r'),
      type,
      number,
      label: type === 'kyakushitsu' ? `客室${number}` : t.label,
      x: 1000,
      y: 1000,
      w: w,
      h: h,
      shape: shape || 'rect',     // 'rect' | 'triangle' | 'trapezoid'
      w2: w2 != null ? w2 : Math.round(w / 2), // 台形の上底(mm)
      rotation: 0,
      showLabel: false,
      areaUse: t.defaultAreaUse || 'auto',
      color: t.color,
    };
    project.regions.push(region);
    return region;
  }

  /* 多角形の区画を追加する。pointsAbs は絶対座標(mm)の頂点列(3点以上)。
   * 内部では「左上を原点(x,y)とした相対座標」で持ち、移動は x,y だけ動かす。 */
  function addPolygonRegion(project, type, pointsAbs) {
    const number = nextRegionNumber(project, type);
    const t = REGION_TYPES[type];
    const minX = Math.min(...pointsAbs.map((p) => p.x));
    const minY = Math.min(...pointsAbs.map((p) => p.y));
    const region = {
      id: nextId(project, 'r'),
      type,
      number,
      label: type === 'kyakushitsu' ? `客室${number}` : t.label,
      x: minX,
      y: minY,
      w: 0,
      h: 0,
      shape: 'polygon',
      points: pointsAbs.map((p) => ({ x: p.x - minX, y: p.y - minY })),
      rotation: 0,
      showLabel: false,
      areaUse: t.defaultAreaUse || 'auto',
      color: t.color,
    };
    normalizePolygon(region);
    project.regions.push(region);
    return region;
  }

  /* 多角形の原点(x,y)を頂点の最小値に合わせ直し、w/h(外接サイズ)を更新する。
   * 頂点編集後に呼ぶことで、当たり判定・全体表示が正しく働く。 */
  function normalizePolygon(region) {
    if (region.shape !== 'polygon' || !region.points || !region.points.length) return;
    const minX = Math.min(...region.points.map((p) => p.x));
    const minY = Math.min(...region.points.map((p) => p.y));
    if (minX !== 0 || minY !== 0) {
      region.x += minX;
      region.y += minY;
      for (const p of region.points) { p.x -= minX; p.y -= minY; }
    }
    region.w = Math.max(...region.points.map((p) => p.x));
    region.h = Math.max(...region.points.map((p) => p.y));
  }

  /* 内壁(部屋を仕切る壁)を追加する。pointsAbs は絶対座標(mm)の頂点列(2点以上)。
   * 区画の多角形と同じ「左上原点 + 相対頂点」で持つが、閉じない折れ線でもよい。
   * 見た目だけの壁で、区画の求積(面積計算)には一切影響しない。 */
  function addPolygonWall(project, pointsAbs, thickness) {
    const xs = pointsAbs.map((p) => p.x), ys = pointsAbs.map((p) => p.y);
    const minX = Math.min(...xs), minY = Math.min(...ys);
    const wall = {
      id: nextId(project, 'w'),
      label: '内壁',
      shape: 'polygon',
      x: minX,
      y: minY,
      points: pointsAbs.map((p) => ({ x: p.x - minX, y: p.y - minY })),
      w: Math.max(...xs) - minX,
      h: Math.max(...ys) - minY,
      rotation: 0,
      thickness: Math.max(10, thickness | 0) || 100,
    };
    project.walls.push(wall);
    return wall;
  }

  /* 営業所外周を作成する。pointsAbs は絶対座標(mm)の頂点列(3点以上)。
   * 多角形区画と同じく「左上原点 + 相対頂点」で持ち、頂点ドラッグも共通で使える。 */
  function setPremise(project, pointsAbs, wallThickness, measuredAt) {
    const minX = Math.min(...pointsAbs.map((p) => p.x));
    const minY = Math.min(...pointsAbs.map((p) => p.y));
    project.premise = {
      id: 'premise',
      label: '営業所外周',
      shape: 'polygon',
      x: minX,
      y: minY,
      w: 0,
      h: 0,
      points: pointsAbs.map((p) => ({ x: p.x - minX, y: p.y - minY })),
      wallThickness: Math.max(10, wallThickness | 0) || 100,
      measuredAt: measuredAt === 'center' ? 'center' : 'inner',
    };
    normalizePolygon(project.premise);
    return project.premise;
  }

  function addFurniture(project, kind, variant) {
    const c = FURNITURE_CATALOG[kind];
    const item = {
      id: nextId(project, 'f'),
      kind,
      label: c.label,
      x: 1500,
      y: 1500,
      w: c.w,
      h: c.h,
      rotation: 0,
      height: c.height,
    };
    // 姿図スタイル(正面図・側面図の形)。未指定なら既定スタイル
    const ds = defaultStyle(kind);
    if (ds) item.variant = variant || ds;
    if (c.t) {
      item.t = c.t; // L字カウンター等の厚み
      if (kind === 'counterL') item.mirrorL = false;
    }
    project.furniture.push(item);
    return item;
  }

  /* 多角形(自由な形)の備品を追加する。pointsAbs は絶対座標(mm)の頂点列(3点以上)。
   * 上から見た形(平面)を保持する。高さは既定700mm(あとから変更可)。
   * 区画の多角形と同じ仕組み(points は原点x,yからの相対mm)。 */
  function addPolygonFurniture(project, pointsAbs, opts) {
    opts = opts || {};
    const xs = pointsAbs.map((p) => p.x), ys = pointsAbs.map((p) => p.y);
    const minX = Math.min(...xs), minY = Math.min(...ys);
    const item = {
      id: nextId(project, 'f'),
      kind: 'custom',
      label: opts.label || '備品',
      shape: 'polygon',
      x: minX,
      y: minY,
      points: pointsAbs.map((p) => ({ x: p.x - minX, y: p.y - minY })),
      w: Math.max(...xs) - minX,
      h: Math.max(...ys) - minY,
      rotation: 0,
      height: opts.height || 700,
    };
    project.furniture.push(item);
    return item;
  }

  function addFitting(project, kind) {
    const c = FITTING_CATALOG[kind];
    const item = {
      id: nextId(project, 'g'),
      kind,
      label: c.label,
      x: 1500,
      y: 1500,
      w: c.w,
      h: c.h,
      rotation: 0,
      layers: ['plan', 'kyuseki'],
    };
    project.fittings.push(item);
    return item;
  }

  function addFixture(project, kind) {
    const c = FIXTURE_CATALOG[kind];
    const item = {
      id: nextId(project, 'x'),
      kind,
      label: c.label,
      x: 1500,
      y: 1500,
      watt: '',
      model: '',
    };
    project.fixtures.push(item);
    return item;
  }

  /* メモ・引き出し線を追加する。layer は表示する図面。位置はあとで呼び出し側が決める。 */
  /* メモ(引き出し線つきの注釈)を追加する。
   * leader=false にすると、引き出し線・矢印のない「コメント(自由テキスト)」になる。 */
  function addNote(project, layer, leader) {
    const note = {
      id: nextId(project, 'n'),
      text: leader === true ? 'メモ' : 'コメント',
      x: 1500,
      y: 1500,
      tx: 0,    // 矢印の先端(指したい場所)。コメント(leader=false)では未使用
      ty: 2500,
      leader: leader === true, // 既定では引き出し線(矢印)なしの自由テキスト(コメント)
      layer: layer || 'plan',
      layers: [layer || 'plan'],
    };
    project.notes = project.notes || [];
    project.notes.push(note);
    return note;
  }

  /* 手動の寸法線を追加する。2点は呼び出し側(作図確定時)が渡す。 */
  function addDimension(project, x1, y1, x2, y2, layer) {
    const dim = {
      id: nextId(project, 'd'),
      x1, y1, x2, y2,
      layer: layer || 'kyuseki',
      layers: [layer || 'kyuseki'], // 既定では求積図だけに表示(平面図には出さない)
      showLength: false, // 既定では長さの数値は図面に表示しない
    };
    project.dimensions = project.dimensions || [];
    project.dimensions.push(dim);
    return dim;
  }

  function removeById(project, id) {
    if (project.premise && project.premise.id === id) {
      project.premise = null;
      return true;
    }
    for (const key of ['regions', 'walls', 'furniture', 'fittings', 'fixtures', 'notes', 'dimensions']) {
      const i = (project[key] || []).findIndex((e) => e.id === id);
      if (i >= 0) { project[key].splice(i, 1); return true; }
    }
    return false;
  }

  const Z_KIND_BASE = {
    regions: 1000,
    walls: 1500,
    fittings: 2000,
    furniture: 3000,
    fixtures: 4000,
    dimensions: 5000,
    notes: 6000,
  };
  const Z_KIND_ORDER = ['regions', 'walls', 'fittings', 'furniture', 'fixtures', 'dimensions', 'notes'];

  function findById(project, id) {
    if (project.premise && project.premise.id === id) {
      return { element: project.premise, kind: 'premise' };
    }
    for (const key of ['regions', 'walls', 'furniture', 'fittings', 'fixtures', 'notes', 'dimensions']) {
      const e = (project[key] || []).find((e) => e.id === id);
      if (e) return { element: e, kind: key };
    }
    return null;
  }

  function elementZ(project, kind, el) {
    if (!el) return -Infinity;
    if (Number.isFinite(el.zIndex)) return el.zIndex;
    const base = Z_KIND_BASE[kind] || 0;
    const arr = project[kind] || [];
    const i = arr.findIndex((e) => e.id === el.id);
    return base + (i >= 0 ? i : 0);
  }

  function sortedOrderableItems(project) {
    const items = [];
    for (const kind of Z_KIND_ORDER) {
      for (const el of (project[kind] || [])) {
        items.push({ kind, element: el, z: elementZ(project, kind, el) });
      }
    }
    return items.sort((a, b) => {
      if (a.z !== b.z) return a.z - b.z;
      return Z_KIND_ORDER.indexOf(a.kind) - Z_KIND_ORDER.indexOf(b.kind);
    });
  }

  function zOrderPosition(project, id) {
    const items = sortedOrderableItems(project);
    const index = items.findIndex((item) => item.element.id === id);
    return { index, count: items.length };
  }

  function setZOrder(project, id, action) {
    const found = findById(project, id);
    if (!found || Z_KIND_ORDER.indexOf(found.kind) < 0) return false;
    const items = sortedOrderableItems(project);
    const index = items.findIndex((item) => item.element.id === id);
    if (index < 0) return false;
    const [item] = items.splice(index, 1);
    if (action === 'front') {
      items.push(item);
    } else if (action === 'back') {
      items.unshift(item);
    } else if (action === 'forward') {
      items.splice(Math.min(index + 1, items.length), 0, item);
    } else if (action === 'backward') {
      items.splice(Math.max(index - 1, 0), 0, item);
    } else {
      return false;
    }
    items.forEach((entry, i) => {
      entry.element.zIndex = (i + 1) * 1000;
    });
    return true;
  }

  /* 選択中の要素を複製する(営業所外周は1つだけなので対象外)。
   * 少し右下にずらして置き、新しい id を振る。区画は通し番号も振り直す。 */
  function duplicateElement(project, id) {
    const found = findById(project, id);
    if (!found || found.kind === 'premise') return null;
    const prefix = { regions: 'r', walls: 'w', furniture: 'f', fittings: 'g', fixtures: 'x', notes: 'n', dimensions: 'd' }[found.kind];
    const copy = JSON.parse(JSON.stringify(found.element));
    copy.id = nextId(project, prefix);
    const d = 300; // 元の要素と完全に重ならないようにずらす量(mm)
    if (found.kind === 'dimensions') {
      copy.x1 += d; copy.y1 += d; copy.x2 += d; copy.y2 += d;
      project[found.kind].push(copy);
      return copy;
    }
    copy.x += d;
    copy.y += d;
    if (found.kind === 'notes') { copy.tx += d; copy.ty += d; }
    if (found.kind === 'regions') {
      copy.number = nextRegionNumber(project, copy.type);
      const t = REGION_TYPES[copy.type] || {};
      // 既定のラベル(「客室1」「厨房」等)のままなら新しい番号で付け直す。手書きのラベルは残す
      const isDefault = copy.type === 'kyakushitsu'
        ? /^客室\d+$/.test(copy.label)
        : copy.label === t.label;
      if (isDefault) {
        copy.label = copy.type === 'kyakushitsu' ? `客室${copy.number}` : t.label;
      }
    }
    project[found.kind].push(copy);
    return copy;
  }

  /* --- 保存 / 読み込み(JSON) --- */
  function serialize(project) {
    return JSON.stringify(project, null, 2);
  }

  function deserialize(text) {
    const obj = JSON.parse(text);
    // 最低限の妥当性チェックと補完
    const base = defaultProject();
    const project = Object.assign(base, obj);
    project.meta = Object.assign(base.meta, obj.meta || {});
    project.regions = (obj.regions || [])
      .filter((r) => r && r.boundaryOnly !== true && r.boundaryArea !== true)
      .map((r) => {
        if (r.type !== 'premisesArea') return r;
        return Object.assign({}, r, {
          type: 'other',
          label: r.label === '営業所囲い' ? 'その他' : r.label,
          areaUse: r.areaUse && r.areaUse !== 'auto' ? r.areaUse : 'premises',
          color: r.color || REGION_TYPES.other.color,
        });
      });
    project.walls = obj.walls || [];
    project.furniture = obj.furniture || [];
    project.fittings = obj.fittings || [];
    project.fixtures = obj.fixtures || [];
    project.premise = obj.premise || null;
    project.underlay = obj.underlay || null;
    project.notes = obj.notes || [];
    project.dimensions = obj.dimensions || [];
    // 届出書情報は項目を追加しても古いデータが壊れないよう既定値で補完する
    project.meta.todokede = Object.assign({}, base.meta.todokede, (obj.meta && obj.meta.todokede) || {});
    project.checklist = Object.assign({ corp: false, items: {} }, obj.checklist || {});
    project.checklist.items = (obj.checklist && obj.checklist.items) || {};
    // 旧版からの引っ越し: 営業所求積図と客室・調理場求積図は「求積図」1枚に統合した。
    // メモ・寸法線・建具の表示先、図面上の表の位置、チェックリストの2項目を付け替える。
    const mapLayer = (l) => (l === 'premises' || l === 'kyakushitsu') ? 'kyuseki' : l;
    for (const el of project.notes.concat(project.dimensions, project.fittings)) {
      if (el.layer) el.layer = mapLayer(el.layer);
      if (Array.isArray(el.layers)) {
        el.layers = el.layers.map(mapLayer).filter((l, i, a) => a.indexOf(l) === i);
      }
    }
    const stl = project.meta.sheetTableLayouts || {};
    if (!stl.kyuseki && (stl.premises || stl.kyakushitsu)) {
      stl.kyuseki = stl.premises || stl.kyakushitsu;
    }
    delete stl.premises;
    delete stl.kyakushitsu;
    const items = project.checklist.items;
    if (('kyuseki_e' in items || 'kyuseki_k' in items) && !('kyuseki' in items)) {
      items.kyuseki = !!(items.kyuseki_e && items.kyuseki_k);
    }
    delete items.kyuseki_e;
    delete items.kyuseki_k;
    // 旧形式の文字サイズ(fontMm=実寸mm)を、現行のサイズ番号(fontSize, 15=標準)へ変換する。
    // 既定の実寸は要素の種類ごとに異なる(render.js の既定値と揃える)。
    const convertFontMm = (list, defaultMm) => {
      for (const el of list || []) {
        if (el.fontMm > 0 && !(el.fontSize > 0)) {
          el.fontSize = Math.min(96, Math.max(6, Math.round(el.fontMm / defaultMm * 15)));
        }
        delete el.fontMm;
      }
    };
    convertFontMm(project.regions, 320);
    convertFontMm(project.furniture, 200);
    convertFontMm(project.fittings, 200);
    convertFontMm(project.notes, 240);
    convertFontMm(project.dimensions, 240);
    // 旧「色分け(慣行色)」の全体設定 → 区画ごとの線色へ引っ越す。
    // 客室=赤・調理場=緑・壁芯線=青を、まだ個別の色が付いていない要素にだけ付ける。
    if (obj.meta && obj.meta.colorMode === 'police') {
      const oldStyles = Object.assign(
        { premises: 'solid', kyakushitsu: 'solid', chubo: 'solid' },
        obj.meta.boundaryLineStyles || {});
      const useOf = (r) => {
        if (r.type === 'pillar') return 'display';
        const u = r.areaUse || 'auto';
        if (u !== 'auto') return u;
        const t = REGION_TYPES[r.type] || {};
        return t.defaultAreaUse || r.type;
      };
      const colorFor = { kyakushitsu: '#e53935', chubo: '#2e7d32' };
      for (const r of project.regions) {
        const use = useOf(r);
        const color = colorFor[use];
        if (!color || oldStyles[use] === 'hidden' || r.boundaryColor) continue;
        r.boundaryColor = color;
        if (!r.boundaryLineStyle && oldStyles[use] !== 'solid') {
          r.boundaryLineStyle = oldStyles[use];
        }
      }
      if (project.premise && !project.premise.lineColor && oldStyles.premises !== 'hidden') {
        project.premise.lineColor = '#1d4ed8';
      }
    }
    delete project.meta.colorMode;
    delete project.meta.boundaryLineStyles;
    if (typeof project._seq !== 'number') {
      project._seq = 1 + project.regions.length + project.furniture.length +
                     project.fittings.length + project.fixtures.length;
    }
    return project;
  }

  global.Model = {
    REGION_TYPES, AREA_USES, FURNITURE_CATALOG, FITTING_CATALOG, DOOR_KINDS, FIXTURE_CATALOG, PAPER_SIZES,
    FURNITURE_STYLES, defaultStyle, furniturePreset,
    SIGHTLINE_LIMIT, CHECKLIST_ITEMS,
    todayStr, defaultProject, nextId, nextRegionNumber,
    addRegion, addPolygonRegion, normalizePolygon, setPremise, addPolygonWall,
    addFurniture, addPolygonFurniture, addFitting, addFixture, addNote, addDimension,
    removeById, findById, elementZ, sortedOrderableItems, zOrderPosition, setZOrder, duplicateElement,
    serialize, deserialize,
  };
})(window);
