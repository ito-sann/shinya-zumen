const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = vm.createContext({ window: {} });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/orthogonal.js'), 'utf8'), context);
const O = context.window.Orthogonal;
const p = (x, y) => ({ x, y });
const len = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
function near(a, b, message = '') { assert.ok(Math.abs(a - b) < 1e-7, `${message}: ${a} != ${b}`); }
function samePoint(actual, expected) { near(actual.x, expected.x, 'x'); near(actual.y, expected.y, 'y'); }
function pointSnapshot(points) { return JSON.stringify(points); }

test('single edge keeps either chosen endpoint and preserves length when requested', () => {
  const pts = [p(1, 2), p(4, 6)];
  const before = pointSnapshot(pts);
  let result = O.adjustEdge(pts, { edgeIndex: 0, anchorIndex: 0, axis: 'horizontal', preserveLength: true });
  assert.ok(result.ok, result.message);
  samePoint(result.points[0], pts[0]);
  samePoint(result.points[1], p(6, 2));
  near(len(...result.points), 5);
  result = O.adjustEdge(pts, { edgeIndex: 0, anchorIndex: 1, axis: 'vertical', preserveLength: true });
  assert.ok(result.ok, result.message);
  samePoint(result.points[1], pts[1]);
  samePoint(result.points[0], p(4, 1));
  assert.equal(pointSnapshot(pts), before);
});

test('single edge projection moves its endpoint only as much as needed', () => {
  const pts = [p(1, 2), p(4, 6)];
  const result = O.adjustEdge(pts, { edgeIndex: 0, anchorIndex: 1, axis: 'horizontal', preserveLength: false });
  assert.ok(result.ok, result.message);
  samePoint(result.points[0], p(1, 6));
  samePoint(result.points[1], pts[1]);
  near(len(...result.points), 3);
});

test('turning a perfectly horizontal line allows both vertical directions', () => {
  const pts = [p(0, 0), p(3, 0)];
  for (const direction of [-1, 1]) {
    const result = O.adjustEdge(pts, { edgeIndex: 0, anchorIndex: 0, axis: 'vertical', preserveLength: true, direction });
    assert.ok(result.ok, result.message);
    samePoint(result.points[1], p(0, direction * 3));
  }
  const invalid = O.adjustEdge(pts, { edgeIndex: 0, anchorIndex: 0, axis: 'vertical', preserveLength: false });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, 'collapsed_edge');
});

test('choosing an interior vertex modifies its neighbouring segment but retains the connection', () => {
  const pts = [p(0, 0), p(4, 1), p(5, 5)];
  const result = O.adjustEdge(pts, { edgeIndex: 1, anchorIndex: 2, axis: 'vertical', preserveLength: false });
  assert.ok(result.ok, result.message);
  samePoint(result.points[1], p(5, 1));
  samePoint(result.points[0], pts[0]);
  samePoint(result.points[2], pts[2]);
});

test('closed outline includes its final-to-first edge and preserves unselected vertices', () => {
  const pts = [p(0, 0), p(5, 0), p(5, 4), p(1, 4)];
  const result = O.adjustEdge(pts, { closed: true, edgeIndex: 3, anchorIndex: 3, axis: 'vertical', preserveLength: false });
  assert.ok(result.ok, result.message);
  samePoint(result.points[0], p(1, 0));
  for (let i = 1; i < 4; i++) samePoint(result.points[i], pts[i]);
});

test('invalid selected endpoint, zero-length edges, and a collapsed projection leave the input untouched', () => {
  const pts = [p(0, 0), p(4, 0), p(4, 4), p(0, 4)];
  const before = pointSnapshot(pts);
  assert.equal(O.adjustEdge(pts, { edgeIndex: 0, anchorIndex: 2, axis: 'vertical' }).code, 'invalid_anchor');
  assert.equal(O.adjustEdge(pts, { edgeIndex: 0, anchorIndex: 0, axis: 'vertical' }).code, 'collapsed_edge');
  assert.equal(O.adjustAll([p(0, 0), p(0, 0)], { anchorIndex: 0 }).code, 'zero_edge');
  assert.equal(pointSnapshot(pts), before);
});

test('a single-edge correction that makes an exterior fold or collapse is rejected', () => {
  const pts = [p(0, 0), p(4, 0), p(4, 4), p(0, 4)];
  const before = pointSnapshot(pts);
  const result = O.adjustEdge(pts, { closed: true, edgeIndex: 1, anchorIndex: 2,
    axis: 'horizontal', preserveLength: true, direction: -1 });
  assert.equal(result.ok, false);
  assert.equal(pointSnapshot(pts), before);
});

