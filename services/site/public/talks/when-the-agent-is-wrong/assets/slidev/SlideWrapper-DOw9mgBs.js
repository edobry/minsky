import {
  k as Zt,
  aq as ct,
  ac as Xt,
  G as Jt,
  J as Qt,
  aI as Wt,
  a1 as L,
  d as P,
  a0 as jt,
  p as vt,
  af as Z,
  Y as X,
  i as et,
  h as zt,
  al as te,
  aJ as ee,
  X as se,
  _ as A,
  N as tt,
  f as q,
  a3 as wt,
  F as ne,
  ad as re,
  L as ie,
  m as St,
  g as ae,
  a6 as oe,
} from "../modules/vue-D4u9h7Td.js";
import {
  ak as Rt,
  o as dt,
  U as bt,
  M as le,
  g as ft,
  T as he,
  l as O,
  Y as ue,
  j as ce,
  q as de,
  E as fe,
  D as pe,
  a8 as Pt,
  a9 as Et,
  a7 as Mt,
  a6 as kt,
  K as ge,
  b as Ot,
  B as me,
  z as ve,
  y as ye,
  A as xe,
  x as _e,
  G as we,
  r as Se,
} from "../index-Bjqpo1hl.js";
const be = Object.defineProperty,
  $t = Object.getOwnPropertySymbols,
  Pe = Object.prototype.hasOwnProperty,
  Ee = Object.prototype.propertyIsEnumerable,
  Lt = (t, e, s) =>
    e in t ? be(t, e, { enumerable: !0, configurable: !0, writable: !0, value: s }) : (t[e] = s),
  pt = (t, e) => {
    for (var s in e || (e = {})) Pe.call(e, s) && Lt(t, s, e[s]);
    if ($t) for (var s of $t(e)) Ee.call(e, s) && Lt(t, s, e[s]);
    return t;
  },
  Me = () => ({
    emit(t, ...e) {
      for (let s = this.events[t] || [], n = 0, r = s.length; n < r; n++) s[n](...e);
    },
    events: {},
    on(t, e) {
      let s;
      return (
        ((s = this.events)[t] || (s[t] = [])).push(e),
        () => {
          let n;
          this.events[t] = (n = this.events[t]) == null ? void 0 : n.filter((r) => e !== r);
        }
      );
    },
  });
function st(t, e) {
  return t - e;
}
function ke(t) {
  return t < 0 ? -1 : 1;
}
function nt(t) {
  return [Math.abs(t), ke(t)];
}
function Ut() {
  const t = () => (((1 + Math.random()) * 65536) | 0).toString(16).substring(1);
  return `${t() + t()}-${t()}-${t()}-${t()}-${t()}${t()}${t()}`;
}
const $e = 2,
  $ = $e;
