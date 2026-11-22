const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const handlers = {};
const win = { addEventListener: (name, fn) => { handlers[name] = fn; }, removeEventListener() {} };
const context = vm.createContext({ window: win });
for (const name of ['model', 'geometry', 'render', 'interactions']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js', name + '.js'), 'utf8'), context);
}
const { Model, Render, Interactions, Geometry } = win;
const p = (x, y) => ({ x, y });

function canvasRecorder() {
  const labels = [];
  const base = {
    measureText: text => ({ width: String(text).length * 8 }),
    fillText: text => labels.push(text),
    setLineDash() {},
  };
  const ctx = new Proxy(base, { get: (obj, key) => key in obj ? obj[key] : () => {}, set: (obj, key, val) => { obj[key] = val; return true; } });
  return { ctx, labels };
}

for (const kind of ['line', 'wall', 'premise']) {
  test(`${kind}: selection displays edge lengths and keeps them updated after dragging`, () => {
    const project = Model.defaultProject();
    project.regions = [];
    project.meta.showPaperFrame = false;
    const points = [p(0, 0), p(3000, 0), p(3000, 4000)];
    const el = kind === 'line' ? Model.addPolyline(project, points, '#333', 'solid')
      : kind === 'wall' ? Model.addPolygonWall(project, points, 100)
      : Model.addPremise(project, points, 100, 'center');
    const state = { selectedId: el.id, selectFilter: 'all' };
    const canvas = { width: 800, height: 600, style: {}, getBoundingClientRect: () => ({ left: 0, top: 0 }),
      addEventListener: (name, fn) => { handlers[`canvas:${name}`] = fn; }, removeEventListener() {} };
    const { ctx, labels } = canvasRecorder();
    Render.setLayer('plan');
    Render.render(ctx, canvas, project, state);
    assert.ok(labels.includes('3.00m'));
    assert.ok(labels.includes('4.00m'));
    if (kind === 'premise') assert.ok(labels.includes('5.00m'));
    Interactions.attach(canvas, ctx, project, state, () => {}, () => {});
    const vertex = Render.worldToScreen(...Object.values(Geometry.polygonAbsPoints(el)[0]));
    handlers['canvas:mousedown']({ clientX: vertex.x, clientY: vertex.y });
    assert.ok(state.vertexMeasurement);
    const moved = Render.worldToScreen(0, -1000);
    handlers.mousemove({ clientX: moved.x, clientY: moved.y });
    labels.length = 0;
    Render.render(ctx, canvas, project, state);
    assert.ok(labels.includes('3.16m'), `moved edge missing: ${labels}`);
    if (kind === 'premise') assert.ok(labels.includes('5.83m'), `closing edge missing: ${labels}`);
    else assert.ok(!labels.includes('5.83m'));
    handlers.mouseup();
    assert.equal(state.vertexMeasurement, null);
    labels.length = 0;
    Render.render(ctx, canvas, project, state);
    assert.ok(labels.includes('3.16m'));
    state.selectedId = null;
    labels.length = 0;
    Render.render(ctx, canvas, project, state);
    assert.ok(!labels.includes('3.16m'));
    state.selectedId = el.id;
    labels.length = 0;
    Render.render(ctx, canvas, project, state, { print: true });
    assert.ok(!labels.includes('3.16m'));
  });
}

test('a middle polyline vertex displays both neighboring lengths', () => {
  const project = Model.defaultProject(); project.regions = []; project.meta.showPaperFrame = false;
  const el = Model.addPolyline(project, [p(0, 0), p(3000, 0), p(3000, 4000)], '#333', 'solid');
  const { ctx, labels } = canvasRecorder();
  Render.setLayer('plan');
  Render.render(ctx, { width: 800, height: 600 }, project,
    { selectedId: el.id, vertexMeasurement: { id: el.id, kind: 'lines', index: 1 } });
  assert.ok(labels.includes('3.00m'));
  assert.ok(labels.includes('4.00m'));
});
