const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = vm.createContext({ window: {} });
for (const name of ['model', 'geometry', 'render', 'interactions']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js', name + '.js'), 'utf8'), context);
}
const { Model: M, Geometry: G, Render: R, Interactions: I } = context.window;
const plain = (value) => JSON.parse(JSON.stringify(value));

test('every equipment kind starts at 100%, including legacy saves without a size', () => {
  const project = M.defaultProject();
  for (const kind of Object.keys(M.FIXTURE_CATALOG)) {
    const fixture = M.addFixture(project, kind);
    assert.equal(fixture.symbolScale, 1);
    delete fixture.symbolScale;
    assert.equal(M.fixtureSymbolScale(fixture), 1);
  }
  const loaded = M.deserialize(M.serialize(project));
  assert.equal(loaded.fixtures.length, Object.keys(M.FIXTURE_CATALOG).length);
  for (const fixture of loaded.fixtures) assert.equal(fixture.symbolScale, 1);
});

test('unusable saved sizes fall back to 100% and positive sizes stay within 25–300%', () => {
  assert.equal(M.fixtureSymbolScale(), 1);
  for (const value of [undefined, null, '', '0.5', false, NaN, Infinity, -Infinity, 0, -1]) {
    assert.equal(M.fixtureSymbolScale({ symbolScale: value }), 1, String(value));
  }
  const project = M.defaultProject();
  for (const [value, expected] of [[0.01, 0.25], [0.25, 0.25], [0.5, 0.5], [2, 2], [3, 3], [20, 3]]) {
    const fixture = M.addFixture(project, 'spotlight');
    fixture.symbolScale = value;
    assert.equal(M.fixtureSymbolScale(fixture), expected);
    const loaded = M.deserialize(M.serialize(project));
    assert.equal(loaded.fixtures.at(-1).symbolScale, expected);
  }
});

test('sizes survive save/load and duplication without changing equipment counts or attributes', () => {
  const project = M.defaultProject();
  const fixture = M.addFixture(project, 'speaker');
  Object.assign(fixture, { x: -1000, y: 3000, label: '天井スピーカー', branch: 'A', watt: '30', model: 'S1' });
  const summary = plain(G.fixtureSummary(project));
  fixture.symbolScale = 0.5;
  assert.deepEqual(plain(G.fixtureSummary(project)), summary);
  const loaded = M.deserialize(M.serialize(project));
  assert.deepEqual(plain(loaded.fixtures[0]), plain(fixture));
  const copy = M.duplicateElement(loaded, fixture.id);
  assert.notEqual(copy.id, fixture.id);
  assert.equal(copy.x, fixture.x + 300);
  assert.equal(copy.y, fixture.y + 300);
  for (const key of ['symbolScale', 'kind', 'label', 'branch', 'watt', 'model']) {
    assert.equal(copy[key], fixture[key]);
  }
  assert.equal(G.fixtureSummary(loaded)[0].count, 2);
  assert.equal(M.serialize(M.deserialize(M.serialize(loaded))), M.serialize(loaded));
});

test('fit-to-view bounds contain the outer edges of differently sized equipment symbols', () => {
  const project = M.defaultProject();
  const large = M.addFixture(project, 'spotlight');
  Object.assign(large, { x: -1000, y: -2000, symbolScale: 3 });
  const small = M.addFixture(project, 'speaker');
  Object.assign(small, { x: 1000, y: 2000, symbolScale: 0.5 });
  assert.deepEqual(plain(G.boundingBox(project)), { x: -1660, y: -2660, w: 2770, h: 4770 });
  project.meta.showPaperFrame = false;
  R.setLayer('lighting');
  const canvas = { width: 800, height: 600 };
  R.fitToView(project, canvas);
  for (const [x, y] of [[-1660, -2660], [1110, 2110]]) {
    const p = R.worldToScreen(x, y);
    assert.ok(p.x > 0 && p.x < canvas.width);
    assert.ok(p.y > 0 && p.y < canvas.height);
  }
});

test('large symbols are selectable at their edges and tiny symbols retain a usable click target', () => {
  const project = M.defaultProject();
  const fixture = M.addFixture(project, 'spotlight');
  Object.assign(fixture, { x: 0, y: 0, symbolScale: 3 });
  R.setLayer('lighting');
  R.view.zoom = 0.1;
  assert.equal(I.hitTest(project, 650, 0), fixture);
  assert.equal(I.hitTest(project, 850, 0), null);
  fixture.symbolScale = 1;
  assert.equal(I.hitTest(project, 650, 0), null);
  fixture.symbolScale = 0.25;
  assert.equal(I.hitTest(project, 100, 0), fixture); // 10px from center, beyond the small circle.
  assert.equal(I.hitTest(project, 130, 0), null);
  R.setLayer('plan');
  assert.equal(I.hitTest(project, 0, 0), null);
});

function recordEquipment(project, selectedId, print) {
  const arcs = [], labels = [], stack = [];
  const ctx = {
    fillStyle: '', strokeStyle: '', font: '',
    save() { stack.push({ fillStyle: this.fillStyle, strokeStyle: this.strokeStyle, font: this.font }); },
    restore() { Object.assign(this, stack.pop()); },
    arc(x, y, radius) { arcs.push({ x, y, radius }); },
    fill() { if (arcs.length) arcs.at(-1).fill = this.fillStyle; },
    fillText(text, x, y) { labels.push({ text, x, y, font: this.font }); },
    measureText(text) { return { width: String(text).length * 8 }; },
  };
  for (const name of ['beginPath', 'closePath', 'moveTo', 'lineTo', 'stroke', 'fillRect', 'strokeRect', 'setLineDash']) {
    ctx[name] = () => {};
  }
  R.setLayer('lighting');
  R.view.zoom = 0.1;
  R.view.offsetX = R.view.offsetY = 0;
  R.render(ctx, { width: 800, height: 600 }, project, { selectedId }, { print });
  return { arcs, labels };
}

test('screen and print scale the circle and its symbol together, while print omits selection color', () => {
  const project = M.defaultProject();
  project.meta.showPaperFrame = false;
  const fixture = M.addFixture(project, 'spotlight');
  fixture.symbolScale = 0.5;
  const screen = recordEquipment(project, fixture.id, false);
  const print = recordEquipment(project, fixture.id, true);
  assert.equal(screen.arcs[0].radius, 11);
  assert.equal(print.arcs[0].radius, 11);
  assert.equal(screen.arcs[0].fill, '#ffe082');
  assert.equal(print.arcs[0].fill, '#fff8e1');
  assert.equal(screen.labels.find((label) => label.text === 'SP').font, 'bold 8.5px sans-serif');
  assert.equal(print.labels.find((label) => label.text === 'SP').font, 'bold 8.5px sans-serif');
  fixture.symbolScale = 2;
  const larger = recordEquipment(project, null, false);
  assert.equal(larger.arcs[0].radius, 44);
  assert.equal(larger.labels.find((label) => label.text === 'SP').font, 'bold 34px sans-serif');
});