function Bt(t, e) {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "defs"),
    n = document.createElementNS("http://www.w3.org/2000/svg", "marker"),
    r = document.createElementNS("http://www.w3.org/2000/svg", "path");
  return (
    r.setAttribute("fill", e),
    n.setAttribute("id", t),
    n.setAttribute("viewBox", "0 -5 10 10"),
    n.setAttribute("refX", "5"),
    n.setAttribute("refY", "0"),
    n.setAttribute("markerWidth", "4"),
    n.setAttribute("markerHeight", "4"),
    n.setAttribute("orient", "auto"),
    r.setAttribute("d", "M0,-5L10,0L0,5"),
    n.appendChild(r),
    s.appendChild(n),
    s
  );
}
function Le(t, e) {
  const s = t.x - e.x,
    n = t.y - e.y;
  return s * s + n * n;
}
function Ce(t, e, s) {
  let n = e.x,
    r = e.y,
    i = s.x - n,
    o = s.y - r;
  if (i !== 0 || o !== 0) {
    const a = ((t.x - n) * i + (t.y - r) * o) / (i * i + o * o);
    a > 1 ? ((n = s.x), (r = s.y)) : a > 0 && ((n += i * a), (r += o * a));
  }
  return (i = t.x - n), (o = t.y - r), i * i + o * o;
}
function De(t, e) {
  let s = t[0];
  const n = [s];
  let r;
  for (let i = 1, o = t.length; i < o; i++) (r = t[i]), Le(r, s) > e && (n.push(r), (s = r));
  return s !== r && r && n.push(r), n;
}
function gt(t, e, s, n, r) {
  let i = n,
    o = 0;
  for (let a = e + 1; a < s; a++) {
    const l = Ce(t[a], t[e], t[s]);
    l > i && ((o = a), (i = l));
  }
  i > n && (o - e > 1 && gt(t, e, o, n, r), r.push(t[o]), s - o > 1 && gt(t, o, s, n, r));
}
function Ne(t, e) {
  const s = t.length - 1,
    n = [t[0]];
  return gt(t, 0, s, e, n), n.push(t[s]), n;
}
function Ct(t, e, s = !1) {
  if (t.length <= 2) return t;
  const n = e * e;
  return (t = s ? t : De(t, n)), (t = Ne(t, n)), t;
}
const U = class {
    constructor(t) {
      (this.drauu = t),
        (this.event = void 0),
        (this.point = void 0),
        (this.start = void 0),
        (this.el = null);
    }
    onSelected(t) {}
    onUnselected() {}
    onStart(t) {}
    onMove(t) {
      return !1;
    }
    onEnd(t) {}
    get brush() {
      return this.drauu.brush;
    }
    get shiftPressed() {
      return this.drauu.shiftPressed;
    }
    get altPressed() {
      return this.drauu.altPressed;
    }
    get svgElement() {
      return this.drauu.el;
    }
    getMousePosition(t) {
      let e, s, n, r;
      const i = this.drauu.el,
        o = (e = this.drauu.options.cssZoom) != null ? e : 1,
        a = (s = this.drauu.options.coordinateScale) != null ? s : 1,
        l = (n = this.drauu.options.offset) != null ? n : { x: 0, y: 0 };
      if (this.drauu.options.coordinateTransform === !1) {
        const d = this.drauu.el.getBoundingClientRect();
        return {
          x: (t.pageX / o - d.left + l.x) * a,
          y: (t.pageY / o - d.top + l.y) * a,
          pressure: t.pressure,
        };
      } else {
        const d = this.drauu.svgPoint;
        (d.x = t.clientX / o + l.x), (d.y = t.clientY / o + l.y);
        const m = d.matrixTransform((r = i.getScreenCTM()) == null ? void 0 : r.inverse());
        return { x: m.x * a, y: m.y * a, pressure: t.pressure };
      }
    }
    createElement(t, e) {
      let s;
      const n = document.createElementNS("http://www.w3.org/2000/svg", t),
        r = e ? pt(pt({}, this.brush), e) : this.brush;
      return (
        n.setAttribute("fill", (s = r.fill) != null ? s : "transparent"),
        n.setAttribute("stroke", r.color),
        n.setAttribute("stroke-width", r.size.toString()),
        n.setAttribute("stroke-linecap", "round"),
        r.dasharray && n.setAttribute("stroke-dasharray", r.dasharray),
        n
      );
    }
    attr(t, e) {
      this.el.setAttribute(t, typeof e == "string" ? e : e.toFixed($));
    }
    _setEvent(t) {
      (this.event = t), (this.point = this.getMousePosition(t));
    }
    _eventDown(t) {
      return this._setEvent(t), (this.start = this.point), this.onStart(this.point);
    }
    _eventMove(t) {
      return this._setEvent(t), this.onMove(this.point);
    }
    _eventUp(t) {
      return this._setEvent(t), this.onEnd(this.point);
    }
  },
  Ie = class j extends U {
    constructor() {
      super(...arguments), (this.points = []), (this.count = 0);
    }
    onStart(e) {
      if (
        ((this.el = this.createElement("path", { fill: "transparent" })),
        (this.points = [e]),
        this.brush.arrowEnd)
      ) {
        this.arrowId = Ut();
        const s = Bt(this.arrowId, this.brush.color);
        this.el.appendChild(s);
      }
      return this.el;
    }
    onMove(e) {
      return (
        this.el || this.onStart(e),
        this.points[this.points.length - 1] !== e && (this.points.push(e), (this.count += 1)),
        this.count > 5 && ((this.points = Ct(this.points, 1, !0)), (this.count = 0)),
        this.attr("d", j.toSvgData(this.points)),
        !0
      );
    }
    onEnd() {
      const e = this.el;
      if (((this.el = null), !e)) return !1;
      if ((e.setAttribute("d", j.toSvgData(Ct(this.points, 1, !0))), !e.getTotalLength())) {
        const { x: s, y: n } = this.points[0],
          r = this.brush.size / 2;
        e.setAttribute(
          "d",
          `M ${s - r} ${n} a ${r},${r} 0 1,0 ${r * 2},0 a ${r},${r} 0 1,0 ${-r * 2},0`
        ),
          e.setAttribute("fill", this.brush.color),
          e.setAttribute("stroke-width", "0");
      }
      return !0;
    }
    static line(e, s) {
      const n = s.x - e.x,
        r = s.y - e.y;
      return { length: Math.sqrt(n ** 2 + r ** 2), angle: Math.atan2(r, n) };
    }
    static controlPoint(e, s, n, r) {
      const i = s || e,
        o = n || e,
        a = 0.2,
        l = j.line(i, o),
        d = l.angle + (r ? Math.PI : 0),
        m = l.length * a,
        y = e.x + Math.cos(d) * m,
        x = e.y + Math.sin(d) * m;
      return { x: y, y: x };
    }
    static bezierCommand(e, s, n) {
      const r = j.controlPoint(n[s - 1], n[s - 2], e),
        i = j.controlPoint(e, n[s - 1], n[s + 1], !0);
      return `C ${r.x.toFixed($)},${r.y.toFixed($)} ${i.x.toFixed($)},${i.y.toFixed($)} ${e.x.toFixed($)},${e.y.toFixed($)}`;
    }
    static toSvgData(e) {
      return e.reduce(
        (s, n, r, i) =>
          r === 0 ? `M ${n.x.toFixed($)},${n.y.toFixed($)}` : `${s} ${j.bezierCommand(n, r, i)}`,
        ""
      );
    }
  },
  Ae = class extends U {
    onStart(t) {
      return (
        (this.el = this.createElement("ellipse")),
        this.attr("cx", t.x),
        this.attr("cy", t.y),
        this.el
      );
    }
    onMove(t) {
      if (!this.el || !this.start) return !1;
      let [e, s] = nt(t.x - this.start.x),
        [n, r] = nt(t.y - this.start.y);
      if (this.shiftPressed) {
        const i = Math.min(e, n);
        (e = i), (n = i);
      }
      if (this.altPressed)
        this.attr("cx", this.start.x),
          this.attr("cy", this.start.y),
          this.attr("rx", e),
          this.attr("ry", n);
      else {
        const [i, o] = [this.start.x, this.start.x + e * s].sort(st),
          [a, l] = [this.start.y, this.start.y + n * r].sort(st);
        this.attr("cx", (i + o) / 2),
          this.attr("cy", (a + l) / 2),
          this.attr("rx", (o - i) / 2),
          this.attr("ry", (l - a) / 2);
      }
      return !0;
    }
    onEnd() {
      const t = this.el;
      if (((this.el = null), !t)) return !1;
      try {
        if (!t.getTotalLength()) return !1;
      } catch {
        return !1;
      }
      return !0;
    }
  },
  Fe = class extends U {
    constructor() {
      super(...arguments),
        (this.pathSubFactor = 20),
        (this.pathFragments = []),
        (this._erased = []);
    }
    onSelected(t) {
      const e = (s, n) => {
        if (s && s.length)
          for (let r = 0; r < s.length; r++) {
            const i = s[r];
            if (i.getTotalLength) {
              const o = i.getTotalLength();
              for (let a = 0; a < this.pathSubFactor; a++) {
                const l = i.getPointAtLength((o * a) / this.pathSubFactor),
                  d = i.getPointAtLength((o * (a + 1)) / this.pathSubFactor);
                this.pathFragments.push({
                  x1: l.x,
                  x2: d.x,
                  y1: l.y,
                  y2: d.y,
                  segment: a,
                  element: n || i,
                });
              }
            } else i.children && e(i.children, i);
          }
      };
      t && e(t.children);
    }
    onUnselected() {
      this.pathFragments = [];
    }
    onStart(t) {
      (this.svgPointPrevious = this.svgElement.createSVGPoint()),
        (this.svgPointPrevious.x = t.x),
        (this.svgPointPrevious.y = t.y);
    }
    onMove(t) {
      (this.svgPointCurrent = this.svgElement.createSVGPoint()),
        (this.svgPointCurrent.x = t.x),
        (this.svgPointCurrent.y = t.y);
      const e = this.checkAndEraseElement();
      return (this.svgPointPrevious = this.svgPointCurrent), e;
    }
    onEnd() {
      (this.svgPointPrevious = void 0), (this.svgPointCurrent = void 0);
      const t = this._erased;
      return (
        (this._erased = []),
        {
          undo: () => t.forEach((e) => this.drauu._restoreNode(e)),
          redo: () => t.forEach((e) => this.drauu._removeNode(e)),
        }
      );
    }
    checkAndEraseElement() {
      if (this.pathFragments.length)
        for (let t = 0; t < this.pathFragments.length; t++) {
          const e = this.pathFragments[t];
          if (this.svgPointPrevious && this.svgPointCurrent) {
            const s = {
              x1: this.svgPointPrevious.x,
              x2: this.svgPointCurrent.x,
              y1: this.svgPointPrevious.y,
              y2: this.svgPointCurrent.y,
            };
            this.lineLineIntersect(e, s) &&
              (this.drauu._removeNode(e.element), this._erased.push(e.element));
          }
        }
      return (
        this._erased.length &&
          (this.pathFragments = this.pathFragments.filter(
            (t) => !this._erased.includes(t.element)
          )),
        this._erased.length > 0
      );
    }
    lineLineIntersect(t, e) {
      const s = t.x1,
        n = t.x2,
        r = e.x1,
        i = e.x2,
        o = t.y1,
        a = t.y2,
        l = e.y1,
        d = e.y2,
        m = (s - n) * (l - d) - (o - a) * (r - i),
        y = (s * a - o * n) * (r - i) - (s - n) * (r * d - l * i),
        x = (s * a - o * n) * (l - d) - (o - a) * (r * d - l * i),
        f = (p, c, E) => (p >= c && p <= E ? !0 : p >= E && p <= c);
      if (m === 0) return !1;
      {
        const p = { x: y / m, y: x / m };
        return f(p.x, s, n) && f(p.y, o, a) && f(p.x, r, i) && f(p.y, l, d);
      }
    }
  },
  Te = class extends U {
    onStart(t) {
      if (
        ((this.el = this.createElement("line", { fill: "transparent" })),
        this.attr("x1", t.x),
        this.attr("y1", t.y),
        this.attr("x2", t.x),
        this.attr("y2", t.y),
        this.brush.arrowEnd)
      ) {
        const e = Ut(),
          s = document.createElementNS("http://www.w3.org/2000/svg", "g");
        return (
          s.append(Bt(e, this.brush.color)),
          s.append(this.el),
          this.attr("marker-end", `url(#${e})`),
          s
        );
      }
      return this.el;
    }
    onMove(t) {
      if (!this.el) return !1;
      let { x: e, y: s } = t;
      if (this.shiftPressed) {
        const n = t.x - this.start.x,
          r = t.y - this.start.y;
        if (r !== 0) {
          let i = n / r;
          (i = Math.round(i)),
            Math.abs(i) <= 1
              ? ((e = this.start.x + r * i), (s = this.start.y + r))
              : ((e = this.start.x + n), (s = this.start.y));
        }
      }
      return (
        this.altPressed
          ? (this.attr("x1", this.start.x * 2 - e),
            this.attr("y1", this.start.y * 2 - s),
            this.attr("x2", e),
            this.attr("y2", s))
          : (this.attr("x1", this.start.x),
            this.attr("y1", this.start.y),
            this.attr("x2", e),
            this.attr("y2", s)),
        !0
      );
    }
    onEnd() {
      const t = this.el;
      if (((this.el = null), !t)) return !1;
      try {
        if (t.getTotalLength() < 5) return !1;
      } catch {
        return !1;
      }
      return !0;
    }
  },
  Ke = class extends U {
    onStart(t) {
      return (
        (this.el = this.createElement("rect")),
        this.brush.cornerRadius &&
          (this.attr("rx", this.brush.cornerRadius), this.attr("ry", this.brush.cornerRadius)),
        this.attr("x", t.x),
        this.attr("y", t.y),
        this.el
      );
    }
    onMove(t) {
      if (!this.el || !this.start) return !1;
      let [e, s] = nt(t.x - this.start.x),
        [n, r] = nt(t.y - this.start.y);
      if (this.shiftPressed) {
        const i = Math.min(e, n);
        (e = i), (n = i);
      }
      if (this.altPressed)
        this.attr("x", this.start.x - e),
          this.attr("y", this.start.y - n),
          this.attr("width", e * 2),
          this.attr("height", n * 2);
      else {
        const [i, o] = [this.start.x, this.start.x + e * s].sort(st),
          [a, l] = [this.start.y, this.start.y + n * r].sort(st);
        this.attr("x", i), this.attr("y", a), this.attr("width", o - i), this.attr("height", l - a);
      }
      return !0;
    }
    onEnd() {
      const t = this.el;
      if (((this.el = null), !t)) return !1;
      try {
        if (!t.getTotalLength()) return !1;
      } catch {
        return !1;
      }
      return !0;
    }
  };
