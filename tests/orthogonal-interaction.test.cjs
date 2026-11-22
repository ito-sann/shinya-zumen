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
for (const name of ['model', 'geometry', 'render', 'interactions']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js', name + '.js'), 'utf8'), context);
}
const { Model, Geometry, Render, Interactions } = win;
const p = (x, y) => ({ x, y });

function newProject() {
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
      if (key === 'fillText') return (value, x, y) => events.push({ type: 'text', value: String(value), x, y, color: obj.fillStyle });
      if (key === 'stroke') return () => events.push({ type: 'stroke', color: obj.strokeStyle, dash: dash.slice() });
      return key in obj ? obj[key] : () => {};
    },
    set(obj, key, value) { obj[key] = value; return true; },
  });
  return { ctx, events };
}
function attach(project, element, orthogonal) {
  const canvasHandlers = {};
  const canvas = {
    width: 800, height: 600, style: {},
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    addEventListener: (name, callback) => { canvasHandlers[name] = callback; },
    removeEventListener: name => { delete canvasHandlers[name]; },
  };
  const state = { selectedId: element.id, selectFilter: 'all', orthogonal };
  const { ctx } = recorder();
  let changed = 0, selected = null;
  Interactions.attach(canvas, ctx, project, state, () => { changed++; }, el => { selected = el; });
  return {
    state,
    click(worldPoint) {
      const screen = Render.worldToScreen(worldPoint.x, worldPoint.y);
      canvasHandlers.mousedown({ clientX: screen.x, clientY: screen.y });
    },
    move(worldPoint) {
      const screen = Render.worldToScreen(worldPoint.x, worldPoint.y);
      handlers.mousemove({ clientX: screen.x, clientY: screen.y });
    },
    release() { handlers.mouseup(); },
    get changed() { return changed; },
    get selected() { return selected; },
  };
}

for (const kind of ['line', 'wall', 'premise']) {
  test(`${kind}: choosing an edge and fixed endpoint does not move the drawing`, () => {
    const project = newProject();
    const points = [p(1000, 1000), p(5000, 1000), p(5000, 5000), p(1000, 5000)];
    const el = kind === 'line' ? Model.addPolyline(project, points, '#333', 'solid')
      : kind === 'wall' ? Model.addPolygonWall(project, points, 100)
      : Model.addPremise(project, points, 100, 'center');
    Render.setLayer('plan');
    const orthogonal = { id: el.id, scope: 'edge', picking: 'edge', edgeIndex: null,
      anchorIndex: null, preview: [p(1, 2), p(3, 4)], source: [p(3, 4)] };
    const session = attach(project, el, orthogonal);
    const before = JSON.stringify(project);
    session.click(p(5000, 3000));
    session.move(p(6500, 3200));
    session.release();
    assert.equal(orthogonal.edgeIndex, 1);
    assert.equal(orthogonal.picking, null);
    assert.equal(orthogonal.preview, null);
    assert.equal(orthogonal.source, null);
    assert.equal(session.selected, el);
    assert.ok(session.changed > 0);
    assert.equal(JSON.stringify(project), before, 'edge selection changed project geometry');

    orthogonal.picking = 'anchor';
    session.click(points[0]); // This is not an endpoint of the chosen edge.
    assert.equal(orthogonal.anchorIndex, null);
    assert.equal(orthogonal.picking, 'anchor');
    assert.match(orthogonal.message, /クリック/);
    session.click(points[2]);
    session.move(p(6000, 5500));
    session.release();
    assert.equal(orthogonal.anchorIndex, 2);
    assert.equal(orthogonal.picking, null);
    assert.equal(JSON.stringify(project), before, 'anchor selection moved a vertex');
  });
}

test('an exterior closing edge and its first endpoint can be picked', () => {
  const project = newProject();
  const points = [p(1000, 1000), p(5000, 1000), p(5000, 5000), p(1000, 5000)];
  const el = Model.addPremise(project, points, 100, 'center');
  const ortho = { id: el.id, scope: 'edge', picking: 'edge', edgeIndex: null, anchorIndex: null };
  const session = attach(project, el, ortho);
  const before = JSON.stringify(project);
  session.click(p(1000, 3000));
  assert.equal(ortho.edgeIndex, 3, 'the final-to-first edge should have the last index');
  ortho.picking = 'anchor';
  session.click(points[0]);
  assert.equal(ortho.anchorIndex, 0, 'the first vertex is an endpoint of the closing edge');
  assert.equal(JSON.stringify(project), before);
});

test('whole-object anchor picking allows any corner without modifying coordinates', () => {
  const project = newProject();
  const points = [p(1000, 1000), p(5000, 1000), p(5000, 5000), p(1000, 5000)];
  const el = Model.addPremise(project, points, 100, 'center');
  const ortho = { id: el.id, scope: 'all', picking: 'anchor', edgeIndex: null, anchorIndex: null };
  const session = attach(project, el, ortho);
  const before = JSON.stringify(project);
  session.click(points[3]);
  assert.equal(ortho.anchorIndex, 3);
  assert.equal(JSON.stringify(project), before);
});

test('correction preview, highlighted edge and vertex labels render only on screen', () => {
  const project = newProject();
  const original = [p(1000, 1000), p(4000, 2000), p(4000, 5000)];
  const el = Model.addPolyline(project, original, '#333', 'solid');
  const preview = [p(1000, 1000), p(4000, 1000), p(4000, 5000)];
  const state = { selectedId: el.id, orthogonal: {
    id: el.id, scope: 'edge', edgeIndex: 0, anchorIndex: 0, preview,
  } };
  const canvas = { width: 800, height: 600 };
  const before = JSON.stringify(project);
  Render.setLayer('plan');
  const screen = recorder();
  Render.render(screen.ctx, canvas, project, state);
  for (const name of ['P1', 'P2', 'P3']) assert.ok(screen.events.some(e => e.type === 'text' && e.value === name), name);
  assert.ok(screen.events.some(e => e.type === 'stroke' && e.color === '#f59e0b'), 'selected edge highlight missing');
  assert.ok(screen.events.some(e => e.type === 'stroke' && e.color === '#2563eb' && e.dash.join(',') === '7,5'), 'blue dashed preview missing');
  assert.ok(screen.events.some(e => e.type === 'text' && e.value === '4.00m' && e.color === '#1d4ed8'), 'preview edge length missing');
  assert.equal(JSON.stringify(project), before);
  const print = recorder();
  Render.render(print.ctx, canvas, project, state, { print: true });
  assert.ok(!print.events.some(e => e.type === 'text' && /^P[1-3]$/.test(e.value)), 'vertex labels leaked into print');
  assert.ok(!print.events.some(e => e.type === 'stroke' && (e.color === '#2563eb' || e.color === '#f59e0b')), 'preview leaked into print');
  assert.ok(!print.events.some(e => e.type === 'text' && e.color === '#1d4ed8'), 'preview lengths leaked into print');
  assert.equal(JSON.stringify(project), before);
});
