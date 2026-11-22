const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = vm.createContext({ window: {} });
for (const name of ['model', 'geometry', 'render']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js', name + '.js'), 'utf8'), context);
}
const { Model: M, Geometry: G, Render: R } = context.window;
const plain = (v) => JSON.parse(JSON.stringify(v));
const rectangle = (x, y, width, height) => [
  { x, y }, { x: x + width, y },
  { x: x + width, y: y + height }, { x, y: y + height },
];
function bounds(points) {
  const xs = Array.from(points, p => p.x), ys = Array.from(points, p => p.y);
  return { x: Math.min(...xs), y: Math.min(...ys),
    w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}
function addDisplayBoundary(project, points) {
  const box = bounds(points);
  const region = M.addRegion(project, 'other', box.w, box.h, 'rect');
  region.x = box.x;
  region.y = box.y;
  region.label = '囲い線';
  region.areaUse = 'display';
  region.boundaryColor = '#1d4ed8';
  region.boundaryLineStyle = 'dashed';
  region.layers = ['plan', 'kyuseki'];
  return region;
}

test('a display boundary retains the entered dimensions and does not enter area totals', () => {
  const project = M.defaultProject();
  const room = M.addRegion(project, 'kyakushitsu', 5000, 3000, 'rect');
  const before = plain(G.buildTable(project));
  const input = rectangle(-530, 475, 4321, 3214);
  const boundary = addDisplayBoundary(project, input);

  assert.equal(boundary.w, 4321);
  assert.equal(boundary.h, 3214);
  assert.equal(boundary.shape, 'rect');
  assert.deepEqual({ x: boundary.x, y: boundary.y, w: boundary.w, h: boundary.h }, bounds(input));
  assert.equal(G.areaUseForRegion(boundary), 'display');
  assert.deepEqual(plain(G.buildTable(project)), before);
  assert.equal(G.buildTable(project).rows.length, 1);
  assert.equal(G.buildTable(project).rows[0].id, room.id);
});

test('inner measurements are preserved and wall thickness is added outside on all sides', () => {
  const project = M.defaultProject();
  const input = rectangle(-530, 475, 4321, 3214);
  const outline = M.addPremise(project, input, 120, 'inner');
  const wall = G.premiseWallPolysAbs(outline);

  assert.equal(outline.measuredAt, 'inner');
  assert.equal(outline.wallThickness, 120);
  assert.deepEqual(bounds(wall.inner), { x: -530, y: 475, w: 4321, h: 3214 });
  assert.deepEqual(bounds(wall.outer), { x: -650, y: 355, w: 4561, h: 3454 });
  assert.deepEqual(bounds(G.premiseCenterlineAbs(outline)),
    { x: -590, y: 415, w: 4441, h: 3334 });
  assert.deepEqual(plain(wall.inner), input);
});

test('adding a second inner-measured rectangle preserves the first outer wall and its area', () => {
  const project = M.defaultProject();
  const first = M.addPremise(project, rectangle(0, 0, 4100, 2700), 150, 'inner');
  const firstBefore = plain(first), firstArea = G.premiseCalc(first).total;
  const second = M.addPremise(project, rectangle(800, 400, 1200, 1800), 80, 'inner');

  assert.equal(project.premise, first);
  assert.equal(project.additionalPremises.length, 1);
  assert.equal(project.additionalPremises[0], second);
  assert.notEqual(second.id, first.id);
  assert.deepEqual(plain(first), firstBefore);
  assert.equal(G.premiseCalc(first).total, firstArea);
  assert.deepEqual(bounds(G.premiseWallPolysAbs(second).inner),
    { x: 800, y: 400, w: 1200, h: 1800 });
  assert.deepEqual(bounds(G.premiseWallPolysAbs(second).outer),
    { x: 720, y: 320, w: 1360, h: 1960 });
});

test('rectangle dimensions, drawing style, and inner-measured walls survive saving and loading', () => {
  const project = M.defaultProject();
  const boundary = addDisplayBoundary(project, rectangle(150, 240, 4237, 2986));
  const outline = M.addPremise(project, rectangle(150, 240, 4237, 2986), 90, 'inner');
  const saved = M.serialize(project);
  const loaded = M.deserialize(saved);
  const loadedBoundary = M.findById(loaded, boundary.id).element;
  const loadedOutline = M.findById(loaded, outline.id).element;

  assert.deepEqual(plain(loadedBoundary), plain(boundary));
  assert.deepEqual(plain(loadedOutline), plain(outline));
  assert.deepEqual(bounds(G.premiseWallPolysAbs(loadedOutline).inner),
    { x: 150, y: 240, w: 4237, h: 2986 });
  assert.deepEqual(bounds(G.premiseWallPolysAbs(loadedOutline).outer),
    { x: 60, y: 150, w: 4417, h: 3166 });
  assert.equal(G.buildTable(loaded).rows.length, 0);
});

test('pillar fitting stores independent horizontal and vertical dimensions', () => {
  const project = M.defaultProject();
  const pillar = M.addFitting(project, 'pillar');
  assert.equal(M.FITTING_CATALOG.pillar.category, 'fitting');
  assert.equal(pillar.label, '柱');
  assert.equal(pillar.w, 300);
  assert.equal(pillar.h, 300);
  pillar.w = 450;
  pillar.h = 625;
  const loaded = M.deserialize(M.serialize(project));
  const savedPillar = M.findById(loaded, pillar.id).element;
  assert.equal(savedPillar.kind, 'pillar');
  assert.equal(savedPillar.w, 450);
  assert.equal(savedPillar.h, 625);
  assert.deepEqual(plain(savedPillar.layers), ['plan', 'kyuseki']);
});

test('a pillar has an unfilled outline and a centered black label on screen and in print', () => {
  const project = M.defaultProject();
  project.regions = [];
  project.meta.showPaperFrame = false;
  project.meta.showNorthMark = false;
  const pillar = M.addFitting(project, 'pillar');
  pillar.rotation = 37;
  R.view.zoom = 0.1;
  R.setLayer('plan');
  for (const [selected, print] of [[false, false], [true, false], [false, true]]) {
    const events = [];
    const base = {};
    const ctx = new Proxy(base, {
      get(obj, key) {
        if (key === 'measureText') return value => ({ width: String(value).length * parseFloat(obj.font) });
        if (key === 'fillRect' || key === 'strokeRect') return (...args) => events.push({ type: key, args, color: key === 'fillRect' ? obj.fillStyle : obj.strokeStyle });
        if (key === 'fillText') return (value, x, y) => events.push({ type: 'text', value, x, y, color: obj.fillStyle, align: obj.textAlign, baseline: obj.textBaseline });
        return key in obj ? obj[key] : () => {};
      },
      set(obj, key, value) { obj[key] = value; return true; },
    });
    R.render(ctx, { width: 800, height: 600 }, project,
      { selectedId: selected ? pillar.id : null }, { print });
    const outline = events.find(e => e.type === 'strokeRect' && e.args[2] === 30 && e.args[3] === 30);
    assert.ok(outline, 'pillar outline is drawn');
    assert.equal(outline.color, selected ? '#d32f2f' : '#000000');
    assert.ok(!events.some(e => e.type === 'fillRect' && e.args[2] === 30 && e.args[3] === 30), 'pillar has no fill');
    const label = events.find(e => e.type === 'text' && e.value === '柱');
    assert.ok(label, 'pillar label is drawn');
    assert.deepEqual([label.x, label.y, label.color, label.align, label.baseline], [0, 0, '#000000', 'center', 'middle']);
  }
});

test('a cupboard is available as a fitting and retains edited dimensions and label', () => {
  const project = M.defaultProject();
  project.regions = [];
  project.meta.showPaperFrame = false;
  project.meta.showNorthMark = false;
  assert.equal(M.FITTING_CATALOG.cupboard.category, 'fitting');
  const cupboard = M.addFitting(project, 'cupboard');
  assert.equal(cupboard.label, '食器棚');
  assert.deepEqual([cupboard.w, cupboard.h], [900, 450]);
  cupboard.w = 1600;
  cupboard.h = 600;
  cupboard.rotation = 90;
  const loaded = M.deserialize(M.serialize(project));
  const saved = M.findById(loaded, cupboard.id).element;
  assert.equal(saved.kind, 'cupboard');
  assert.deepEqual([saved.w, saved.h, saved.rotation, saved.label], [1600, 600, 90, '食器棚']);
  assert.deepEqual(plain(saved.layers), ['plan', 'kyuseki']);

  R.view.zoom = 0.1;
  R.setLayer('plan');
  for (const print of [false, true]) {
    const events = [];
    const base = {};
    const ctx = new Proxy(base, {
      get(obj, key) {
        if (key === 'measureText') return value => ({ width: String(value).length * parseFloat(obj.font) });
        if (key === 'fillRect' || key === 'strokeRect') return (...args) => events.push({ type: key, args, color: key === 'fillRect' ? obj.fillStyle : obj.strokeStyle });
        if (key === 'fillText') return (value, x, y) => events.push({ type: 'text', value, x, y, color: obj.fillStyle, align: obj.textAlign, baseline: obj.textBaseline });
        return key in obj ? obj[key] : () => {};
      },
      set(obj, key, value) { obj[key] = value; return true; },
    });
    R.render(ctx, { width: 800, height: 600 }, loaded, { selectedId: null }, { print });
    const outline = events.find(e => e.type === 'strokeRect' && e.args[2] === 160 && e.args[3] === 60);
    assert.ok(outline, 'cupboard outline is drawn');
    assert.equal(outline.color, '#000000');
    assert.ok(!events.some(e => e.type === 'fillRect' && e.args[2] === 160 && e.args[3] === 60), 'cupboard has no fill');
    const label = events.find(e => e.type === 'text' && e.value === '食器棚');
    assert.ok(label, 'cupboard label is drawn');
    assert.deepEqual([label.x, label.y, label.color, label.align, label.baseline], [0, 0, '#000000', 'center', 'middle']);
  }
  saved.label = '収納棚';
  const reloaded = M.deserialize(M.serialize(loaded));
  assert.equal(M.findById(reloaded, cupboard.id).element.label, '収納棚');
});

test('1/35 scale survives saving and sets the paper frame and PDF scale bar', () => {
  const project = M.defaultProject();
  project.meta.scale = 35;
  project.meta.paper = 'A4';
  project.meta.orientation = 'landscape';
  const loaded = M.deserialize(M.serialize(project));
  assert.equal(loaded.meta.scale, 35);
  assert.deepEqual(plain(R.paperFrameWorld(loaded)), { x: 0, y: 0, w: 10395, h: 7350 });
  loaded.meta.orientation = 'portrait';
  assert.deepEqual(plain(R.paperFrameWorld(loaded)), { x: 0, y: 0, w: 7350, h: 10395 });
  loaded.meta.orientation = 'landscape';

  let html = '', rendered;
  const view = { zoom: 0.05, offsetX: 12, offsetY: 34 };
  let layer = 'plan';
  const render = {
    LAYERS: R.LAYERS, view,
    getLayer: () => layer,
    setLayer: value => { layer = value; },
    paperFrameWorld: R.paperFrameWorld,
    render: (_ctx, canvas, p, _state, options) => {
      rendered = { width: canvas.width, zoom: view.zoom, scale: p.meta.scale, print: options.print };
    },
  };
  const win = { Model: M, Render: render,
    open: () => ({ document: { write: value => { html = value; }, close() {} } }) };
  const doc = { createElement: () => ({ getContext: () => ({}), toDataURL: () => 'data:image/png;base64,AA==' }) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/print.js'), 'utf8'), { window: win, document: doc });
  win.Printer.printCurrent(loaded);
  assert.equal(rendered.scale, 35);
  assert.equal(rendered.print, true);
  assert.ok(Math.abs(rendered.width / rendered.zoom - 10395) < 1e-7);
  assert.match(html, /aria-label="縮尺 1\/35"/);
  assert.match(html, /frame-scale-bar" style="width:28\.57mm/);
  assert.match(html, /--scale-label-size:128px/);
  loaded.meta.fontScale = 150;
  win.Printer.printCurrent(loaded);
  assert.match(html, /frame-scale-bar" style="width:28\.57mm/);
  assert.match(html, /--scale-label-size:192px/);
  loaded.meta.fontScale = 62.5;
  win.Printer.printCurrent(loaded);
  assert.match(html, /frame-scale-bar" style="width:28\.57mm/);
  assert.match(html, /--scale-label-size:80px/);
  assert.deepEqual(view, { zoom: 0.05, offsetX: 12, offsetY: 34 });
});

function textRecorder() {
  const labels = [];
  const base = {};
  const ctx = new Proxy(base, {
    get(obj, key) {
      if (key === 'measureText') return value => ({ width: String(value).length * (parseFloat(String(obj.font).replace('bold ', '')) || 0) });
      if (key === 'fillText') return (value, x, y) => labels.push({ value: String(value), x, y, font: obj.font });
      return key in obj ? obj[key] : () => {};
    },
    set(obj, key, value) { obj[key] = value; return true; },
  });
  return { ctx, labels };
}

test('table text defaults to size 8, respects size 5 after saving, and prints the same', () => {
  const project = M.defaultProject();
  project.meta.showPaperFrame = false;
  project.meta.showNorthMark = false;
  project.meta.manualKyuseki = { digits: 2, rows: [
    { id: 'row1', name: '試験区画', expr: '2*3', group: 'kyakushitsu' },
  ] };
  const originalView = { ...R.view };
  const originalLayer = R.getLayer();
  const renderTable = (p, print) => {
    const { ctx, labels } = textRecorder();
    R.setLayer('kyusekihyo');
    R.view.zoom = 0.03;
    R.view.offsetX = R.view.offsetY = 0;
    R.render(ctx, { width: 1200, height: 900 }, p, { selectedId: null }, { print });
    const font = text => {
      const label = labels.find(e => e.value === text);
      assert.ok(label, `missing table text ${text}`);
      return parseFloat(String(label.font).replace('bold ', ''));
    };
    return { title: font('客室求積表'), cell: font('試験区画') };
  };
  try {
    const standard = renderTable(project, false);
    project.meta.sheetTableLayouts = { kyusekihyo: { fontSize: 8 } };
    const explicit = renderTable(project, false);
    assert.deepEqual(explicit, standard);
    project.meta.sheetTableLayouts.kyusekihyo.fontSize = 5;
    const loaded = M.deserialize(M.serialize(project));
    assert.equal(loaded.meta.sheetTableLayouts.kyusekihyo.fontSize, 5);
    const smaller = renderTable(loaded, false);
    const printed = renderTable(loaded, true);
    assert.ok(Math.abs(smaller.title / standard.title - 5 / 8) < 1e-9);
    assert.ok(Math.abs(smaller.cell / standard.cell - 5 / 8) < 1e-9);
    assert.deepEqual(printed, smaller);
    loaded.meta.fontScale = 150;
    assert.deepEqual(renderTable(loaded, false), smaller);
    delete loaded.meta.sheetTableLayouts.kyusekihyo.fontSize;
    const global = renderTable(loaded, false);
    assert.ok(Math.abs(global.title / standard.title - 1.5) < 1e-9);
    assert.ok(Math.abs(global.cell / standard.cell - 1.5) < 1e-9);
  } finally {
    Object.assign(R.view, originalView);
    R.setLayer(originalLayer);
  }
});

test('north and scale labels use the standard text size and global font percentage', () => {
  const project = M.defaultProject();
  project.meta.scale = 35;
  project.meta.showPaperFrame = true;
  project.meta.showNorthMark = true;
  const originalView = { ...R.view };
  const originalLayer = R.getLayer();
  const renderLabels = percent => {
    project.meta.fontScale = percent;
    const { ctx, labels } = textRecorder();
    R.setLayer('plan');
    R.view.zoom = 0.1;
    R.view.offsetX = R.view.offsetY = 0;
    R.render(ctx, { width: 1200, height: 900 }, project, { selectedId: null });
    return ['N', '縮尺 1/35'].map(text => {
      const found = labels.find(e => e.value === text);
      assert.ok(found, `missing ${text}`);
      return parseFloat(String(found.font).replace('bold ', ''));
    });
  };
  try {
    const standard = renderLabels(100);
    assert.ok(Math.abs(standard[0] - 280 * 0.1 * 8 / 15) < 1e-9);
    assert.ok(Math.abs(standard[1] - 240 * 0.1 * 8 / 15) < 1e-9);
    const enlarged = renderLabels(150);
    assert.ok(Math.abs(enlarged[0] / standard[0] - 1.5) < 1e-9);
    assert.ok(Math.abs(enlarged[1] / standard[1] - 1.5) < 1e-9);
    const reduced = renderLabels(62.5);
    assert.ok(Math.abs(reduced[0] / standard[0] - 5 / 8) < 1e-9);
    assert.ok(Math.abs(reduced[1] / standard[1] - 5 / 8) < 1e-9);
  } finally {
    Object.assign(R.view, originalView);
    R.setLayer(originalLayer);
  }
});
