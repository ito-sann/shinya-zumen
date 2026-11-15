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

// Canvas の座標変換を再現し、描画された寸法値の位置を調べる。
function dimensionLabels(project, print = false) {
  const labels = [], stack = [];
  let matrix = [1, 0, 0, 1, 0, 0];
  const target = {
    save() { stack.push({ matrix: matrix.slice(), fillStyle: this.fillStyle, font: this.font, textBaseline: this.textBaseline }); },
    restore() { const prev = stack.pop(); matrix = prev.matrix; Object.assign(this, { fillStyle: prev.fillStyle, font: prev.font, textBaseline: prev.textBaseline }); },
    translate(x, y) { matrix[4] += matrix[0] * x + matrix[2] * y; matrix[5] += matrix[1] * x + matrix[3] * y; },
    rotate(a) {
      const [a0, b, c, d] = matrix, co = Math.cos(a), si = Math.sin(a);
      matrix[0] = a0 * co + c * si; matrix[1] = b * co + d * si;
      matrix[2] = c * co - a0 * si; matrix[3] = d * co - b * si;
    },
    fillText(text, x, y) {
      if (this.fillStyle === '#1565c0') labels.push({ text, x: matrix[0] * x + matrix[2] * y + matrix[4], y: matrix[1] * x + matrix[3] * y + matrix[5], baseline: this.textBaseline });
    },
    measureText(text) { return { width: String(text).length * 8 }; },
  };
  const ctx = new Proxy(target, { get(obj, key) { return key in obj ? obj[key] : () => {}; } });
  project.meta.showPaperFrame = false;
  project.meta.showNorthMark = false;
  R.setLayer('kyuseki');
  R.view.zoom = 0.1; R.view.offsetX = R.view.offsetY = 0;
  R.render(ctx, { width: 800, height: 600 }, project, { selectedId: null }, { print });
  return labels;
}

test('rectangle and triangle dimensions move independently on screen and print, without changing area', () => {
  for (const shape of ['rect', 'triangle']) {
    const project = M.defaultProject();
    const r = M.addRegion(project, 'kyakushitsu', 4000, 2000, shape);
    const area = G.regionAreaSqm(r);
    const original = dimensionLabels(project);
    assert.equal(original.find((p) => p.text === '4.00m').y, 335);
    assert.equal(original.find((p) => p.text === '2.00m').x, 65);
    r.dimWidthSide = 'top'; r.dimHeightSide = 'right';
    const screen = dimensionLabels(project), print = dimensionLabels(project, true);
    assert.equal(screen.find((p) => p.text === '4.00m').y, 65);
    assert.equal(screen.find((p) => p.text === '2.00m').x, 535);
    assert.equal(screen.find((p) => p.text === '4.00m').baseline, 'bottom');
    assert.equal(screen.find((p) => p.text === '2.00m').baseline, 'top');
    assert.deepEqual(print, screen);
    assert.equal(G.regionAreaSqm(r), area);
    const loaded = M.deserialize(M.serialize(project));
    assert.deepEqual(dimensionLabels(loaded), screen);
  }
});

test('trapezoid retains distinct upper and lower bases even if an invalid top setting is present', () => {
  const project = M.defaultProject();
  const r = M.addRegion(project, 'kyakushitsu', 4000, 2000, 'trapezoid', 3000);
  r.dimWidthSide = 'top'; r.dimHeightSide = 'right';
  const labels = dimensionLabels(project);
  assert.equal(labels.find((p) => p.text === '4.00m').y, 335);
  assert.equal(labels.find((p) => p.text === '3.00m').y, 65);
  assert.equal(labels.find((p) => p.text === '2.00m').x, 535);
});

test('chosen positions rotate with the region', () => {
  const project = M.defaultProject();
  const r = M.addRegion(project, 'kyakushitsu', 4000, 2000, 'rect');
  Object.assign(r, { dimWidthSide: 'top', dimHeightSide: 'right', rotation: 90 });
  const labels = dimensionLabels(project);
  const width = labels.find((p) => p.text === '4.00m');
  const height = labels.find((p) => p.text === '2.00m');
  assert.ok(Math.abs(width.x - 435) < 1e-8 && Math.abs(width.y - 200) < 1e-8);
  assert.ok(Math.abs(height.x - 300) < 1e-8 && Math.abs(height.y - 435) < 1e-8);
});

test('polygon reverses only the chosen edge, retains edits and resets after a vertex count change', () => {
  const project = M.defaultProject();
  const r = M.addPolygonRegion(project, 'kyakushitsu', [{ x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 2000 }, { x: 0, y: 2000 }]);
  const before = dimensionLabels(project), area = G.regionAreaSqm(r);
  r.polygonDimSides = { vertexCount: 4, reversed: [0] };
  const after = dimensionLabels(project);
  assert.ok(before[0].y < 0 && after[0].y > 0);
  assert.deepEqual(after.slice(1), before.slice(1));
  assert.equal(G.regionAreaSqm(r), area);
  assert.deepEqual(dimensionLabels(M.deserialize(M.serialize(project)), true), after);
  r.points.push({ x: 0, y: 1000 });
  assert.equal(M.deserialize(M.serialize(project)).regions[0].polygonDimSides, undefined);
  M.normalizePolygon(r);
  assert.equal(r.polygonDimSides, undefined);
});
