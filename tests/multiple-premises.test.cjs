const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = vm.createContext({ window: {} });
for (const name of ['model', 'geometry']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js', name + '.js'), 'utf8'), context);
}
const { Model: M, Geometry: G } = context.window;
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
