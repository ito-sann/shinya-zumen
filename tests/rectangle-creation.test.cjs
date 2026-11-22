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
