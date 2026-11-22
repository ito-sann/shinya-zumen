/* 水平・垂直補正。すべてワールド座標(mm)で計算し、入力は変更しない。 */
(function (global) {
  'use strict';

  const MIN_EDGE = 0.000001;
  const COORD_EPS = 0.0000001;

  function failure(code, message) { return { ok: false, code, message }; }
  function copyPoints(points) { return points.map((p) => ({ x: p.x, y: p.y })); }
  function distance(a, b) { return Math.hypot(b.x - a.x, b.y - a.y); }
  function closeEnough(a, b, scale) {
    return Math.abs(a - b) <= Math.max(0.0000001, scale * 0.000000001);
  }
  function validInput(points, closed) {
    if (!Array.isArray(points) || points.length < (closed ? 3 : 2) ||
        points.some((p) => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) {
      return failure('invalid_points', '図形の点を読み取れないため補正できません。');
    }
    const count = closed ? points.length : points.length - 1;
    for (let i = 0; i < count; i++) {
      if (distance(points[i], points[(i + 1) % points.length]) <= MIN_EDGE) {
        return failure('zero_edge', '長さが0の辺があるため補正できません。');
      }
    }
    return null;
  }
  function cross(a, b, c) {
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  }
  function orientation(a, b, c) {
    const value = cross(a, b, c);
    const tolerance = COORD_EPS * Math.max(1, distance(a, b), distance(a, c));
    return value > tolerance ? 1 : value < -tolerance ? -1 : 0;
  }
  function onSegment(a, b, p) {
    return p.x >= Math.min(a.x, b.x) - COORD_EPS && p.x <= Math.max(a.x, b.x) + COORD_EPS &&
      p.y >= Math.min(a.y, b.y) - COORD_EPS && p.y <= Math.max(a.y, b.y) + COORD_EPS;
  }
  function intersects(a, b, c, d) {
    const o1 = orientation(a, b, c), o2 = orientation(a, b, d);
    const o3 = orientation(c, d, a), o4 = orientation(c, d, b);
    if (o1 * o2 < 0 && o3 * o4 < 0) return true;
    return (!o1 && onSegment(a, b, c)) || (!o2 && onSegment(a, b, d)) ||
      (!o3 && onSegment(c, d, a)) || (!o4 && onSegment(c, d, b));
  }
  function signedArea(points) {
    // 原点からの距離が大きくても桁落ちしにくいよう最初の頂点を基準にする。
    const base = points[0];
    let area2 = 0;
    for (let i = 1; i < points.length - 1; i++) area2 += cross(base, points[i], points[i + 1]);
    return area2;
  }
  function simpleOutline(points) {
    const n = points.length;
    if (Math.abs(signedArea(points)) <= MIN_EDGE * MIN_EDGE) return false;
    for (let i = 0; i < n; i++) {
      const a = points[i], b = points[(i + 1) % n], c = points[(i + 2) % n];
      if (distance(a, b) <= MIN_EDGE) return false;
      // 隣り合う辺が折り返して重なる形も認めない。
      if (orientation(a, b, c) === 0 &&
          (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y) < 0) return false;
      for (let j = i + 1; j < n; j++) {
        if (j === i + 1 || (i === 0 && j === n - 1)) continue;
        if (intersects(a, b, points[j], points[(j + 1) % n])) return false;
      }
    }
    return true;
  }
  function validateResult(original, result, closed) {
    const invalid = validInput(result, closed);
    if (invalid) return failure('invalid_result', '補正すると長さが0の辺ができるため、適用できません。');
    if (closed && (!simpleOutline(result) ||
        signedArea(original) * signedArea(result) <= 0)) {
      return failure('invalid_outline', '補正すると外周が交差・重複するか、形が反転するため適用できません。');
    }
    return null;
  }
  function correctEdge(points, options) {
    options = options || {};
    const closed = options.closed === true;
    const invalid = validInput(points, closed);
    if (invalid) return invalid;
    const edgeCount = closed ? points.length : points.length - 1;
    const i = options.edgeIndex;
    if (!Number.isInteger(i) || i < 0 || i >= edgeCount ||
        (options.axis !== 'horizontal' && options.axis !== 'vertical')) {
      return failure('invalid_edge', '補正する辺と向きを選択してください。');
    }
    const j = (i + 1) % points.length;
    if (options.anchorIndex !== i && options.anchorIndex !== j) {
      return failure('invalid_anchor', '選んだ辺の動かしたくない端を選択してください。');
    }
    const fixed = options.anchorIndex, moving = fixed === i ? j : i;
    const origin = points[fixed], old = points[moving];
    const dx = old.x - origin.x, dy = old.y - origin.y;
    const length = Math.hypot(dx, dy);
    const isHorizontal = options.axis === 'horizontal';
    const component = isHorizontal ? dx : dy;
    // 成分がちょうど0のときはどちら側も等距離。正方向へ出し、プレビューで示す。
    const sign = options.direction === -1 || options.direction === 1
      ? options.direction : (component < 0 ? -1 : 1);
    const extent = options.preserveLength === true ? sign * length : component;
    if (Math.abs(extent) <= MIN_EDGE) {
      return failure('collapsed_edge', 'その向きにすると辺の長さが0になります。「長さを保つ」をお試しください。');
    }
    const result = copyPoints(points);
    result[moving] = isHorizontal ? { x: origin.x + extent, y: origin.y }
      : { x: origin.x, y: origin.y + extent };
    return validateResult(points, result, closed) || { ok: true, points: result };
  }

  // 各辺が水平ならyを、垂直ならxを等値グループにまとめる。
  // 固定点を含むグループは固定し、それ以外は元の座標の平均に合わせる。
  // これにより固定点と各辺の向きを満たしながら全頂点の移動二乗和を最小化する。
  function adjustCoordinates(points, edges, anchor) {
    function coordinates(axis) {
      const parent = points.map((_, i) => i);
      function root(i) {
        while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
        return i;
      }
      function join(i, j) { parent[root(j)] = root(i); }
      for (let i = 0; i < edges.length; i++) {
        const same = axis === 'x' ? edges[i].axis === 'vertical' : edges[i].axis === 'horizontal';
        if (same) join(i, (i + 1) % points.length);
      }
      const groups = new Map();
      for (let i = 0; i < points.length; i++) {
        const r = root(i), g = groups.get(r) || { sum: 0, count: 0 };
        g.sum += points[i][axis]; g.count++;
        groups.set(r, g);
      }
      const fixed = root(anchor);
      return points.map((_, i) => {
        const r = root(i), g = groups.get(r);
        return r === fixed ? points[anchor][axis] : g.sum / g.count;
      });
    }
    const x = coordinates('x'), y = coordinates('y');
    return points.map((_, i) => ({ x: x[i], y: y[i] }));
  }
  function solveAll(points, options, axes) {
    const closed = options.closed === true;
    const anchor = options.anchorIndex;
    const edgeCount = closed ? points.length : points.length - 1;
    const edges = [];
    for (let i = 0; i < edgeCount; i++) {
      const a = points[i], b = points[(i + 1) % points.length];
      const dx = b.x - a.x, dy = b.y - a.y;
      const axis = axes[i];
      const component = axis === 'horizontal' ? dx : dy;
      edges.push({ axis, sign: component < 0 ? -1 : 1,
        extent: options.preserveLength === true ? Math.hypot(dx, dy) : Math.abs(component) });
    }
    if (closed && options.preserveLength === true) {
      for (const axis of ['horizontal', 'vertical']) {
        const group = edges.filter((e) => e.axis === axis);
        const total = group.reduce((sum, e) => sum + e.sign * e.extent, 0);
        const scale = group.reduce((sum, e) => sum + e.extent, 0);
        if (!group.length || !closeEnough(total, 0, scale)) {
          return failure('lengths_impossible', '各辺の長さを保ったまま外周を閉じられません。「長さが変わってもよい」をお試しください。');
        }
      }
    }
    const result = options.preserveLength === true ? new Array(points.length) : adjustCoordinates(points, edges, anchor);
    function advance(base, edge, direction) {
      const amount = edge.sign * edge.extent * direction;
      return edge.axis === 'horizontal' ? { x: base.x + amount, y: base.y }
        : { x: base.x, y: base.y + amount };
    }
    if (options.preserveLength === true) {
      result[anchor] = { x: points[anchor].x, y: points[anchor].y };
      if (closed) {
        for (let step = 0; step < points.length - 1; step++) {
          const i = (anchor + step) % points.length, next = (i + 1) % points.length;
          result[next] = advance(result[i], edges[i], 1);
        }
      } else {
        for (let i = anchor; i < points.length - 1; i++) result[i + 1] = advance(result[i], edges[i], 1);
        for (let i = anchor - 1; i >= 0; i--) result[i] = advance(result[i + 1], edges[i], -1);
      }
    }
    const resultError = validateResult(points, result, closed);
    if (resultError) return resultError;
    // 最後の閉じる辺も指定の向き・長さになっているかを検証する。
    for (let i = 0; i < edgeCount; i++) {
      const a = result[i], b = result[(i + 1) % points.length];
      const edge = edges[i], length = distance(a, b);
      const offAxis = edge.axis === 'horizontal' ? b.y - a.y : b.x - a.x;
      const component = edge.axis === 'horizontal' ? b.x - a.x : b.y - a.y;
      if (edge.sign * component <= MIN_EDGE) {
        return failure('direction_impossible', '補正すると辺が消えるか向きが反転するため適用できません。1辺ずつの補正をお試しください。');
      }
      if (!closeEnough(offAxis, 0, length) || (options.preserveLength === true && !closeEnough(length, edge.extent, length))) {
        return failure('lengths_impossible', '指定された条件では全ての辺を補正できません。条件を変更してお試しください。');
      }
    }
    return { ok: true, points: result };
  }

  function correctAll(points, options) {
    options = options || {};
    const closed = options.closed === true;
    const invalid = validInput(points, closed);
    if (invalid) return invalid;
    if (!Number.isInteger(options.anchorIndex) || options.anchorIndex < 0 || options.anchorIndex >= points.length) {
      return failure('invalid_anchor', '動かしたくない端または角を選択してください。');
    }
    const edgeCount = closed ? points.length : points.length - 1;
    const axes = [], tied = [];
    for (let i = 0; i < edgeCount; i++) {
      const a = points[i], b = points[(i + 1) % points.length];
      const dx = Math.abs(b.x - a.x), dy = Math.abs(b.y - a.y);
      axes.push(dx >= dy ? 'horizontal' : 'vertical');
      // 45度ちょうどは水平と垂直が等距離。閉じる形を作れる方向も試す。
      if (Math.abs(dx - dy) <= 1e-12 * Math.max(1, dx, dy)) tied.push(i);
    }
    const triedTies = Math.min(tied.length, 8);
    let firstFailure;
    for (let mask = 0; mask < (1 << triedTies); mask++) {
      const choice = axes.slice();
      for (let j = 0; j < triedTies; j++) {
        if (mask & (1 << j)) choice[tied[j]] = choice[tied[j]] === 'horizontal' ? 'vertical' : 'horizontal';
      }
      const result = solveAll(points, options, choice);
      if (result.ok) return result;
      if (!firstFailure) firstFailure = result;
    }
    return firstFailure;
  }

  /* 寸法線の両端の差から近い軸を選ぶ。中心と長さを維持して位置ずれを抑える。 */
  function autoAlignDimension(points) {
    if (!Array.isArray(points) || points.length !== 2) {
      return failure('invalid_points', '寸法線の両端を読み取れません。');
    }
    const invalid = validInput(points, false);
    if (invalid) return invalid;
    const [a, b] = points;
    const axis = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y) ? 'horizontal' : 'vertical';
    const corrected = correctEdge(points, { edgeIndex: 0, anchorIndex: 0, axis, preserveLength: true });
    if (!corrected.ok) return corrected;
    const dx = ((b.x - a.x) - (corrected.points[1].x - corrected.points[0].x)) / 2;
    const dy = ((b.y - a.y) - (corrected.points[1].y - corrected.points[0].y)) / 2;
    return { ok: true, axis, points: corrected.points.map(p => ({ x: p.x + dx, y: p.y + dy })) };
  }

  global.Orthogonal = { adjustEdge: correctEdge, adjustAll: correctAll, autoAlignDimension };
})(typeof window !== 'undefined' ? window : globalThis);