function Dt(t, e, s, n = (r) => r) {
  return t * n(0.5 - e * (0.5 - s));
}
function je(t) {
  return [-t[0], -t[1]];
}
function k(t, e) {
  return [t[0] + e[0], t[1] + e[1]];
}
function b(t, e) {
  return [t[0] - e[0], t[1] - e[1]];
}
function M(t, e) {
  return [t[0] * e, t[1] * e];
}
function ze(t, e) {
  return [t[0] / e, t[1] / e];
}
function V(t) {
  return [t[1], -t[0]];
}
function Nt(t, e) {
  return t[0] * e[0] + t[1] * e[1];
}
function Re(t, e) {
  return t[0] === e[0] && t[1] === e[1];
}
function Oe(t) {
  return Math.hypot(t[0], t[1]);
}
function Ue(t) {
  return t[0] * t[0] + t[1] * t[1];
}
function It(t, e) {
  return Ue(b(t, e));
}
function Gt(t) {
  return ze(t, Oe(t));
}
function Be(t, e) {
  return Math.hypot(t[1] - e[1], t[0] - e[0]);
}
function H(t, e, s) {
  const n = Math.sin(s),
    r = Math.cos(s),
    i = t[0] - e[0],
    o = t[1] - e[1],
    a = i * r - o * n,
    l = i * n + o * r;
  return [a + e[0], l + e[1]];
}
function mt(t, e, s) {
  return k(t, M(b(e, t), s));
}
function At(t, e, s) {
  return k(t, M(e, s));
}
let { min: R, PI: Ge } = Math,
  Ft = 0.275,
  Y = Ge + 1e-4;
