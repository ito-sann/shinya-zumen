const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const handlers = {};
const win = {
  addEventListener(name, callback) { handlers[name] = callback; },
  removeEventListener(name) { delete handlers[name]; },
};
const context = vm.createContext({ window: win });
for (const name of ['model', 'geometry', 'orthogonal', 'render', 'interactions']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js', name + '.js'), 'utf8'), context);
}
const { Model, Geometry, Orthogonal, Render, Interactions } = win;
const point = (x, y) => ({ x, y });
const plain = value => JSON.parse(JSON.stringify(value));

function projectWithoutSamples() {
  const project = Model.defaultProject();
  project.regions = [];
  project.meta.showPaperFrame = false;
  project.meta.showNorthMark = false;
  return project;
}

function recorder() {
  const events = [];
  let dash = [];
  const base = {
    measureText: value => ({ width: String(value).length * 8 }),
    setLineDash: value => { dash = Array.from(value); },
  };
  const ctx = new Proxy(base, {
    get(obj, key) {
      if (key === 'fillText') return (value, x, y) => events.push({ type: 'text', value: String(value), x, y, color: obj.fillStyle, font: obj.font });
      if (key === 'stroke') return () => events.push({ type: 'stroke', color: obj.strokeStyle, dash: dash.slice() });
      return key in obj ? obj[key] : () => {};
    },
    set(obj, key, value) { obj[key] = value; return true; },
  });
  return { ctx, events };
}

test('new manual dimensions default to 8 and saved explicit sizes and layer data are retained', () => {
  const project = projectWithoutSamples();
  const d = Model.addDimension(project, 1000, 2000, 4000, 6000, 'plan');
  assert.equal(d.fontSize, 8);
  assert.equal(d.showLength, false, 'default visibility remains unchanged');
  assert.deepEqual(plain(d.layers), ['plan']);

  const other = Model.addDimension(project, 2000, 1000, 5000, 1000, 'kyuseki');
  other.fontSize = 12;
  const loaded = Model.deserialize(Model.serialize(project));
  assert.equal(Model.findById(loaded, d.id).element.fontSize, 8);
  assert.equal(Model.findById(loaded, other.id).element.fontSize, 12);
  assert.deepEqual(plain(Model.findById(loaded, d.id).element.layers), ['plan']);
});

test('legacy dimensions without a font size render at 8 while explicit and old fontMm sizes survive', () => {
  const project = projectWithoutSamples();
  const newDim = Model.addDimension(project, 0, 0, 3000, 0, 'plan');
  const legacy = Model.addDimension(project, 0, 1000, 4000, 1000, 'plan');
  delete legacy.fontSize;
  const custom = Model.addDimension(project, 0, 2000, 5000, 2000, 'plan');
  custom.fontSize = 12;
  for (const d of [newDim, legacy, custom]) d.showLength = true;
  const fromOldMm = Model.addDimension(project, 0, 3000, 6000, 3000, 'plan');
  delete fromOldMm.fontSize;
  fromOldMm.fontMm = 192; // old dimension size: 192 / 240 * 15 = 12
  fromOldMm.showLength = true;
  const loaded = Model.deserialize(Model.serialize(project));
  assert.equal(Model.findById(loaded, custom.id).element.fontSize, 12);
  assert.equal(Model.findById(loaded, fromOldMm.id).element.fontSize, 12);

  const rec = recorder();
  Render.setLayer('plan');
  Render.render(rec.ctx, { width: 800, height: 600 }, loaded, { selectedId: null });
  const fontFor = text => {
    const item = rec.events.find(e => e.type === 'text' && e.value === text);
    assert.ok(item, `missing dimension label ${text}`);
    return item.font;
  };
  assert.equal(fontFor('3.00m'), fontFor('4.00m'), 'unset legacy size must match the new default');
  assert.equal(fontFor('5.00m'), fontFor('6.00m'), 'legacy fontMm must retain its explicit converted size');
  assert.ok(parseFloat(fontFor('5.00m')) > parseFloat(fontFor('3.00m')));
});

test('dimension correction can hold either chosen endpoint without mutating the original', () => {
  const project = projectWithoutSamples();
  const dimension = Model.addDimension(project, 1000, 1000, 4000, 5000, 'plan');
  const before = JSON.stringify(project);
  const source = Geometry.orthogonalPoints(dimension, 'dimensions');
  assert.deepEqual(plain(source), [point(1000, 1000), point(4000, 5000)]);
  for (const anchorIndex of [0, 1]) {
    for (const axis of ['horizontal', 'vertical']) {
      const result = Orthogonal.adjustEdge(source, { edgeIndex: 0, anchorIndex, axis, preserveLength: true });
      assert.ok(result.ok, result.message);
      assert.deepEqual(plain(result.points[anchorIndex]), plain(source[anchorIndex]));
      assert.ok(Math.abs(Math.hypot(result.points[1].x - result.points[0].x, result.points[1].y - result.points[0].y) - 5000) < 1e-6);
      if (axis === 'horizontal') assert.equal(result.points[0].y, result.points[1].y);
      else assert.equal(result.points[0].x, result.points[1].x);
    }
  }
  assert.equal(JSON.stringify(project), before);
});

