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
const plain = (value) => JSON.parse(JSON.stringify(value));
const rectangle = (x, y, w, h) => [
  { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
];
const addMain = (project) => M.addPremise(project, rectangle(0, 0, 6000, 4000), 100, 'center');
const addToilet = (project) => M.addPremise(project, rectangle(500, 500, 1200, 2000), 150, 'inner');

test('drawing additional outlines preserves the existing business exterior and makes each selectable', () => {
  const project = M.defaultProject();
  const main = addMain(project), original = plain(main);
  const toilet = addToilet(project);
  const third = M.addPremise(project, rectangle(3000, 500, 1000, 1000), 80, 'center');
  assert.equal(project.premise, main);
  assert.deepEqual(plain(main), original);
  assert.deepEqual(plain(M.premiseOutlines(project).map((p) => p.label)), ['営業所外周', '外周2', '外周3']);
  assert.equal(new Set(M.premiseOutlines(project).map((p) => p.id)).size, 3);
  for (const outline of [main, toilet, third]) {
    const selected = M.findById(project, outline.id);
    assert.equal(selected.kind, 'premise');
    assert.equal(selected.element, outline);
  }
  assert.equal(toilet.wallThickness, 150);
  assert.equal(toilet.measuredAt, 'inner');
});

test('deleting an additional outline leaves the main and the other outlines intact', () => {
  const project = M.defaultProject();
  const main = addMain(project), toilet = addToilet(project), other = addToilet(project);
  assert.equal(M.removeById(project, toilet.id), true);
  assert.equal(M.findById(project, toilet.id), null);
  assert.equal(project.premise, main);
  assert.deepEqual(plain(M.premiseOutlines(project).map((p) => p.id)), [main.id, other.id]);
  assert.equal(M.removeById(project, toilet.id), false);
});

test('deleting the main never turns a toilet outline into the business area', () => {
  const project = M.defaultProject();
  const main = addMain(project), toilet = addToilet(project);
  assert.equal(M.removeById(project, main.id), true);
  assert.equal(project.premise, null);
  assert.equal(M.findById(project, toilet.id).element, toilet);
  assert.deepEqual(plain(M.premiseOutlines(project).map((p) => p.id)), [toilet.id]);
  const replacement = addMain(project);
  assert.equal(replacement.id, 'premise');
  assert.equal(project.premise, replacement);
  assert.equal(project.additionalPremises[0], toilet);
});

test('duplicating either kind of outline makes an independent additional outline', () => {
  const project = M.defaultProject();
  const main = addMain(project), toilet = addToilet(project);
  Object.assign(toilet, { label: 'トイレ', lineColor: '#112233', lineStyle: 'dashed', showLengths: false });
  const mainCopy = M.duplicateElement(project, main.id);
  assert.equal(mainCopy.label, '外周3');
  const toiletCopy = M.duplicateElement(project, toilet.id);
  assert.equal(project.premise, main);
  assert.equal(project.additionalPremises.length, 3);
  assert.equal(new Set(M.premiseOutlines(project).map((p) => p.id)).size, 4);
  assert.equal(toiletCopy.label, 'トイレ');
  for (const key of ['wallThickness', 'measuredAt', 'lineColor', 'lineStyle', 'showLengths']) {
    assert.equal(toiletCopy[key], toilet[key]);
  }
  assert.equal(toiletCopy.x, toilet.x + 300);
  assert.equal(toiletCopy.y, toilet.y + 300);
  toiletCopy.points[0].x += 50;
  assert.notEqual(toiletCopy.points[0].x, toilet.points[0].x);
  M.removeById(project, main.id);
  const orphanCopy = M.duplicateElement(project, toilet.id);
  assert.equal(project.premise, null);
  assert.equal(project.additionalPremises.at(-1), orphanCopy);
});

test('multiple outlines and styling survive JSON save/load with stable IDs', () => {
  const project = M.defaultProject();
  addMain(project);
  const toilet = addToilet(project);
  Object.assign(toilet, { label: 'トイレ', wallThickness: 220, lineColor: '#123456', lineStyle: 'dashed' });
  const loaded = M.deserialize(M.serialize(project));
  assert.deepEqual(plain(M.premiseOutlines(loaded)), plain(M.premiseOutlines(project)));
  assert.equal(M.serialize(M.deserialize(M.serialize(loaded))), M.serialize(loaded));
  // A stale sequence in a manually edited/older save must not create duplicate selection IDs.
  loaded._seq = 1;
  const added = addToilet(loaded), duplicated = M.duplicateElement(loaded, toilet.id);
  assert.notEqual(added.id, toilet.id);
  assert.notEqual(duplicated.id, added.id);
  assert.equal(new Set(M.premiseOutlines(loaded).map((p) => p.id)).size, 4);
});

test('legacy single-outline data loads unchanged and remains editable', () => {
  const project = M.defaultProject();
  const main = M.setPremise(project, rectangle(-200, -300, 6000, 4000), 120, 'inner');
  main.lineColor = '#1d4ed8';
  delete project.additionalPremises;
  const oldMain = plain(main), oldArea = G.premiseCalc(main).total;
  const loaded = M.deserialize(M.serialize(project));
  assert.deepEqual(plain(loaded.premise), oldMain);
  assert.deepEqual(plain(loaded.additionalPremises), []);
  assert.equal(G.premiseCalc(loaded.premise).total, oldArea);
  assert.equal(M.findById(loaded, 'premise').element, loaded.premise);
  assert.equal(G.premiseRegionLike(loaded.premise).id, 'premise-centerline');
  addToilet(loaded);
  assert.deepEqual(plain(loaded.premise), oldMain);
});

test('the legacy setter replaces only the main, leaving additional outlines alone', () => {
  const project = M.defaultProject();
  addMain(project);
  const toilet = addToilet(project);
  const replacement = M.setPremise(project, rectangle(0, 0, 8000, 5000), 200, 'center');
  assert.equal(project.premise, replacement);
  assert.equal(replacement.id, 'premise');
  assert.equal(project.additionalPremises[0], toilet);
  assert.equal(G.premiseCalc(replacement).total, 40);
});

test('fit-to-view includes additional outlines and keeps working without the main', () => {
  const project = M.defaultProject();
  addMain(project);
  const distant = M.addPremise(project, rectangle(10000, -3000, 2000, 1000), 200, 'inner');
  assert.deepEqual(plain(G.boundingBox(project)), { x: -100, y: -3200, w: 12300, h: 7300 });
  M.removeById(project, 'premise');
  assert.deepEqual(plain(G.boundingBox(project)), { x: 9800, y: -3200, w: 2400, h: 1400 });
  assert.equal(G.premiseRegionLike(distant).id, distant.id + '-centerline');
});

test('toilet wall outlines do not inflate the main centerline area or region totals', () => {
  const project = M.defaultProject();
  const main = addMain(project);
  M.addRegion(project, 'kyakushitsu', 6000, 4000, 'rect');
  const summary = plain(G.summary(project));
  addToilet(project);
  M.duplicateElement(project, 'premise');
  assert.equal(G.premiseCalc(project.premise).total, 24);
  assert.equal(project.premise, main);
  assert.deepEqual(plain(G.summary(project)), summary);
});

test('centerlines are hidden in new projects and legacy saves without changing outlines or areas', () => {
  const project = M.defaultProject();
  assert.equal(project.meta.showPremiseCenterlines, false);
  addMain(project);
  addToilet(project);
  const outlines = plain(M.premiseOutlines(project)), summary = plain(G.summary(project));
  delete project.meta.showPremiseCenterlines;
  const loaded = M.deserialize(M.serialize(project));
  assert.equal(loaded.meta.showPremiseCenterlines, false);
  assert.deepEqual(plain(M.premiseOutlines(loaded)), outlines);
  assert.deepEqual(plain(G.summary(loaded)), summary);
});

test('centerline visibility survives saving, loading, and repeated loading in either state', () => {
  for (const visible of [true, false]) {
    const project = M.defaultProject();
    project.meta.showPremiseCenterlines = visible;
    addMain(project);
    addToilet(project);
    const saved = M.serialize(project), loaded = M.deserialize(saved);
    assert.equal(loaded.meta.showPremiseCenterlines, visible);
    assert.deepEqual(plain(M.premiseOutlines(loaded)), plain(M.premiseOutlines(project)));
    assert.equal(M.deserialize(M.serialize(loaded)).meta.showPremiseCenterlines, visible);
  }
});

test('only the explicit boolean true enables centerlines when loading a save', () => {
  for (const value of [null, 0, 1, '', 'false', 'true', [], {}]) {
    const project = M.defaultProject();
    project.meta.showPremiseCenterlines = value;
    assert.equal(M.deserialize(M.serialize(project)).meta.showPremiseCenterlines, false,
      `invalid saved visibility ${JSON.stringify(value)} must stay hidden`);
  }
});

// Record the actual Canvas stroke commands, including saved drawing styles, so
// these tests distinguish the centerline from both physical wall outlines.
function recordingCanvas() {
  const strokes = [], stack = [];
  let currentPath = [];
  const ctx = {
    strokeStyle: '#000', lineWidth: 1, globalAlpha: 1, dash: [],
    save() {
      stack.push({ strokeStyle: this.strokeStyle, lineWidth: this.lineWidth,
        globalAlpha: this.globalAlpha, dash: [...this.dash] });
    },
    restore() { Object.assign(this, stack.pop()); },
    beginPath() { currentPath = []; },
    moveTo(x, y) { currentPath.push(['moveTo', x, y]); },
    lineTo(x, y) { currentPath.push(['lineTo', x, y]); },
    closePath() { currentPath.push(['closePath']); },
    setLineDash(dash) { this.dash = Array.from(dash); },
    stroke() {
      strokes.push({ color: this.strokeStyle, width: this.lineWidth, alpha: this.globalAlpha,
        dash: [...this.dash], path: currentPath.map((command) => [...command]) });
    },
    fillRect() {},
  };
  return { ctx, strokes, canvas: { width: 800, height: 600 } };
}

const centerlineColors = ['#1234ab', '#ab3412'];
function renderOutlines(project, layer, print) {
  const { ctx, canvas, strokes } = recordingCanvas();
  R.setLayer(layer);
  R.render(ctx, canvas, project, { selectedId: null }, { print });
  return {
    centerlines: strokes.filter((stroke) => centerlineColors.includes(stroke.color)),
    walls: strokes.filter((stroke) => stroke.color === '#000'),
  };
}

for (const layer of ['plan', 'kyuseki', 'lighting']) {
  for (const print of [false, true]) {
    test(`centerline off/on/off preserves both walls and geometry on ${layer} (${print ? 'print' : 'screen'})`, () => {
      const project = M.defaultProject();
      project.meta.showPaperFrame = false;
      const outlines = [addMain(project), addToilet(project)];
      outlines.forEach((outline, i) => { outline.lineColor = centerlineColors[i]; });
      const geometry = plain(M.premiseOutlines(project)), summary = plain(G.summary(project));
      const expectedCenterlines = outlines.map((outline, i) => {
        const region = G.premiseRegionLike(outline);
        return { color: centerlineColors[i], path: [
          ...Array.from(region.points, (point, j) => {
            const p = R.worldToScreen(region.x + point.x, region.y + point.y);
            return [j === 0 ? 'moveTo' : 'lineTo', p.x, p.y];
          }),
          ['closePath'],
        ] };
      });
      let originalWalls;
      for (const visible of [false, true, false]) {
        project.meta.showPremiseCenterlines = visible;
        const rendered = renderOutlines(project, layer, print);
        const shouldShow = visible && layer !== 'lighting';
        assert.deepEqual(rendered.centerlines.map(({ color, path }) => ({ color, path })),
          shouldShow ? expectedCenterlines : [], `centerline visibility is ${visible}`);
        assert.equal(rendered.walls.length, 4, 'both inner and outer edges of both rooms remain visible');
        if (!originalWalls) originalWalls = rendered.walls;
        assert.deepEqual(rendered.walls, originalWalls, 'toggling cannot alter wall paths or styles');
        assert.deepEqual(plain(M.premiseOutlines(project)), geometry, 'rendering cannot change room geometry');
        assert.deepEqual(plain(G.summary(project)), summary, 'area totals are independent of visibility');
      }
      assert.equal(G.premiseCalc(project.premise).total, 24);
    });
  }
}