function qe(t, e = {}) {
  let {
      size: s = 16,
      smoothing: n = 0.5,
      thinning: r = 0.5,
      simulatePressure: i = !0,
      easing: o = (u) => u,
      start: a = {},
      end: l = {},
      last: d = !1,
    } = e,
    { cap: m = !0, easing: y = (u) => u * (2 - u) } = a,
    { cap: x = !0, easing: f = (u) => --u * u * u + 1 } = l;
  if (t.length === 0 || s <= 0) return [];
  let p = t[t.length - 1].runningLength,
    c = a.taper === !1 ? 0 : a.taper === !0 ? Math.max(s, p) : a.taper,
    E = l.taper === !1 ? 0 : l.taper === !0 ? Math.max(s, p) : l.taper,
    z = Math.pow(s * n, 2),
    C = [],
    h = [],
    _ = t.slice(0, 10).reduce((u, S) => {
      let g = S.pressure;
      if (i) {
        const v = R(1, S.distance / s),
          lt = R(1, 1 - v);
        g = R(1, u + (lt - u) * (v * Ft));
      }
      return (u + g) / 2;
    }, t[0].pressure),
    w = Dt(s, r, t[t.length - 1].pressure, o),
    rt,
    it = t[0].vector,
    B = t[0].point,
    J = B,
    T = B,
    K = J,
    at = !1;
  for (let u = 0; u < t.length; u++) {
    let { pressure: S } = t[u],
      { point: g, vector: v, distance: lt, runningLength: G } = t[u];
    if (u < t.length - 1 && p - G < 3) continue;
    if (r) {
      if (i) {
        const I = R(1, lt / s),
          ut = R(1, 1 - I);
        S = R(1, _ + (ut - _) * (I * Ft));
      }
      w = Dt(s, r, S, o);
    } else w = s / 2;
    rt === void 0 && (rt = w);
    const Vt = G < c ? y(G / c) : 1,
      Ht = p - G < E ? f((p - G) / E) : 1;
    w = Math.max(0.01, w * Math.min(Vt, Ht));
    const yt = (u < t.length - 1 ? t[u + 1] : t[u]).vector,
      ht = u < t.length - 1 ? Nt(v, yt) : 1,
      Yt = Nt(v, it) < 0 && !at,
      xt = ht !== null && ht < 0;
    if (Yt || xt) {
      const I = M(V(it), w);
      for (let ut = 1 / 13, W = 0; W <= 1; W += ut)
        (T = H(b(g, I), g, Y * W)), C.push(T), (K = H(k(g, I), g, Y * -W)), h.push(K);
      (B = T), (J = K), xt && (at = !0);
      continue;
    }
    if (((at = !1), u === t.length - 1)) {
      const I = M(V(v), w);
      C.push(b(g, I)), h.push(k(g, I));
      continue;
    }
    const _t = M(V(mt(yt, v, ht)), w);
    (T = b(g, _t)),
      (u <= 1 || It(B, T) > z) && (C.push(T), (B = T)),
      (K = k(g, _t)),
      (u <= 1 || It(J, K) > z) && (h.push(K), (J = K)),
      (_ = S),
      (it = v);
  }
  const D = t[0].point.slice(0, 2),
    N = t.length > 1 ? t[t.length - 1].point.slice(0, 2) : k(t[0].point, [1, 1]),
    ot = [],
    Q = [];
  if (t.length === 1) {
    if (!(c || E) || d) {
      const u = At(D, Gt(V(b(D, N))), -(rt || w)),
        S = [];
      for (let g = 1 / 13, v = g; v <= 1; v += g) S.push(H(u, D, Y * 2 * v));
      return S;
    }
  } else {
    if (!(c || (E && t.length === 1)))
      if (m)
        for (let S = 1 / 13, g = S; g <= 1; g += S) {
          const v = H(h[0], D, Y * g);
          ot.push(v);
        }
      else {
        const S = b(C[0], h[0]),
          g = M(S, 0.5),
          v = M(S, 0.51);
        ot.push(b(D, g), b(D, v), k(D, v), k(D, g));
      }
    const u = V(je(t[t.length - 1].vector));
    if (E || (c && t.length === 1)) Q.push(N);
    else if (x) {
      const S = At(N, u, w);
      for (let g = 1 / 29, v = g; v < 1; v += g) Q.push(H(S, N, Y * 3 * v));
    } else Q.push(k(N, M(u, w)), k(N, M(u, w * 0.99)), b(N, M(u, w * 0.99)), b(N, M(u, w)));
  }
  return C.concat(Q, h.reverse(), ot);
}
function Ve(t, e = {}) {
  let s;
  const { streamline: n = 0.5, size: r = 16, last: i = !1 } = e;
  if (t.length === 0) return [];
  let o = 0.15 + (1 - n) * 0.85,
    a = Array.isArray(t[0]) ? t : t.map(({ x: f, y: p, pressure: c = 0.5 }) => [f, p, c]);
  if (a.length === 2) {
    const f = a[1];
    a = a.slice(0, -1);
    for (let p = 1; p < 5; p++) a.push(mt(a[0], f, p / 4));
  }
  a.length === 1 && (a = [...a, [...k(a[0], [1, 1]), ...a[0].slice(2)]]);
  let l = [
      {
        point: [a[0][0], a[0][1]],
        pressure: a[0][2] >= 0 ? a[0][2] : 0.25,
        vector: [1, 1],
        distance: 0,
        runningLength: 0,
      },
    ],
    d = !1,
    m = 0,
    y = l[0],
    x = a.length - 1;
  for (let f = 1; f < a.length; f++) {
    const p = i && f === x ? a[f].slice(0, 2) : mt(y.point, a[f], o);
    if (Re(y.point, p)) continue;
    const c = Be(p, y.point);
    if (((m += c), f < x && !d)) {
      if (m < r) continue;
      d = !0;
    }
    (y = {
      point: p,
      pressure: a[f][2] >= 0 ? a[f][2] : 0.5,
      vector: Gt(b(y.point, p)),
      distance: c,
      runningLength: m,
    }),
      l.push(y);
  }
  return (l[0].vector = ((s = l[1]) == null ? void 0 : s.vector) || [0, 0]), l;
}
function He(t, e = {}) {
  return qe(Ve(t, e), e);
}
const Ye = class qt extends U {
  constructor() {
    super(...arguments), (this.points = []);
  }
  onStart(e) {
    return (
      (this.el = document.createElementNS("http://www.w3.org/2000/svg", "path")),
      (this.points = [e]),
      this.attr("fill", this.brush.color),
      this.attr("d", this.getSvgData(this.points)),
      this.el
    );
  }
  onMove(e) {
    return (
      this.el || this.onStart(e),
      this.points[this.points.length - 1] !== e && this.points.push(e),
      this.attr("d", this.getSvgData(this.points)),
      !0
    );
  }
  onEnd() {
    const e = this.el;
    return (this.el = null), !!e;
  }
  getSvgData(e) {
    return qt.getSvgData(e, this.brush);
  }
  static getSvgData(e, s) {
    const n = He(
      e,
      pt(
        {
          size: s.size,
          thinning: 0.9,
          simulatePressure: !1,
          start: { taper: 5 },
          end: { taper: 5 },
        },
        s.stylusOptions
      )
    );
    if (!n.length) return "";
    const r = n.reduce(
      (i, [o, a], l, d) => {
        const [m, y] = d[(l + 1) % d.length];
        return i.push(o, a, (o + m) / 2, (a + y) / 2), i;
      },
      ["M", ...n[0], "Q"]
    );
    return r.push("Z"), r.map((i) => (typeof i == "number" ? i.toFixed(2) : i)).join(" ");
  }
};
function Ze(t) {
  return {
    draw: new Ie(t),
    stylus: new Ye(t),
    line: new Te(t),
    rectangle: new Ke(t),
    ellipse: new Ae(t),
    eraseLine: new Fe(t),
  };
}
const Xe = class {
  constructor(t = {}) {
    (this.options = t),
      (this.el = null),
      (this.svgPoint = null),
      (this.eventEl = null),
      (this.shiftPressed = !1),
      (this.altPressed = !1),
      (this.drawing = !1),
      (this._emitter = Me()),
      (this._originalPointerId = null),
      (this._models = Ze(this)),
      (this._opStack = []),
      (this._opIndex = 0),
      (this._disposables = []),
      (this._elements = []),
      this.options.brush || (this.options.brush = { color: "black", size: 3, mode: "stylus" }),
      t.el && this.mount(t.el, t.eventTarget, t.window);
  }
  get model() {
    return this._models[this.mode];
  }
  get mounted() {
    return !!this.el;
  }
  get mode() {
    return this.options.brush.mode || "stylus";
  }
  set mode(t) {
    this._models[this.mode].onUnselected(),
      (this.options.brush.mode = t),
      this.model.onSelected(this.el);
  }
  get brush() {
    return this.options.brush;
  }
  set brush(t) {
    this.options.brush = t;
  }
  resolveSelector(t) {
    return typeof t == "string" ? document.querySelector(t) : t || null;
  }
  mount(t, e, s = window) {
    if (this.el) throw new Error("[drauu] already mounted, unmount previous target first");
    if (((this.el = this.resolveSelector(t)), !this.el))
      throw new Error("[drauu] target element not found");
    if (this.el.tagName.toLocaleLowerCase() !== "svg")
      throw new Error("[drauu] can only mount to a SVG element");
    if (!this.el.createSVGPoint)
      throw new Error(
        "[drauu] SVG element must be create by document.createElementNS('http://www.w3.org/2000/svg', 'svg')"
      );
    this.svgPoint = this.el.createSVGPoint();
    const n = this.resolveSelector(e) || this.el,
      r = this.eventStart.bind(this),
      i = this.eventMove.bind(this),
      o = this.eventEnd.bind(this),
      a = this.eventKeyboard.bind(this);
    n.addEventListener("pointerdown", r, { passive: !1 }),
      s.addEventListener("pointermove", i, { passive: !1 }),
      s.addEventListener("pointerup", o, { passive: !1 }),
      s.addEventListener("pointercancel", o, { passive: !1 }),
      s.addEventListener("keydown", a, !1),
      s.addEventListener("keyup", a, !1),
      this._disposables.push(() => {
        n.removeEventListener("pointerdown", r),
          s.removeEventListener("pointermove", i),
          s.removeEventListener("pointerup", o),
          s.removeEventListener("pointercancel", o),
          s.removeEventListener("keydown", a, !1),
          s.removeEventListener("keyup", a, !1);
      }),
      this._emitter.emit("mounted");
  }
  unmount() {
    this._disposables.forEach((t) => t()),
      (this._disposables.length = 0),
      (this._elements.length = 0),
      (this.el = null),
      this._emitter.emit("unmounted");
  }
  on(t, e) {
    return this._emitter.on(t, e);
  }
  undo() {
    return !this.canUndo() || this.drawing
      ? !1
      : (this._opStack[--this._opIndex].undo(), this._emitter.emit("changed"), !0);
  }
  redo() {
    return !this.canRedo() || this.drawing
      ? !1
      : (this._opStack[this._opIndex++].redo(), this._emitter.emit("changed"), !0);
  }
  canRedo() {
    return this._opIndex < this._opStack.length;
  }
  canUndo() {
    return this._opIndex > 0;
  }
  eventMove(t) {
    !this.acceptsInput(t) ||
      !this.drawing ||
      (this.model._eventMove(t) &&
        (t.stopPropagation(), t.preventDefault(), this._emitter.emit("changed")));
  }
  eventStart(t) {
    this.acceptsInput(t) &&
      (t.stopPropagation(),
      t.preventDefault(),
      this._currentNode && this.cancel(),
      (this.drawing = !0),
      (this._originalPointerId = t.pointerId),
      this._emitter.emit("start"),
      (this._currentNode = this.model._eventDown(t)),
      this._currentNode && this.mode !== "eraseLine" && this.el.appendChild(this._currentNode),
      this._emitter.emit("changed"));
  }
  eventEnd(t) {
    if (!this.acceptsInput(t) || !this.drawing) return;
    const e = this.model._eventUp(t);
    if (!e) this.cancel();
    else if (e === !0) {
      const s = this._currentNode;
      s &&
        (this._appendNode(s),
        this.commit({ undo: () => this._removeNode(s), redo: () => this._restoreNode(s) }));
    } else this.commit(e);
    (this.drawing = !1),
      this._emitter.emit("end"),
      this._emitter.emit("changed"),
      (this._originalPointerId = null);
  }
  acceptsInput(t) {
    return (
      (!this.options.acceptsInputTypes || this.options.acceptsInputTypes.includes(t.pointerType)) &&
      !(this._originalPointerId && this._originalPointerId !== t.pointerId)
    );
  }
  eventKeyboard(t) {
    (this.shiftPressed === t.shiftKey && this.altPressed === t.altKey) ||
      ((this.shiftPressed = t.shiftKey),
      (this.altPressed = t.altKey),
      this.model.point && this.model.onMove(this.model.point) && this._emitter.emit("changed"));
  }
  commit(t) {
    (this._opStack.length = this._opIndex), this._opStack.push(t), this._opIndex++;
    const e = this._currentNode;
    (this._currentNode = void 0), this._emitter.emit("committed", e);
  }
  clear() {
    (this._opStack.length = 0),
      (this._opIndex = 0),
      (this._elements = []),
      this.cancel(),
      (this.el.innerHTML = ""),
      this._emitter.emit("changed");
  }
  cancel() {
    this._currentNode &&
      (this.el.removeChild(this._currentNode),
      (this._currentNode = void 0),
      this._emitter.emit("canceled"));
  }
  dump() {
    return this.el.innerHTML;
  }
  load(t) {
    this.clear(), (this.el.innerHTML = t);
  }
  _appendNode(t) {
    const e = this._elements.at(-1);
    e ? e.after(t) : this.el.append(t);
    const s = this._elements.push(t) - 1;
    t.dataset.drauu_index = s.toString();
  }
  _removeNode(t) {
    t.remove(), (this._elements[+t.dataset.drauu_index] = null);
  }
  _restoreNode(t) {
    const e = +t.dataset.drauu_index;
    this._elements[e] = t;
    for (let s = e - 1; s >= 0; s--) {
      const n = this._elements[s];
      if (n) {
        n.after(t);
        return;
      }
    }
    this.el.prepend(t);
  }
};
function Je(t) {
  return new Xe(t);
}
const Qe = Zt(() => {
    const { currentSlideNo: t, isPresenter: e } = Rt(),
      s = ["#ff595e", "#ffca3a", "#8ac926", "#1982c4", "#6a4c93", "#ffffff", "#000000"],
      n = ct("slidev-drawing-enabled", !1),
      r = ct("slidev-drawing-pinned", !1),
      i = Xt(ct("slidev-drawing-brush", { color: s[0], size: 4, mode: "stylus" })),
      o = L(!1),
      a = L(!1),
      l = L(!1),
      d = L(!1),
      m = L("stylus"),
      y = P(() => ft.drawings.syncAll || e.value);
    let x = !1;
    const f = P({
        get() {
          return m.value;
        },
        set(h) {
          (m.value = h),
            h === "arrow"
              ? ((c.mode = "line"), (i.arrowEnd = !0))
              : ((c.mode = h), (i.arrowEnd = !1));
        },
      }),
      p = jt({
        brush: i,
        acceptsInputTypes: P(() =>
          n.value && (!ft.drawings.presenterOnly || e.value) ? void 0 : ["pen"]
        ),
        coordinateTransform: !1,
      }),
      c = Jt(Je(p));
    function E() {
      c.clear(), y.value && bt(t.value, "");
    }
    function z() {
      let h;
      (l.value = c.canRedo()),
        (a.value = c.canUndo()),
        (d.value = !!((h = c.el) != null && h.children.length));
    }
    function C(h) {
      x = !0;
      const _ = dt[h || t.value];
      _ != null ? c.load(_) : c.clear(), z(), (x = !1);
    }
    return (
      c.on("changed", () => {
        if ((z(), !x)) {
          const h = c.dump(),
            _ = t.value;
          (dt[_] || "") !== h && y.value && bt(_, c.dump());
        }
      }),
      he((h) => {
        (x = !0), h[t.value] != null && c.load(h[t.value] || ""), (x = !1), z();
      }),
      Qt(() => {
        Wt(
          t,
          () => {
            c.mounted && C();
          },
          { immediate: !0 }
        );
      }),
      c.on("start", () => (o.value = !0)),
      c.on("end", () => (o.value = !1)),
      window.addEventListener(
        "keydown",
        (h) => {
          if (!n.value || le.value) return;
          const _ = !h.ctrlKey && !h.altKey && !h.shiftKey && !h.metaKey;
          let w = !0;
          h.code === "KeyZ" && (h.ctrlKey || h.metaKey)
            ? h.shiftKey
              ? c.redo()
              : c.undo()
            : h.code === "Escape"
              ? (n.value = !1)
              : h.code === "KeyL" && _
                ? (f.value = "line")
                : h.code === "KeyA" && _
                  ? (f.value = "arrow")
                  : h.code === "KeyS" && _
                    ? (f.value = "stylus")
                    : h.code === "KeyR" && _
                      ? (f.value = "rectangle")
                      : h.code === "KeyE" && _
                        ? (f.value = "ellipse")
                        : h.code === "KeyC" && _
                          ? E()
                          : h.code.startsWith("Digit") && _ && +h.code[5] <= s.length
                            ? (i.color = s[+h.code[5] - 1])
                            : (w = !1),
            w && (h.preventDefault(), h.stopPropagation());
        },
        !1
      ),
      {
        brush: i,
        brushColors: s,
        canClear: d,
        canRedo: l,
        canUndo: a,
        clear: E,
        drauu: c,
        drauuOptions: p,
        drawingEnabled: n,
        drawingMode: f,
        drawingPinned: r,
        drawingState: dt,
        isDrawing: o,
        loadCanvas: C,
      }
    );
  }),
  We = ["innerHTML"],
  ms = vt({
    __name: "DrawingPreview",
    props: { page: {} },
    setup(t) {
      const { drawingState: e } = Qe();
      return (s, n) =>
        Z(e)[t.page]
          ? (X(),
            et(
              "svg",
              {
                key: 0,
                class: "w-full h-full absolute top-0 pointer-events-none",
                innerHTML: Z(e)[t.page],
              },
              null,
              8,
              We
            ))
          : zt("v-if", !0);
    },
  }),
  F = jt({});