test('one-click dimension correction chooses the nearest axis and retains length and midpoint', () => {
  for (const [a, b, expectedAxis] of [
    [point(1000, 2000), point(5000, 3000), 'horizontal'],
    [point(4000, 5000), point(3000, 1000), 'vertical'],
    [point(1000, 1000), point(4000, 4000), 'horizontal'],
    [point(4000, 2000), point(1000, 2000), 'horizontal'],
  ]) {
    const points = [a, b], before = JSON.stringify(points);
    const result = Orthogonal.autoAlignDimension(points);
    assert.ok(result.ok, result.message);
    assert.equal(result.axis, expectedAxis);
    const [c, d] = result.points;
    assert.ok(Math.abs(Math.hypot(d.x - c.x, d.y - c.y) - Math.hypot(b.x - a.x, b.y - a.y)) < 1e-7);
    assert.ok(Math.abs((a.x + b.x) / 2 - (c.x + d.x) / 2) < 1e-7);
    assert.ok(Math.abs((a.y + b.y) / 2 - (c.y + d.y) / 2) < 1e-7);
    if (expectedAxis === 'horizontal') assert.equal(c.y, d.y);
    else assert.equal(c.x, d.x);
    assert.equal(JSON.stringify(points), before);
  }
  assert.equal(Orthogonal.autoAlignDimension([point(1, 1), point(1, 1)]).ok, false);
});

test('one-click alignment also handles rotated two-point lines and walls without modifying them', () => {
  for (const kind of ['lines', 'walls']) {
    const project = projectWithoutSamples();
    const points = [point(1000, 1000), point(4000, 3000)];
    const el = kind === 'lines'
      ? Model.addPolyline(project, points, '#123456', 'dashed')
      : Model.addPolygonWall(project, points, 120);
    el.rotation = 37;
    const original = Geometry.orthogonalPoints(el, kind);
    const before = JSON.stringify(project);
    const result = Orthogonal.autoAlignTwoPoints(original);
    assert.ok(result.ok, result.message);
    const [a, b] = original, [c, d] = result.points;
    assert.ok(Math.abs(Math.hypot(d.x - c.x, d.y - c.y) - Math.hypot(b.x - a.x, b.y - a.y)) < 1e-7);
    assert.ok(Math.abs((a.x + b.x) / 2 - (c.x + d.x) / 2) < 1e-7);
    assert.ok(Math.abs((a.y + b.y) / 2 - (c.y + d.y) / 2) < 1e-7);
    assert.ok(c.x === d.x || c.y === d.y);
    assert.equal(JSON.stringify(project), before);
  }
});

test('picking a dimension endpoint on the canvas selects it without dragging or changing data', () => {
  const project = projectWithoutSamples();
  const dimension = Model.addDimension(project, 1000, 1000, 4000, 5000, 'plan');
  const canvasHandlers = {};
  const canvas = {
    width: 800, height: 600, style: {},
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    addEventListener: (name, callback) => { canvasHandlers[name] = callback; },
    removeEventListener: name => { delete canvasHandlers[name]; },
  };
  const orthogonal = { id: dimension.id, scope: 'edge', edgeIndex: 0, anchorIndex: null, picking: 'anchor' };
  const state = { selectedId: dimension.id, selectFilter: 'all', orthogonal };
  const { ctx } = recorder();
  let selected = null;
  Interactions.attach(canvas, ctx, project, state, () => {}, el => { selected = el; });
  const before = JSON.stringify(project);
  for (const [index, p] of [[0, point(1000, 1000)], [1, point(4000, 5000)]]) {
    orthogonal.picking = 'anchor';
    const s = Render.worldToScreen(p.x, p.y);
    canvasHandlers.mousedown({ clientX: s.x, clientY: s.y });
    const moved = Render.worldToScreen(p.x + 2000, p.y + 2000);
    handlers.mousemove({ clientX: moved.x, clientY: moved.y });
    handlers.mouseup();
    assert.equal(orthogonal.anchorIndex, index);
    assert.equal(orthogonal.picking, null);
    assert.equal(selected, dimension);
    assert.equal(JSON.stringify(project), before, 'picking must not move a dimension endpoint');
  }
});

test('dimension correction preview and endpoint markers appear only on screen', () => {
  const project = projectWithoutSamples();
  const dimension = Model.addDimension(project, 1000, 1000, 4000, 5000, 'plan');
  dimension.showLength = true;
  const state = { selectedId: dimension.id, orthogonal: {
    id: dimension.id, scope: 'edge', edgeIndex: 0, anchorIndex: 0,
    preview: [point(1000, 1000), point(6000, 1000)],
  } };
  const before = JSON.stringify(project);
  const canvas = { width: 800, height: 600 };
  Render.setLayer('plan');
  const screen = recorder();
  Render.render(screen.ctx, canvas, project, state);
  for (const name of ['P1', 'P2']) assert.ok(screen.events.some(e => e.type === 'text' && e.value === name), name);
  assert.ok(screen.events.some(e => e.type === 'stroke' && e.color === '#f59e0b'), 'selected edge highlight missing');
  assert.ok(screen.events.some(e => e.type === 'stroke' && e.color === '#2563eb' && e.dash.join(',') === '7,5'), 'blue dashed preview missing');
  const print = recorder();
  Render.render(print.ctx, canvas, project, state, { print: true });
  assert.ok(!print.events.some(e => e.type === 'text' && /^P[12]$/.test(e.value)));
  assert.ok(!print.events.some(e => e.type === 'stroke' && (e.color === '#2563eb' || e.color === '#f59e0b')));
  assert.equal(JSON.stringify(project), before, 'preview must not change persisted dimensions');
});
