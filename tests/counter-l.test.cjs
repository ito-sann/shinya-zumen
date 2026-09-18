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
const close = (actual, expected, message = '') => assert.ok(Math.abs(actual - expected) < 1e-6,
  `${message}: ${actual} != ${expected}`);
const pointClose = (actual, expected) => { close(actual.x, expected.x); close(actual.y, expected.y); };
const base = (extra = {}) => ({ kind: 'counterL', id: 'f1', label: 'L字カウンター',
  x: 1500, y: 2100, w: 2700, h: 1800, t: 600, height: 1000, rotation: 0, ...extra });
function world(f, x, y) {
  const a = f.rotation * Math.PI / 180, dx = x - f.w / 2, dy = y - f.h / 2;
  return { x: f.x + f.w / 2 + dx * Math.cos(a) - dy * Math.sin(a),
    y: f.y + f.h / 2 + dx * Math.sin(a) + dy * Math.cos(a) };
}

test('legacy dimensions and outline remain unchanged, including shallow old counters', () => {
  for (const [w, h, t] of [[4500, 900, 600], [2700, 1800, 600], [400, 200, 600]]) {
    for (const mirrorL of [false, true]) {
      const f = base({ w, h, t, mirrorL }), saved = plain(f), thickness = Math.min(t, w, h);
      assert.deepEqual(plain(G.counterLDimensions(f)), { w, h, tTop: thickness, tSide: thickness });
      const expected = [[0, 0], [w, 0], [w, thickness], [thickness, thickness], [thickness, h], [0, h]]
        .map(([x, y]) => ({ x: mirrorL ? w - x : x, y }));
      assert.deepEqual(plain(G.counterLPoints(f)), expected);
      assert.deepEqual(plain(f), saved, 'reading old data must not migrate it');
    }
  }
});

test('both arm thicknesses can be edited independently without moving the outer bounds', () => {
  const f = base(), before = { ...f };
  f.tTop = 450;
  G.normalizeCounterL(f, before);
  assert.equal(f.tTop, 450);
  assert.equal(f.tSide, 600);
  const next = { ...f };
  f.tSide = 750;
  G.normalizeCounterL(f, next);
  assert.equal(f.tTop, 450);
  assert.equal(f.tSide, 750);
  for (const key of ['x', 'y', 'w', 'h']) assert.equal(f[key], before[key]);
});

for (const rotation of [0, 90, 37]) {
  for (const mirrorL of [false, true]) {
    test(`all six handles extend and shrink without anchor drift (${rotation}°, mirror ${mirrorL})`, () => {
      const movements = [[-300, -200], [300, 0], [300, 100], [100, 100], [100, 200], [0, 200]];
      for (let index = 0; index < 6; index++) {
        for (const sign of [-1, 1]) {
          const start = base({ rotation, mirrorL }), f = { ...start };
          const corner = G.counterLPoints(start)[index];
          const dx = movements[index][0] * (mirrorL ? -1 : 1) * sign;
          const dy = movements[index][1] * sign;
          const target = world(start, corner.x + dx, corner.y + dy);
          G.resizeCounterL(f, start, index, target, 0);
          pointClose(G.counterLWorldPoints(f)[index], target);
          // Outer bend resize fixes the opposite bounding corner; other handles fix the bend.
          const anchorX = index === 0 ? (mirrorL ? 0 : start.w) : (mirrorL ? start.w : 0);
          const anchorY = index === 0 ? start.h : 0;
          const nextX = index === 0 ? (mirrorL ? 0 : f.w) : (mirrorL ? f.w : 0);
          pointClose(world(f, nextX, index === 0 ? f.h : 0), world(start, anchorX, anchorY));
          const after = plain(f);
          G.resizeCounterL(f, start, index, target, 0);
          assert.deepEqual(plain(f), after, 'repeated mousemove must not accumulate displacement');
          if (index === 3) for (const key of ['x', 'y', 'w', 'h']) close(f[key], start[key]);
        }
      }
    });
  }
}

test('dragging beyond the other edges keeps a nondegenerate right-angled L', () => {
  for (const mirrorL of [false, true]) {
    for (let i = 0; i < 6; i++) {
      for (const v of [-100000, 100000]) {
        const start = base({ mirrorL, rotation: 37 }), f = { ...start };
        G.resizeCounterL(f, start, i, world(start, v, v), 10);
        const d = G.counterLDimensions(f), points = G.counterLPoints(f);
        assert.ok(d.w > 0 && d.h > 0 && d.tTop > 0 && d.tSide > 0);
        assert.ok(d.tTop < d.h && d.tSide < d.w);
        for (let j = 0; j < 6; j++) {
          const p = points[j], q = points[(j + 1) % 6];
          assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
          assert.ok(p.x === q.x || p.y === q.y, 'every edge stays horizontal or vertical');
        }
      }
    }
  }
});

test('snapping uses millimetres even after rotation; free drag preserves fractional dimensions', () => {
  const start = base({ rotation: 37 }), target = world(start, 2737.25, 0);
  const snapped = { ...start }, free = { ...start };
  G.resizeCounterL(snapped, start, 1, target, 10);
  G.resizeCounterL(free, start, 1, target, 0);
  close(snapped.w, 2740);
  close(free.w, 2737.25);
});

test('save/load and duplication keep separate arm dimensions, mirror and rotation', () => {
  const project = M.defaultProject();
  const item = M.addFurniture(project, 'counterL');
  Object.assign(item, { tTop: 480, tSide: 720, rotation: 37, mirrorL: true });
  const copy = M.deserialize(M.serialize(project)).furniture.find((f) => f.id === item.id);
  for (const key of ['tTop', 'tSide', 'rotation', 'mirrorL']) assert.equal(copy[key], item[key]);
  const duplicate = M.duplicateElement(project, item.id);
  for (const key of ['tTop', 'tSide', 'rotation', 'mirrorL']) assert.equal(duplicate[key], item[key]);
});

test('different L outlines get separate numbers; equivalent legacy and explicit dimensions group together', () => {
  const old = base(), same = base({ id: 'f2', tTop: 600, tSide: 600 });
  assert.equal(G.furnKey(old), G.furnKey(same));
  for (const variant of [{ tTop: 400 }, { tSide: 400 }, { mirrorL: true }]) {
    assert.notEqual(G.furnKey(old), G.furnKey(base(variant)));
  }
  const project = M.defaultProject();
  project.furniture = [old, same, base({ id: 'f3', tTop: 400 })];
  assert.deepEqual(plain(G.furnitureNumberMap(project)), { f1: 1, f2: 1, f3: 2 });
});

test('legacy mirrored or nonstandard counters retain saved furniture-view positions', () => {
  for (const extra of [{ mirrorL: true }, { t: 450 }]) {
    const project = M.defaultProject(), item = base(extra);
    project.furniture = [item];
    delete project.meta.counterLLayoutVersion;
    const oldKey = 'counterL|2700|1800|1000|std';
    project.meta.furnViewPos = { [oldKey]: { x: 12500, y: 7000 } };
    const loaded = M.deserialize(M.serialize(project));
    assert.deepEqual(plain(loaded.meta.furnViewPos[G.furnKey(item)]), { x: 12500, y: 7000 });
    assert.equal(M.serialize(M.deserialize(M.serialize(loaded))), M.serialize(loaded), 'migration is idempotent');
  }
});