test('open whole-line correction keeps any chosen anchor and all lengths when requested', () => {
  const pts = [p(0, 0), p(4, 1), p(5, 5), p(1, 6)];
  const before = pointSnapshot(pts);
  for (let anchorIndex = 0; anchorIndex < pts.length; anchorIndex++) {
    const result = O.adjustAll(pts, { anchorIndex, preserveLength: true, closed: false });
    assert.ok(result.ok, result.message);
    samePoint(result.points[anchorIndex], pts[anchorIndex]);
    for (let i = 0; i < pts.length - 1; i++) near(len(result.points[i], result.points[i + 1]), len(pts[i], pts[i + 1]));
    near(result.points[0].y, result.points[1].y);
    near(result.points[1].x, result.points[2].x);
    near(result.points[2].y, result.points[3].y);
  }
  assert.equal(pointSnapshot(pts), before);
});

test('whole-line correction with changeable lengths minimizes vertex displacement', () => {
  const pts = [p(0, 0), p(5, 1), p(6, 5)];
  const result = O.adjustAll(pts, { anchorIndex: 0, preserveLength: false, closed: false });
  assert.ok(result.ok, result.message);
  samePoint(result.points[0], p(0, 0));
  samePoint(result.points[1], p(5.5, 0));
  samePoint(result.points[2], p(5.5, 5));
});

test('whole exterior moves no anchor and closes all edges when lengths may change', () => {
  const pts = [p(0, 0), p(5, 0), p(4, 4), p(0, 4)];
  const before = pointSnapshot(pts);
  for (let anchorIndex = 0; anchorIndex < 4; anchorIndex++) {
    const result = O.adjustAll(pts, { closed: true, anchorIndex, preserveLength: false });
    assert.ok(result.ok, result.message);
    samePoint(result.points[anchorIndex], pts[anchorIndex]);
    for (let i = 0; i < 4; i++) {
      const a = result.points[i], b = result.points[(i + 1) % 4];
      assert.ok(Math.abs(a.x - b.x) < 1e-7 || Math.abs(a.y - b.y) < 1e-7);
      assert.ok(len(a, b) > 1e-6);
    }
  }
  assert.equal(pointSnapshot(pts), before);
});

test('skewed exterior cannot retain unequal opposite edge lengths under axis correction', () => {
  const pts = [p(0, 0), p(5, 0), p(4, 4), p(0, 4)];
  const before = pointSnapshot(pts);
  const result = O.adjustAll(pts, { closed: true, anchorIndex: 2, preserveLength: true });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'lengths_impossible');
  assert.equal(pointSnapshot(pts), before);
});

test('a rotated rectangle can be corrected while retaining every edge and an arbitrary corner', () => {
  const angle = Math.PI / 18, c = Math.cos(angle), s = Math.sin(angle);
  const pts = [p(0, 0), p(5, 0), p(5, 4), p(0, 4)].map((v) => p(v.x * c - v.y * s, v.x * s + v.y * c));
  const result = O.adjustAll(pts, { closed: true, anchorIndex: 2, preserveLength: true });
  assert.ok(result.ok, result.message);
  samePoint(result.points[2], pts[2]);
  for (let i = 0; i < 4; i++) near(len(result.points[i], result.points[(i + 1) % 4]), len(pts[i], pts[(i + 1) % 4]));
});

test('45 degree rectangle chooses compatible horizontal/vertical directions', () => {
  const angle = Math.PI / 4, c = Math.cos(angle), s = Math.sin(angle);
  const pts = [p(0, 0), p(5, 0), p(5, 4), p(0, 4)].map((v) => p(v.x * c - v.y * s, v.x * s + v.y * c));
  for (const preserveLength of [true, false]) {
    for (let anchorIndex = 0; anchorIndex < 4; anchorIndex++) {
      const result = O.adjustAll(pts, { closed: true, anchorIndex, preserveLength });
      assert.ok(result.ok, result.message);
      samePoint(result.points[anchorIndex], pts[anchorIndex]);
      for (let i = 0; i < 4; i++) {
        const a = result.points[i], b = result.points[(i + 1) % 4];
        assert.ok(Math.abs(a.x - b.x) < 1e-7 || Math.abs(a.y - b.y) < 1e-7);
        if (preserveLength) near(len(a, b), len(pts[i], pts[(i + 1) % 4]));
      }
    }
  }
});

test('an exterior that cannot remain nondegenerate after whole correction is rejected', () => {
  const pts = [p(0, 0), p(4, 0), p(2, 4)];
  const before = pointSnapshot(pts);
  for (const preserveLength of [true, false]) {
    const result = O.adjustAll(pts, { closed: true, anchorIndex: 0, preserveLength });
    assert.equal(result.ok, false);
    assert.equal(pointSnapshot(pts), before);
  }
});