const ts = [],
  es = [];
O(F, "$syncUp", !0);
O(F, "$syncDown", !0);
O(F, "$paused", !1);
O(F, "$onSet", (t) => ts.push(t));
O(F, "$onPatch", (t) => es.push(t));
ue();
O(F, "$patch", async () => !1);
const ss = ce(F, F, !0);
let Tt;
(Tt = window.navigator.userAgent.match(/Chrome\/(\d+)/)) == null || Tt[1];
let Kt;
(Kt = window.navigator.userAgent.match(/Chrome\/(\d+)/)) == null || Kt[1];
class ns {
  constructor() {
    this._screenshotSession = null;
  }
  getSnapshot(e, s) {
    const n = e + (s ? "-dark" : "-light"),
      r = ss.state[n];
    if (!r) return;
    const i = de(e);
    if (i && (r == null ? void 0 : r.revision) === (i == null ? void 0 : i.meta.slide.revision))
      return r.image;
  }
  async saveSnapshot(e, s, n) {
    return !1;
  }
  async startCapturing(e) {
    return !1;
  }
}
const rs = new ns(),
  is = ["id"],
  as = ["id"],
  os = { class: "slidev-slide-container w-full h-full relative" },
  ls = ["src"],
  hs = vt({
    __name: "SlideContainer",
    props: {
      width: { type: Number },
      meta: { default: () => ({}) },
      isMain: { type: Boolean, default: !1 },
      no: { type: Number, required: !1 },
      useSnapshot: { type: Boolean, default: !1 },
      contentStyle: { type: Object, default: () => ({}) },
    },
    setup(t) {
      const e = t,
        { isPrintMode: s } = Rt(),
        n = L(null),
        r = te(n),
        i = L(null),
        o = P(() => e.width ?? r.width.value),
        a = P(() => (e.width ? e.width / kt.value : r.height.value)),
        l = P(() =>
          Pt.value && !s.value ? +Pt.value : Math.min(o.value / Et.value, a.value / Mt.value)
        ),
        d = P(() => ({
          ...e.contentStyle,
          height: `${Mt.value}px`,
          width: `${Et.value}px`,
          transform: `translate(-50%, -50%) scale(${l.value})`,
          "--slidev-slide-scale": l.value,
        })),
        m = P(() => (e.width ? { width: `${e.width}px`, height: `${e.width / kt.value}px` } : {}));
      if (e.isMain) {
        const x = document.documentElement.style;
        ee(() => x.setProperty("--slidev-slide-scale", l.value.toString())),
          se(() => x.removeProperty("--slidev-slide-scale"));
      }
      A(fe, l), A(pe, i);
      const y = P(() => {
        if (!(e.no == null || !e.useSnapshot)) return rs.getSnapshot(e.no, ge.value);
      });
      return (x, f) =>
        y.value
          ? (X(),
            et(
              ne,
              { key: 1 },
              [
                zt(" Image Snapshot "),
                q("div", os, [
                  q(
                    "img",
                    { src: y.value, class: "w-full h-full object-cover", style: tt(m.value) },
                    null,
                    12,
                    ls
                  ),
                  f[0] ||
                    (f[0] = q(
                      "div",
                      {
                        absolute: "",
                        "bottom-1": "",
                        "right-1": "",
                        "p0.5": "",
                        "text-cyan:75": "",
                        "bg-cyan:10": "",
                        rounded: "",
                        title: "Snapshot",
                      },
                      [q("div", { class: "i-carbon-camera" })],
                      -1
                    )),
                ]),
              ],
              2112
            ))
          : (X(),
            et(
              "div",
              {
                key: 0,
                id: t.isMain ? "slide-container" : void 0,
                ref_key: "container",
                ref: n,
                class: "slidev-slide-container",
                style: tt(m.value),
              },
              [
                q(
                  "div",
                  {
                    id: t.isMain ? "slide-content" : void 0,
                    ref_key: "slideElement",
                    ref: i,
                    class: "slidev-slide-content",
                    style: tt(d.value),
                  },
                  [wt(x.$slots, "default", {}, void 0, !0)],
                  12,
                  as
                ),
                wt(x.$slots, "controls", {}, void 0, !0),
              ],
              12,
              is
            ));
    },
  }),
  vs = Ot(hs, [["__scopeId", "data-v-e9bf4cb5"]]),
  ys = { render: () => [] },
  xs = { render: () => [] },
  us = { render: () => [] },
  cs = { render: () => [] },
  ds = ["data-slidev-no", "lang"],
  fs = vt({
    __name: "SlideWrapper",
    props: {
      clicksContext: { type: Object, required: !0 },
      renderContext: { type: String, default: "slide" },
      route: { type: Object, required: !0 },
    },
    setup(t) {
      const e = t,
        s = P(() => {
          let i, o;
          return (
            ((o = (i = e.route.meta) == null ? void 0 : i.slide) == null
              ? void 0
              : o.frontmatter.zoom) ?? 1
          );
        });
      A(me, e.route),
        A(ve, e.route.meta.slide.frontmatter),
        A(ye, L(e.route.no)),
        A(xe, L(e.renderContext)),
        A(_e, re(e, "clicksContext")),
        A(we, s);
      const n = P(() =>
          s.value === 1
            ? void 0
            : {
                width: `${100 / s.value}%`,
                height: `${100 / s.value}%`,
                transformOrigin: "top left",
                transform: `scale(${s.value})`,
              }
        ),
        r = P(() => ({ ...n.value, "user-select": ft.selectable ? void 0 : "none" }));
      return (i, o) => (
        X(),
        et(
          "div",
          {
            "data-slidev-no": e.route.no,
            class: ie(
              Z(Se)(
                t.route,
                ["slide", "presenter"].includes(e.renderContext) ? "" : "disable-view-transition"
              )
            ),
            style: tt(r.value),
            lang: e.route.meta.slide.frontmatter.lang,
          },
          [St(Z(cs)), (X(), ae(oe(e.route.component))), St(Z(us))],
          14,
          ds
        )
      );
    },
  }),
  _s = Ot(fs, [["__scopeId", "data-v-a155920e"]]);
export { xs as G, vs as S, ms as _, ys as a, _s as b, Qe as u };
