const xp = Object.defineProperty;
const Rp = (e, t, n) =>
  t in e ? xp(e, t, { enumerable: !0, configurable: !0, writable: !0, value: n }) : (e[t] = n);
const Ct = (e, t, n) => Rp(e, typeof t != "symbol" ? `${t  }` : t, n);
/**
 * @vue/shared v3.5.34
 * (c) 2018-present Yuxi (Evan) You and Vue contributors
 * @license MIT
 **/ function Et(e) {
  const t = Object.create(null);
  for (const n of e.split(",")) t[n] = 1;
  return (n) => n in t;
}
const he = {},
  ds = [],
  Je = () => {},
  fs = () => !1,
  Zn = (e) =>
    e.charCodeAt(0) === 111 &&
    e.charCodeAt(1) === 110 &&
    (e.charCodeAt(2) > 122 || e.charCodeAt(2) < 97),
  Bi = (e) => e.startsWith("onUpdate:"),
  ce = Object.assign,
  Al = (e, t) => {
    const n = e.indexOf(t);
    n > -1 && e.splice(n, 1);
  },
  Ip = Object.prototype.hasOwnProperty,
  ye = (e, t) => Ip.call(e, t),
  K = Array.isArray,
  ps = (e) => Ds(e) === "[object Map]",
  Qn = (e) => Ds(e) === "[object Set]",
  Hc = (e) => Ds(e) === "[object Date]",
  Pp = (e) => Ds(e) === "[object RegExp]",
  Q = (e) => typeof e == "function",
  ne = (e) => typeof e == "string",
  nt = (e) => typeof e == "symbol",
  ge = (e) => e !== null && typeof e == "object",
  Ol = (e) => (ge(e) || Q(e)) && Q(e.then) && Q(e.catch),
  Ou = Object.prototype.toString,
  Ds = (e) => Ou.call(e),
  Mp = (e) => Ds(e).slice(8, -1),
  Hi = (e) => Ds(e) === "[object Object]",
  ji = (e) => ne(e) && e !== "NaN" && e[0] !== "-" && `${  parseInt(e, 10)}` === e,
  sn = Et(
    ",key,ref,ref_for,ref_key,onVnodeBeforeMount,onVnodeMounted,onVnodeBeforeUpdate,onVnodeUpdated,onVnodeBeforeUnmount,onVnodeUnmounted"
  ),
  kp = Et("bind,cloak,else-if,else,for,html,if,model,on,once,pre,show,slot,text,memo"),
  $i = (e) => {
    const t = Object.create(null);
    return (n) => t[n] || (t[n] = e(n));
  },
  Dp = /-\w/g,
  e = $i((e) => e.replace(Dp, (t) => t.slice(1).toUpperCase())),
  Fp = /\B([A-Z])/g,
  dt = $i((e) => e.replace(Fp, "-$1").toLowerCase()),
  es = $i((e) => e.charAt(0).toUpperCase() + e.slice(1)),
  ms = $i((e) => (e ? `on${es(e)}` : "")),
  Ge = (e, t) => !Object.is(e, t),
  gs = (e, ...t) => {
    for (let n = 0; n < e.length; n++) e[n](...t);
  },
  Nu = (e, t, n, s = !1) => {
    Object.defineProperty(e, t, { configurable: !0, enumerable: !1, writable: s, value: n });
  },
  Ui = (e) => {
    const t = parseFloat(e);
    return isNaN(t) ? e : t;
  },
  hi = (e) => {
    const t = ne(e) ? Number(e) : NaN;
    return isNaN(t) ? e : t;
  };
let jc;
const Wi = () =>
  jc ||
  (jc =
    typeof globalThis < "u"
      ? globalThis
      : typeof self < "u"
        ? self
        : typeof window < "u"
          ? window
          : typeof global < "u"
            ? global
            : {});
function Lp(e, t) {
  return e + JSON.stringify(t, (n, s) => (typeof s == "function" ? s.toString() : s));
}
const Vp =
    "Infinity,undefined,NaN,isFinite,isNaN,parseFloat,parseInt,decodeURI,decodeURIComponent,encodeURI,encodeURIComponent,Math,Number,Date,Array,Object,Boolean,String,RegExp,Map,Set,JSON,Intl,BigInt,console,Error,Symbol",
  Bp = Et(Vp);
function Or(e) {
  if (K(e)) {
    const t = {};
    for (let n = 0; n < e.length; n++) {
      const s = e[n],
        r = ne(s) ? xu(s) : Or(s);
      if (r) for (const i in r) t[i] = r[i];
    }
    return t;
  } else if (ne(e) || ge(e)) return e;
}
const Hp = /;(?![^(]*\))/g,
  jp = /:([^]+)/,
  $p = /\/\*[^]*?\*\//g;
function xu(e) {
  const t = {};
  return (
    e
      .replace($p, "")
      .split(Hp)
      .forEach((n) => {
        if (n) {
          const s = n.split(jp);
          s.length > 1 && (t[s[0].trim()] = s[1].trim());
        }
      }),
    t
  );
}
function Nr(e) {
  let t = "";
  if (ne(e)) t = e;
  else if (K(e))
    for (let n = 0; n < e.length; n++) {
      const s = Nr(e[n]);
      s && (t += `${s  } `);
    }
  else if (ge(e)) for (const n in e) e[n] && (t += `${n  } `);
  return t.trim();
}
function Up(e) {
  if (!e) return null;
  const { class: t, style: n } = e;
  return t && !ne(t) && (e.class = Nr(t)), n && (e.style = Or(n)), e;
}
const Wp =
    "html,body,base,head,link,meta,style,title,address,article,aside,footer,header,hgroup,h1,h2,h3,h4,h5,h6,nav,section,div,dd,dl,dt,figcaption,figure,picture,hr,img,li,main,ol,p,pre,ul,a,b,abbr,bdi,bdo,br,cite,code,data,dfn,em,i,kbd,mark,q,rp,rt,ruby,s,samp,small,span,strong,sub,sup,time,u,var,wbr,area,audio,map,track,video,embed,object,param,source,canvas,script,noscript,del,ins,caption,col,colgroup,table,thead,tbody,td,th,tr,button,datalist,fieldset,form,input,label,legend,meter,optgroup,option,output,progress,select,textarea,details,dialog,menu,summary,template,blockquote,iframe,tfoot",
  Kp =
    "svg,animate,animateMotion,animateTransform,circle,clipPath,color-profile,defs,desc,discard,ellipse,feBlend,feColorMatrix,feComponentTransfer,feComposite,feConvolveMatrix,feDiffuseLighting,feDisplacementMap,feDistantLight,feDropShadow,feFlood,feFuncA,feFuncB,feFuncG,feFuncR,feGaussianBlur,feImage,feMerge,feMergeNode,feMorphology,feOffset,fePointLight,feSpecularLighting,feSpotLight,feTile,feTurbulence,filter,foreignObject,g,hatch,hatchpath,image,line,linearGradient,marker,mask,mesh,meshgradient,meshpatch,meshrow,metadata,mpath,path,pattern,polygon,polyline,radialGradient,rect,set,solidcolor,stop,switch,symbol,text,textPath,title,tspan,unknown,use,view",
  qp =
    "annotation,annotation-xml,maction,maligngroup,malignmark,math,menclose,merror,mfenced,mfrac,mfraction,mglyph,mi,mlabeledtr,mlongdiv,mmultiscripts,mn,mo,mover,mpadded,mphantom,mprescripts,mroot,mrow,ms,mscarries,mscarry,msgroup,msline,mspace,msqrt,msrow,mstack,mstyle,msub,msubsup,msup,mtable,mtd,mtext,mtr,munder,munderover,none,semantics",
  Gp = "area,base,br,col,embed,hr,img,input,link,meta,param,source,track,wbr",
  zp = Et(Wp),
  Yp = Et(Kp),
  Jp = Et(qp),
  Xp = Et(Gp),
  Zp = "itemscope,allowfullscreen,formnovalidate,ismap,nomodule,novalidate,readonly",
  Qp = Et(Zp);
function Ru(e) {
  return !!e || e === "";
}
function em(e, t) {
  if (e.length !== t.length) return !1;
  let n = !0;
  for (let s = 0; n && s < e.length; s++) n = an(e[s], t[s]);
  return n;
}
function an(e, t) {
  if (e === t) return !0;
  let n = Hc(e),
    s = Hc(t);
  if (n || s) return n && s ? e.getTime() === t.getTime() : !1;
  if (((n = nt(e)), (s = nt(t)), n || s)) return e === t;
  if (((n = K(e)), (s = K(t)), n || s)) return n && s ? em(e, t) : !1;
  if (((n = ge(e)), (s = ge(t)), n || s)) {
    if (!n || !s) return !1;
    const r = Object.keys(e).length,
      i = Object.keys(t).length;
    if (r !== i) return !1;
    for (const o in e) {
      const l = e.hasOwnProperty(o),
        c = t.hasOwnProperty(o);
      if ((l && !c) || (!l && c) || !an(e[o], t[o])) return !1;
    }
  }
  return String(e) === String(t);
}
function Ki(e, t) {
  return e.findIndex((n) => an(n, t));
}
const Iu = (e) => !!(e && e.__v_isRef === !0),
  Pu = (e) =>
    ne(e)
      ? e
      : e == null
        ? ""
        : K(e) || (ge(e) && (e.toString === Ou || !Q(e.toString)))
          ? Iu(e)
            ? Pu(e.value)
            : JSON.stringify(e, Mu, 2)
          : String(e),
  Mu = (e, t) =>
    Iu(t)
      ? Mu(e, t.value)
      : ps(t)
        ? {
            [`Map(${t.size})`]: [...t.entries()].reduce(
              (n, [s, r], i) => ((n[`${go(s, i)  } =>`] = r), n),
              {}
            ),
          }
        : Qn(t)
          ? { [`Set(${t.size})`]: [...t.values()].map((n) => go(n)) }
          : nt(t)
            ? go(t)
            : ge(t) && !K(t) && !Hi(t)
              ? String(t)
              : t,
  go = (e, t = "") => {
    let n;
    return nt(e) ? `Symbol(${(n = e.description) != null ? n : t})` : e;
  };
function tm(e) {
  return e == null ? "initial" : typeof e == "string" ? (e === "" ? " " : e) : String(e);
}
/**
 * @vue/reactivity v3.5.34
 * (c) 2018-present Yuxi (Evan) You and Vue contributors
 * @license MIT
 **/ let je;
class Nl {
  constructor(t = !1) {
    (this.detached = t),
      (this._active = !0),
      (this._on = 0),
      (this.effects = []),
      (this.cleanups = []),
      (this._isPaused = !1),
      (this._warnOnRun = !0),
      (this.__v_skip = !0),
      !t &&
        je &&
        (je.active
          ? ((this.parent = je), (this.index = (je.scopes || (je.scopes = [])).push(this) - 1))
          : ((this._active = !1), (this._warnOnRun = !1)));
  }
  get active() {
    return this._active;
  }
  pause() {
    if (this._active) {
      this._isPaused = !0;
      let t, n;
      if (this.scopes) for (t = 0, n = this.scopes.length; t < n; t++) this.scopes[t].pause();
      for (t = 0, n = this.effects.length; t < n; t++) this.effects[t].pause();
    }
  }
  resume() {
    if (this._active && this._isPaused) {
      this._isPaused = !1;
      let t, n;
      if (this.scopes) for (t = 0, n = this.scopes.length; t < n; t++) this.scopes[t].resume();
      for (t = 0, n = this.effects.length; t < n; t++) this.effects[t].resume();
    }
  }
  run(t) {
    if (this._active) {
      const n = je;
      try {
        return (je = this), t();
      } finally {
        je = n;
      }
    }
  }
  on() {
    ++this._on === 1 && ((this.prevScope = je), (je = this));
  }
  off() {
    if (this._on > 0 && --this._on === 0) {
      if (je === this) je = this.prevScope;
      else {
        let t = je;
        for (; t; ) {
          if (t.prevScope === this) {
            t.prevScope = this.prevScope;
            break;
          }
          t = t.prevScope;
        }
      }
      this.prevScope = void 0;
    }
  }
  stop(t) {
    if (this._active) {
      this._active = !1;
      let n, s;
      for (n = 0, s = this.effects.length; n < s; n++) this.effects[n].stop();
      for (this.effects.length = 0, n = 0, s = this.cleanups.length; n < s; n++) this.cleanups[n]();
      if (((this.cleanups.length = 0), this.scopes)) {
        for (n = 0, s = this.scopes.length; n < s; n++) this.scopes[n].stop(!0);
        this.scopes.length = 0;
      }
      if (!this.detached && this.parent && !t) {
        const r = this.parent.scopes.pop();
        r && r !== this && ((this.parent.scopes[this.index] = r), (r.index = this.index));
      }
      this.parent = void 0;
    }
  }
}
function ku(e) {
  return new Nl(e);
}
function xl() {
  return je;
}
function Du(e, t = !1) {
  je && je.cleanups.push(e);
}
let Te;
const yo = new WeakSet();
class or {
  constructor(t) {
    (this.fn = t),
      (this.deps = void 0),
      (this.depsTail = void 0),
      (this.flags = 5),
      (this.next = void 0),
      (this.cleanup = void 0),
      (this.scheduler = void 0),
      je && (je.active ? je.effects.push(this) : (this.flags &= -2));
  }
  pause() {
    this.flags |= 64;
  }
  resume() {
    this.flags & 64 && ((this.flags &= -65), yo.has(this) && (yo.delete(this), this.trigger()));
  }
  notify() {
    (this.flags & 2 && !(this.flags & 32)) || this.flags & 8 || Lu(this);
  }
  run() {
    if (!(this.flags & 1)) return this.fn();
    (this.flags |= 2), $c(this), Vu(this);
    const t = Te,
      n = Dt;
    (Te = this), (Dt = !0);
    try {
      return this.fn();
    } finally {
      Bu(this), (Te = t), (Dt = n), (this.flags &= -3);
    }
  }
  stop() {
    if (this.flags & 1) {
      for (let t = this.deps; t; t = t.nextDep) Pl(t);
      (this.deps = this.depsTail = void 0),
        $c(this),
        this.onStop && this.onStop(),
        (this.flags &= -2);
    }
  }
  trigger() {
    this.flags & 64 ? yo.add(this) : this.scheduler ? this.scheduler() : this.runIfDirty();
  }
  runIfDirty() {
    Ho(this) && this.run();
  }
  get dirty() {
    return Ho(this);
  }
}
let Fu = 0,
  Ys,
  Js;
function Lu(e, t = !1) {
  if (((e.flags |= 8), t)) {
    (e.next = Js), (Js = e);
    return;
  }
  (e.next = Ys), (Ys = e);
}
function Rl() {
  Fu++;
}
function Il() {
  if (--Fu > 0) return;
  if (Js) {
    let t = Js;
    for (Js = void 0; t; ) {
      const n = t.next;
      (t.next = void 0), (t.flags &= -9), (t = n);
    }
  }
  let e;
  for (; Ys; ) {
    let t = Ys;
    for (Ys = void 0; t; ) {
      const n = t.next;
      if (((t.next = void 0), (t.flags &= -9), t.flags & 1))
        try {
          t.trigger();
        } catch (s) {
          e || (e = s);
        }
      t = n;
    }
  }
  if (e) throw e;
}
function Vu(e) {
  for (let t = e.deps; t; t = t.nextDep)
    (t.version = -1), (t.prevActiveLink = t.dep.activeLink), (t.dep.activeLink = t);
}
function Bu(e) {
  let t,
    n = e.depsTail,
    s = n;
  for (; s; ) {
    const r = s.prevDep;
    s.version === -1 ? (s === n && (n = r), Pl(s), nm(s)) : (t = s),
      (s.dep.activeLink = s.prevActiveLink),
      (s.prevActiveLink = void 0),
      (s = r);
  }
  (e.deps = t), (e.depsTail = n);
}
function Ho(e) {
  for (let t = e.deps; t; t = t.nextDep)
    if (
      t.dep.version !== t.version ||
      (t.dep.computed && (Hu(t.dep.computed) || t.dep.version !== t.version))
    )
      return !0;
  return !!e._dirty;
}
function Hu(e) {
  if (
    (e.flags & 4 && !(e.flags & 16)) ||
    ((e.flags &= -17), e.globalVersion === lr) ||
    ((e.globalVersion = lr), !e.isSSR && e.flags & 128 && ((!e.deps && !e._dirty) || !Ho(e)))
  )
    return;
  e.flags |= 2;
  const t = e.dep,
    n = Te,
    s = Dt;
  (Te = e), (Dt = !0);
  try {
    Vu(e);
    const r = e.fn(e._value);
    (t.version === 0 || Ge(r, e._value)) && ((e.flags |= 128), (e._value = r), t.version++);
  } catch (r) {
    throw (t.version++, r);
  } finally {
    (Te = n), (Dt = s), Bu(e), (e.flags &= -3);
  }
}
function Pl(e, t = !1) {
  const { dep: n, prevSub: s, nextSub: r } = e;
  if (
    (s && ((s.nextSub = r), (e.prevSub = void 0)),
    r && ((r.prevSub = s), (e.nextSub = void 0)),
    n.subs === e && ((n.subs = s), !s && n.computed))
  ) {
    n.computed.flags &= -5;
    for (let i = n.computed.deps; i; i = i.nextDep) Pl(i, !0);
  }
  !t && !--n.sc && n.map && n.map.delete(n.key);
}
function nm(e) {
  const { prevDep: t, nextDep: n } = e;
  t && ((t.nextDep = n), (e.prevDep = void 0)), n && ((n.prevDep = t), (e.nextDep = void 0));
}
function sm(e, t) {
  e.effect instanceof or && (e = e.effect.fn);
  const n = new or(e);
  t && ce(n, t);
  try {
    n.run();
  } catch (r) {
    throw (n.stop(), r);
  }
  const s = n.run.bind(n);
  return (s.effect = n), s;
}
function rm(e) {
  e.effect.stop();
}
let Dt = !0;
const ju = [];
function un() {
  ju.push(Dt), (Dt = !1);
}
function fn() {
  const e = ju.pop();
  Dt = e === void 0 ? !0 : e;
}
function $c(e) {
  const { cleanup: t } = e;
  if (((e.cleanup = void 0), t)) {
    const n = Te;
    Te = void 0;
    try {
      t();
    } finally {
      Te = n;
    }
  }
}
let lr = 0;
class im {
  constructor(t, n) {
    (this.sub = t),
      (this.dep = n),
      (this.version = n.version),
      (this.nextDep = this.prevDep = this.nextSub = this.prevSub = this.prevActiveLink = void 0);
  }
}
class qi {
  constructor(t) {
    (this.computed = t),
      (this.version = 0),
      (this.activeLink = void 0),
      (this.subs = void 0),
      (this.map = void 0),
      (this.key = void 0),
      (this.sc = 0),
      (this.__v_skip = !0);
  }
  track(t) {
    if (!Te || !Dt || Te === this.computed) return;
    let n = this.activeLink;
    if (n === void 0 || n.sub !== Te)
      (n = this.activeLink = new im(Te, this)),
        Te.deps
          ? ((n.prevDep = Te.depsTail), (Te.depsTail.nextDep = n), (Te.depsTail = n))
          : (Te.deps = Te.depsTail = n),
        $u(n);
    else if (n.version === -1 && ((n.version = this.version), n.nextDep)) {
      const s = n.nextDep;
      (s.prevDep = n.prevDep),
        n.prevDep && (n.prevDep.nextDep = s),
        (n.prevDep = Te.depsTail),
        (n.nextDep = void 0),
        (Te.depsTail.nextDep = n),
        (Te.depsTail = n),
        Te.deps === n && (Te.deps = s);
    }
    return n;
  }
  trigger(t) {
    this.version++, lr++, this.notify(t);
  }
  notify(t) {
    Rl();
    try {
      for (let n = this.subs; n; n = n.prevSub) n.sub.notify() && n.sub.dep.notify();
    } finally {
      Il();
    }
  }
}
function $u(e) {
  if ((e.dep.sc++, e.sub.flags & 4)) {
    const t = e.dep.computed;
    if (t && !e.dep.subs) {
      t.flags |= 20;
      for (let s = t.deps; s; s = s.nextDep) $u(s);
    }
    const n = e.dep.subs;
    n !== e && ((e.prevSub = n), n && (n.nextSub = e)), (e.dep.subs = e);
  }
}
const di = new WeakMap(),
  Wn = Symbol(""),
  jo = Symbol(""),
  cr = Symbol("");
function Qe(e, t, n) {
  if (Dt && Te) {
    let s = di.get(e);
    s || di.set(e, (s = new Map()));
    let r = s.get(n);
    r || (s.set(n, (r = new qi())), (r.map = s), (r.key = n)), r.track();
  }
}
function en(e, t, n, s, r, i) {
  const o = di.get(e);
  if (!o) {
    lr++;
    return;
  }
  const l = (c) => {
    c && c.trigger();
  };
  if ((Rl(), t === "clear")) o.forEach(l);
  else {
    const c = K(e),
      u = c && ji(n);
    if (c && n === "length") {
      const a = Number(s);
      o.forEach((f, d) => {
        (d === "length" || d === cr || (!nt(d) && d >= a)) && l(f);
      });
    } else
      switch (((n !== void 0 || o.has(void 0)) && l(o.get(n)), u && l(o.get(cr)), t)) {
        case "add":
          c ? u && l(o.get("length")) : (l(o.get(Wn)), ps(e) && l(o.get(jo)));
          break;
        case "delete":
          c || (l(o.get(Wn)), ps(e) && l(o.get(jo)));
          break;
        case "set":
          ps(e) && l(o.get(Wn));
          break;
      }
  }
  Il();
}
function om(e, t) {
  const n = di.get(e);
  return n && n.get(t);
}
function is(e) {
  const t = fe(e);
  return t === e ? t : (Qe(t, "iterate", cr), mt(e) ? t : t.map(Lt));
}
function Gi(e) {
  return Qe((e = fe(e)), "iterate", cr), e;
}
function Kt(e, t) {
  return qt(e) ? Cs(rn(e) ? Lt(t) : t) : Lt(t);
}
const lm = {
  __proto__: null,
  [Symbol.iterator]() {
    return vo(this, Symbol.iterator, (e) => Kt(this, e));
  },
  concat(...e) {
    return is(this).concat(...e.map((t) => (K(t) ? is(t) : t)));
  },
  entries() {
    return vo(this, "entries", (e) => ((e[1] = Kt(this, e[1])), e));
  },
  every(e, t) {
    return zt(this, "every", e, t, void 0, arguments);
  },
  filter(e, t) {
    return zt(this, "filter", e, t, (n) => n.map((s) => Kt(this, s)), arguments);
  },
  find(e, t) {
    return zt(this, "find", e, t, (n) => Kt(this, n), arguments);
  },
  findIndex(e, t) {
    return zt(this, "findIndex", e, t, void 0, arguments);
  },
  findLast(e, t) {
    return zt(this, "findLast", e, t, (n) => Kt(this, n), arguments);
  },
  findLastIndex(e, t) {
    return zt(this, "findLastIndex", e, t, void 0, arguments);
  },
  forEach(e, t) {
    return zt(this, "forEach", e, t, void 0, arguments);
  },
  includes(...e) {
    return bo(this, "includes", e);
  },
  indexOf(...e) {
    return bo(this, "indexOf", e);
  },
  join(e) {
    return is(this).join(e);
  },
  lastIndexOf(...e) {
    return bo(this, "lastIndexOf", e);
  },
  map(e, t) {
    return zt(this, "map", e, t, void 0, arguments);
  },
  pop() {
    return Bs(this, "pop");
  },
  push(...e) {
    return Bs(this, "push", e);
  },
  reduce(e, ...t) {
    return Uc(this, "reduce", e, t);
  },
  reduceRight(e, ...t) {
    return Uc(this, "reduceRight", e, t);
  },
  shift() {
    return Bs(this, "shift");
  },
  some(e, t) {
    return zt(this, "some", e, t, void 0, arguments);
  },
  splice(...e) {
    return Bs(this, "splice", e);
  },
  toReversed() {
    return is(this).toReversed();
  },
  toSorted(e) {
    return is(this).toSorted(e);
  },
  toSpliced(...e) {
    return is(this).toSpliced(...e);
  },
  unshift(...e) {
    return Bs(this, "unshift", e);
  },
  values() {
    return vo(this, "values", (e) => Kt(this, e));
  },
};
function vo(e, t, n) {
  const s = Gi(e),
    r = s[t]();
  return (
    s !== e &&
      !mt(e) &&
      ((r._next = r.next),
      (r.next = () => {
        const i = r._next();
        return i.done || (i.value = n(i.value)), i;
      })),
    r
  );
}
const cm = Array.prototype;
function zt(e, t, n, s, r, i) {
  const o = Gi(e),
    l = o !== e && !mt(e),
    c = o[t];
  if (c !== cm[t]) {
    const f = c.apply(e, i);
    return l ? Lt(f) : f;
  }
  let u = n;
  o !== e &&
    (l
      ? (u = function (f, d) {
          return n.call(this, Kt(e, f), d, e);
        })
      : n.length > 2 &&
        (u = function (f, d) {
          return n.call(this, f, d, e);
        }));
  const a = c.call(o, u, s);
  return l && r ? r(a) : a;
}
function Uc(e, t, n, s) {
  const r = Gi(e),
    i = r !== e && !mt(e);
  let o = n,
    l = !1;
  r !== e &&
    (i
      ? ((l = s.length === 0),
        (o = function (u, a, f) {
          return l && ((l = !1), (u = Kt(e, u))), n.call(this, u, Kt(e, a), f, e);
        }))
      : n.length > 3 &&
        (o = function (u, a, f) {
          return n.call(this, u, a, f, e);
        }));
  const c = r[t](o, ...s);
  return l ? Kt(e, c) : c;
}
function bo(e, t, n) {
  const s = fe(e);
  Qe(s, "iterate", cr);
  const r = s[t](...n);
  return (r === -1 || r === !1) && xr(n[0]) ? ((n[0] = fe(n[0])), s[t](...n)) : r;
}
function Bs(e, t, n = []) {
  un(), Rl();
  const s = fe(e)[t].apply(e, n);
  return Il(), fn(), s;
}
const am = Et("__proto__,__v_isRef,__isVue"),
  Uu = new Set(
    Object.getOwnPropertyNames(Symbol)
      .filter((e) => e !== "arguments" && e !== "caller")
      .map((e) => Symbol[e])
      .filter(nt)
  );
function um(e) {
  nt(e) || (e = String(e));
  const t = fe(this);
  return Qe(t, "has", e), t.hasOwnProperty(e);
}
class Wu {
  constructor(t = !1, n = !1) {
    (this._isReadonly = t), (this._isShallow = n);
  }
  get(t, n, s) {
    if (n === "__v_skip") return t.__v_skip;
    const r = this._isReadonly,
      i = this._isShallow;
    if (n === "__v_isReactive") return !r;
    if (n === "__v_isReadonly") return r;
    if (n === "__v_isShallow") return i;
    if (n === "__v_raw")
      return s === (r ? (i ? Ju : Yu) : i ? zu : Gu).get(t) ||
        Object.getPrototypeOf(t) === Object.getPrototypeOf(s)
        ? t
        : void 0;
    const o = K(t);
    if (!r) {
      let c;
      if (o && (c = lm[n])) return c;
      if (n === "hasOwnProperty") return um;
    }
    const l = Reflect.get(t, n, we(t) ? t : s);
    if ((nt(n) ? Uu.has(n) : am(n)) || (r || Qe(t, "get", n), i)) return l;
    if (we(l)) {
      const c = o && ji(n) ? l : l.value;
      return r && ge(c) ? kt(c) : c;
    }
    return ge(l) ? (r ? kt(l) : gt(l)) : l;
  }
}
class Ku extends Wu {
  constructor(t = !1) {
    super(!1, t);
  }
  set(t, n, s, r) {
    let i = t[n];
    const o = K(t) && ji(n);
    if (!this._isShallow) {
      const u = qt(i);
      if ((!mt(s) && !qt(s) && ((i = fe(i)), (s = fe(s))), !o && we(i) && !we(s)))
        return u || (i.value = s), !0;
    }
    const l = o ? Number(n) < t.length : ye(t, n),
      c = Reflect.set(t, n, s, we(t) ? t : r);
    return t === fe(r) && (l ? Ge(s, i) && en(t, "set", n, s) : en(t, "add", n, s)), c;
  }
  deleteProperty(t, n) {
    const s = ye(t, n);
    t[n];
    const r = Reflect.deleteProperty(t, n);
    return r && s && en(t, "delete", n, void 0), r;
  }
  has(t, n) {
    const s = Reflect.has(t, n);
    return (!nt(n) || !Uu.has(n)) && Qe(t, "has", n), s;
  }
  ownKeys(t) {
    return Qe(t, "iterate", K(t) ? "length" : Wn), Reflect.ownKeys(t);
  }
}
class qu extends Wu {
  constructor(t = !1) {
    super(!0, t);
  }
  set(t, n) {
    return !0;
  }
  deleteProperty(t, n) {
    return !0;
  }
}
const fm = new Ku(),
  hm = new qu(),
  dm = new Ku(!0),
  pm = new qu(!0),
  $o = (e) => e,
  $r = (e) => Reflect.getPrototypeOf(e);
function mm(e, t, n) {
  return function (...s) {
    const r = this.__v_raw,
      i = fe(r),
      o = ps(i),
      l = e === "entries" || (e === Symbol.iterator && o),
      c = e === "keys" && o,
      u = r[e](...s),
      a = n ? $o : t ? Cs : Lt;
    return (
      !t && Qe(i, "iterate", c ? jo : Wn),
      ce(Object.create(u), {
        next() {
          const { value: f, done: d } = u.next();
          return d ? { value: f, done: d } : { value: l ? [a(f[0]), a(f[1])] : a(f), done: d };
        },
      })
    );
  };
}
function Ur(e) {
  return function (...t) {
    return e === "delete" ? !1 : e === "clear" ? void 0 : this;
  };
}
function gm(e, t) {
  const n = {
    get(r) {
      const i = this.__v_raw,
        o = fe(i),
        l = fe(r);
      e || (Ge(r, l) && Qe(o, "get", r), Qe(o, "get", l));
      const { has: c } = $r(o),
        u = t ? $o : e ? Cs : Lt;
      if (c.call(o, r)) return u(i.get(r));
      if (c.call(o, l)) return u(i.get(l));
      i !== o && i.get(r);
    },
    get size() {
      const r = this.__v_raw;
      return !e && Qe(fe(r), "iterate", Wn), r.size;
    },
    has(r) {
      const i = this.__v_raw,
        o = fe(i),
        l = fe(r);
      return (
        e || (Ge(r, l) && Qe(o, "has", r), Qe(o, "has", l)),
        r === l ? i.has(r) : i.has(r) || i.has(l)
      );
    },
    forEach(r, i) {
      const o = this,
        l = o.__v_raw,
        c = fe(l),
        u = t ? $o : e ? Cs : Lt;
      return !e && Qe(c, "iterate", Wn), l.forEach((a, f) => r.call(i, u(a), u(f), o));
    },
  };
  return (
    ce(
      n,
      e
        ? { add: Ur("add"), set: Ur("set"), delete: Ur("delete"), clear: Ur("clear") }
        : {
            add(r) {
              const i = fe(this),
                o = $r(i),
                l = fe(r),
                c = !t && !mt(r) && !qt(r) ? l : r;
              return (
                o.has.call(i, c) ||
                  (Ge(r, c) && o.has.call(i, r)) ||
                  (Ge(l, c) && o.has.call(i, l)) ||
                  (i.add(c), en(i, "add", c, c)),
                this
              );
            },
            set(r, i) {
              !t && !mt(i) && !qt(i) && (i = fe(i));
              const o = fe(this),
                { has: l, get: c } = $r(o);
              let u = l.call(o, r);
              u || ((r = fe(r)), (u = l.call(o, r)));
              const a = c.call(o, r);
              return o.set(r, i), u ? Ge(i, a) && en(o, "set", r, i) : en(o, "add", r, i), this;
            },
            delete(r) {
              const i = fe(this),
                { has: o, get: l } = $r(i);
              let c = o.call(i, r);
              c || ((r = fe(r)), (c = o.call(i, r))), l && l.call(i, r);
              const u = i.delete(r);
              return c && en(i, "delete", r, void 0), u;
            },
            clear() {
              const r = fe(this),
                i = r.size !== 0,
                o = r.clear();
              return i && en(r, "clear", void 0, void 0), o;
            },
          }
    ),
    ["keys", "values", "entries", Symbol.iterator].forEach((r) => {
      n[r] = mm(r, e, t);
    }),
    n
  );
}
function zi(e, t) {
  const n = gm(e, t);
  return (s, r, i) =>
    r === "__v_isReactive"
      ? !e
      : r === "__v_isReadonly"
        ? e
        : r === "__v_raw"
          ? s
          : Reflect.get(ye(n, r) && r in s ? n : s, r, i);
}
const ym = { get: zi(!1, !1) },
  vm = { get: zi(!1, !0) },
  bm = { get: zi(!0, !1) },
  m = { get: zi(!0, !0) },
  Gu = new WeakMap(),
  zu = new WeakMap(),
  Yu = new WeakMap(),
  Ju = new WeakMap();
function Sm(e) {
  switch (e) {
    case "Object":
    case "Array":
      return 1;
    case "Map":
    case "Set":
    case "WeakMap":
    case "WeakSet":
      return 2;
    default:
      return 0;
  }
}
function Em(e) {
  return e.__v_skip || !Object.isExtensible(e) ? 0 : Sm(Mp(e));
}
function gt(e) {
  return qt(e) ? e : Yi(e, !1, fm, ym, Gu);
}
function Ml(e) {
  return Yi(e, !1, dm, vm, zu);
}
function kt(e) {
  return Yi(e, !0, hm, bm, Yu);
}
function ar(e) {
  return Yi(e, !0, pm, _m, Ju);
}
function Yi(e, t, n, s, r) {
  if (!ge(e) || (e.__v_raw && !(t && e.__v_isReactive))) return e;
  const i = Em(e);
  if (i === 0) return e;
  const o = r.get(e);
  if (o) return o;
  const l = new Proxy(e, i === 2 ? s : n);
  return r.set(e, l), l;
}
function rn(e) {
  return qt(e) ? rn(e.__v_raw) : !!(e && e.__v_isReactive);
}
function qt(e) {
  return !!(e && e.__v_isReadonly);
}
function mt(e) {
  return !!(e && e.__v_isShallow);
}
function xr(e) {
  return e ? !!e.__v_raw : !1;
}
function fe(e) {
  const t = e && e.__v_raw;
  return t ? fe(t) : e;
}
function Xu(e) {
  return !ye(e, "__v_skip") && Object.isExtensible(e) && Nu(e, "__v_skip", !0), e;
}
const Lt = (e) => (ge(e) ? gt(e) : e),
  Cs = (e) => (ge(e) ? kt(e) : e);
function we(e) {
  return e ? e.__v_isRef === !0 : !1;
}
function Le(e) {
  return Zu(e, !1);
}
function te(e) {
  return Zu(e, !0);
}
function Zu(e, t) {
  return we(e) ? e : new Tm(e, t);
}
class Tm {
  constructor(t, n) {
    (this.dep = new qi()),
      (this.__v_isRef = !0),
      (this.__v_isShallow = !1),
      (this._rawValue = n ? t : fe(t)),
      (this._value = n ? t : Lt(t)),
      (this.__v_isShallow = n);
  }
  get value() {
    return this.dep.track(), this._value;
  }
  set value(t) {
    const n = this._rawValue,
      s = this.__v_isShallow || mt(t) || qt(t);
    (t = s ? t : fe(t)),
      Ge(t, n) && ((this._rawValue = t), (this._value = s ? t : Lt(t)), this.dep.trigger());
  }
}
function wm(e) {
  e.dep && e.dep.trigger();
}
function Ke(e) {
  return we(e) ? e.value : e;
}
function re(e) {
  return Q(e) ? e() : Ke(e);
}
const Cm = {
  get: (e, t, n) => (t === "__v_raw" ? e : Ke(Reflect.get(e, t, n))),
  set: (e, t, n, s) => {
    const r = e[t];
    return we(r) && !we(n) ? ((r.value = n), !0) : Reflect.set(e, t, n, s);
  },
};
function kl(e) {
  return rn(e) ? e : new Proxy(e, Cm);
}
class Am {
  constructor(t) {
    (this.__v_isRef = !0), (this._value = void 0);
    const n = (this.dep = new qi()),
      { get: s, set: r } = t(n.track.bind(n), n.trigger.bind(n));
    (this._get = s), (this._set = r);
  }
  get value() {
    return (this._value = this._get());
  }
  set value(t) {
    this._set(t);
  }
}
function Ji(e) {
  return new Am(e);
}
function Qu(e) {
  const t = K(e) ? new Array(e.length) : {};
  for (const n in e) t[n] = tf(e, n);
  return t;
}
class Om {
  constructor(t, n, s) {
    (this._object = t),
      (this._defaultValue = s),
      (this.__v_isRef = !0),
      (this._value = void 0),
      (this._key = nt(n) ? n : String(n)),
      (this._raw = fe(t));
    let r = !0,
      i = t;
    if (!K(t) || nt(this._key) || !ji(this._key))
      do r = !xr(i) || mt(i);
      while (r && (i = i.__v_raw));
    this._shallow = r;
  }
  get value() {
    let t = this._object[this._key];
    return this._shallow && (t = Ke(t)), (this._value = t === void 0 ? this._defaultValue : t);
  }
  set value(t) {
    if (this._shallow && we(this._raw[this._key])) {
      const n = this._object[this._key];
      if (we(n)) {
        n.value = t;
        return;
      }
    }
    this._object[this._key] = t;
  }
  get dep() {
    return om(this._raw, this._key);
  }
}
class Nm {
  constructor(t) {
    (this._getter = t), (this.__v_isRef = !0), (this.__v_isReadonly = !0), (this._value = void 0);
  }
  get value() {
    return (this._value = this._getter());
  }
}
function ef(e, t, n) {
  return we(e) ? e : Q(e) ? new Nm(e) : ge(e) && arguments.length > 1 ? tf(e, t, n) : Le(e);
}
function tf(e, t, n) {
  return new Om(e, t, n);
}
class xm {
  constructor(t, n, s) {
    (this.fn = t),
      (this.setter = n),
      (this._value = void 0),
      (this.dep = new qi(this)),
      (this.__v_isRef = !0),
      (this.deps = void 0),
      (this.depsTail = void 0),
      (this.flags = 16),
      (this.globalVersion = lr - 1),
      (this.next = void 0),
      (this.effect = this),
      (this.__v_isReadonly = !n),
      (this.isSSR = s);
  }
  notify() {
    if (((this.flags |= 16), !(this.flags & 8) && Te !== this)) return Lu(this, !0), !0;
  }
  get value() {
    const t = this.dep.track();
    return Hu(this), t && (t.version = this.dep.version), this._value;
  }
  set value(t) {
    this.setter && this.setter(t);
  }
}
function Rm(e, t, n = !1) {
  let s, r;
  return Q(e) ? (s = e) : ((s = e.get), (r = e.set)), new xm(s, r, n);
}
const Im = { GET: "get", HAS: "has", ITERATE: "iterate" },
  Pm = { SET: "set", ADD: "add", DELETE: "delete", CLEAR: "clear" },
  Wr = {},
  pi = new WeakMap();
let n;
function Mm() {
  return _n;
}
function nf(e, t = !1, n = _n) {
  if (n) {
    let s = pi.get(n);
    s || pi.set(n, (s = [])), s.push(e);
  }
}
function km(e, t, n = he) {
  const { immediate: s, deep: r, once: i, scheduler: o, augmentJob: l, call: c } = n,
    u = (b) => (r ? b : mt(b) || r === !1 || r === 0 ? tn(b, 1) : tn(b));
  let a,
    f,
    d,
    h,
    m = !1,
    v = !1;
  if (
    (we(e)
      ? ((f = () => e.value), (m = mt(e)))
      : rn(e)
        ? ((f = () => u(e)), (m = !0))
        : K(e)
          ? ((v = !0),
            (m = e.some((b) => rn(b) || mt(b))),
            (f = () =>
              e.map((b) => {
                if (we(b)) return b.value;
                if (rn(b)) return u(b);
                if (Q(b)) return c ? c(b, 2) : b();
              })))
          : Q(e)
            ? t
              ? (f = c ? () => c(e, 2) : e)
              : (f = () => {
                  if (d) {
                    un();
                    try {
                      d();
                    } finally {
                      fn();
                    }
                  }
                  const b = _n;
                  _n = a;
                  try {
                    return c ? c(e, 3, [h]) : e(h);
                  } finally {
                    _n = b;
                  }
                })
            : (f = Je),
    t && r)
  ) {
    const b = f,
      T = r === !0 ? 1 / 0 : r;
    f = () => tn(b(), T);
  }
  const _ = xl(),
    S = () => {
      a.stop(), _ && _.active && Al(_.effects, a);
    };
  if (i && t) {
    const b = t;
    t = (...T) => {
      b(...T), S();
    };
  }
  let g = v ? new Array(e.length).fill(Wr) : Wr;
  const p = (b) => {
    if (!(!(a.flags & 1) || (!a.dirty && !b)))
      if (t) {
        const T = a.run();
        if (r || m || (v ? T.some((R, C) => Ge(R, g[C])) : Ge(T, g))) {
          d && d();
          const R = _n;
          _n = a;
          try {
            const C = [T, g === Wr ? void 0 : v && g[0] === Wr ? [] : g, h];
            (g = T), c ? c(t, 3, C) : t(...C);
          } finally {
            _n = R;
          }
        }
      } else a.run();
  };
  return (
    l && l(p),
    (a = new or(f)),
    (a.scheduler = o ? () => o(p, !1) : p),
    (h = (b) => nf(b, !1, a)),
    (d = a.onStop =
      () => {
        const b = pi.get(a);
        if (b) {
          if (c) c(b, 4);
          else for (const T of b) T();
          pi.delete(a);
        }
      }),
    t ? (s ? p(!0) : (g = a.run())) : o ? o(p.bind(null, !0), !0) : a.run(),
    (S.pause = a.pause.bind(a)),
    (S.resume = a.resume.bind(a)),
    (S.stop = S),
    S
  );
}
function tn(e, t = 1 / 0, n) {
  if (t <= 0 || !ge(e) || e.__v_skip || ((n = n || new Map()), (n.get(e) || 0) >= t)) return e;
  if ((n.set(e, t), t--, we(e))) tn(e.value, t, n);
  else if (K(e)) for (let s = 0; s < e.length; s++) tn(e[s], t, n);
  else if (Qn(e) || ps(e))
    e.forEach((s) => {
      tn(s, t, n);
    });
  else if (Hi(e)) {
    for (const s in e) tn(e[s], t, n);
    for (const s of Object.getOwnPropertySymbols(e))
      Object.prototype.propertyIsEnumerable.call(e, s) && tn(e[s], t, n);
  }
  return e;
}
/**
 * @vue/runtime-core v3.5.34
 * (c) 2018-present Yuxi (Evan) You and Vue contributors
 * @license MIT
 **/ const sf = [];
function Dm(e) {
  sf.push(e);
}
function Fm() {
  sf.pop();
}
function Lm(e, t) {}
const Vm = {
    SETUP_FUNCTION: 0,
    0: "SETUP_FUNCTION",
    RENDER_FUNCTION: 1,
    1: "RENDER_FUNCTION",
    NATIVE_EVENT_HANDLER: 5,
    5: "NATIVE_EVENT_HANDLER",
    COMPONENT_EVENT_HANDLER: 6,
    6: "COMPONENT_EVENT_HANDLER",
    VNODE_HOOK: 7,
    7: "VNODE_HOOK",
    DIRECTIVE_HOOK: 8,
    8: "DIRECTIVE_HOOK",
    TRANSITION_HOOK: 9,
    9: "TRANSITION_HOOK",
    APP_ERROR_HANDLER: 10,
    10: "APP_ERROR_HANDLER",
    APP_WARN_HANDLER: 11,
    11: "APP_WARN_HANDLER",
    FUNCTION_REF: 12,
    12: "FUNCTION_REF",
    ASYNC_COMPONENT_LOADER: 13,
    13: "ASYNC_COMPONENT_LOADER",
    SCHEDULER: 14,
    14: "SCHEDULER",
    COMPONENT_UPDATE: 15,
    15: "COMPONENT_UPDATE",
    APP_UNMOUNT_CLEANUP: 16,
    16: "APP_UNMOUNT_CLEANUP",
  },
  Bm = {
    sp: "serverPrefetch hook",
    bc: "beforeCreate hook",
    c: "created hook",
    bm: "beforeMount hook",
    m: "mounted hook",
    bu: "beforeUpdate hook",
    u: "updated",
    bum: "beforeUnmount hook",
    um: "unmounted hook",
    a: "activated hook",
    da: "deactivated hook",
    ec: "errorCaptured hook",
    rtc: "renderTracked hook",
    rtg: "renderTriggered hook",
    0: "setup function",
    1: "render function",
    2: "watcher getter",
    3: "watcher callback",
    4: "watcher cleanup function",
    5: "native event handler",
    6: "component event handler",
    7: "vnode hook",
    8: "directive hook",
    9: "transition hook",
    10: "app errorHandler",
    11: "app warnHandler",
    12: "ref function",
    13: "async component loader",
    14: "scheduler flush",
    15: "component update",
    16: "app unmount cleanup function",
  };
function Fs(e, t, n, s) {
  try {
    return s ? e(...s) : e();
  } catch (r) {
    ts(r, t, n);
  }
}
function It(e, t, n, s) {
  if (Q(e)) {
    const r = Fs(e, t, n, s);
    return (
      r &&
        Ol(r) &&
        r.catch((i) => {
          ts(i, t, n);
        }),
      r
    );
  }
  if (K(e)) {
    const r = [];
    for (let i = 0; i < e.length; i++) r.push(It(e[i], t, n, s));
    return r;
  }
}
function ts(e, t, n, s = !0) {
  const r = t ? t.vnode : null,
    { errorHandler: i, throwUnhandledErrorInProduction: o } = (t && t.appContext.config) || he;
  if (t) {
    let l = t.parent;
    const c = t.proxy,
      u = `https://vuejs.org/error-reference/#runtime-${n}`;
    for (; l; ) {
      const a = l.ec;
      if (a) {
        for (let f = 0; f < a.length; f++) if (a[f](e, c, u) === !1) return;
      }
      l = l.parent;
    }
    if (i) {
      un(), Fs(i, null, 10, [e, c, u]), fn();
      return;
    }
  }
  Hm(e, n, r, s, o);
}
function Hm(e, t, n, s = !0, r = !1) {
  if (r) throw e;
  console.error(e);
}
const it = [];
let $t = -1;
const ys = [];
let Sn = null,
  cs = 0;
const rf = Promise.resolve();
let mi = null;
function xn(e) {
  const t = mi || rf;
  return e ? t.then(this ? e.bind(this) : e) : t;
}
function jm(e) {
  let t = $t + 1,
    n = it.length;
  for (; t < n; ) {
    const s = (t + n) >>> 1,
      r = it[s],
      i = fr(r);
    i < e || (i === e && r.flags & 2) ? (t = s + 1) : (n = s);
  }
  return t;
}
function Dl(e) {
  if (!(e.flags & 1)) {
    const t = fr(e),
      n = it[it.length - 1];
    !n || (!(e.flags & 2) && t >= fr(n)) ? it.push(e) : it.splice(jm(t), 0, e),
      (e.flags |= 1),
      of();
  }
}
function of() {
  mi || (mi = rf.then(lf));
}
function ur(e) {
  K(e)
    ? ys.push(...e)
    : Sn && e.id === -1
      ? Sn.splice(cs + 1, 0, e)
      : e.flags & 1 || (ys.push(e), (e.flags |= 1)),
    of();
}
function Wc(e, t, n = $t + 1) {
  for (; n < it.length; n++) {
    const s = it[n];
    if (s && s.flags & 2) {
      if (e && s.id !== e.uid) continue;
      it.splice(n, 1), n--, s.flags & 4 && (s.flags &= -2), s(), s.flags & 4 || (s.flags &= -2);
    }
  }
}
function gi(e) {
  if (ys.length) {
    const t = [...new Set(ys)].sort((n, s) => fr(n) - fr(s));
    if (((ys.length = 0), Sn)) {
      Sn.push(...t);
      return;
    }
    for (Sn = t, cs = 0; cs < Sn.length; cs++) {
      const n = Sn[cs];
      n.flags & 4 && (n.flags &= -2), n.flags & 8 || n(), (n.flags &= -2);
    }
    (Sn = null), (cs = 0);
  }
}
const fr = (e) => (e.id == null ? (e.flags & 2 ? -1 : 1 / 0) : e.id);
function lf(e) {
  try {
    for ($t = 0; $t < it.length; $t++) {
      const t = it[$t];
      t &&
        !(t.flags & 8) &&
        (t.flags & 4 && (t.flags &= -2), Fs(t, t.i, t.i ? 15 : 14), t.flags & 4 || (t.flags &= -2));
    }
  } finally {
    for (; $t < it.length; $t++) {
      const t = it[$t];
      t && (t.flags &= -2);
    }
    ($t = -1), (it.length = 0), gi(), (mi = null), (it.length || ys.length) && lf();
  }
}
let as,
  Kr = [];
function cf(e, t) {
  let n, s;
  (as = e),
    as
      ? ((as.enabled = !0), Kr.forEach(({ event: r, args: i }) => as.emit(r, ...i)), (Kr = []))
      : typeof window < "u" &&
          window.HTMLElement &&
          !(
            (s = (n = window.navigator) == null ? void 0 : n.userAgent) != null &&
            s.includes("jsdom")
          )
        ? ((t.__VUE_DEVTOOLS_HOOK_REPLAY__ = t.__VUE_DEVTOOLS_HOOK_REPLAY__ || []).push((i) => {
            cf(i, t);
          }),
          setTimeout(() => {
            as || ((t.__VUE_DEVTOOLS_HOOK_REPLAY__ = null), (Kr = []));
          }, 3e3))
        : (Kr = []);
}
let Ye = null,
  Xi = null;
function hr(e) {
  const t = Ye;
  return (Ye = e), (Xi = (e && e.type.__scopeId) || null), t;
}
function $m(e) {
  Xi = e;
}
function Um() {
  Xi = null;
}
const Wm = (e) => Fl;
function Fl(e, t = Ye, n) {
  if (!t || e._n) return e;
  const s = (...r) => {
    s._d && gr(-1);
    const i = hr(t);
    let o;
    try {
      o = e(...r);
    } finally {
      hr(i), s._d && gr(1);
    }
    return o;
  };
  return (s._n = !0), (s._c = !0), (s._d = !0), s;
}
function Km(e, t) {
  if (Ye === null) return e;
  const n = kr(Ye),
    s = e.dirs || (e.dirs = []);
  for (let r = 0; r < t.length; r++) {
    let [i, o, l, c = he] = t[r];
    i &&
      (Q(i) && (i = { mounted: i, updated: i }),
      i.deep && tn(o),
      s.push({ dir: i, instance: n, value: o, oldValue: void 0, arg: l, modifiers: c }));
  }
  return e;
}
function Ut(e, t, n, s) {
  const r = e.dirs,
    i = t && t.dirs;
  for (let o = 0; o < r.length; o++) {
    const l = r[o];
    i && (l.oldValue = i[o].value);
    const c = l.dir[s];
    c && (un(), It(c, n, 8, [e.el, l, e, t]), fn());
  }
}
function vs(e, t) {
  if (ze) {
    let n = ze.provides;
    const s = ze.parent && ze.parent.provides;
    s === n && (n = ze.provides = Object.create(s)), (n[e] = t);
  }
}
function St(e, t, n = !1) {
  const s = Ve();
  if (s || Kn) {
    const r = Kn
      ? Kn._context.provides
      : s
        ? s.parent == null || s.ce
          ? s.vnode.appContext && s.vnode.appContext.provides
          : s.parent.provides
        : void 0;
    if (r && e in r) return r[e];
    if (arguments.length > 1) return n && Q(t) ? t.call(s && s.proxy) : t;
  }
}
function Ll() {
  return !!(Ve() || Kn);
}
const af = Symbol.for("v-scx"),
  uf = () => St(af);
function Vl(e, t) {
  return Rr(e, null, t);
}
function qm(e, t) {
  return Rr(e, null, { flush: "post" });
}
function ff(e, t) {
  return Rr(e, null, { flush: "sync" });
}
function de(e, t, n) {
  return Rr(e, t, n);
}
function Rr(e, t, n = he) {
  const { immediate: s, deep: r, flush: i, once: o } = n,
    l = ce({}, n),
    c = (t && s) || (!t && i !== "post");
  let u;
  if (Jn) {
    if (i === "sync") {
      const h = uf();
      u = h.__watcherHandles || (h.__watcherHandles = []);
    } else if (!c) {
      const h = () => {};
      return (h.stop = Je), (h.resume = Je), (h.pause = Je), h;
    }
  }
  const a = ze;
  l.call = (h, m, v) => It(h, a, m, v);
  let f = !1;
  i === "post"
    ? (l.scheduler = (h) => {
        De(h, a && a.suspense);
      })
    : i !== "sync" &&
      ((f = !0),
      (l.scheduler = (h, m) => {
        m ? h() : Dl(h);
      })),
    (l.augmentJob = (h) => {
      t && (h.flags |= 4), f && ((h.flags |= 2), a && ((h.id = a.uid), (h.i = a)));
    });
  const d = km(e, t, l);
  return Jn && (u ? u.push(d) : c && d()), d;
}
function Gm(e, t, n) {
  const s = this.proxy,
    r = ne(e) ? (e.includes(".") ? hf(s, e) : () => s[e]) : e.bind(s, s);
  let i;
  Q(t) ? (i = t) : ((i = t.handler), (n = t));
  const o = Ls(this),
    l = Rr(r, i.bind(s), n);
  return o(), l;
}
function hf(e, t) {
  const n = t.split(".");
  return () => {
    let s = e;
    for (let r = 0; r < n.length && s; r++) s = s[n[r]];
    return s;
  };
}
const vn = new WeakMap(),
  df = Symbol("_vte"),
  pf = (e) => e.__isTeleport,
  Vn = (e) => e && (e.disabled || e.disabled === ""),
  zm = (e) => e && (e.defer || e.defer === ""),
  Kc = (e) => typeof SVGElement < "u" && e instanceof SVGElement,
  qc = (e) => typeof MathMLElement == "function" && e instanceof MathMLElement,
  Uo = (e, t) => {
    const n = e && e.to;
    return ne(n) ? (t ? t(n) : null) : n;
  },
  Ym = {
    name: "Teleport",
    __isTeleport: !0,
    process(e, t, n, s, r, i, o, l, c, u) {
      const {
          mc: a,
          pc: f,
          pbc: d,
          o: { insert: h, querySelector: m, createText: v, createComment: _, parentNode: S },
        } = u,
        g = Vn(t.props);
      const { dynamicChildren: p } = t;
      const b = (C, A, w) => {
          C.shapeFlag & 16 && a(C.children, A, w, r, i, o, l, c);
        },
        T = (C = t) => {
          const A = Vn(C.props),
            w = (C.target = Uo(C.props, m)),
            N = Wo(w, C, v, h);
          w &&
            (o !== "svg" && Kc(w) ? (o = "svg") : o !== "mathml" && qc(w) && (o = "mathml"),
            r && r.isCE && (r.ce._teleportTargets || (r.ce._teleportTargets = new Set())).add(w),
            A || (b(C, w, N), Ks(C, !1)));
        },
        R = (C) => {
          const A = () => {
            if (vn.get(C) === A) {
              if ((vn.delete(C), Vn(C.props))) {
                const w = S(C.el) || n;
                b(C, w, C.anchor), Ks(C, !0);
              }
              T(C);
            }
          };
          vn.set(C, A), De(A, i);
        };
      if (e == null) {
        const C = (t.el = v("")),
          A = (t.anchor = v(""));
        if ((h(C, n, s), h(A, n, s), zm(t.props) || (i && i.pendingBranch))) {
          R(t);
          return;
        }
        g && (b(t, n, A), Ks(t, !0)), T();
      } else {
        t.el = e.el;
        const C = (t.anchor = e.anchor),
          A = vn.get(e);
        if (A) {
          (A.flags |= 8), vn.delete(e), R(t);
          return;
        }
        t.targetStart = e.targetStart;
        const w = (t.target = e.target),
          N = (t.targetAnchor = e.targetAnchor),
          P = Vn(e.props),
          O = P ? n : w,
          V = P ? C : N;
        if (
          (o === "svg" || Kc(w) ? (o = "svg") : (o === "mathml" || qc(w)) && (o = "mathml"),
          p
            ? (d(e.dynamicChildren, p, O, r, i, o, l), Yl(e, t, !0))
            : c || f(e, t, O, V, r, i, o, l, !1),
          g)
        )
          P
            ? t.props && e.props && t.props.to !== e.props.to && (t.props.to = e.props.to)
            : qr(t, n, C, u, 1);
        else if ((t.props && t.props.to) !== (e.props && e.props.to)) {
          const k = (t.target = Uo(t.props, m));
          k && qr(t, k, null, u, 0);
        } else P && qr(t, w, N, u, 1);
        Ks(t, g);
      }
    },
    remove(e, t, n, { um: s, o: { remove: r } }, i) {
      const {
        shapeFlag: o,
        children: l,
        anchor: c,
        targetStart: u,
        targetAnchor: a,
        target: f,
        props: d,
      } = e;
      let h = i || !Vn(d);
      const m = vn.get(e);
      if ((m && ((m.flags |= 8), vn.delete(e), (h = !1)), f && (r(u), r(a)), i && r(c), o & 16))
        for (let v = 0; v < l.length; v++) {
          const _ = l[v];
          s(_, t, n, h, !!_.dynamicChildren);
        }
    },
    move: qr,
    hydrate: Jm,
  };
function qr(e, t, n, { o: { insert: s }, m: r }, i = 2) {
  i === 0 && s(e.targetAnchor, t, n);
  const { el: o, anchor: l, shapeFlag: c, children: u, props: a } = e,
    f = i === 2;
  if ((f && s(o, t, n), !vn.has(e) && (!f || Vn(a)) && c & 16))
    for (let d = 0; d < u.length; d++) r(u[d], t, n, 2);
  f && s(l, t, n);
}
function Jm(
  e,
  t,
  n,
  s,
  r,
  i,
  { o: { nextSibling: o, parentNode: l, querySelector: c, insert: u, createText: a } },
  f
) {
  function d(_, S) {
    let g = S;
    for (; g; ) {
      if (g && g.nodeType === 8) {
        if (g.data === "teleport start anchor") t.targetStart = g;
        else if (g.data === "teleport anchor") {
          (t.targetAnchor = g), (_._lpa = t.targetAnchor && o(t.targetAnchor));
          break;
        }
      }
      g = o(g);
    }
  }
  function h(_, S) {
    S.anchor = f(o(_), S, l(_), n, s, r, i);
  }
  const m = (t.target = Uo(t.props, c)),
    v = Vn(t.props);
  if (m) {
    const _ = m._lpa || m.firstChild;
    t.shapeFlag & 16 &&
      (v
        ? (h(e, t), d(m, _), t.targetAnchor || Wo(m, t, a, u, l(e) === m ? e : null))
        : ((t.anchor = o(e)),
          d(m, _),
          t.targetAnchor || Wo(m, t, a, u),
          f(_ && o(_), t, m, n, s, r, i))),
      Ks(t, v);
  } else v && t.shapeFlag & 16 && (h(e, t), (t.targetStart = e), (t.targetAnchor = o(e)));
  return t.anchor && o(t.anchor);
}
const Xm = Ym;
function Ks(e, t) {
  const n = e.ctx;
  if (n && n.ut) {
    let s, r;
    for (
      t ? ((s = e.el), (r = e.anchor)) : ((s = e.targetStart), (r = e.targetAnchor));
      s && s !== r;

    )
      s.nodeType === 1 && s.setAttribute("data-v-owner", n.uid), (s = s.nextSibling);
    n.ut();
  }
}
function Wo(e, t, n, s, r = null) {
  const i = (t.targetStart = n("")),
    o = (t.targetAnchor = n(""));
  return (i[df] = o), e && (s(i, e, r), s(o, e, r)), o;
}
const Wt = Symbol("_leaveCb"),
  Hs = Symbol("_enterCb");
function Bl() {
  const e = { isMounted: !1, isLeaving: !1, isUnmounting: !1, leavingVNodes: new Map() };
  return (
    ns(() => {
      e.isMounted = !0;
    }),
    to(() => {
      e.isUnmounting = !0;
    }),
    e
  );
}
const At = [Function, Array],
  Hl = {
    mode: String,
    appear: Boolean,
    persisted: Boolean,
    onBeforeEnter: At,
    onEnter: At,
    onAfterEnter: At,
    onEnterCancelled: At,
    onBeforeLeave: At,
    onLeave: At,
    onAfterLeave: At,
    onLeaveCancelled: At,
    onBeforeAppear: At,
    onAppear: At,
    onAfterAppear: At,
    onAppearCancelled: At,
  },
  mf = (e) => {
    const t = e.subTree;
    return t.component ? mf(t.component) : t;
  },
  Zm = {
    name: "BaseTransition",
    props: Hl,
    setup(e, { slots: t }) {
      const n = Ve(),
        s = Bl();
      return () => {
        const r = t.default && Zi(t.default(), !0),
          i = r && r.length ? gf(r) : n.subTree ? eh() : void 0;
        if (!i) return;
        const o = fe(e),
          { mode: l } = o;
        if (s.isLeaving) return _o(i);
        const c = Gc(i);
        if (!c) return _o(i);
        let u = As(c, o, s, n, (f) => (u = f));
        c.type !== Pe && hn(c, u);
        let a = n.subTree && Gc(n.subTree);
        if (a && a.type !== Pe && !Mt(a, c) && mf(n).type !== Pe) {
          const f = As(a, o, s, n);
          if ((hn(a, f), l === "out-in" && c.type !== Pe))
            return (
              (s.isLeaving = !0),
              (f.afterLeave = () => {
                (s.isLeaving = !1),
                  n.job.flags & 8 || n.update(),
                  delete f.afterLeave,
                  (a = void 0);
              }),
              _o(i)
            );
          l === "in-out" && c.type !== Pe
            ? (f.delayLeave = (d, h, m) => {
                const v = vf(s, a);
                (v[String(a.key)] = a),
                  (d[Wt] = () => {
                    h(), (d[Wt] = void 0), delete u.delayedLeave, (a = void 0);
                  }),
                  (u.delayedLeave = () => {
                    m(), delete u.delayedLeave, (a = void 0);
                  });
              })
            : (a = void 0);
        } else a && (a = void 0);
        return i;
      };
    },
  };
function gf(e) {
  let t = e[0];
  if (e.length > 1) {
    for (const n of e)
      if (n.type !== Pe) {
        t = n;
        break;
      }
  }
  return t;
}
const yf = Zm;
function vf(e, t) {
  const { leavingVNodes: n } = e;
  let s = n.get(t.type);
  return s || ((s = Object.create(null)), n.set(t.type, s)), s;
}
function As(e, t, n, s, r) {
  const {
      appear: i,
      mode: o,
      persisted: l = !1,
      onBeforeEnter: c,
      onEnter: u,
      onAfterEnter: a,
      onEnterCancelled: f,
      onBeforeLeave: d,
      onLeave: h,
      onAfterLeave: m,
      onLeaveCancelled: v,
      onBeforeAppear: _,
      onAppear: S,
      onAfterAppear: g,
      onAppearCancelled: p,
    } = t,
    b = String(e.key),
    T = vf(n, e),
    R = (w, N) => {
      w && It(w, s, 9, N);
    },
    C = (w, N) => {
      const P = N[1];
      R(w, N), K(w) ? w.every((O) => O.length <= 1) && P() : w.length <= 1 && P();
    },
    A = {
      mode: o,
      persisted: l,
      beforeEnter(w) {
        let N = c;
        if (!n.isMounted)
          if (i) N = _ || c;
          else return;
        w[Wt] && w[Wt](!0);
        const P = T[b];
        P && Mt(e, P) && P.el[Wt] && P.el[Wt](), R(N, [w]);
      },
      enter(w) {
        if (T[b] === e) return;
        let N = u,
          P = a,
          O = f;
        if (!n.isMounted)
          if (i) (N = S || u), (P = g || a), (O = p || f);
          else return;
        let V = !1;
        w[Hs] = ($) => {
          V ||
            ((V = !0),
            $ ? R(O, [w]) : R(P, [w]),
            A.delayedLeave && A.delayedLeave(),
            (w[Hs] = void 0));
        };
        const k = w[Hs].bind(null, !1);
        N ? C(N, [w, k]) : k();
      },
      leave(w, N) {
        const P = String(e.key);
        if ((w[Hs] && w[Hs](!0), n.isUnmounting)) return N();
        R(d, [w]);
        let O = !1;
        w[Wt] = (k) => {
          O ||
            ((O = !0), N(), k ? R(v, [w]) : R(m, [w]), (w[Wt] = void 0), T[P] === e && delete T[P]);
        };
        const V = w[Wt].bind(null, !1);
        (T[P] = e), h ? C(h, [w, V]) : V();
      },
      clone(w) {
        const N = As(w, t, n, s, r);
        return r && r(N), N;
      },
    };
  return A;
}
function _o(e) {
  if (Pr(e)) return (e = Gt(e)), (e.children = null), e;
}
function Gc(e) {
  if (!Pr(e)) return pf(e.type) && e.children ? gf(e.children) : e;
  if (e.component) return e.component.subTree;
  const { shapeFlag: t, children: n } = e;
  if (n) {
    if (t & 16) return n[0];
    if (t & 32 && Q(n.default)) return n.default();
  }
}
function hn(e, t) {
  e.shapeFlag & 6 && e.component
    ? ((e.transition = t), hn(e.component.subTree, t))
    : e.shapeFlag & 128
      ? ((e.ssContent.transition = t.clone(e.ssContent)),
        (e.ssFallback.transition = t.clone(e.ssFallback)))
      : (e.transition = t);
}
function Zi(e, t = !1, n) {
  let s = [],
    r = 0;
  for (let i = 0; i < e.length; i++) {
    const o = e[i];
    const l = n == null ? o.key : String(n) + String(o.key != null ? o.key : i);
    o.type === We
      ? (o.patchFlag & 128 && r++, (s = s.concat(Zi(o.children, t, l))))
      : (t || o.type !== Pe) && s.push(l != null ? Gt(o, { key: l }) : o);
  }
  if (r > 1) for (let i = 0; i < s.length; i++) s[i].patchFlag = -2;
  return s;
}
function Ir(e, t) {
  return Q(e) ? ce({ name: e.name }, t, { setup: e }) : e;
}
function Qm() {
  const e = Ve();
  return e ? `${e.appContext.config.idPrefix || "v"  }-${  e.ids[0]  }${e.ids[1]++}` : "";
}
function jl(e) {
  e.ids = [`${e.ids[0] + e.ids[2]++  }-`, 0, 0];
}
function eg(e) {
  const t = Ve(),
    n = te(null);
  if (t) {
    const r = t.refs === he ? (t.refs = {}) : t.refs;
    Object.defineProperty(r, e, { enumerable: !0, get: () => n.value, set: (i) => (n.value = i) });
  }
  return n;
}
function zc(e, t) {
  let n;
  return !!((n = Object.getOwnPropertyDescriptor(e, t)) && !n.configurable);
}
const yi = new WeakMap();
function bs(e, t, n, s, r = !1) {
  if (K(e)) {
    e.forEach((v, _) => bs(v, t && (K(t) ? t[_] : t), n, s, r));
    return;
  }
  if (on(s) && !r) {
    s.shapeFlag & 512 &&
      s.type.__asyncResolved &&
      s.component.subTree.component &&
      bs(e, t, n, s.component.subTree);
    return;
  }
  const i = s.shapeFlag & 4 ? kr(s.component) : s.el,
    o = r ? null : i,
    { i: l, r: c } = e,
    u = t && t.r,
    a = l.refs === he ? (l.refs = {}) : l.refs,
    f = l.setupState,
    d = fe(f),
    h = f === he ? fs : (v) => (zc(a, v) ? !1 : ye(d, v)),
    m = (v, _) => !(_ && zc(a, _));
  if (u != null && u !== c) {
    if ((Yc(t), ne(u))) (a[u] = null), h(u) && (f[u] = null);
    else if (we(u)) {
      const v = t;
      m(u, v.k) && (u.value = null), v.k && (a[v.k] = null);
    }
  }
  if (Q(c)) Fs(c, l, 12, [o, a]);
  else {
    const v = ne(c),
      _ = we(c);
    if (v || _) {
      const S = () => {
        if (e.f) {
          const g = v ? (h(c) ? f[c] : a[c]) : m() || !e.k ? c.value : a[e.k];
          if (r) K(g) && Al(g, i);
          else if (K(g)) g.includes(i) || g.push(i);
          else if (v) (a[c] = [i]), h(c) && (f[c] = a[c]);
          else {
            const p = [i];
            m(c, e.k) && (c.value = p), e.k && (a[e.k] = p);
          }
        } else
          v
            ? ((a[c] = o), h(c) && (f[c] = o))
            : _ && (m(c, e.k) && (c.value = o), e.k && (a[e.k] = o));
      };
      if (o) {
        const g = () => {
          S(), yi.delete(e);
        };
        (g.id = -1), yi.set(e, g), De(g, n);
      } else Yc(e), S();
    }
  }
}
function Yc(e) {
  const t = yi.get(e);
  t && ((t.flags |= 8), yi.delete(e));
}
let Jc = !1;
const os = () => {
    Jc || (console.error("Hydration completed but contains mismatches."), (Jc = !0));
  },
  tg = (e) => e.namespaceURI.includes("svg") && e.tagName !== "foreignObject",
  ng = (e) => e.namespaceURI.includes("MathML"),
  Gr = (e) => {
    if (e.nodeType === 1) {
      if (tg(e)) return "svg";
      if (ng(e)) return "mathml";
    }
  },
  hs = (e) => e.nodeType === 8;
function sg(e) {
  const {
      mt: t,
      p: n,
      o: {
        patchProp: s,
        createText: r,
        nextSibling: i,
        parentNode: o,
        remove: l,
        insert: c,
        createComment: u,
      },
    } = e,
    a = (p, b) => {
      if (!b.hasChildNodes()) {
        n(null, p, b), gi(), (b._vnode = p);
        return;
      }
      f(b.firstChild, p, null, null, null), gi(), (b._vnode = p);
    },
    f = (p, b, T, R, C, A = !1) => {
      A = A || !!b.dynamicChildren;
      const w = hs(p) && p.data === "[",
        N = () => v(p, b, T, R, C, w),
        { type: P, ref: O, shapeFlag: V, patchFlag: k } = b;
      let $ = p.nodeType;
      (b.el = p), k === -2 && ((A = !1), (b.dynamicChildren = null));
      let B = null;
      switch (P) {
        case Cn:
          $ !== 3
            ? b.children === ""
              ? (c((b.el = r("")), o(p), p), (B = p))
              : (B = N())
            : (p.data !== b.children && (os(), (p.data = b.children)), (B = i(p)));
          break;
        case Pe:
          g(p)
            ? ((B = i(p)), S((b.el = p.content.firstChild), p, T))
            : $ !== 8 || w
              ? (B = N())
              : (B = i(p));
          break;
        case qn:
          if ((w && ((p = i(p)), ($ = p.nodeType)), $ === 1 || $ === 3)) {
            B = p;
            const J = !b.children.length;
            for (let q = 0; q < b.staticCount; q++)
              J && (b.children += B.nodeType === 1 ? B.outerHTML : B.data),
                q === b.staticCount - 1 && (b.anchor = B),
                (B = i(B));
            return w ? i(B) : B;
          } else N();
          break;
        case We:
          w ? (B = m(p, b, T, R, C, A)) : (B = N());
          break;
        default:
          if (V & 1)
            ($ !== 1 || b.type.toLowerCase() !== p.tagName.toLowerCase()) && !g(p)
              ? (B = N())
              : (B = d(p, b, T, R, C, A));
          else if (V & 6) {
            b.slotScopeIds = C;
            const J = o(p);
            if (
              (w
                ? (B = _(p))
                : hs(p) && p.data === "teleport start"
                  ? (B = _(p, p.data, "teleport end"))
                  : (B = i(p)),
              t(b, J, null, T, R, Gr(J), A),
              on(b) && !b.type.__asyncResolved)
            ) {
              let q;
              w
                ? ((q = Ne(We)), (q.anchor = B ? B.previousSibling : J.lastChild))
                : (q = p.nodeType === 3 ? Xl("") : Ne("div")),
                (q.el = p),
                (b.component.subTree = q);
            }
          } else
            V & 64
              ? $ !== 8
                ? (B = N())
                : (B = b.type.hydrate(p, b, T, R, C, A, e, h))
              : V & 128 && (B = b.type.hydrate(p, b, T, R, Gr(o(p)), C, A, e, f));
      }
      return O != null && bs(O, null, R, b), B;
    },
    d = (p, b, T, R, C, A) => {
      A = A || !!b.dynamicChildren;
      const { type: w, props: N, patchFlag: P, shapeFlag: O, dirs: V, transition: k } = b,
        $ = w === "input" || w === "option";
      if ($ || P !== -1) {
        V && Ut(b, null, T, "created");
        let B = !1;
        if (g(p)) {
          B = Kf(null, k) && T && T.vnode.props && T.vnode.props.appear;
          const q = p.content.firstChild;
          if (B) {
            const pe = q.getAttribute("class");
            pe && (q.$cls = pe), k.beforeEnter(q);
          }
          S(q, p, T), (b.el = p = q);
        }
        if (O & 16 && !(N && (N.innerHTML || N.textContent))) {
          let q = h(p.firstChild, b, p, T, R, C, A);
          for (; q; ) {
            zr(p, 1) || os();
            const pe = q;
            (q = q.nextSibling), l(pe);
          }
        } else if (O & 8) {
          let q = b.children;
          q[0] ===
            `
` &&
            (p.tagName === "PRE" || p.tagName === "TEXTAREA") &&
            (q = q.slice(1));
          const { textContent: pe } = p;
          pe !== q &&
            pe !==
              q.replace(
                /\r\n|\r/g,
                `
`
              ) &&
            (zr(p, 0) || os(), (p.textContent = b.children));
        }
        if (N) {
          if ($ || !A || P & 48) {
            const q = p.tagName.includes("-");
            for (const pe in N)
              (($ && (pe.endsWith("value") || pe === "indeterminate")) ||
                (Zn(pe) && !sn(pe)) ||
                pe[0] === "." ||
                (q && !sn(pe))) &&
                s(p, pe, null, N[pe], void 0, T);
          } else if (N.onClick) s(p, "onClick", null, N.onClick, void 0, T);
          else if (P & 4 && rn(N.style)) for (const q in N.style) N.style[q];
        }
        let J;
        (J = N && N.onVnodeBeforeMount) && ut(J, T, b),
          V && Ut(b, null, T, "beforeMount"),
          ((J = N && N.onVnodeMounted) || V || B) &&
            Yf(() => {
              J && ut(J, T, b), B && k.enter(p), V && Ut(b, null, T, "mounted");
            }, R);
      }
      return p.nextSibling;
    },
    h = (p, b, T, R, C, A, w) => {
      w = w || !!b.dynamicChildren;
      const N = b.children,
        P = N.length;
      for (let O = 0; O < P; O++) {
        const V = w ? N[O] : (N[O] = ht(N[O])),
          k = V.type === Cn;
        p
          ? (k &&
              !w &&
              O + 1 < P &&
              ht(N[O + 1]).type === Cn &&
              (c(r(p.data.slice(V.children.length)), T, i(p)), (p.data = V.children)),
            (p = f(p, V, R, C, A, w)))
          : k && !V.children
            ? c((V.el = r("")), T)
            : (zr(T, 1) || os(), n(null, V, T, null, R, C, Gr(T), A));
      }
      return p;
    },
    m = (p, b, T, R, C, A) => {
      const { slotScopeIds: w } = b;
      w && (C = C ? C.concat(w) : w);
      const N = o(p),
        P = h(i(p), b, N, T, R, C, A);
      return P && hs(P) && P.data === "]"
        ? i((b.anchor = P))
        : (os(), c((b.anchor = u("]")), N, P), P);
    },
    v = (p, b, T, R, C, A) => {
      if ((zr(p.parentElement, 1) || os(), (b.el = null), A)) {
        const P = _(p);
        for (;;) {
          const O = i(p);
          if (O && O !== P) l(O);
          else break;
        }
      }
      const w = i(p),
        N = o(p);
      return l(p), n(null, b, N, w, T, R, Gr(N), C), T && ((T.vnode.el = b.el), so(T, b.el)), w;
    },
    _ = (p, b = "[", T = "]") => {
      let R = 0;
      for (; p; )
        if (((p = i(p)), p && hs(p) && (p.data === b && R++, p.data === T))) {
          if (R === 0) return i(p);
          R--;
        }
      return p;
    },
    S = (p, b, T) => {
      const R = b.parentNode;
      R && R.replaceChild(p, b);
      let C = T;
      for (; C; ) C.vnode.el === b && (C.vnode.el = C.subTree.el = p), (C = C.parent);
    },
    g = (p) => p.nodeType === 1 && p.tagName === "TEMPLATE";
  return [a, f];
}
const Xc = "data-allow-mismatch",
  rg = { 0: "text", 1: "children", 2: "class", 3: "style", 4: "attribute" };
function zr(e, t) {
  if (t === 0 || t === 1) for (; e && !e.hasAttribute(Xc); ) e = e.parentElement;
  const n = e && e.getAttribute(Xc);
  if (n == null) return !1;
  if (n === "") return !0;
  {
    const s = n.split(",");
    return t === 0 && s.includes("children") ? !0 : s.includes(rg[t]);
  }
}
const ig = Wi().requestIdleCallback || ((e) => setTimeout(e, 1)),
  og = Wi().cancelIdleCallback || ((e) => clearTimeout(e)),
  lg =
    (e = 1e4) =>
    (t) => {
      const n = ig(t, { timeout: e });
      return () => og(n);
    };
function cg(e) {
  const { top: t, left: n, bottom: s, right: r } = e.getBoundingClientRect(),
    { innerHeight: i, innerWidth: o } = window;
  return ((t > 0 && t < i) || (s > 0 && s < i)) && ((n > 0 && n < o) || (r > 0 && r < o));
}
const ag = (e) => (t, n) => {
    const s = new IntersectionObserver((r) => {
      for (const i of r)
        if (i.isIntersecting) {
          s.disconnect(), t();
          break;
        }
    }, e);
    return (
      n((r) => {
        if (r instanceof Element) {
          if (cg(r)) return t(), s.disconnect(), !1;
          s.observe(r);
        }
      }),
      () => s.disconnect()
    );
  },
  ug = (e) => (t) => {
    if (e) {
      const n = matchMedia(e);
      if (n.matches) t();
      else
        return (
          n.addEventListener("change", t, { once: !0 }), () => n.removeEventListener("change", t)
        );
    }
  },
  fg =
    (e = []) =>
    (t, n) => {
      ne(e) && (e = [e]);
      let s = !1;
      const r = (o) => {
          s || ((s = !0), i(), t(), o.target.dispatchEvent(new o.constructor(o.type, o)));
        },
        i = () => {
          n((o) => {
            for (const l of e) o.removeEventListener(l, r);
          });
        };
      return (
        n((o) => {
          for (const l of e) o.addEventListener(l, r, { once: !0 });
        }),
        i
      );
    };
function hg(e, t) {
  if (hs(e) && e.data === "[") {
    let n = 1,
      s = e.nextSibling;
    for (; s; ) {
      if (s.nodeType === 1) {
        if (t(s) === !1) break;
      } else if (hs(s))
        if (s.data === "]") {
          if (--n === 0) break;
        } else s.data === "[" && n++;
      s = s.nextSibling;
    }
  } else t(e);
}
const on = (e) => !!e.type.__asyncLoader;
function dg(e) {
  Q(e) && (e = { loader: e });
  const {
    loader: t,
    loadingComponent: n,
    errorComponent: s,
    delay: r = 200,
    hydrate: i,
    timeout: o,
    suspensible: l = !0,
    onError: c,
  } = e;
  let u = null,
    a,
    f = 0;
  const d = () => (f++, (u = null), h()),
    h = () => {
      let m;
      return (
        u ||
        (m = u =
          t()
            .catch((v) => {
              if (((v = v instanceof Error ? v : new Error(String(v))), c))
                return new Promise((_, S) => {
                  c(
                    v,
                    () => _(d()),
                    () => S(v),
                    f + 1
                  );
                });
              throw v;
            })
            .then((v) =>
              m !== u && u
                ? u
                : (v && (v.__esModule || v[Symbol.toStringTag] === "Module") && (v = v.default),
                  (a = v),
                  v)
            ))
      );
    };
  return Ir({
    name: "AsyncComponentWrapper",
    __asyncLoader: h,
    __asyncHydrate(m, v, _) {
      let S = !1;
      (v.bu || (v.bu = [])).push(() => (S = !0));
      const g = () => {
          S || _();
        },
        p = i
          ? () => {
              const b = i(g, (T) => hg(m, T));
              b && (v.bum || (v.bum = [])).push(b);
            }
          : g;
      a ? p() : h().then(() => !v.isUnmounted && p());
    },
    get __asyncResolved() {
      return a;
    },
    setup() {
      const m = ze;
      if ((jl(m), a)) return () => Yr(a, m);
      const v = (p) => {
        (u = null), ts(p, m, 13, !s);
      };
      if ((l && m.suspense) || Jn)
        return h()
          .then((p) => () => Yr(p, m))
          .catch((p) => (v(p), () => (s ? Ne(s, { error: p }) : null)));
      const _ = Le(!1),
        S = Le(),
        g = Le(!!r);
      return (
        r &&
          setTimeout(() => {
            g.value = !1;
          }, r),
        o != null &&
          setTimeout(() => {
            if (!_.value && !S.value) {
              const p = new Error(`Async component timed out after ${o}ms.`);
              v(p), (S.value = p);
            }
          }, o),
        h()
          .then(() => {
            (_.value = !0), m.parent && Pr(m.parent.vnode) && m.parent.update();
          })
          .catch((p) => {
            v(p), (S.value = p);
          }),
        () => {
          if (_.value && a) return Yr(a, m);
          if (S.value && s) return Ne(s, { error: S.value });
          if (n && !g.value) return Yr(n, m);
        }
      );
    },
  });
}
function Yr(e, t) {
  const { ref: n, props: s, children: r, ce: i } = t.vnode,
    o = Ne(e, s, r);
  return (o.ref = n), (o.ce = i), delete t.vnode.ce, o;
}
const Pr = (e) => e.type.__isKeepAlive,
  pg = {
    name: "KeepAlive",
    __isKeepAlive: !0,
    props: {
      include: [String, RegExp, Array],
      exclude: [String, RegExp, Array],
      max: [String, Number],
    },
    setup(e, { slots: t }) {
      const n = Ve(),
        s = n.ctx;
      if (!s.renderer)
        return () => {
          const g = t.default && t.default();
          return g && g.length === 1 ? g[0] : g;
        };
      const r = new Map(),
        i = new Set();
      let o = null;
      const l = n.suspense,
        {
          renderer: {
            p: c,
            m: u,
            um: a,
            o: { createElement: f },
          },
        } = s,
        d = f("div");
      (s.activate = (g, p, b, T, R) => {
        const C = g.component;
        u(g, p, b, 0, l),
          c(C.vnode, g, p, b, C, l, T, g.slotScopeIds, R),
          De(() => {
            (C.isDeactivated = !1), C.a && gs(C.a);
            const A = g.props && g.props.onVnodeMounted;
            A && ut(A, C.parent, g);
          }, l);
      }),
        (s.deactivate = (g) => {
          const p = g.component;
          bi(p.m),
            bi(p.a),
            u(g, d, null, 1, l),
            De(() => {
              p.da && gs(p.da);
              const b = g.props && g.props.onVnodeUnmounted;
              b && ut(b, p.parent, g), (p.isDeactivated = !0);
            }, l);
        });
      function h(g) {
        So(g), a(g, n, l, !0);
      }
      function m(g) {
        r.forEach((p, b) => {
          const T = Qo(on(p) ? p.type.__asyncResolved || {} : p.type);
          T && !g(T) && v(b);
        });
      }
      function v(g) {
        const p = r.get(g);
        p && (!o || !Mt(p, o)) ? h(p) : o && So(o), r.delete(g), i.delete(g);
      }
      de(
        () => [e.include, e.exclude],
        ([g, p]) => {
          g && m((b) => qs(g, b)), p && m((b) => !qs(p, b));
        },
        { flush: "post", deep: !0 }
      );
      let _ = null;
      const S = () => {
        _ != null &&
          (_i(n.subTree.type)
            ? De(() => {
                r.set(_, Jr(n.subTree));
              }, n.subTree.suspense)
            : r.set(_, Jr(n.subTree)));
      };
      return (
        ns(S),
        eo(S),
        to(() => {
          r.forEach((g) => {
            const { subTree: p, suspense: b } = n,
              T = Jr(p);
            if (g.type === T.type && g.key === T.key) {
              So(T);
              const R = T.component.da;
              R && De(R, b);
              return;
            }
            h(g);
          });
        }),
        () => {
          if (((_ = null), !t.default)) return (o = null);
          const g = t.default(),
            p = g[0];
          if (g.length > 1) return (o = null), g;
          if (!dn(p) || (!(p.shapeFlag & 4) && !(p.shapeFlag & 128))) return (o = null), p;
          let b = Jr(p);
          if (b.type === Pe) return (o = null), b;
          const T = b.type,
            R = Qo(on(b) ? b.type.__asyncResolved || {} : T),
            { include: C, exclude: A, max: w } = e;
          if ((C && (!R || !qs(C, R))) || (A && R && qs(A, R)))
            return (b.shapeFlag &= -257), (o = b), p;
          const N = b.key == null ? T : b.key,
            P = r.get(N);
          return (
            b.el && ((b = Gt(b)), p.shapeFlag & 128 && (p.ssContent = b)),
            (_ = N),
            P
              ? ((b.el = P.el),
                (b.component = P.component),
                b.transition && hn(b, b.transition),
                (b.shapeFlag |= 512),
                i.delete(N),
                i.add(N))
              : (i.add(N), w && i.size > parseInt(w, 10) && v(i.values().next().value)),
            (b.shapeFlag |= 256),
            (o = b),
            _i(p.type) ? p : b
          );
        }
      );
    },
  },
  mg = pg;
function qs(e, t) {
  return K(e)
    ? e.some((n) => qs(n, t))
    : ne(e)
      ? e.split(",").includes(t)
      : Pp(e)
        ? ((e.lastIndex = 0), e.test(t))
        : !1;
}
function bf(e, t) {
  Sf(e, "a", t);
}
function _f(e, t) {
  Sf(e, "da", t);
}
function Sf(e, t, n = ze) {
  const s =
    e.__wdc ||
    (e.__wdc = () => {
      let r = n;
      for (; r; ) {
        if (r.isDeactivated) return;
        r = r.parent;
      }
      return e();
    });
  if ((Qi(t, s, n), n)) {
    let r = n.parent;
    for (; r && r.parent; ) Pr(r.parent.vnode) && gg(s, t, n, r), (r = r.parent);
  }
}
function gg(e, t, n, s) {
  const r = Qi(t, e, s, !0);
  Mr(() => {
    Al(s[t], r);
  }, n);
}
function So(e) {
  (e.shapeFlag &= -257), (e.shapeFlag &= -513);
}
function Jr(e) {
  return e.shapeFlag & 128 ? e.ssContent : e;
}
function Qi(e, t, n = ze, s = !1) {
  if (n) {
    const r = n[e] || (n[e] = []),
      i =
        t.__weh ||
        (t.__weh = (...o) => {
          un();
          const l = Ls(n),
            c = It(t, n, e, o);
          return l(), fn(), c;
        });
    return s ? r.unshift(i) : r.push(i), i;
  }
}
const pn =
    (e) =>
    (t, n = ze) => {
      (!Jn || e === "sp") && Qi(e, (...s) => t(...s), n);
    },
  Ef = pn("bm"),
  ns = pn("m"),
  $l = pn("bu"),
  eo = pn("u"),
  to = pn("bum"),
  Mr = pn("um"),
  Tf = pn("sp"),
  wf = pn("rtg"),
  Cf = pn("rtc");
function Af(e, t = ze) {
  Qi("ec", e, t);
}
const Ul = "components",
  yg = "directives";
function vg(e, t) {
  return Wl(Ul, e, !0, t) || e;
}
const Of = Symbol.for("v-ndc");
function bg(e) {
  return ne(e) ? Wl(Ul, e, !1) || e : e || Of;
}
function _g(e) {
  return Wl(yg, e);
}
function Wl(e, t, n = !0, s = !1) {
  const r = Ye || ze;
  if (r) {
    const i = r.type;
    if (e === Ul) {
      const l = Qo(i, !1);
      if (l && (l === t || l === _e(t) || l === es(_e(t)))) return i;
    }
    const o = Zc(r[e] || i[e], t) || Zc(r.appContext[e], t);
    return !o && s ? i : o;
  }
}
function Zc(e, t) {
  return e && (e[t] || e[_e(t)] || e[es(_e(t))]);
}
function Sg(e, t, n, s) {
  let r;
  const i = n && n[s],
    o = K(e);
  if (o || ne(e)) {
    const l = o && rn(e);
    let c = !1,
      u = !1;
    l && ((c = !mt(e)), (u = qt(e)), (e = Gi(e))), (r = new Array(e.length));
    for (let a = 0, f = e.length; a < f; a++)
      r[a] = t(c ? (u ? Cs(Lt(e[a])) : Lt(e[a])) : e[a], a, void 0, i && i[a]);
  } else if (typeof e == "number") {
    r = new Array(e);
    for (let l = 0; l < e; l++) r[l] = t(l + 1, l, void 0, i && i[l]);
  } else if (ge(e))
    if (e[Symbol.iterator]) r = Array.from(e, (l, c) => t(l, c, void 0, i && i[c]));
    else {
      const l = Object.keys(e);
      r = new Array(l.length);
      for (let c = 0, u = l.length; c < u; c++) {
        const a = l[c];
        r[c] = t(e[a], a, c, i && i[c]);
      }
    }
  else r = [];
  return n && (n[s] = r), r;
}
function Eg(e, t) {
  for (let n = 0; n < t.length; n++) {
    const s = t[n];
    if (K(s)) for (let r = 0; r < s.length; r++) e[s[r].name] = s[r].fn;
    else
      s &&
        (e[s.name] = s.key
          ? (...r) => {
              const i = s.fn(...r);
              return i && (i.key = s.key), i;
            }
          : s.fn);
  }
  return e;
}
function Tg(e, t, n = {}, s, r) {
  if (Ye.ce || (Ye.parent && on(Ye.parent) && Ye.parent.ce)) {
    const u = Object.keys(n).length > 0;
    return (
      t !== "default" && (n.name = t), mr(), Si(We, null, [Ne("slot", n, s && s())], u ? -2 : 64)
    );
  }
  const i = e[t];
  i && i._c && (i._d = !1), mr();
  const o = i && Kl(i(n)),
    l = n.key || (o && o.key),
    c = Si(
      We,
      { key: (l && !nt(l) ? l : `_${t}`) + (!o && s ? "_fb" : "") },
      o || (s ? s() : []),
      o && e._ === 1 ? 64 : -2
    );
  return !r && c.scopeId && (c.slotScopeIds = [`${c.scopeId  }-s`]), i && i._c && (i._d = !0), c;
}
function Kl(e) {
  return e.some((t) => (dn(t) ? !(t.type === Pe || (t.type === We && !Kl(t.children))) : !0))
    ? e
    : null;
}
function wg(e, t) {
  const n = {};
  for (const s in e) n[t && /[A-Z]/.test(s) ? `on:${s}` : ms(s)] = e[s];
  return n;
}
const Ko = (e) => (e ? (sh(e) ? kr(e) : Ko(e.parent)) : null),
  Xs = ce(Object.create(null), {
    $: (e) => e,
    $el: (e) => e.vnode.el,
    $data: (e) => e.data,
    $props: (e) => e.props,
    $attrs: (e) => e.attrs,
    $slots: (e) => e.slots,
    $refs: (e) => e.refs,
    $parent: (e) => Ko(e.parent),
    $root: (e) => Ko(e.root),
    $host: (e) => e.ce,
    $emit: (e) => e.emit,
    $options: (e) => ql(e),
    $forceUpdate: (e) =>
      e.f ||
      (e.f = () => {
        Dl(e.update);
      }),
    $nextTick: (e) => e.n || (e.n = xn.bind(e.proxy)),
    $watch: (e) => Gm.bind(e),
  }),
  Eo = (e, t) => e !== he && !e.__isScriptSetup && ye(e, t),
  qo = {
    get({ _: e }, t) {
      if (t === "__v_skip") return !0;
      const {
        ctx: n,
        setupState: s,
        data: r,
        props: i,
        accessCache: o,
        type: l,
        appContext: c,
      } = e;
      if (t[0] !== "$") {
        const d = o[t];
        if (d !== void 0)
          switch (d) {
            case 1:
              return s[t];
            case 2:
              return r[t];
            case 4:
              return n[t];
            case 3:
              return i[t];
          }
        else {
          if (Eo(s, t)) return (o[t] = 1), s[t];
          if (r !== he && ye(r, t)) return (o[t] = 2), r[t];
          if (ye(i, t)) return (o[t] = 3), i[t];
          if (n !== he && ye(n, t)) return (o[t] = 4), n[t];
          Go && (o[t] = 0);
        }
      }
      const u = Xs[t];
      let a, f;
      if (u) return t === "$attrs" && Qe(e.attrs, "get", ""), u(e);
      if ((a = l.__cssModules) && (a = a[t])) return a;
      if (n !== he && ye(n, t)) return (o[t] = 4), n[t];
      if (((f = c.config.globalProperties), ye(f, t))) return f[t];
    },
    set({ _: e }, t, n) {
      const { data: s, setupState: r, ctx: i } = e;
      return Eo(r, t)
        ? ((r[t] = n), !0)
        : s !== he && ye(s, t)
          ? ((s[t] = n), !0)
          : ye(e.props, t) || (t[0] === "$" && t.slice(1) in e)
            ? !1
            : ((i[t] = n), !0);
    },
    has(
      { _: { data: e, setupState: t, accessCache: n, ctx: s, appContext: r, props: i, type: o } },
      l
    ) {
      let c;
      return !!(
        n[l] ||
        (e !== he && l[0] !== "$" && ye(e, l)) ||
        Eo(t, l) ||
        ye(i, l) ||
        ye(s, l) ||
        ye(Xs, l) ||
        ye(r.config.globalProperties, l) ||
        ((c = o.__cssModules) && c[l])
      );
    },
    defineProperty(e, t, n) {
      return (
        n.get != null ? (e._.accessCache[t] = 0) : ye(n, "value") && this.set(e, t, n.value, null),
        Reflect.defineProperty(e, t, n)
      );
    },
  },
  Cg = ce({}, qo, {
    get(e, t) {
      if (t !== Symbol.unscopables) return qo.get(e, t, e);
    },
    has(e, t) {
      return t[0] !== "_" && !Bp(t);
    },
  });
function Ag() {
  return null;
}
function Og() {
  return null;
}
function Ng(e) {}
function xg(e) {}
function Rg() {
  return null;
}
function Ig() {}
function Pg(e, t) {
  return null;
}
function Mg() {
  return Nf().slots;
}
function kg() {
  return Nf().attrs;
}
function Nf(e) {
  const t = Ve();
  return t.setupContext || (t.setupContext = lh(t));
}
function dr(e) {
  return K(e) ? e.reduce((t, n) => ((t[n] = null), t), {}) : e;
}
function Dg(e, t) {
  const n = dr(e);
  for (const s in t) {
    if (s.startsWith("__skip")) continue;
    let r = n[s];
    r
      ? K(r) || Q(r)
        ? (r = n[s] = { type: r, default: t[s] })
        : (r.default = t[s])
      : r === null && (r = n[s] = { default: t[s] }),
      r && t[`__skip_${s}`] && (r.skipFactory = !0);
  }
  return n;
}
function Fg(e, t) {
  return !e || !t ? e || t : K(e) && K(t) ? e.concat(t) : ce({}, dr(e), dr(t));
}
function Lg(e, t) {
  const n = {};
  for (const s in e)
    t.includes(s) || Object.defineProperty(n, s, { enumerable: !0, get: () => e[s] });
  return n;
}
function Vg(e) {
  const t = Ve(),
    n = Jn;
  let s = e();
  yr(), n && Ss(!1);
  const r = () => {
      Ls(t), n && Ss(!0);
    },
    i = () => {
      Ve() !== t && t.scope.off(), yr(), n && Ss(!1);
    };
  return (
    Ol(s) &&
      (s = s.catch((o) => {
        throw (r(), Promise.resolve().then(() => Promise.resolve().then(i)), o);
      })),
    [
      s,
      () => {
        r(), Promise.resolve().then(i);
      },
    ]
  );
}
let Go = !0;
function Bg(e) {
  const t = ql(e),
    n = e.proxy,
    s = e.ctx;
  (Go = !1), t.beforeCreate && Qc(t.beforeCreate, e, "bc");
  const {
    data: r,
    computed: i,
    methods: o,
    watch: l,
    provide: c,
    inject: u,
    created: a,
    beforeMount: f,
    mounted: d,
    beforeUpdate: h,
    updated: m,
    activated: v,
    deactivated: _,
    beforeDestroy: S,
    beforeUnmount: g,
    destroyed: p,
    unmounted: b,
    render: T,
    renderTracked: R,
    renderTriggered: C,
    errorCaptured: A,
    serverPrefetch: w,
    expose: N,
    inheritAttrs: P,
    components: O,
    directives: V,
    filters: k,
  } = t;
  if ((u && Hg(u, s, null), o))
    for (const J in o) {
      const q = o[J];
      Q(q) && (s[J] = q.bind(n));
    }
  if (r) {
    const J = r.call(n, n);
    ge(J) && (e.data = gt(J));
  }
  if (((Go = !0), i))
    for (const J in i) {
      const q = i[J],
        pe = Q(q) ? q.bind(n, n) : Q(q.get) ? q.get.bind(n, n) : Je,
        ot = !Q(q) && Q(q.set) ? q.set.bind(n) : Je,
        lt = oe({ get: pe, set: ot });
      Object.defineProperty(s, J, {
        enumerable: !0,
        configurable: !0,
        get: () => lt.value,
        set: (ct) => (lt.value = ct),
      });
    }
  if (l) for (const J in l) xf(l[J], s, n, J);
  if (c) {
    const J = Q(c) ? c.call(n) : c;
    Reflect.ownKeys(J).forEach((q) => {
      vs(q, J[q]);
    });
  }
  a && Qc(a, e, "c");
  function B(J, q) {
    K(q) ? q.forEach((pe) => J(pe.bind(n))) : q && J(q.bind(n));
  }
  if (
    (B(Ef, f),
    B(ns, d),
    B($l, h),
    B(eo, m),
    B(bf, v),
    B(_f, _),
    B(Af, A),
    B(Cf, R),
    B(wf, C),
    B(to, g),
    B(Mr, b),
    B(Tf, w),
    K(N))
  )
    if (N.length) {
      const J = e.exposed || (e.exposed = {});
      N.forEach((q) => {
        Object.defineProperty(J, q, { get: () => n[q], set: (pe) => (n[q] = pe), enumerable: !0 });
      });
    } else e.exposed || (e.exposed = {});
  T && e.render === Je && (e.render = T),
    P != null && (e.inheritAttrs = P),
    O && (e.components = O),
    V && (e.directives = V),
    w && jl(e);
}
function Hg(e, t, n = Je) {
  K(e) && (e = zo(e));
  for (const s in e) {
    const r = e[s];
    let i;
    ge(r)
      ? "default" in r
        ? (i = St(r.from || s, r.default, !0))
        : (i = St(r.from || s))
      : (i = St(r)),
      we(i)
        ? Object.defineProperty(t, s, {
            enumerable: !0,
            configurable: !0,
            get: () => i.value,
            set: (o) => (i.value = o),
          })
        : (t[s] = i);
  }
}
function Qc(e, t, n) {
  It(K(e) ? e.map((s) => s.bind(t.proxy)) : e.bind(t.proxy), t, n);
}
function xf(e, t, n, s) {
  const r = s.includes(".") ? hf(n, s) : () => n[s];
  if (ne(e)) {
    const i = t[e];
    Q(i) && de(r, i);
  } else if (Q(e)) de(r, e.bind(n));
  else if (ge(e))
    if (K(e)) e.forEach((i) => xf(i, t, n, s));
    else {
      const i = Q(e.handler) ? e.handler.bind(n) : t[e.handler];
      Q(i) && de(r, i, e);
    }
}
function ql(e) {
  const t = e.type,
    { mixins: n, extends: s } = t,
    {
      mixins: r,
      optionsCache: i,
      config: { optionMergeStrategies: o },
    } = e.appContext,
    l = i.get(t);
  let c;
  return (
    l
      ? (c = l)
      : !r.length && !n && !s
        ? (c = t)
        : ((c = {}), r.length && r.forEach((u) => vi(c, u, o, !0)), vi(c, t, o)),
    ge(t) && i.set(t, c),
    c
  );
}
function vi(e, t, n, s = !1) {
  const { mixins: r, extends: i } = t;
  i && vi(e, i, n, !0), r && r.forEach((o) => vi(e, o, n, !0));
  for (const o in t)
    if (!(s && o === "expose")) {
      const l = jg[o] || (n && n[o]);
      e[o] = l ? l(e[o], t[o]) : t[o];
    }
  return e;
}
const jg = {
  data: ea,
  props: ta,
  emits: ta,
  methods: Gs,
  computed: Gs,
  beforeCreate: st,
  created: st,
  beforeMount: st,
  mounted: st,
  beforeUpdate: st,
  updated: st,
  beforeDestroy: st,
  beforeUnmount: st,
  destroyed: st,
  unmounted: st,
  activated: st,
  deactivated: st,
  errorCaptured: st,
  serverPrefetch: st,
  components: Gs,
  directives: Gs,
  watch: Ug,
  provide: ea,
  inject: $g,
};
function ea(e, t) {
  return t
    ? e
      ? function () {
          return ce(Q(e) ? e.call(this, this) : e, Q(t) ? t.call(this, this) : t);
        }
      : t
    : e;
}
function $g(e, t) {
  return Gs(zo(e), zo(t));
}
function zo(e) {
  if (K(e)) {
    const t = {};
    for (let n = 0; n < e.length; n++) t[e[n]] = e[n];
    return t;
  }
  return e;
}
function st(e, t) {
  return e ? [...new Set([].concat(e, t))] : t;
}
function Gs(e, t) {
  return e ? ce(Object.create(null), e, t) : t;
}
function ta(e, t) {
  return e
    ? K(e) && K(t)
      ? [...new Set([...e, ...t])]
      : ce(Object.create(null), dr(e), dr(t ?? {}))
    : t;
}
function Ug(e, t) {
  if (!e) return t;
  if (!t) return e;
  const n = ce(Object.create(null), e);
  for (const s in t) n[s] = st(e[s], t[s]);
  return n;
}
function Rf() {
  return {
    app: null,
    config: {
      isNativeTag: fs,
      performance: !1,
      globalProperties: {},
      optionMergeStrategies: {},
      errorHandler: void 0,
      warnHandler: void 0,
      compilerOptions: {},
    },
    mixins: [],
    components: {},
    directives: {},
    provides: Object.create(null),
    optionsCache: new WeakMap(),
    propsCache: new WeakMap(),
    emitsCache: new WeakMap(),
  };
}
let Wg = 0;
function Kg(e, t) {
  return function (s, r = null) {
    Q(s) || (s = ce({}, s)), r != null && !ge(r) && (r = null);
    const i = Rf(),
      o = new WeakSet(),
      l = [];
    let c = !1;
    const u = (i.app = {
      _uid: Wg++,
      _component: s,
      _props: r,
      _container: null,
      _context: i,
      _instance: null,
      version: ah,
      get config() {
        return i.config;
      },
      set config(a) {},
      use(a, ...f) {
        return (
          o.has(a) ||
            (a && Q(a.install) ? (o.add(a), a.install(u, ...f)) : Q(a) && (o.add(a), a(u, ...f))),
          u
        );
      },
      mixin(a) {
        return i.mixins.includes(a) || i.mixins.push(a), u;
      },
      component(a, f) {
        return f ? ((i.components[a] = f), u) : i.components[a];
      },
      directive(a, f) {
        return f ? ((i.directives[a] = f), u) : i.directives[a];
      },
      mount(a, f, d) {
        if (!c) {
          const h = u._ceVNode || Ne(s, r);
          return (
            (h.appContext = i),
            d === !0 ? (d = "svg") : d === !1 && (d = void 0),
            f && t ? t(h, a) : e(h, a, d),
            (c = !0),
            (u._container = a),
            (a.__vue_app__ = u),
            kr(h.component)
          );
        }
      },
      onUnmount(a) {
        l.push(a);
      },
      unmount() {
        c && (It(l, u._instance, 16), e(null, u._container), delete u._container.__vue_app__);
      },
      provide(a, f) {
        return (i.provides[a] = f), u;
      },
      runWithContext(a) {
        const f = Kn;
        Kn = u;
        try {
          return a();
        } finally {
          Kn = f;
        }
      },
    });
    return u;
  };
}
let Kn = null;
function qg(e, t, n = he) {
  const s = Ve(),
    r = _e(t),
    i = dt(t),
    o = If(e, r),
    l = Ji((c, u) => {
      let a,
        f = he,
        d;
      return (
        ff(() => {
          const h = e[r];
          Ge(a, h) && ((a = h), u());
        }),
        {
          get() {
            return c(), n.get ? n.get(a) : a;
          },
          set(h) {
            const m = n.set ? n.set(h) : h;
            if (!Ge(m, a) && !(f !== he && Ge(h, f))) return;
            const v = s.vnode.props;
            (v &&
              (t in v || r in v || i in v) &&
              (`onUpdate:${t}` in v || `onUpdate:${r}` in v || `onUpdate:${i}` in v)) ||
              ((a = h), u()),
              s.emit(`update:${t}`, m),
              Ge(h, m) && Ge(h, f) && !Ge(m, d) && u(),
              (f = h),
              (d = m);
          },
        }
      );
    });
  return (
    (l[Symbol.iterator] = () => {
      let c = 0;
      return {
        next() {
          return c < 2 ? { value: c++ ? o || he : l, done: !1 } : { done: !0 };
        },
      };
    }),
    l
  );
}
const If = (e, t) =>
  t === "modelValue" || t === "model-value"
    ? e.modelModifiers
    : e[`${t}Modifiers`] || e[`${_e(t)}Modifiers`] || e[`${dt(t)}Modifiers`];
function Gg(e, t, ...n) {
  if (e.isUnmounted) return;
  const s = e.vnode.props || he;
  let r = n;
  const i = t.startsWith("update:"),
    o = i && If(s, t.slice(7));
  o && (o.trim && (r = n.map((a) => (ne(a) ? a.trim() : a))), o.number && (r = n.map(Ui)));
  let l,
    c = s[(l = ms(t))] || s[(l = ms(_e(t)))];
  !c && i && (c = s[(l = ms(dt(t)))]), c && It(c, e, 6, r);
  const u = s[`${l  }Once`];
  if (u) {
    if (!e.emitted) e.emitted = {};
    else if (e.emitted[l]) return;
    (e.emitted[l] = !0), It(u, e, 6, r);
  }
}
const zg = new WeakMap();
function Pf(e, t, n = !1) {
  const s = n ? zg : t.emitsCache,
    r = s.get(e);
  if (r !== void 0) return r;
  const i = e.emits;
  let o = {},
    l = !1;
  if (!Q(e)) {
    const c = (u) => {
      const a = Pf(u, t, !0);
      a && ((l = !0), ce(o, a));
    };
    !n && t.mixins.length && t.mixins.forEach(c),
      e.extends && c(e.extends),
      e.mixins && e.mixins.forEach(c);
  }
  return !i && !l
    ? (ge(e) && s.set(e, null), null)
    : (K(i) ? i.forEach((c) => (o[c] = null)) : ce(o, i), ge(e) && s.set(e, o), o);
}
function no(e, t) {
  return !e || !Zn(t)
    ? !1
    : ((t = t.slice(2).replace(/Once$/, "")),
      ye(e, t[0].toLowerCase() + t.slice(1)) || ye(e, dt(t)) || ye(e, t));
}
function ri(e) {
  const {
      type: t,
      vnode: n,
      proxy: s,
      withProxy: r,
      propsOptions: [i],
      slots: o,
      attrs: l,
      emit: c,
      render: u,
      renderCache: a,
      props: f,
      data: d,
      setupState: h,
      ctx: m,
      inheritAttrs: v,
    } = e,
    _ = hr(e);
  let S, g;
  try {
    if (n.shapeFlag & 4) {
      const b = r || s,
        T = b;
      (S = ht(u.call(T, b, a, f, h, d, m))), (g = l);
    } else {
      const b = t;
      (S = ht(b.length > 1 ? b(f, { attrs: l, slots: o, emit: c }) : b(f, null))),
        (g = t.props ? l : Jg(l));
    }
  } catch (b) {
    (Zs.length = 0), ts(b, e, 1), (S = Ne(Pe));
  }
  let p = S;
  if (g && v !== !1) {
    const b = Object.keys(g),
      { shapeFlag: T } = p;
    b.length && T & 7 && (i && b.some(Bi) && (g = Xg(g, i)), (p = Gt(p, g, !1, !0)));
  }
  return (
    n.dirs && ((p = Gt(p, null, !1, !0)), (p.dirs = p.dirs ? p.dirs.concat(n.dirs) : n.dirs)),
    n.transition && hn(p, n.transition),
    (S = p),
    hr(_),
    S
  );
}
function Yg(e, t = !0) {
  let n;
  for (let s = 0; s < e.length; s++) {
    const r = e[s];
    if (dn(r)) {
      if (r.type !== Pe || r.children === "v-if") {
        if (n) return;
        n = r;
      }
    } else return;
  }
  return n;
}
const Jg = (e) => {
    let t;
    for (const n in e) (n === "class" || n === "style" || Zn(n)) && ((t || (t = {}))[n] = e[n]);
    return t;
  },
  Xg = (e, t) => {
    const n = {};
    for (const s in e) (!Bi(s) || !(s.slice(9) in t)) && (n[s] = e[s]);
    return n;
  };
function Zg(e, t, n) {
  const { props: s, children: r, component: i } = e,
    { props: o, children: l, patchFlag: c } = t,
    u = i.emitsOptions;
  if (t.dirs || t.transition) return !0;
  if (n && c >= 0) {
    if (c & 1024) return !0;
    if (c & 16) return s ? na(s, o, u) : !!o;
    if (c & 8) {
      const a = t.dynamicProps;
      for (let f = 0; f < a.length; f++) {
        const d = a[f];
        if (Mf(o, s, d) && !no(u, d)) return !0;
      }
    }
  } else
    return (r || l) && (!l || !l.$stable) ? !0 : s === o ? !1 : s ? (o ? na(s, o, u) : !0) : !!o;
  return !1;
}
function na(e, t, n) {
  const s = Object.keys(t);
  if (s.length !== Object.keys(e).length) return !0;
  for (let r = 0; r < s.length; r++) {
    const i = s[r];
    if (Mf(t, e, i) && !no(n, i)) return !0;
  }
  return !1;
}
function Mf(e, t, n) {
  const s = e[n],
    r = t[n];
  return n === "style" && ge(s) && ge(r) ? !an(s, r) : s !== r;
}
function so({ vnode: e, parent: t, suspense: n }, s) {
  for (; t; ) {
    const r = t.subTree;
    if (
      (r.suspense && r.suspense.activeBranch === e && ((r.suspense.vnode.el = r.el = s), (e = r)),
      r === e)
    )
      ((e = t.vnode).el = s), (t = t.parent);
    else break;
  }
  n && n.activeBranch === e && (n.vnode.el = s);
}
const kf = {},
  Df = () => Object.create(kf),
  Ff = (e) => Object.getPrototypeOf(e) === kf;
function Qg(e, t, n, s = !1) {
  const r = {},
    i = Df();
  (e.propsDefaults = Object.create(null)), Lf(e, t, r, i);
  for (const o in e.propsOptions[0]) o in r || (r[o] = void 0);
  n ? (e.props = s ? r : Ml(r)) : e.type.props ? (e.props = r) : (e.props = i), (e.attrs = i);
}
function ey(e, t, n, s) {
  const {
      props: r,
      attrs: i,
      vnode: { patchFlag: o },
    } = e,
    l = fe(r),
    [c] = e.propsOptions;
  let u = !1;
  if ((s || o > 0) && !(o & 16)) {
    if (o & 8) {
      const a = e.vnode.dynamicProps;
      for (let f = 0; f < a.length; f++) {
        const d = a[f];
        if (no(e.emitsOptions, d)) continue;
        const h = t[d];
        if (c)
          if (ye(i, d)) h !== i[d] && ((i[d] = h), (u = !0));
          else {
            const m = _e(d);
            r[m] = Yo(c, l, m, h, e, !1);
          }
        else h !== i[d] && ((i[d] = h), (u = !0));
      }
    }
  } else {
    Lf(e, t, r, i) && (u = !0);
    let a;
    for (const f in l)
      (!t || (!ye(t, f) && ((a = dt(f)) === f || !ye(t, a)))) &&
        (c
          ? n && (n[f] !== void 0 || n[a] !== void 0) && (r[f] = Yo(c, l, f, void 0, e, !0))
          : delete r[f]);
    if (i !== l) for (const f in i) (!t || !ye(t, f)) && (delete i[f], (u = !0));
  }
  u && en(e.attrs, "set", "");
}
function Lf(e, t, n, s) {
  const [r, i] = e.propsOptions;
  let o = !1,
    l;
  if (t)
    for (const c in t) {
      if (sn(c)) continue;
      const u = t[c];
      let a;
      r && ye(r, (a = _e(c)))
        ? !i || !i.includes(a)
          ? (n[a] = u)
          : ((l || (l = {}))[a] = u)
        : no(e.emitsOptions, c) || ((!(c in s) || u !== s[c]) && ((s[c] = u), (o = !0)));
    }
  if (i) {
    const c = fe(n),
      u = l || he;
    for (let a = 0; a < i.length; a++) {
      const f = i[a];
      n[f] = Yo(r, c, f, u[f], e, !ye(u, f));
    }
  }
  return o;
}
function Yo(e, t, n, s, r, i) {
  const o = e[n];
  if (o != null) {
    const l = ye(o, "default");
    if (l && s === void 0) {
      const c = o.default;
      if (o.type !== Function && !o.skipFactory && Q(c)) {
        const { propsDefaults: u } = r;
        if (n in u) s = u[n];
        else {
          const a = Ls(r);
          (s = u[n] = c.call(null, t)), a();
        }
      } else s = c;
      r.ce && r.ce._setProp(n, s);
    }
    o[0] && (i && !l ? (s = !1) : o[1] && (s === "" || s === dt(n)) && (s = !0));
  }
  return s;
}
const ty = new WeakMap();
function Vf(e, t, n = !1) {
  const s = n ? ty : t.propsCache,
    r = s.get(e);
  if (r) return r;
  const i = e.props,
    o = {},
    l = [];
  let c = !1;
  if (!Q(e)) {
    const a = (f) => {
      c = !0;
      const [d, h] = Vf(f, t, !0);
      ce(o, d), h && l.push(...h);
    };
    !n && t.mixins.length && t.mixins.forEach(a),
      e.extends && a(e.extends),
      e.mixins && e.mixins.forEach(a);
  }
  if (!i && !c) return ge(e) && s.set(e, ds), ds;
  if (K(i))
    for (let a = 0; a < i.length; a++) {
      const f = _e(i[a]);
      sa(f) && (o[f] = he);
    }
  else if (i)
    for (const a in i) {
      const f = _e(a);
      if (sa(f)) {
        const d = i[a],
          h = (o[f] = K(d) || Q(d) ? { type: d } : ce({}, d)),
          m = h.type;
        let v = !1,
          _ = !0;
        if (K(m))
          for (let S = 0; S < m.length; ++S) {
            const g = m[S],
              p = Q(g) && g.name;
            if (p === "Boolean") {
              v = !0;
              break;
            } else p === "String" && (_ = !1);
          }
        else v = Q(m) && m.name === "Boolean";
        (h[0] = v), (h[1] = _), (v || ye(h, "default")) && l.push(f);
      }
    }
  const u = [o, l];
  return ge(e) && s.set(e, u), u;
}
function sa(e) {
  return e[0] !== "$" && !sn(e);
}
const Gl = (e) => e === "_" || e === "_ctx" || e === "$stable",
  zl = (e) => (K(e) ? e.map(ht) : [ht(e)]),
  ny = (e, t, n) => {
    if (t._n) return t;
    const s = Fl((...r) => zl(t(...r)), n);
    return (s._c = !1), s;
  },
  Bf = (e, t, n) => {
    const s = e._ctx;
    for (const r in e) {
      if (Gl(r)) continue;
      const i = e[r];
      if (Q(i)) t[r] = ny(r, i, s);
      else if (i != null) {
        const o = zl(i);
        t[r] = () => o;
      }
    }
  },
  Hf = (e, t) => {
    const n = zl(t);
    e.slots.default = () => n;
  },
  jf = (e, t, n) => {
    for (const s in t) (n || !Gl(s)) && (e[s] = t[s]);
  },
  sy = (e, t, n) => {
    const s = (e.slots = Df());
    if (e.vnode.shapeFlag & 32) {
      const r = t._;
      r ? (jf(s, t, n), n && Nu(s, "_", r, !0)) : Bf(t, s);
    } else t && Hf(e, t);
  },
  ry = (e, t, n) => {
    const { vnode: s, slots: r } = e;
    let i = !0,
      o = he;
    if (s.shapeFlag & 32) {
      const l = t._;
      l ? (n && l === 1 ? (i = !1) : jf(r, t, n)) : ((i = !t.$stable), Bf(t, r)), (o = t);
    } else t && (Hf(e, t), (o = { default: 1 }));
    if (i) for (const l in r) !Gl(l) && o[l] == null && delete r[l];
  },
  De = Yf;
function $f(e) {
  return Wf(e);
}
function Uf(e) {
  return Wf(e, sg);
}
function Wf(e, t) {
  const n = Wi();
  n.__VUE__ = !0;
  const {
      insert: s,
      remove: r,
      patchProp: i,
      createElement: o,
      createText: l,
      createComment: c,
      setText: u,
      setElementText: a,
      parentNode: f,
      nextSibling: d,
      setScopeId: h = Je,
      insertStaticContent: m,
    } = e,
    v = (y, E, x, D = null, I = null, F = null, U = void 0, j = null, H = !!E.dynamicChildren) => {
      if (y === E) return;
      y && !Mt(y, E) && ((D = M(y)), ct(y, I, F, !0), (y = null)),
        E.patchFlag === -2 && ((H = !1), (E.dynamicChildren = null));
      const { type: L, ref: Z, shapeFlag: G } = E;
      switch (L) {
        case Cn:
          _(y, E, x, D);
          break;
        case Pe:
          S(y, E, x, D);
          break;
        case qn:
          y == null && g(E, x, D, U);
          break;
        case We:
          O(y, E, x, D, I, F, U, j, H);
          break;
        default:
          G & 1
            ? T(y, E, x, D, I, F, U, j, H)
            : G & 6
              ? V(y, E, x, D, I, F, U, j, H)
              : (G & 64 || G & 128) && L.process(y, E, x, D, I, F, U, j, H, X);
      }
      Z != null && I
        ? bs(Z, y && y.ref, F, E || y, !E)
        : Z == null && y && y.ref != null && bs(y.ref, null, F, y, !0);
    },
    _ = (y, E, x, D) => {
      if (y == null) s((E.el = l(E.children)), x, D);
      else {
        const I = (E.el = y.el);
        E.children !== y.children && u(I, E.children);
      }
    },
    S = (y, E, x, D) => {
      y == null ? s((E.el = c(E.children || "")), x, D) : (E.el = y.el);
    },
    g = (y, E, x, D) => {
      [y.el, y.anchor] = m(y.children, E, x, D, y.el, y.anchor);
    },
    p = ({ el: y, anchor: E }, x, D) => {
      let I;
      for (; y && y !== E; ) (I = d(y)), s(y, x, D), (y = I);
      s(E, x, D);
    },
    b = ({ el: y, anchor: E }) => {
      let x;
      for (; y && y !== E; ) (x = d(y)), r(y), (y = x);
      r(E);
    },
    T = (y, E, x, D, I, F, U, j, H) => {
      if ((E.type === "svg" ? (U = "svg") : E.type === "math" && (U = "mathml"), y == null))
        R(E, x, D, I, F, U, j, H);
      else {
        const L = y.el && y.el._isVueCE ? y.el : null;
        try {
          L && L._beginPatch(), w(y, E, I, F, U, j, H);
        } finally {
          L && L._endPatch();
        }
      }
    },
    R = (y, E, x, D, I, F, U, j) => {
      let H, L;
      const { props: Z, shapeFlag: G, transition: Y, dirs: ee } = y;
      if (
        ((H = y.el = o(y.type, F, Z && Z.is, Z)),
        G & 8 ? a(H, y.children) : G & 16 && A(y.children, H, null, D, I, To(y, F), U, j),
        ee && Ut(y, null, D, "created"),
        C(H, y, y.scopeId, U, D),
        Z)
      ) {
        for (const Se in Z) Se !== "value" && !sn(Se) && i(H, Se, null, Z[Se], F, D);
        "value" in Z && i(H, "value", null, Z.value, F), (L = Z.onVnodeBeforeMount) && ut(L, D, y);
      }
      ee && Ut(y, null, D, "beforeMount");
      const me = Kf(I, Y);
      me && Y.beforeEnter(H),
        s(H, E, x),
        ((L = Z && Z.onVnodeMounted) || me || ee) &&
          De(() => {
            try {
              L && ut(L, D, y), me && Y.enter(H), ee && Ut(y, null, D, "mounted");
            } finally {
            }
          }, I);
    },
    C = (y, E, x, D, I) => {
      if ((x && h(y, x), D)) for (let F = 0; F < D.length; F++) h(y, D[F]);
      if (I) {
        const F = I.subTree;
        if (E === F || (_i(F.type) && (F.ssContent === E || F.ssFallback === E))) {
          const U = I.vnode;
          C(y, U, U.scopeId, U.slotScopeIds, I.parent);
        }
      }
    },
    A = (y, E, x, D, I, F, U, j, H = 0) => {
      for (let L = H; L < y.length; L++) {
        const Z = (y[L] = j ? Qt(y[L]) : ht(y[L]));
        v(null, Z, E, x, D, I, F, U, j);
      }
    },
    w = (y, E, x, D, I, F, U) => {
      const j = (E.el = y.el);
      let { patchFlag: H, dynamicChildren: L, dirs: Z } = E;
      H |= y.patchFlag & 16;
      const G = y.props || he,
        Y = E.props || he;
      let ee;
      if (
        (x && Mn(x, !1),
        (ee = Y.onVnodeBeforeUpdate) && ut(ee, x, E, y),
        Z && Ut(E, y, x, "beforeUpdate"),
        x && Mn(x, !0),
        ((G.innerHTML && Y.innerHTML == null) || (G.textContent && Y.textContent == null)) &&
          a(j, ""),
        L
          ? N(y.dynamicChildren, L, j, x, D, To(E, I), F)
          : U || q(y, E, j, null, x, D, To(E, I), F, !1),
        H > 0)
      ) {
        if (H & 16) P(j, G, Y, x, I);
        else if (
          (H & 2 && G.class !== Y.class && i(j, "class", null, Y.class, I),
          H & 4 && i(j, "style", G.style, Y.style, I),
          H & 8)
        ) {
          const me = E.dynamicProps;
          for (let Se = 0; Se < me.length; Se++) {
            const Ee = me[Se],
              ke = G[Ee],
              Be = Y[Ee];
            (Be !== ke || Ee === "value") && i(j, Ee, ke, Be, I, x);
          }
        }
        H & 1 && y.children !== E.children && a(j, E.children);
      } else !U && L == null && P(j, G, Y, x, I);
      ((ee = Y.onVnodeUpdated) || Z) &&
        De(() => {
          ee && ut(ee, x, E, y), Z && Ut(E, y, x, "updated");
        }, D);
    },
    N = (y, E, x, D, I, F, U) => {
      for (let j = 0; j < E.length; j++) {
        const H = y[j],
          L = E[j],
          Z = H.el && (H.type === We || !Mt(H, L) || H.shapeFlag & 198) ? f(H.el) : x;
        v(H, L, Z, null, D, I, F, U, !0);
      }
    },
    P = (y, E, x, D, I) => {
      if (E !== x) {
        if (E !== he) for (const F in E) !sn(F) && !(F in x) && i(y, F, E[F], null, I, D);
        for (const F in x) {
          if (sn(F)) continue;
          const U = x[F],
            j = E[F];
          U !== j && F !== "value" && i(y, F, j, U, I, D);
        }
        "value" in x && i(y, "value", E.value, x.value, I);
      }
    },
    O = (y, E, x, D, I, F, U, j, H) => {
      const L = (E.el = y ? y.el : l("")),
        Z = (E.anchor = y ? y.anchor : l(""));
      const { patchFlag: G, dynamicChildren: Y, slotScopeIds: ee } = E;
      ee && (j = j ? j.concat(ee) : ee),
        y == null
          ? (s(L, x, D), s(Z, x, D), A(E.children || [], x, Z, I, F, U, j, H))
          : G > 0 && G & 64 && Y && y.dynamicChildren && y.dynamicChildren.length === Y.length
            ? (N(y.dynamicChildren, Y, x, I, F, U, j),
              (E.key != null || (I && E === I.subTree)) && Yl(y, E, !0))
            : q(y, E, x, Z, I, F, U, j, H);
    },
    V = (y, E, x, D, I, F, U, j, H) => {
      (E.slotScopeIds = j),
        y == null
          ? E.shapeFlag & 512
            ? I.ctx.activate(E, x, D, U, H)
            : k(E, x, D, I, F, U, H)
          : $(y, E, H);
    },
    k = (y, E, x, D, I, F, U) => {
      const j = (y.component = nh(y, D, I));
      if ((Pr(y) && (j.ctx.renderer = X), rh(j, !1, U), j.asyncDep)) {
        if ((I && I.registerDep(j, B, U), !y.el)) {
          const H = (j.subTree = Ne(Pe));
          S(null, H, E, x), (y.placeholder = H.el);
        }
      } else B(j, y, E, x, I, F, U);
    },
    $ = (y, E, x) => {
      const D = (E.component = y.component);
      if (Zg(y, E, x))
        if (D.asyncDep && !D.asyncResolved) {
          J(D, E, x);
          return;
        } else (D.next = E), D.update();
      else (E.el = y.el), (D.vnode = E);
    },
    B = (y, E, x, D, I, F, U) => {
      const j = () => {
        if (y.isMounted) {
          let { next: G, bu: Y, u: ee, parent: me, vnode: Se } = y;
          {
            const yt = qf(y);
            if (yt) {
              G && ((G.el = Se.el), J(y, G, U)),
                yt.asyncDep.then(() => {
                  De(() => {
                    y.isUnmounted || L();
                  }, I);
                });
              return;
            }
          }
          let Ee = G,
            ke;
          Mn(y, !1),
            G ? ((G.el = Se.el), J(y, G, U)) : (G = Se),
            Y && gs(Y),
            (ke = G.props && G.props.onVnodeBeforeUpdate) && ut(ke, me, G, Se),
            Mn(y, !0);
          const Be = ri(y),
            Pt = y.subTree;
          (y.subTree = Be),
            v(Pt, Be, f(Pt.el), M(Pt), y, I, F),
            (G.el = Be.el),
            Ee === null && so(y, Be.el),
            ee && De(ee, I),
            (ke = G.props && G.props.onVnodeUpdated) && De(() => ut(ke, me, G, Se), I);
        } else {
          let G;
          const { el: Y, props: ee } = E,
            { bm: me, m: Se, parent: Ee, root: ke, type: Be } = y,
            Pt = on(E);
          if (
            (Mn(y, !1),
            me && gs(me),
            !Pt && (G = ee && ee.onVnodeBeforeMount) && ut(G, Ee, E),
            Mn(y, !0),
            Y && Ae)
          ) {
            const yt = () => {
              (y.subTree = ri(y)), Ae(Y, y.subTree, y, I, null);
            };
            Pt && Be.__asyncHydrate ? Be.__asyncHydrate(Y, y, yt) : yt();
          } else {
            ke.ce &&
              ke.ce._hasShadowRoot() &&
              ke.ce._injectChildStyle(Be, y.parent ? y.parent.type : void 0);
            const yt = (y.subTree = ri(y));
            v(null, yt, x, D, y, I, F), (E.el = yt.el);
          }
          if ((Se && De(Se, I), !Pt && (G = ee && ee.onVnodeMounted))) {
            const yt = E;
            De(() => ut(G, Ee, yt), I);
          }
          (E.shapeFlag & 256 || (Ee && on(Ee.vnode) && Ee.vnode.shapeFlag & 256)) &&
            y.a &&
            De(y.a, I),
            (y.isMounted = !0),
            (E = x = D = null);
        }
      };
      y.scope.on();
      const H = (y.effect = new or(j));
      y.scope.off();
      const L = (y.update = H.run.bind(H)),
        Z = (y.job = H.runIfDirty.bind(H));
      (Z.i = y), (Z.id = y.uid), (H.scheduler = () => Dl(Z)), Mn(y, !0), L();
    },
    J = (y, E, x) => {
      E.component = y;
      const D = y.vnode.props;
      (y.vnode = E), (y.next = null), ey(y, E.props, D, x), ry(y, E.children, x), un(), Wc(y), fn();
    },
    q = (y, E, x, D, I, F, U, j, H = !1) => {
      const L = y && y.children,
        Z = y ? y.shapeFlag : 0,
        G = E.children,
        { patchFlag: Y, shapeFlag: ee } = E;
      if (Y > 0) {
        if (Y & 128) {
          ot(L, G, x, D, I, F, U, j, H);
          return;
        } else if (Y & 256) {
          pe(L, G, x, D, I, F, U, j, H);
          return;
        }
      }
      ee & 8
        ? (Z & 16 && wt(L, I, F), G !== L && a(x, G))
        : Z & 16
          ? ee & 16
            ? ot(L, G, x, D, I, F, U, j, H)
            : wt(L, I, F, !0)
          : (Z & 8 && a(x, ""), ee & 16 && A(G, x, D, I, F, U, j, H));
    },
    pe = (y, E, x, D, I, F, U, j, H) => {
      (y = y || ds), (E = E || ds);
      const L = y.length,
        Z = E.length,
        G = Math.min(L, Z);
      let Y;
      for (Y = 0; Y < G; Y++) {
        const ee = (E[Y] = H ? Qt(E[Y]) : ht(E[Y]));
        v(y[Y], ee, x, null, I, F, U, j, H);
      }
      L > Z ? wt(y, I, F, !0, !1, G) : A(E, x, D, I, F, U, j, H, G);
    },
    ot = (y, E, x, D, I, F, U, j, H) => {
      let L = 0;
      const Z = E.length;
      let G = y.length - 1,
        Y = Z - 1;
      for (; L <= G && L <= Y; ) {
        const ee = y[L],
          me = (E[L] = H ? Qt(E[L]) : ht(E[L]));
        if (Mt(ee, me)) v(ee, me, x, null, I, F, U, j, H);
        else break;
        L++;
      }
      for (; L <= G && L <= Y; ) {
        const ee = y[G],
          me = (E[Y] = H ? Qt(E[Y]) : ht(E[Y]));
        if (Mt(ee, me)) v(ee, me, x, null, I, F, U, j, H);
        else break;
        G--, Y--;
      }
      if (L > G) {
        if (L <= Y) {
          const ee = Y + 1,
            me = ee < Z ? E[ee].el : D;
          for (; L <= Y; ) v(null, (E[L] = H ? Qt(E[L]) : ht(E[L])), x, me, I, F, U, j, H), L++;
        }
      } else if (L > Y) for (; L <= G; ) ct(y[L], I, F, !0), L++;
      else {
        const ee = L,
          me = L,
          Se = new Map();
        for (L = me; L <= Y; L++) {
          const vt = (E[L] = H ? Qt(E[L]) : ht(E[L]));
          vt.key != null && Se.set(vt.key, L);
        }
        let Ee,
          ke = 0;
        const Be = Y - me + 1;
        let Pt = !1,
          yt = 0;
        const Vs = new Array(Be);
        for (L = 0; L < Be; L++) Vs[L] = 0;
        for (L = ee; L <= G; L++) {
          const vt = y[L];
          if (ke >= Be) {
            ct(vt, I, F, !0);
            continue;
          }
          let Ht;
          if (vt.key != null) Ht = Se.get(vt.key);
          else
            for (Ee = me; Ee <= Y; Ee++)
              if (Vs[Ee - me] === 0 && Mt(vt, E[Ee])) {
                Ht = Ee;
                break;
              }
          Ht === void 0
            ? ct(vt, I, F, !0)
            : ((Vs[Ht - me] = L + 1),
              Ht >= yt ? (yt = Ht) : (Pt = !0),
              v(vt, E[Ht], x, null, I, F, U, j, H),
              ke++);
        }
        const Lc = Pt ? iy(Vs) : ds;
        for (Ee = Lc.length - 1, L = Be - 1; L >= 0; L--) {
          const vt = me + L,
            Ht = E[vt],
            Vc = E[vt + 1],
            Bc = vt + 1 < Z ? Vc.el || Gf(Vc) : D;
          Vs[L] === 0
            ? v(null, Ht, x, Bc, I, F, U, j, H)
            : Pt && (Ee < 0 || L !== Lc[Ee] ? lt(Ht, x, Bc, 2) : Ee--);
        }
      }
    },
    lt = (y, E, x, D, I = null) => {
      const { el: F, type: U, transition: j, children: H, shapeFlag: L } = y;
      if (L & 6) {
        lt(y.component.subTree, E, x, D);
        return;
      }
      if (L & 128) {
        y.suspense.move(E, x, D);
        return;
      }
      if (L & 64) {
        U.move(y, E, x, X);
        return;
      }
      if (U === We) {
        s(F, E, x);
        for (let G = 0; G < H.length; G++) lt(H[G], E, x, D);
        s(y.anchor, E, x);
        return;
      }
      if (U === qn) {
        p(y, E, x);
        return;
      }
      if (D !== 2 && L & 1 && j)
        if (D === 0) j.beforeEnter(F), s(F, E, x), De(() => j.enter(F), I);
        else {
          const { leave: G, delayLeave: Y, afterLeave: ee } = j,
            me = () => {
              y.ctx.isUnmounted ? r(F) : s(F, E, x);
            },
            Se = () => {
              F._isLeaving && F[Wt](!0),
                G(F, () => {
                  me(), ee && ee();
                });
            };
          Y ? Y(F, me, Se) : Se();
        }
      else s(F, E, x);
    },
    ct = (y, E, x, D = !1, I = !1) => {
      const {
        type: F,
        props: U,
        ref: j,
        children: H,
        dynamicChildren: L,
        shapeFlag: Z,
        patchFlag: G,
        dirs: Y,
        cacheIndex: ee,
        memo: me,
      } = y;
      if (
        (G === -2 && (I = !1),
        j != null && (un(), bs(j, null, x, y, !0), fn()),
        ee != null && (E.renderCache[ee] = void 0),
        Z & 256)
      ) {
        E.ctx.deactivate(y);
        return;
      }
      const Se = Z & 1 && Y,
        Ee = !on(y);
      let ke;
      if ((Ee && (ke = U && U.onVnodeBeforeUnmount) && ut(ke, E, y), Z & 6)) Pn(y.component, x, D);
      else {
        if (Z & 128) {
          y.suspense.unmount(x, D);
          return;
        }
        Se && Ut(y, null, E, "beforeUnmount"),
          Z & 64
            ? y.type.remove(y, E, x, X, D)
            : L && !L.hasOnce && (F !== We || (G > 0 && G & 64))
              ? wt(L, E, x, !1, !0)
              : ((F === We && G & 384) || (!I && Z & 16)) && wt(H, E, x),
          D && ss(y);
      }
      const Be = me != null && ee == null;
      ((Ee && (ke = U && U.onVnodeUnmounted)) || Se || Be) &&
        De(() => {
          ke && ut(ke, E, y), Se && Ut(y, null, E, "unmounted"), Be && (y.el = null);
        }, x);
    },
    ss = (y) => {
      const { type: E, el: x, anchor: D, transition: I } = y;
      if (E === We) {
        rs(x, D);
        return;
      }
      if (E === qn) {
        b(y);
        return;
      }
      const F = () => {
        r(x), I && !I.persisted && I.afterLeave && I.afterLeave();
      };
      if (y.shapeFlag & 1 && I && !I.persisted) {
        const { leave: U, delayLeave: j } = I,
          H = () => U(x, F);
        j ? j(y.el, F, H) : H();
      } else F();
    },
    rs = (y, E) => {
      let x;
      for (; y !== E; ) (x = d(y)), r(y), (y = x);
      r(E);
    },
    Pn = (y, E, x) => {
      const { bum: D, scope: I, job: F, subTree: U, um: j, m: H, a: L } = y;
      bi(H),
        bi(L),
        D && gs(D),
        I.stop(),
        F && ((F.flags |= 8), ct(U, y, E, x)),
        j && De(j, E),
        De(() => {
          y.isUnmounted = !0;
        }, E);
    },
    wt = (y, E, x, D = !1, I = !1, F = 0) => {
      for (let U = F; U < y.length; U++) ct(y[U], E, x, D, I);
    },
    M = (y) => {
      if (y.shapeFlag & 6) return M(y.component.subTree);
      if (y.shapeFlag & 128) return y.suspense.next();
      const E = d(y.anchor || y.el),
        x = E && E[df];
      return x ? d(x) : E;
    };
  let z = !1;
  const W = (y, E, x) => {
      let D;
      y == null
        ? E._vnode && (ct(E._vnode, null, null, !0), (D = E._vnode.component))
        : v(E._vnode || null, y, E, null, null, null, x),
        (E._vnode = y),
        z || ((z = !0), Wc(D), gi(), (z = !1));
    },
    X = { p: v, um: ct, m: lt, r: ss, mt: k, mc: A, pc: q, pbc: N, n: M, o: e };
  let ae, Ae;
  return t && ([ae, Ae] = t(X)), { render: W, hydrate: ae, createApp: Kg(W, ae) };
}
function To({ type: e, props: t }, n) {
  return (n === "svg" && e === "foreignObject") ||
    (n === "mathml" && e === "annotation-xml" && t && t.encoding && t.encoding.includes("html"))
    ? void 0
    : n;
}
function Mn({ effect: e, job: t }, n) {
  n ? ((e.flags |= 32), (t.flags |= 4)) : ((e.flags &= -33), (t.flags &= -5));
}
function Kf(e, t) {
  return (!e || (e && !e.pendingBranch)) && t && !t.persisted;
}
function Yl(e, t, n = !1) {
  const s = e.children,
    r = t.children;
  if (K(s) && K(r))
    for (let i = 0; i < s.length; i++) {
      const o = s[i];
      let l = r[i];
      l.shapeFlag & 1 &&
        !l.dynamicChildren &&
        ((l.patchFlag <= 0 || l.patchFlag === 32) && ((l = r[i] = Qt(r[i])), (l.el = o.el)),
        !n && l.patchFlag !== -2 && Yl(o, l)),
        l.type === Cn && (l.patchFlag === -1 && (l = r[i] = Qt(l)), (l.el = o.el)),
        l.type === Pe && !l.el && (l.el = o.el);
    }
}
function iy(e) {
  const t = e.slice(),
    n = [0];
  let s, r, i, o, l;
  const c = e.length;
  for (s = 0; s < c; s++) {
    const u = e[s];
    if (u !== 0) {
      if (((r = n[n.length - 1]), e[r] < u)) {
        (t[s] = r), n.push(s);
        continue;
      }
      for (i = 0, o = n.length - 1; i < o; )
        (l = (i + o) >> 1), e[n[l]] < u ? (i = l + 1) : (o = l);
      u < e[n[i]] && (i > 0 && (t[s] = n[i - 1]), (n[i] = s));
    }
  }
  for (i = n.length, o = n[i - 1]; i-- > 0; ) (n[i] = o), (o = t[o]);
  return n;
}
function qf(e) {
  const t = e.subTree.component;
  if (t) return t.asyncDep && !t.asyncResolved ? t : qf(t);
}
function bi(e) {
  if (e) for (let t = 0; t < e.length; t++) e[t].flags |= 8;
}
function Gf(e) {
  if (e.placeholder) return e.placeholder;
  const t = e.component;
  return t ? Gf(t.subTree) : null;
}
const i = (e) => e.__isSuspense;
let Jo = 0;
const oy = {
    name: "Suspense",
    __isSuspense: !0,
    process(e, t, n, s, r, i, o, l, c, u) {
      if (e == null) cy(t, n, s, r, i, o, l, c, u);
      else {
        if (i && i.deps > 0 && !e.suspense.isInFallback) {
          (t.suspense = e.suspense), (t.suspense.vnode = t), (t.el = e.el);
          return;
        }
        ay(e, t, n, s, r, o, l, c, u);
      }
    },
    hydrate: uy,
    normalize: fy,
  },
  ly = oy;
function pr(e, t) {
  const n = e.props && e.props[t];
  Q(n) && n();
}
function cy(e, t, n, s, r, i, o, l, c) {
  const {
      p: u,
      o: { createElement: a },
    } = c,
    f = a("div"),
    d = (e.suspense = zf(e, r, s, t, f, n, i, o, l, c));
  u(null, (d.pendingBranch = e.ssContent), f, null, s, d, i, o),
    d.deps > 0
      ? (pr(e, "onPending"),
        pr(e, "onFallback"),
        u(null, e.ssFallback, t, n, s, null, i, o),
        _s(d, e.ssFallback))
      : d.resolve(!1, !0);
}
function ay(e, t, n, s, r, i, o, l, { p: c, um: u, o: { createElement: a } }) {
  const f = (t.suspense = e.suspense);
  (f.vnode = t), (t.el = e.el);
  const d = t.ssContent,
    h = t.ssFallback,
    { activeBranch: m, pendingBranch: v, isInFallback: _, isHydrating: S } = f;
  if (v)
    (f.pendingBranch = d),
      Mt(v, d)
        ? (c(v, d, f.hiddenContainer, null, r, f, i, o, l),
          f.deps <= 0 ? f.resolve() : _ && (S || (c(m, h, n, s, r, null, i, o, l), _s(f, h))))
        : ((f.pendingId = Jo++),
          S ? ((f.isHydrating = !1), (f.activeBranch = v)) : u(v, r, f),
          (f.deps = 0),
          (f.effects.length = 0),
          (f.hiddenContainer = a("div")),
          _
            ? (c(null, d, f.hiddenContainer, null, r, f, i, o, l),
              f.deps <= 0 ? f.resolve() : (c(m, h, n, s, r, null, i, o, l), _s(f, h)))
            : m && Mt(m, d)
              ? (c(m, d, n, s, r, f, i, o, l), f.resolve(!0))
              : (c(null, d, f.hiddenContainer, null, r, f, i, o, l), f.deps <= 0 && f.resolve()));
  else if (m && Mt(m, d)) c(m, d, n, s, r, f, i, o, l), _s(f, d);
  else if (
    (pr(t, "onPending"),
    (f.pendingBranch = d),
    d.shapeFlag & 512 ? (f.pendingId = d.component.suspenseId) : (f.pendingId = Jo++),
    c(null, d, f.hiddenContainer, null, r, f, i, o, l),
    f.deps <= 0)
  )
    f.resolve();
  else {
    const { timeout: g, pendingId: p } = f;
    g > 0
      ? setTimeout(() => {
          f.pendingId === p && f.fallback(h);
        }, g)
      : g === 0 && f.fallback(h);
  }
}
function zf(e, t, n, s, r, i, o, l, c, u, a = !1) {
  const {
    p: f,
    m: d,
    um: h,
    n: m,
    o: { parentNode: v, remove: _ },
  } = u;
  let S;
  const g = hy(e);
  g && t && t.pendingBranch && ((S = t.pendingId), t.deps++);
  const p = e.props ? hi(e.props.timeout) : void 0,
    b = i,
    T = {
      vnode: e,
      parent: t,
      parentComponent: n,
      namespace: o,
      container: s,
      hiddenContainer: r,
      deps: 0,
      pendingId: Jo++,
      timeout: typeof p == "number" ? p : -1,
      activeBranch: null,
      isFallbackMountPending: !1,
      pendingBranch: null,
      isInFallback: !a,
      isHydrating: a,
      isUnmounted: !1,
      effects: [],
      resolve(R = !1, C = !1) {
        const {
          vnode: A,
          activeBranch: w,
          pendingBranch: N,
          pendingId: P,
          effects: O,
          parentComponent: V,
          container: k,
          isInFallback: $,
        } = T;
        let B = !1;
        if (T.isHydrating) T.isHydrating = !1;
        else if (!R) {
          B = w && N.transition && N.transition.mode === "out-in";
          let pe = !1;
          B &&
            (w.transition.afterLeave = () => {
              P === T.pendingId &&
                (d(N, k, i === b && !pe ? m(w) : i, 0),
                ur(O),
                $ && A.ssFallback && (A.ssFallback.el = null));
            }),
            w &&
              !T.isFallbackMountPending &&
              (v(w.el) === k && ((i = m(w)), (pe = !0)),
              h(w, V, T, !0),
              !B && $ && A.ssFallback && De(() => (A.ssFallback.el = null), T)),
            B || d(N, k, i, 0);
        }
        (T.isFallbackMountPending = !1), _s(T, N), (T.pendingBranch = null), (T.isInFallback = !1);
        let J = T.parent,
          q = !1;
        for (; J; ) {
          if (J.pendingBranch) {
            J.effects.push(...O), (q = !0);
            break;
          }
          J = J.parent;
        }
        !q && !B && ur(O),
          (T.effects = []),
          g &&
            t &&
            t.pendingBranch &&
            S === t.pendingId &&
            (t.deps--, t.deps === 0 && !C && t.resolve()),
          pr(A, "onResolve");
      },
      fallback(R) {
        if (!T.pendingBranch) return;
        const { vnode: C, activeBranch: A, parentComponent: w, container: N, namespace: P } = T;
        pr(C, "onFallback");
        const O = m(A),
          V = () => {
            (T.isFallbackMountPending = !1),
              T.isInFallback && (f(null, R, N, O, w, null, P, l, c), _s(T, R));
          },
          k = R.transition && R.transition.mode === "out-in";
        k && ((T.isFallbackMountPending = !0), (A.transition.afterLeave = V)),
          (T.isInFallback = !0),
          h(A, w, null, !0),
          k || V();
      },
      move(R, C, A) {
        T.activeBranch && d(T.activeBranch, R, C, A), (T.container = R);
      },
      next() {
        return T.activeBranch && m(T.activeBranch);
      },
      registerDep(R, C, A) {
        const w = !!T.pendingBranch;
        w && T.deps++;
        const N = R.vnode.el;
        R.asyncDep
          .catch((P) => {
            ts(P, R, 0);
          })
          .then((P) => {
            if (R.isUnmounted || T.isUnmounted || T.pendingId !== R.suspenseId) return;
            yr(), (R.asyncResolved = !0);
            const { vnode: O } = R;
            Xo(R, P, !1), N && (O.el = N);
            const V = !N && R.subTree.el;
            C(R, O, v(N || R.subTree.el), N ? null : m(R.subTree), T, o, A),
              V && ((O.placeholder = null), _(V)),
              so(R, O.el),
              w && --T.deps === 0 && T.resolve();
          });
      },
      unmount(R, C) {
        (T.isUnmounted = !0),
          T.activeBranch && h(T.activeBranch, n, R, C),
          T.pendingBranch && h(T.pendingBranch, n, R, C);
      },
    };
  return T;
}
function uy(e, t, n, s, r, i, o, l, c) {
  const u = (t.suspense = zf(
      t,
      s,
      n,
      e.parentNode,
      document.createElement("div"),
      null,
      r,
      i,
      o,
      l,
      !0
    )),
    a = c(e, (u.pendingBranch = t.ssContent), n, u, i, o);
  return u.deps === 0 && u.resolve(!1, !0), a;
}
function fy(e) {
  const { shapeFlag: t, children: n } = e,
    s = t & 32;
  (e.ssContent = ra(s ? n.default : n)), (e.ssFallback = s ? ra(n.fallback) : Ne(Pe));
}
function ra(e) {
  let t;
  if (Q(e)) {
    const n = Yn && e._c;
    n && ((e._d = !1), mr()), (e = e()), n && ((e._d = !0), (t = et), Jf());
  }
  return (
    K(e) && (e = Yg(e)),
    (e = ht(e)),
    t && !e.dynamicChildren && (e.dynamicChildren = t.filter((n) => n !== e)),
    e
  );
}
function Yf(e, t) {
  t && t.pendingBranch ? (K(e) ? t.effects.push(...e) : t.effects.push(e)) : ur(e);
}
function _s(e, t) {
  e.activeBranch = t;
  const { vnode: n, parentComponent: s } = e;
  let r = t.el;
  for (; !r && t.component; ) (t = t.component.subTree), (r = t.el);
  (n.el = r), s && s.subTree === n && ((s.vnode.el = r), so(s, r));
}
function hy(e) {
  const t = e.props && e.props.suspensible;
  return t != null && t !== !1;
}
const We = Symbol.for("v-fgt"),
  Cn = Symbol.for("v-txt"),
  Pe = Symbol.for("v-cmt"),
  qn = Symbol.for("v-stc"),
  Zs = [];
let et = null;
function mr(e = !1) {
  Zs.push((et = e ? null : []));
}
function Jf() {
  Zs.pop(), (et = Zs[Zs.length - 1] || null);
}
let Yn = 1;
function gr(e, t = !1) {
  (Yn += e), e < 0 && et && t && (et.hasOnce = !0);
}
function Xf(e) {
  return (e.dynamicChildren = Yn > 0 ? et || ds : null), Jf(), Yn > 0 && et && et.push(e), e;
}
function dy(e, t, n, s, r, i) {
  return Xf(Jl(e, t, n, s, r, i, !0));
}
function Si(e, t, n, s, r) {
  return Xf(Ne(e, t, n, s, r, !0));
}
function dn(e) {
  return e ? e.__v_isVNode === !0 : !1;
}
function Mt(e, t) {
  return e.type === t.type && e.key === t.key;
}
function py(e) {}
const Zf = ({ key: e }) => e ?? null,
  ii = ({ ref: e, ref_key: t, ref_for: n }) => (
    typeof e == "number" && (e = `${  e}`),
    e != null ? (ne(e) || we(e) || Q(e) ? { i: Ye, r: e, k: t, f: !!n } : e) : null
  );
function Jl(e, t = null, n = null, s = 0, r = null, i = e === We ? 0 : 1, o = !1, l = !1) {
  const c = {
    __v_isVNode: !0,
    __v_skip: !0,
    type: e,
    props: t,
    key: t && Zf(t),
    ref: t && ii(t),
    scopeId: Xi,
    slotScopeIds: null,
    children: n,
    component: null,
    suspense: null,
    ssContent: null,
    ssFallback: null,
    dirs: null,
    transition: null,
    el: null,
    anchor: null,
    target: null,
    targetStart: null,
    targetAnchor: null,
    staticCount: 0,
    shapeFlag: i,
    patchFlag: s,
    dynamicProps: r,
    dynamicChildren: null,
    appContext: null,
    ctx: Ye,
  };
  return (
    l ? (Zl(c, n), i & 128 && e.normalize(c)) : n && (c.shapeFlag |= ne(n) ? 8 : 16),
    Yn > 0 && !o && et && (c.patchFlag > 0 || i & 6) && c.patchFlag !== 32 && et.push(c),
    c
  );
}
const Ne = my;
function my(e, t = null, n = null, s = 0, r = null, i = !1) {
  if (((!e || e === Of) && (e = Pe), dn(e))) {
    const l = Gt(e, t, !0);
    return (
      n && Zl(l, n),
      Yn > 0 && !i && et && (l.shapeFlag & 6 ? (et[et.indexOf(e)] = l) : et.push(l)),
      (l.patchFlag = -2),
      l
    );
  }
  if ((Ey(e) && (e = e.__vccOpts), t)) {
    t = Qf(t);
    let { class: l, style: c } = t;
    l && !ne(l) && (t.class = Nr(l)),
      ge(c) && (xr(c) && !K(c) && (c = ce({}, c)), (t.style = Or(c)));
  }
  const o = ne(e) ? 1 : _i(e) ? 128 : pf(e) ? 64 : ge(e) ? 4 : Q(e) ? 2 : 0;
  return Jl(e, t, n, s, r, o, i, !0);
}
function Qf(e) {
  return e ? (xr(e) || Ff(e) ? ce({}, e) : e) : null;
}
function Gt(e, t, n = !1, s = !1) {
  const { props: r, ref: i, patchFlag: o, children: l, transition: c } = e,
    u = t ? th(r || {}, t) : r,
    a = {
      __v_isVNode: !0,
      __v_skip: !0,
      type: e.type,
      props: u,
      key: u && Zf(u),
      ref: t && t.ref ? (n && i ? (K(i) ? i.concat(ii(t)) : [i, ii(t)]) : ii(t)) : i,
      scopeId: e.scopeId,
      slotScopeIds: e.slotScopeIds,
      children: l,
      target: e.target,
      targetStart: e.targetStart,
      targetAnchor: e.targetAnchor,
      staticCount: e.staticCount,
      shapeFlag: e.shapeFlag,
      patchFlag: t && e.type !== We ? (o === -1 ? 16 : o | 16) : o,
      dynamicProps: e.dynamicProps,
      dynamicChildren: e.dynamicChildren,
      appContext: e.appContext,
      dirs: e.dirs,
      transition: c,
      component: e.component,
      suspense: e.suspense,
      ssContent: e.ssContent && Gt(e.ssContent),
      ssFallback: e.ssFallback && Gt(e.ssFallback),
      placeholder: e.placeholder,
      el: e.el,
      anchor: e.anchor,
      ctx: e.ctx,
      ce: e.ce,
    };
  return c && s && hn(a, c.clone(a)), a;
}
function Xl(e = " ", t = 0) {
  return Ne(Cn, null, e, t);
}
function gy(e, t) {
  const n = Ne(qn, null, e);
  return (n.staticCount = t), n;
}
function eh(e = "", t = !1) {
  return t ? (mr(), Si(Pe, null, e)) : Ne(Pe, null, e);
}
function ht(e) {
  return e == null || typeof e == "boolean"
    ? Ne(Pe)
    : K(e)
      ? Ne(We, null, e.slice())
      : dn(e)
        ? Qt(e)
        : Ne(Cn, null, String(e));
}
function Qt(e) {
  return (e.el === null && e.patchFlag !== -1) || e.memo ? e : Gt(e);
}
function Zl(e, t) {
  let n = 0;
  const { shapeFlag: s } = e;
  if (t == null) t = null;
  else if (K(t)) n = 16;
  else if (typeof t == "object")
    if (s & 65) {
      const r = t.default;
      r && (r._c && (r._d = !1), Zl(e, r()), r._c && (r._d = !0));
      return;
    } else {
      n = 32;
      const r = t._;
      !r && !Ff(t)
        ? (t._ctx = Ye)
        : r === 3 && Ye && (Ye.slots._ === 1 ? (t._ = 1) : ((t._ = 2), (e.patchFlag |= 1024)));
    }
  else
    Q(t)
      ? ((t = { default: t, _ctx: Ye }), (n = 32))
      : ((t = String(t)), s & 64 ? ((n = 16), (t = [Xl(t)])) : (n = 8));
  (e.children = t), (e.shapeFlag |= n);
}
function th(...e) {
  const t = {};
  for (let n = 0; n < e.length; n++) {
    const s = e[n];
    for (const r in s)
      if (r === "class") t.class !== s.class && (t.class = Nr([t.class, s.class]));
      else if (r === "style") t.style = Or([t.style, s.style]);
      else if (Zn(r)) {
        const i = t[r],
          o = s[r];
        o && i !== o && !(K(i) && i.includes(o))
          ? (t[r] = i ? [].concat(i, o) : o)
          : o == null && i == null && !Bi(r) && (t[r] = o);
      } else r !== "" && (t[r] = s[r]);
  }
  return t;
}
function ut(e, t, n, s = null) {
  It(e, t, 7, [n, s]);
}
const yy = Rf();
let vy = 0;
function nh(e, t, n) {
  const s = e.type,
    r = (t ? t.appContext : e.appContext) || yy,
    i = {
      uid: vy++,
      vnode: e,
      type: s,
      parent: t,
      appContext: r,
      root: null,
      next: null,
      subTree: null,
      effect: null,
      update: null,
      job: null,
      scope: new Nl(!0),
      render: null,
      proxy: null,
      exposed: null,
      exposeProxy: null,
      withProxy: null,
      provides: t ? t.provides : Object.create(r.provides),
      ids: t ? t.ids : ["", 0, 0],
      accessCache: null,
      renderCache: [],
      components: null,
      directives: null,
      propsOptions: Vf(s, r),
      emitsOptions: Pf(s, r),
      emit: null,
      emitted: null,
      propsDefaults: he,
      inheritAttrs: s.inheritAttrs,
      ctx: he,
      data: he,
      props: he,
      attrs: he,
      slots: he,
      refs: he,
      setupState: he,
      setupContext: null,
      suspense: n,
      suspenseId: n ? n.pendingId : 0,
      asyncDep: null,
      asyncResolved: !1,
      isMounted: !1,
      isUnmounted: !1,
      isDeactivated: !1,
      bc: null,
      c: null,
      bm: null,
      m: null,
      bu: null,
      u: null,
      um: null,
      bum: null,
      da: null,
      a: null,
      rtg: null,
      rtc: null,
      ec: null,
      sp: null,
    };
  return (
    (i.ctx = { _: i }), (i.root = t ? t.root : i), (i.emit = Gg.bind(null, i)), e.ce && e.ce(i), i
  );
}
let ze = null;
const Ve = () => ze || Ye;
let Ei, Ss;
{
  const e = Wi(),
    t = (n, s) => {
      let r;
      return (
        (r = e[n]) || (r = e[n] = []),
        r.push(s),
        (i) => {
          r.length > 1 ? r.forEach((o) => o(i)) : r[0](i);
        }
      );
    };
  (Ei = t("__VUE_INSTANCE_SETTERS__", (n) => (ze = n))),
    (Ss = t("__VUE_SSR_SETTERS__", (n) => (Jn = n)));
}
const Ls = (e) => {
    const t = ze;
    return (
      Ei(e),
      e.scope.on(),
      () => {
        e.scope.off(), Ei(t);
      }
    );
  },
  yr = () => {
    ze && ze.scope.off(), Ei(null);
  };
function sh(e) {
  return e.vnode.shapeFlag & 4;
}
let Jn = !1;
function rh(e, t = !1, n = !1) {
  t && Ss(t);
  const { props: s, children: r } = e.vnode,
    i = sh(e);
  Qg(e, s, i, t), sy(e, r, n || t);
  const o = i ? by(e, t) : void 0;
  return t && Ss(!1), o;
}
function by(e, t) {
  const n = e.type;
  (e.accessCache = Object.create(null)), (e.proxy = new Proxy(e.ctx, qo));
  const { setup: s } = n;
  if (s) {
    un();
    const r = (e.setupContext = s.length > 1 ? lh(e) : null),
      i = Ls(e),
      o = Fs(s, e, 0, [e.props, r]),
      l = Ol(o);
    if ((fn(), i(), (l || e.sp) && !on(e) && jl(e), l)) {
      if ((o.then(yr, yr), t))
        return o
          .then((c) => {
            Xo(e, c, t);
          })
          .catch((c) => {
            ts(c, e, 0);
          });
      e.asyncDep = o;
    } else Xo(e, o, t);
  } else oh(e, t);
}
function Xo(e, t, n) {
  Q(t)
    ? e.type.__ssrInlineRender
      ? (e.ssrRender = t)
      : (e.render = t)
    : ge(t) && (e.setupState = kl(t)),
    oh(e, n);
}
let Ti, Zo;
function ih(e) {
  (Ti = e),
    (Zo = (t) => {
      t.render._rc && (t.withProxy = new Proxy(t.ctx, Cg));
    });
}
const y = () => !Ti;
function oh(e, t, n) {
  const s = e.type;
  if (!e.render) {
    if (!t && Ti && !s.render) {
      const r = s.template || ql(e).template;
      if (r) {
        const { isCustomElement: i, compilerOptions: o } = e.appContext.config,
          { delimiters: l, compilerOptions: c } = s,
          u = ce(ce({ isCustomElement: i, delimiters: l }, o), c);
        s.render = Ti(r, u);
      }
    }
    (e.render = s.render || Je), Zo && Zo(e);
  }
  {
    const r = Ls(e);
    un();
    try {
      Bg(e);
    } finally {
      fn(), r();
    }
  }
}
const Sy = {
  get(e, t) {
    return Qe(e, "get", ""), e[t];
  },
};
function lh(e) {
  const t = (n) => {
    e.exposed = n || {};
  };
  return { attrs: new Proxy(e.attrs, Sy), slots: e.slots, emit: e.emit, expose: t };
}
function kr(e) {
  return e.exposed
    ? e.exposeProxy ||
        (e.exposeProxy = new Proxy(kl(Xu(e.exposed)), {
          get(t, n) {
            if (n in t) return t[n];
            if (n in Xs) return Xs[n](e);
          },
          has(t, n) {
            return n in t || n in Xs;
          },
        }))
    : e.proxy;
}
function Qo(e, t = !0) {
  return Q(e) ? e.displayName || e.name : e.name || (t && e.__name);
}
function Ey(e) {
  return Q(e) && "__vccOpts" in e;
}
const oe = (e, t) => Rm(e, t, Jn);
function ro(e, t, n) {
  try {
    gr(-1);
    const s = arguments.length;
    return s === 2
      ? ge(t) && !K(t)
        ? dn(t)
          ? Ne(e, null, [t])
          : Ne(e, t)
        : Ne(e, null, t)
      : (s > 3 ? (n = Array.prototype.slice.call(arguments, 2)) : s === 3 && dn(n) && (n = [n]),
        Ne(e, t, n));
  } finally {
    gr(1);
  }
}
function Ty() {}
function wy(e, t, n, s) {
  const r = n[s];
  if (r && ch(r, e)) return r;
  const i = t();
  return (i.memo = e.slice()), (i.cacheIndex = s), (n[s] = i);
}
function ch(e, t) {
  const n = e.memo;
  if (n.length != t.length) return !1;
  for (let s = 0; s < n.length; s++) if (Ge(n[s], t[s])) return !1;
  return Yn > 0 && et && et.push(e), !0;
}
const ah = "3.5.34",
  Cy = Je,
  Ay = Bm,
  Oy = as,
  Ny = cf,
  xy = {
    createComponentInstance: nh,
    setupComponent: rh,
    renderComponentRoot: ri,
    setCurrentRenderingInstance: hr,
    isVNode: dn,
    normalizeVNode: ht,
    getComponentPublicInstance: kr,
    ensureValidVNode: Kl,
    pushWarningContext: Dm,
    popWarningContext: Fm,
  },
  Ry = xy,
  Iy = null,
  Py = null,
  My = null;
/**
 * @vue/runtime-dom v3.5.34
 * (c) 2018-present Yuxi (Evan) You and Vue contributors
 * @license MIT
 **/ let el;
const ia = typeof window < "u" && window.trustedTypes;
if (ia)
  try {
    el = ia.createPolicy("vue", { createHTML: (e) => e });
  } catch {}
const uh = el ? (e) => el.createHTML(e) : (e) => e,
  ky = "http://www.w3.org/2000/svg",
  Dy = "http://www.w3.org/1998/Math/MathML",
  Zt = typeof document < "u" ? document : null,
  oa = Zt && Zt.createElement("template"),
  fh = {
    insert: (e, t, n) => {
      t.insertBefore(e, n || null);
    },
    remove: (e) => {
      const t = e.parentNode;
      t && t.removeChild(e);
    },
    createElement: (e, t, n, s) => {
      const r =
        t === "svg"
          ? Zt.createElementNS(ky, e)
          : t === "mathml"
            ? Zt.createElementNS(Dy, e)
            : n
              ? Zt.createElement(e, { is: n })
              : Zt.createElement(e);
      return e === "select" && s && s.multiple != null && r.setAttribute("multiple", s.multiple), r;
    },
    createText: (e) => Zt.createTextNode(e),
    createComment: (e) => Zt.createComment(e),
    setText: (e, t) => {
      e.nodeValue = t;
    },
    setElementText: (e, t) => {
      e.textContent = t;
    },
    parentNode: (e) => e.parentNode,
    nextSibling: (e) => e.nextSibling,
    querySelector: (e) => Zt.querySelector(e),
    setScopeId(e, t) {
      e.setAttribute(t, "");
    },
    insertStaticContent(e, t, n, s, r, i) {
      const o = n ? n.previousSibling : t.lastChild;
      if (r && (r === i || r.nextSibling))
        for (; t.insertBefore(r.cloneNode(!0), n), !(r === i || !(r = r.nextSibling)); );
      else {
        oa.innerHTML = uh(
          s === "svg" ? `<svg>${e}</svg>` : s === "mathml" ? `<math>${e}</math>` : e
        );
        const l = oa.content;
        if (s === "svg" || s === "mathml") {
          const c = l.firstChild;
          for (; c.firstChild; ) l.appendChild(c.firstChild);
          l.removeChild(c);
        }
        t.insertBefore(l, n);
      }
      return [o ? o.nextSibling : t.firstChild, n ? n.previousSibling : t.lastChild];
    },
  },
  mn = "transition",
  js = "animation",
  Os = Symbol("_vtc"),
  hh = {
    name: String,
    type: String,
    css: { type: Boolean, default: !0 },
    duration: [String, Number, Object],
    enterFromClass: String,
    enterActiveClass: String,
    enterToClass: String,
    appearFromClass: String,
    appearActiveClass: String,
    appearToClass: String,
    leaveFromClass: String,
    leaveActiveClass: String,
    leaveToClass: String,
  },
  dh = ce({}, Hl, hh),
  Fy = (e) => ((e.displayName = "Transition"), (e.props = dh), e),
  Ly = Fy((e, { slots: t }) => ro(yf, ph(e), t)),
  kn = (e, t = []) => {
    K(e) ? e.forEach((n) => n(...t)) : e && e(...t);
  },
  la = (e) => (e ? (K(e) ? e.some((t) => t.length > 1) : e.length > 1) : !1);
function ph(e) {
  const t = {};
  for (const O in e) O in hh || (t[O] = e[O]);
  if (e.css === !1) return t;
  const {
      name: n = "v",
      type: s,
      duration: r,
      enterFromClass: i = `${n}-enter-from`,
      enterActiveClass: o = `${n}-enter-active`,
      enterToClass: l = `${n}-enter-to`,
      appearFromClass: c = i,
      appearActiveClass: u = o,
      appearToClass: a = l,
      leaveFromClass: f = `${n}-leave-from`,
      leaveActiveClass: d = `${n}-leave-active`,
      leaveToClass: h = `${n}-leave-to`,
    } = e,
    m = Vy(r),
    v = m && m[0],
    _ = m && m[1],
    {
      onBeforeEnter: S,
      onEnter: g,
      onEnterCancelled: p,
      onLeave: b,
      onLeaveCancelled: T,
      onBeforeAppear: R = S,
      onAppear: C = g,
      onAppearCancelled: A = p,
    } = t,
    w = (O, V, k, $) => {
      (O._enterCancelled = $), bn(O, V ? a : l), bn(O, V ? u : o), k && k();
    },
    N = (O, V) => {
      (O._isLeaving = !1), bn(O, f), bn(O, h), bn(O, d), V && V();
    },
    P = (O) => (V, k) => {
      const $ = O ? C : g,
        B = () => w(V, O, k);
      kn($, [V, B]),
        ca(() => {
          bn(V, O ? c : i), jt(V, O ? a : l), la($) || aa(V, s, v, B);
        });
    };
  return ce(t, {
    onBeforeEnter(O) {
      kn(S, [O]), jt(O, i), jt(O, o);
    },
    onBeforeAppear(O) {
      kn(R, [O]), jt(O, c), jt(O, u);
    },
    onEnter: P(!1),
    onAppear: P(!0),
    onLeave(O, V) {
      O._isLeaving = !0;
      const k = () => N(O, V);
      jt(O, f),
        O._enterCancelled ? (jt(O, d), tl(O)) : (tl(O), jt(O, d)),
        ca(() => {
          O._isLeaving && (bn(O, f), jt(O, h), la(b) || aa(O, s, _, k));
        }),
        kn(b, [O, k]);
    },
    onEnterCancelled(O) {
      w(O, !1, void 0, !0), kn(p, [O]);
    },
    onAppearCancelled(O) {
      w(O, !0, void 0, !0), kn(A, [O]);
    },
    onLeaveCancelled(O) {
      N(O), kn(T, [O]);
    },
  });
}
function Vy(e) {
  if (e == null) return null;
  if (ge(e)) return [wo(e.enter), wo(e.leave)];
  {
    const t = wo(e);
    return [t, t];
  }
}
function wo(e) {
  return hi(e);
}
function jt(e, t) {
  t.split(/\s+/).forEach((n) => n && e.classList.add(n)), (e[Os] || (e[Os] = new Set())).add(t);
}
function bn(e, t) {
  t.split(/\s+/).forEach((s) => s && e.classList.remove(s));
  const n = e[Os];
  n && (n.delete(t), n.size || (e[Os] = void 0));
}
function ca(e) {
  requestAnimationFrame(() => {
    requestAnimationFrame(e);
  });
}
let By = 0;
function aa(e, t, n, s) {
  const r = (e._endId = ++By),
    i = () => {
      r === e._endId && s();
    };
  if (n != null) return setTimeout(i, n);
  const { type: o, timeout: l, propCount: c } = mh(e, t);
  if (!o) return s();
  const u = `${o  }end`;
  let a = 0;
  const f = () => {
      e.removeEventListener(u, d), i();
    },
    d = (h) => {
      h.target === e && ++a >= c && f();
    };
  setTimeout(() => {
    a < c && f();
  }, l + 1),
    e.addEventListener(u, d);
}
function mh(e, t) {
  const n = window.getComputedStyle(e),
    s = (m) => (n[m] || "").split(", "),
    r = s(`${mn}Delay`),
    i = s(`${mn}Duration`),
    o = ua(r, i),
    l = s(`${js}Delay`),
    c = s(`${js}Duration`),
    u = ua(l, c);
  let a = null,
    f = 0,
    d = 0;
  t === mn
    ? o > 0 && ((a = mn), (f = o), (d = i.length))
    : t === js
      ? u > 0 && ((a = js), (f = u), (d = c.length))
      : ((f = Math.max(o, u)),
        (a = f > 0 ? (o > u ? mn : js) : null),
        (d = a ? (a === mn ? i.length : c.length) : 0));
  const h = a === mn && /\b(?:transform|all)(?:,|$)/.test(s(`${mn}Property`).toString());
  return { type: a, timeout: f, propCount: d, hasTransform: h };
}
function ua(e, t) {
  for (; e.length < t.length; ) e = e.concat(e);
  return Math.max(...t.map((n, s) => fa(n) + fa(e[s])));
}
function fa(e) {
  return e === "auto" ? 0 : Number(e.slice(0, -1).replace(",", ".")) * 1e3;
}
function tl(e) {
  return (e ? e.ownerDocument : document).body.offsetHeight;
}
function Hy(e, t, n) {
  const s = e[Os];
  s && (t = (t ? [t, ...s] : [...s]).join(" ")),
    t == null ? e.removeAttribute("class") : n ? e.setAttribute("class", t) : (e.className = t);
}
const wi = Symbol("_vod"),
  gh = Symbol("_vsh"),
  yh = {
    name: "show",
    beforeMount(e, { value: t }, { transition: n }) {
      (e[wi] = e.style.display === "none" ? "" : e.style.display),
        n && t ? n.beforeEnter(e) : $s(e, t);
    },
    mounted(e, { value: t }, { transition: n }) {
      n && t && n.enter(e);
    },
    updated(e, { value: t, oldValue: n }, { transition: s }) {
      !t != !n &&
        (s
          ? t
            ? (s.beforeEnter(e), $s(e, !0), s.enter(e))
            : s.leave(e, () => {
                $s(e, !1);
              })
          : $s(e, t));
    },
    beforeUnmount(e, { value: t }) {
      $s(e, t);
    },
  };
function $s(e, t) {
  (e.style.display = t ? e[wi] : "none"), (e[gh] = !t);
}
function jy() {
  yh.getSSRProps = ({ value: e }) => {
    if (!e) return { style: { display: "none" } };
  };
}
const vh = Symbol("");
function $y(e) {
  const t = Ve();
  if (!t) return;
  const n = (t.ut = (r = e(t.proxy)) => {
      Array.from(document.querySelectorAll(`[data-v-owner="${t.uid}"]`)).forEach((i) => Ci(i, r));
    }),
    s = () => {
      const r = e(t.proxy);
      t.ce ? Ci(t.ce, r) : nl(t.subTree, r), n(r);
    };
  $l(() => {
    ur(s);
  }),
    ns(() => {
      de(s, Je, { flush: "post" });
      const r = new MutationObserver(s);
      r.observe(t.subTree.el.parentNode, { childList: !0 }), Mr(() => r.disconnect());
    });
}
function nl(e, t) {
  if (e.shapeFlag & 128) {
    const n = e.suspense;
    (e = n.activeBranch),
      n.pendingBranch &&
        !n.isHydrating &&
        n.effects.push(() => {
          nl(n.activeBranch, t);
        });
  }
  for (; e.component; ) e = e.component.subTree;
  if (e.shapeFlag & 1 && e.el) Ci(e.el, t);
  else if (e.type === We) e.children.forEach((n) => nl(n, t));
  else if (e.type === qn) {
    let { el: n, anchor: s } = e;
    for (; n && (Ci(n, t), n !== s); ) n = n.nextSibling;
  }
}
function Ci(e, t) {
  if (e.nodeType === 1) {
    const n = e.style;
    let s = "";
    for (const r in t) {
      const i = tm(t[r]);
      n.setProperty(`--${r}`, i), (s += `--${r}: ${i};`);
    }
    n[vh] = s;
  }
}
const Uy = /(?:^|;)\s*display\s*:/;
function Wy(e, t, n) {
  const s = e.style,
    r = ne(n);
  let i = !1;
  if (n && !r) {
    if (t)
      if (ne(t))
        for (const o of t.split(";")) {
          const l = o.slice(0, o.indexOf(":")).trim();
          n[l] == null && zs(s, l, "");
        }
      else for (const o in t) n[o] == null && zs(s, o, "");
    for (const o in n) {
      o === "display" && (i = !0);
      const l = n[o];
      l != null ? qy(e, o, !ne(t) && t ? t[o] : void 0, l) || zs(s, o, l) : zs(s, o, "");
    }
  } else if (r) {
    if (t !== n) {
      const o = s[vh];
      o && (n += `;${  o}`), (s.cssText = n), (i = Uy.test(n));
    }
  } else t && e.removeAttribute("style");
  wi in e && ((e[wi] = i ? s.display : ""), e[gh] && (s.display = "none"));
}
const ha = /\s*!important$/;
function zs(e, t, n) {
  if (K(n)) n.forEach((s) => zs(e, t, s));
  else if ((n == null && (n = ""), t.startsWith("--"))) e.setProperty(t, n);
  else {
    const s = Ky(e, t);
    ha.test(n) ? e.setProperty(dt(s), n.replace(ha, ""), "important") : (e[s] = n);
  }
}
const da = ["Webkit", "Moz", "ms"],
  Co = {};
function Ky(e, t) {
  const n = Co[t];
  if (n) return n;
  let s = _e(t);
  if (s !== "filter" && s in e) return (Co[t] = s);
  s = es(s);
  for (let r = 0; r < da.length; r++) {
    const i = da[r] + s;
    if (i in e) return (Co[t] = i);
  }
  return t;
}
function qy(e, t, n, s) {
  return e.tagName === "TEXTAREA" && (t === "width" || t === "height") && ne(s) && n === s;
}
const pa = "http://www.w3.org/1999/xlink";
function ma(e, t, n, s, r, i = Qp(t)) {
  s && t.startsWith("xlink:")
    ? n == null
      ? e.removeAttributeNS(pa, t.slice(6, t.length))
      : e.setAttributeNS(pa, t, n)
    : n == null || (i && !Ru(n))
      ? e.removeAttribute(t)
      : e.setAttribute(t, i ? "" : nt(n) ? String(n) : n);
}
function ga(e, t, n, s, r) {
  if (t === "innerHTML" || t === "textContent") {
    n != null && (e[t] = t === "innerHTML" ? uh(n) : n);
    return;
  }
  const i = e.tagName;
  if (t === "value" && i !== "PROGRESS" && !i.includes("-")) {
    const l = i === "OPTION" ? e.getAttribute("value") || "" : e.value,
      c = n == null ? (e.type === "checkbox" ? "on" : "") : String(n);
    (l !== c || !("_value" in e)) && (e.value = c),
      n == null && e.removeAttribute(t),
      (e._value = n);
    return;
  }
  let o = !1;
  if (n === "" || n == null) {
    const l = typeof e[t];
    l === "boolean"
      ? (n = Ru(n))
      : n == null && l === "string"
        ? ((n = ""), (o = !0))
        : l === "number" && ((n = 0), (o = !0));
  }
  try {
    e[t] = n;
  } catch {}
  o && e.removeAttribute(r || t);
}
function nn(e, t, n, s) {
  e.addEventListener(t, n, s);
}
function Gy(e, t, n, s) {
  e.removeEventListener(t, n, s);
}
const ya = Symbol("_vei");
function zy(e, t, n, s, r = null) {
  const i = e[ya] || (e[ya] = {}),
    o = i[t];
  if (s && o) o.value = s;
  else {
    const [l, c] = Yy(t);
    if (s) {
      const u = (i[t] = Zy(s, r));
      nn(e, l, u, c);
    } else o && (Gy(e, l, o, c), (i[t] = void 0));
  }
}
const va = /(?:Once|Passive|Capture)$/;
function Yy(e) {
  let t;
  if (va.test(e)) {
    t = {};
    let s;
    for (; (s = e.match(va)); )
      (e = e.slice(0, e.length - s[0].length)), (t[s[0].toLowerCase()] = !0);
  }
  return [e[2] === ":" ? e.slice(3) : dt(e.slice(2)), t];
}
let Ao = 0;
const Jy = Promise.resolve(),
  Xy = () => Ao || (Jy.then(() => (Ao = 0)), (Ao = Date.now()));
function Zy(e, t) {
  const n = (s) => {
    if (!s._vts) s._vts = Date.now();
    else if (s._vts <= n.attached) return;
    It(Qy(s, n.value), t, 5, [s]);
  };
  return (n.value = e), (n.attached = Xy()), n;
}
function Qy(e, t) {
  if (K(t)) {
    const n = e.stopImmediatePropagation;
    return (
      (e.stopImmediatePropagation = () => {
        n.call(e), (e._stopped = !0);
      }),
      t.map((s) => (r) => !r._stopped && s && s(r))
    );
  } else return t;
}
const ba = (e) =>
    e.charCodeAt(0) === 111 &&
    e.charCodeAt(1) === 110 &&
    e.charCodeAt(2) > 96 &&
    e.charCodeAt(2) < 123,
  bh = (e, t, n, s, r, i) => {
    const o = r === "svg";
    t === "class"
      ? Hy(e, s, o)
      : t === "style"
        ? Wy(e, n, s)
        : Zn(t)
          ? Bi(t) || zy(e, t, n, s, i)
          : (
                t[0] === "."
                  ? ((t = t.slice(1)), !0)
                  : t[0] === "^"
                    ? ((t = t.slice(1)), !1)
                    : ev(e, t, s, o)
              )
            ? (ga(e, t, s),
              !e.tagName.includes("-") &&
                (t === "value" || t === "checked" || t === "selected") &&
                ma(e, t, s, o, i, t !== "value"))
            : e._isVueCE && (tv(e, t) || (e._def.__asyncLoader && (/[A-Z]/.test(t) || !ne(s))))
              ? ga(e, _e(t), s, i, t)
              : (t === "true-value"
                  ? (e._trueValue = s)
                  : t === "false-value" && (e._falseValue = s),
                ma(e, t, s, o));
  };
function ev(e, t, n, s) {
  if (s) return !!(t === "innerHTML" || t === "textContent" || (t in e && ba(t) && Q(n)));
  if (
    t === "spellcheck" ||
    t === "draggable" ||
    t === "translate" ||
    t === "autocorrect" ||
    (t === "sandbox" && e.tagName === "IFRAME") ||
    t === "form" ||
    (t === "list" && e.tagName === "INPUT") ||
    (t === "type" && e.tagName === "TEXTAREA")
  )
    return !1;
  if (t === "width" || t === "height") {
    const r = e.tagName;
    if (r === "IMG" || r === "VIDEO" || r === "CANVAS" || r === "SOURCE") return !1;
  }
  return ba(t) && ne(n) ? !1 : t in e;
}
function tv(e, t) {
  const n = e._def.props;
  if (!n) return !1;
  const s = _e(t);
  return Array.isArray(n) ? n.some((r) => _e(r) === s) : Object.keys(n).some((r) => _e(r) === s);
}
const a = {};
function _h(e, t, n) {
  let s = Ir(e, t);
  Hi(s) && (s = ce({}, s, t));
  class r extends io {
    constructor(o) {
      super(s, o, n);
    }
  }
  return (r.def = s), r;
}
const nv = (e, t) => _h(e, t, Mh),
  sv = typeof HTMLElement < "u" ? HTMLElement : class {};
class io extends sv {
  constructor(t, n = {}, s = sl) {
    super(),
      (this._def = t),
      (this._props = n),
      (this._createApp = s),
      (this._isVueCE = !0),
      (this._instance = null),
      (this._app = null),
      (this._nonce = this._def.nonce),
      (this._connected = !1),
      (this._resolved = !1),
      (this._patching = !1),
      (this._dirty = !1),
      (this._numberProps = null),
      (this._styleChildren = new WeakSet()),
      (this._styleAnchors = new WeakMap()),
      (this._ob = null),
      this.shadowRoot && s !== sl
        ? (this._root = this.shadowRoot)
        : t.shadowRoot !== !1
          ? (this.attachShadow(ce({}, t.shadowRootOptions, { mode: "open" })),
            (this._root = this.shadowRoot))
          : (this._root = this);
  }
  connectedCallback() {
    if (!this.isConnected) return;
    !this.shadowRoot && !this._resolved && this._parseSlots(), (this._connected = !0);
    let t = this;
    for (; (t = t && (t.assignedSlot || t.parentNode || t.host)); )
      if (t instanceof io) {
        this._parent = t;
        break;
      }
    this._instance ||
      (this._resolved
        ? this._mount(this._def)
        : t && t._pendingResolve
          ? (this._pendingResolve = t._pendingResolve.then(() => {
              (this._pendingResolve = void 0), this._resolveDef();
            }))
          : this._resolveDef());
  }
  _setParent(t = this._parent) {
    t && ((this._instance.parent = t._instance), this._inheritParentContext(t));
  }
  _inheritParentContext(t = this._parent) {
    t && this._app && Object.setPrototypeOf(this._app._context.provides, t._instance.provides);
  }
  disconnectedCallback() {
    (this._connected = !1),
      xn(() => {
        this._connected ||
          (this._ob && (this._ob.disconnect(), (this._ob = null)),
          this._app && this._app.unmount(),
          this._instance && (this._instance.ce = void 0),
          (this._app = this._instance = null),
          this._teleportTargets &&
            (this._teleportTargets.clear(), (this._teleportTargets = void 0)));
      });
  }
  _processMutations(t) {
    for (const n of t) this._setAttr(n.attributeName);
  }
  _resolveDef() {
    if (this._pendingResolve) return;
    for (let s = 0; s < this.attributes.length; s++) this._setAttr(this.attributes[s].name);
    (this._ob = new MutationObserver(this._processMutations.bind(this))),
      this._ob.observe(this, { attributes: !0 });
    const t = (s, r = !1) => {
        (this._resolved = !0), (this._pendingResolve = void 0);
        const { props: i, styles: o } = s;
        let l;
        if (i && !K(i))
          for (const c in i) {
            const u = i[c];
            (u === Number || (u && u.type === Number)) &&
              (c in this._props && (this._props[c] = hi(this._props[c])),
              ((l || (l = Object.create(null)))[_e(c)] = !0));
          }
        (this._numberProps = l),
          this._resolveProps(s),
          this.shadowRoot && this._applyStyles(o),
          this._mount(s);
      },
      n = this._def.__asyncLoader;
    n
      ? (this._pendingResolve = n().then((s) => {
          (s.configureApp = this._def.configureApp), t((this._def = s), !0);
        }))
      : t(this._def);
  }
  _mount(t) {
    (this._app = this._createApp(t)),
      this._inheritParentContext(),
      t.configureApp && t.configureApp(this._app),
      (this._app._ceVNode = this._createVNode()),
      this._app.mount(this._root);
    const n = this._instance && this._instance.exposed;
    if (n)
      for (const s in n) ye(this, s) || Object.defineProperty(this, s, { get: () => Ke(n[s]) });
  }
  _resolveProps(t) {
    const { props: n } = t,
      s = K(n) ? n : Object.keys(n || {});
    for (const r of Object.keys(this)) r[0] !== "_" && s.includes(r) && this._setProp(r, this[r]);
    for (const r of s.map(_e))
      Object.defineProperty(this, r, {
        get() {
          return this._getProp(r);
        },
        set(i) {
          this._setProp(r, i, !0, !this._patching);
        },
      });
  }
  _setAttr(t) {
    if (t.startsWith("data-v-")) return;
    const n = this.hasAttribute(t);
    let s = n ? this.getAttribute(t) : _a;
    const r = _e(t);
    n && this._numberProps && this._numberProps[r] && (s = hi(s)), this._setProp(r, s, !1, !0);
  }
  _getProp(t) {
    return this._props[t];
  }
  _setProp(t, n, s = !0, r = !1) {
    if (
      n !== this._props[t] &&
      ((this._dirty = !0),
      n === _a
        ? delete this._props[t]
        : ((this._props[t] = n), t === "key" && this._app && (this._app._ceVNode.key = n)),
      r && this._instance && this._update(),
      s)
    ) {
      const i = this._ob;
      i && (this._processMutations(i.takeRecords()), i.disconnect()),
        n === !0
          ? this.setAttribute(dt(t), "")
          : typeof n == "string" || typeof n == "number"
            ? this.setAttribute(dt(t), `${n  }`)
            : n || this.removeAttribute(dt(t)),
        i && i.observe(this, { attributes: !0 });
    }
  }
  _update() {
    const t = this._createVNode();
    this._app && (t.appContext = this._app._context), Ph(t, this._root);
  }
  _createVNode() {
    const t = {};
    this.shadowRoot || (t.onVnodeMounted = t.onVnodeUpdated = this._renderSlots.bind(this));
    const n = Ne(this._def, ce(t, this._props));
    return (
      this._instance ||
        (n.ce = (s) => {
          (this._instance = s), (s.ce = this), (s.isCE = !0);
          const r = (i, o) => {
            this.dispatchEvent(
              new CustomEvent(i, Hi(o[0]) ? ce({ detail: o }, o[0]) : { detail: o })
            );
          };
          (s.emit = (i, ...o) => {
            r(i, o), dt(i) !== i && r(dt(i), o);
          }),
            this._setParent();
        }),
      n
    );
  }
  _applyStyles(t, n, s) {
    if (!t) return;
    if (n) {
      if (n === this._def || this._styleChildren.has(n)) return;
      this._styleChildren.add(n);
    }
    const r = this._nonce,
      i = this.shadowRoot,
      o = s
        ? this._getStyleAnchor(s) || this._getStyleAnchor(this._def)
        : this._getRootStyleInsertionAnchor(i);
    let l = null;
    for (let c = t.length - 1; c >= 0; c--) {
      const u = document.createElement("style");
      r && u.setAttribute("nonce", r),
        (u.textContent = t[c]),
        i.insertBefore(u, l || o),
        (l = u),
        c === 0 && (s || this._styleAnchors.set(this._def, u), n && this._styleAnchors.set(n, u));
    }
  }
  _getStyleAnchor(t) {
    if (!t) return null;
    const n = this._styleAnchors.get(t);
    return n && n.parentNode === this.shadowRoot ? n : (n && this._styleAnchors.delete(t), null);
  }
  _getRootStyleInsertionAnchor(t) {
    for (let n = 0; n < t.childNodes.length; n++) {
      const s = t.childNodes[n];
      if (!(s instanceof HTMLStyleElement)) return s;
    }
    return null;
  }
  _parseSlots() {
    const t = (this._slots = {});
    let n;
    for (; (n = this.firstChild); ) {
      const s = (n.nodeType === 1 && n.getAttribute("slot")) || "default";
      (t[s] || (t[s] = [])).push(n), this.removeChild(n);
    }
  }
  _renderSlots() {
    const t = this._getSlots(),
      n = this._instance.type.__scopeId;
    for (let s = 0; s < t.length; s++) {
      const r = t[s],
        i = r.getAttribute("name") || "default",
        o = this._slots[i],
        l = r.parentNode;
      if (o)
        for (const c of o) {
          if (n && c.nodeType === 1) {
            const u = `${n  }-s`,
              a = document.createTreeWalker(c, 1);
            c.setAttribute(u, "");
            let f;
            for (; (f = a.nextNode()); ) f.setAttribute(u, "");
          }
          l.insertBefore(c, r);
        }
      else for (; r.firstChild; ) l.insertBefore(r.firstChild, r);
      l.removeChild(r);
    }
  }
  _getSlots() {
    const t = [this];
    this._teleportTargets && t.push(...this._teleportTargets);
    const n = new Set();
    for (const s of t) {
      const r = s.querySelectorAll("slot");
      for (let i = 0; i < r.length; i++) n.add(r[i]);
    }
    return Array.from(n);
  }
  _injectChildStyle(t, n) {
    this._applyStyles(t.styles, t, n);
  }
  _beginPatch() {
    (this._patching = !0), (this._dirty = !1);
  }
  _endPatch() {
    (this._patching = !1), this._dirty && this._instance && this._update();
  }
  _hasShadowRoot() {
    return this._def.shadowRoot !== !1;
  }
  _removeChildStyle(t) {}
}
function Sh(e) {
  const t = Ve(),
    n = t && t.ce;
  return n || null;
}
function rv() {
  const e = Sh();
  return e && e.shadowRoot;
}
function iv(e = "$style") {
  {
    const t = Ve();
    if (!t) return he;
    const n = t.type.__cssModules;
    if (!n) return he;
    const s = n[e];
    return s || he;
  }
}
const Eh = new WeakMap(),
  Th = new WeakMap(),
  Ai = Symbol("_moveCb"),
  Sa = Symbol("_enterCb"),
  ov = (e) => (delete e.props.mode, e),
  lv = ov({
    name: "TransitionGroup",
    props: ce({}, dh, { tag: String, moveClass: String }),
    setup(e, { slots: t }) {
      const n = Ve(),
        s = Bl();
      let r, i;
      return (
        eo(() => {
          if (!r.length) return;
          const o = e.moveClass || `${e.name || "v"}-move`;
          if (!hv(r[0].el, n.vnode.el, o)) {
            r = [];
            return;
          }
          r.forEach(av), r.forEach(uv);
          const l = r.filter(fv);
          tl(n.vnode.el),
            l.forEach((c) => {
              const u = c.el,
                a = u.style;
              jt(u, o), (a.transform = a.webkitTransform = a.transitionDuration = "");
              const f = (u[Ai] = (d) => {
                (d && d.target !== u) ||
                  ((!d || d.propertyName.endsWith("transform")) &&
                    (u.removeEventListener("transitionend", f), (u[Ai] = null), bn(u, o)));
              });
              u.addEventListener("transitionend", f);
            }),
            (r = []);
        }),
        () => {
          const o = fe(e),
            l = ph(o);
          const c = o.tag || We;
          if (((r = []), i))
            for (let u = 0; u < i.length; u++) {
              const a = i[u];
              a.el &&
                a.el instanceof Element &&
                (r.push(a), hn(a, As(a, l, s, n)), Eh.set(a, wh(a.el)));
            }
          i = t.default ? Zi(t.default()) : [];
          for (let u = 0; u < i.length; u++) {
            const a = i[u];
            a.key != null && hn(a, As(a, l, s, n));
          }
          return Ne(c, null, i);
        }
      );
    },
  }),
  cv = lv;
function av(e) {
  const t = e.el;
  t[Ai] && t[Ai](), t[Sa] && t[Sa]();
}
function uv(e) {
  Th.set(e, wh(e.el));
}
function fv(e) {
  const t = Eh.get(e),
    n = Th.get(e),
    s = t.left - n.left,
    r = t.top - n.top;
  if (s || r) {
    const i = e.el,
      o = i.style,
      l = i.getBoundingClientRect();
    let c = 1,
      u = 1;
    return (
      i.offsetWidth && (c = l.width / i.offsetWidth),
      i.offsetHeight && (u = l.height / i.offsetHeight),
      (!Number.isFinite(c) || c === 0) && (c = 1),
      (!Number.isFinite(u) || u === 0) && (u = 1),
      Math.abs(c - 1) < 0.01 && (c = 1),
      Math.abs(u - 1) < 0.01 && (u = 1),
      (o.transform = o.webkitTransform = `translate(${s / c}px,${r / u}px)`),
      (o.transitionDuration = "0s"),
      e
    );
  }
}
function wh(e) {
  const t = e.getBoundingClientRect();
  return { left: t.left, top: t.top };
}
function hv(e, t, n) {
  const s = e.cloneNode(),
    r = e[Os];
  r &&
    r.forEach((l) => {
      l.split(/\s+/).forEach((c) => c && s.classList.remove(c));
    }),
    n.split(/\s+/).forEach((l) => l && s.classList.add(l)),
    (s.style.display = "none");
  const i = t.nodeType === 1 ? t : t.parentNode;
  i.appendChild(s);
  const { hasTransform: o } = mh(s);
  return i.removeChild(s), o;
}
const On = (e) => {
  const t = e.props["onUpdate:modelValue"] || !1;
  return K(t) ? (n) => gs(t, n) : t;
};
function dv(e) {
  e.target.composing = !0;
}
function Ea(e) {
  const t = e.target;
  t.composing && ((t.composing = !1), t.dispatchEvent(new Event("input")));
}
const Rt = Symbol("_assign");
function Ta(e, t, n) {
  return t && (e = e.trim()), n && (e = Ui(e)), e;
}
const Oi = {
    created(e, { modifiers: { lazy: t, trim: n, number: s } }, r) {
      e[Rt] = On(r);
      const i = s || (r.props && r.props.type === "number");
      nn(e, t ? "change" : "input", (o) => {
        o.target.composing || e[Rt](Ta(e.value, n, i));
      }),
        (n || i) &&
          nn(e, "change", () => {
            e.value = Ta(e.value, n, i);
          }),
        t || (nn(e, "compositionstart", dv), nn(e, "compositionend", Ea), nn(e, "change", Ea));
    },
    mounted(e, { value: t }) {
      e.value = t ?? "";
    },
    beforeUpdate(e, { value: t, oldValue: n, modifiers: { lazy: s, trim: r, number: i } }, o) {
      if (((e[Rt] = On(o)), e.composing)) return;
      const l = (i || e.type === "number") && !/^0\d/.test(e.value) ? Ui(e.value) : e.value,
        c = t ?? "";
      if (l === c) return;
      const u = e.getRootNode();
      ((u instanceof Document || u instanceof ShadowRoot) &&
        u.activeElement === e &&
        e.type !== "range" &&
        ((s && t === n) || (r && e.value.trim() === c))) ||
        (e.value = c);
    },
  },
  Ql = {
    deep: !0,
    created(e, t, n) {
      (e[Rt] = On(n)),
        nn(e, "change", () => {
          const s = e._modelValue,
            r = Ns(e),
            i = e.checked,
            o = e[Rt];
          if (K(s)) {
            const l = Ki(s, r),
              c = l !== -1;
            if (i && !c) o(s.concat(r));
            else if (!i && c) {
              const u = [...s];
              u.splice(l, 1), o(u);
            }
          } else if (Qn(s)) {
            const l = new Set(s);
            i ? l.add(r) : l.delete(r), o(l);
          } else o(Ah(e, i));
        });
    },
    mounted: wa,
    beforeUpdate(e, t, n) {
      (e[Rt] = On(n)), wa(e, t, n);
    },
  };
function wa(e, { value: t, oldValue: n }, s) {
  e._modelValue = t;
  let r;
  if (K(t)) r = Ki(t, s.props.value) > -1;
  else if (Qn(t)) r = t.has(s.props.value);
  else {
    if (t === n) return;
    r = an(t, Ah(e, !0));
  }
  e.checked !== r && (e.checked = r);
}
const ec = {
    created(e, { value: t }, n) {
      (e.checked = an(t, n.props.value)),
        (e[Rt] = On(n)),
        nn(e, "change", () => {
          e[Rt](Ns(e));
        });
    },
    beforeUpdate(e, { value: t, oldValue: n }, s) {
      (e[Rt] = On(s)), t !== n && (e.checked = an(t, s.props.value));
    },
  },
  Ch = {
    deep: !0,
    created(e, { value: t, modifiers: { number: n } }, s) {
      const r = Qn(t);
      nn(e, "change", () => {
        const i = Array.prototype.filter
          .call(e.options, (o) => o.selected)
          .map((o) => (n ? Ui(Ns(o)) : Ns(o)));
        e[Rt](e.multiple ? (r ? new Set(i) : i) : i[0]),
          (e._assigning = !0),
          xn(() => {
            e._assigning = !1;
          });
      }),
        (e[Rt] = On(s));
    },
    mounted(e, { value: t }) {
      Ca(e, t);
    },
    beforeUpdate(e, t, n) {
      e[Rt] = On(n);
    },
    updated(e, { value: t }) {
      e._assigning || Ca(e, t);
    },
  };
function Ca(e, t) {
  const n = e.multiple,
    s = K(t);
  if (!(n && !s && !Qn(t))) {
    for (let r = 0, i = e.options.length; r < i; r++) {
      const o = e.options[r],
        l = Ns(o);
      if (n)
        if (s) {
          const c = typeof l;
          c === "string" || c === "number"
            ? (o.selected = t.some((u) => String(u) === String(l)))
            : (o.selected = Ki(t, l) > -1);
        } else o.selected = t.has(l);
      else if (an(Ns(o), t)) {
        e.selectedIndex !== r && (e.selectedIndex = r);
        return;
      }
    }
    !n && e.selectedIndex !== -1 && (e.selectedIndex = -1);
  }
}
function Ns(e) {
  return "_value" in e ? e._value : e.value;
}
function Ah(e, t) {
  const n = t ? "_trueValue" : "_falseValue";
  return n in e ? e[n] : t;
}
const Oh = {
  created(e, t, n) {
    Xr(e, t, n, null, "created");
  },
  mounted(e, t, n) {
    Xr(e, t, n, null, "mounted");
  },
  beforeUpdate(e, t, n, s) {
    Xr(e, t, n, s, "beforeUpdate");
  },
  updated(e, t, n, s) {
    Xr(e, t, n, s, "updated");
  },
};
function Nh(e, t) {
  switch (e) {
    case "SELECT":
      return Ch;
    case "TEXTAREA":
      return Oi;
    default:
      switch (t) {
        case "checkbox":
          return Ql;
        case "radio":
          return ec;
        default:
          return Oi;
      }
  }
}
function Xr(e, t, n, s, r) {
  const o = Nh(e.tagName, n.props && n.props.type)[r];
  o && o(e, t, n, s);
}
function pv() {
  (Oi.getSSRProps = ({ value: e }) => ({ value: e })),
    (ec.getSSRProps = ({ value: e }, t) => {
      if (t.props && an(t.props.value, e)) return { checked: !0 };
    }),
    (Ql.getSSRProps = ({ value: e }, t) => {
      if (K(e)) {
        if (t.props && Ki(e, t.props.value) > -1) return { checked: !0 };
      } else if (Qn(e)) {
        if (t.props && e.has(t.props.value)) return { checked: !0 };
      } else if (e) return { checked: !0 };
    }),
    (Oh.getSSRProps = (e, t) => {
      if (typeof t.type != "string") return;
      const n = Nh(t.type.toUpperCase(), t.props && t.props.type);
      if (n.getSSRProps) return n.getSSRProps(e, t);
    });
}
const mv = ["ctrl", "shift", "alt", "meta"],
  gv = {
    stop: (e) => e.stopPropagation(),
    prevent: (e) => e.preventDefault(),
    self: (e) => e.target !== e.currentTarget,
    ctrl: (e) => !e.ctrlKey,
    shift: (e) => !e.shiftKey,
    alt: (e) => !e.altKey,
    meta: (e) => !e.metaKey,
    left: (e) => "button" in e && e.button !== 0,
    middle: (e) => "button" in e && e.button !== 1,
    right: (e) => "button" in e && e.button !== 2,
    exact: (e, t) => mv.some((n) => e[`${n}Key`] && !t.includes(n)),
  },
  yv = (e, t) => {
    if (!e) return e;
    const n = e._withMods || (e._withMods = {}),
      s = t.join(".");
    return (
      n[s] ||
      (n[s] = (r, ...i) => {
        for (let o = 0; o < t.length; o++) {
          const l = gv[t[o]];
          if (l && l(r, t)) return;
        }
        return e(r, ...i);
      })
    );
  },
  vv = {
    esc: "escape",
    space: " ",
    up: "arrow-up",
    left: "arrow-left",
    right: "arrow-right",
    down: "arrow-down",
    delete: "backspace",
  },
  bv = (e, t) => {
    const n = e._withKeys || (e._withKeys = {}),
      s = t.join(".");
    return (
      n[s] ||
      (n[s] = (r) => {
        if (!("key" in r)) return;
        const i = dt(r.key);
        if (t.some((o) => o === i || vv[o] === i)) return e(r);
      })
    );
  },
  xh = ce({ patchProp: bh }, fh);
let Qs,
  Aa = !1;
function Rh() {
  return Qs || (Qs = $f(xh));
}
function Ih() {
  return (Qs = Aa ? Qs : Uf(xh)), (Aa = !0), Qs;
}
const Ph = (...e) => {
    Rh().render(...e);
  },
  v = (...e) => {
    Ih().hydrate(...e);
  },
  sl = (...e) => {
    const t = Rh().createApp(...e),
      { mount: n } = t;
    return (
      (t.mount = (s) => {
        const r = Dh(s);
        if (!r) return;
        const i = t._component;
        !Q(i) && !i.render && !i.template && (i.template = r.innerHTML),
          r.nodeType === 1 && (r.textContent = "");
        const o = n(r, !1, kh(r));
        return (
          r instanceof Element && (r.removeAttribute("v-cloak"), r.setAttribute("data-v-app", "")),
          o
        );
      }),
      t
    );
  },
  Mh = (...e) => {
    const t = Ih().createApp(...e),
      { mount: n } = t;
    return (
      (t.mount = (s) => {
        const r = Dh(s);
        if (r) return n(r, !0, kh(r));
      }),
      t
    );
  };
function kh(e) {
  if (e instanceof SVGElement) return "svg";
  if (typeof MathMLElement == "function" && e instanceof MathMLElement) return "mathml";
}
function Dh(e) {
  return ne(e) ? document.querySelector(e) : e;
}
let Oa = !1;
const Sv = () => {
    Oa || ((Oa = !0), pv(), jy());
  },
  Ev = Object.freeze(
    Object.defineProperty(
      {
        __proto__: null,
        BaseTransition: yf,
        BaseTransitionPropsValidators: Hl,
        Comment: Pe,
        DeprecationTypes: My,
        EffectScope: Nl,
        ErrorCodes: Vm,
        ErrorTypeStrings: Ay,
        Fragment: We,
        KeepAlive: mg,
        ReactiveEffect: or,
        Static: qn,
        Suspense: ly,
        Teleport: Xm,
        Text: Cn,
        TrackOpTypes: Im,
        Transition: Ly,
        TransitionGroup: cv,
        TriggerOpTypes: Pm,
        VueElement: io,
        assertNumber: Lm,
        callWithAsyncErrorHandling: It,
        callWithErrorHandling: Fs,
        camelize: _e,
        capitalize: es,
        cloneVNode: Gt,
        compatUtils: Py,
        computed: oe,
        createApp: sl,
        createBlock: Si,
        createCommentVNode: eh,
        createElementBlock: dy,
        createElementVNode: Jl,
        createHydrationRenderer: Uf,
        createPropsRestProxy: Lg,
        createRenderer: $f,
        createSSRApp: Mh,
        createSlots: Eg,
        createStaticVNode: gy,
        createTextVNode: Xl,
        createVNode: Ne,
        customRef: Ji,
        defineAsyncComponent: dg,
        defineComponent: Ir,
        defineCustomElement: _h,
        defineEmits: Og,
        defineExpose: Ng,
        defineModel: Ig,
        defineOptions: xg,
        defineProps: Ag,
        defineSSRCustomElement: nv,
        defineSlots: Rg,
        devtools: Oy,
        effect: sm,
        effectScope: ku,
        getCurrentInstance: Ve,
        getCurrentScope: xl,
        getCurrentWatcher: Mm,
        getTransitionRawChildren: Zi,
        guardReactiveProps: Qf,
        h: ro,
        handleError: ts,
        hasInjectionContext: Ll,
        hydrate: _v,
        hydrateOnIdle: lg,
        hydrateOnInteraction: fg,
        hydrateOnMediaQuery: ug,
        hydrateOnVisible: ag,
        initCustomFormatter: Ty,
        initDirectivesForSSR: Sv,
        inject: St,
        isMemoSame: ch,
        isProxy: xr,
        isReactive: rn,
        isReadonly: qt,
        isRef: we,
        isRuntimeOnly: _y,
        isShallow: mt,
        isVNode: dn,
        markRaw: Xu,
        mergeDefaults: Dg,
        mergeModels: Fg,
        mergeProps: th,
        nextTick: xn,
        nodeOps: fh,
        normalizeClass: Nr,
        normalizeProps: Up,
        normalizeStyle: Or,
        onActivated: bf,
        onBeforeMount: Ef,
        onBeforeUnmount: to,
        onBeforeUpdate: $l,
        onDeactivated: _f,
        onErrorCaptured: Af,
        onMounted: ns,
        onRenderTracked: Cf,
        onRenderTriggered: wf,
        onScopeDispose: Du,
        onServerPrefetch: Tf,
        onUnmounted: Mr,
        onUpdated: eo,
        onWatcherCleanup: nf,
        openBlock: mr,
        patchProp: bh,
        popScopeId: Um,
        provide: vs,
        proxyRefs: kl,
        pushScopeId: $m,
        queuePostFlushCb: ur,
        reactive: gt,
        readonly: kt,
        ref: Le,
        registerRuntimeCompiler: ih,
        render: Ph,
        renderList: Sg,
        renderSlot: Tg,
        resolveComponent: vg,
        resolveDirective: _g,
        resolveDynamicComponent: bg,
        resolveFilter: Iy,
        resolveTransitionHooks: As,
        setBlockTracking: gr,
        setDevtoolsHook: Ny,
        setTransitionHooks: hn,
        shallowReactive: Ml,
        shallowReadonly: ar,
        shallowRef: te,
        ssrContextKey: af,
        ssrUtils: Ry,
        stop: rm,
        toDisplayString: Pu,
        toHandlerKey: ms,
        toHandlers: wg,
        toRaw: fe,
        toRef: ef,
        toRefs: Qu,
        toValue: re,
        transformVNodeArgs: py,
        triggerRef: wm,
        unref: Ke,
        useAttrs: kg,
        useCssModule: iv,
        useCssVars: $y,
        useHost: Sh,
        useId: Qm,
        useModel: qg,
        useSSRContext: uf,
        useShadowRoot: rv,
        useSlots: Mg,
        useTemplateRef: eg,
        useTransitionState: Bl,
        vModelCheckbox: Ql,
        vModelDynamic: Oh,
        vModelRadio: ec,
        vModelSelect: Ch,
        vModelText: Oi,
        vShow: yh,
        version: ah,
        warn: Cy,
        watch: de,
        watchEffect: Vl,
        watchPostEffect: qm,
        watchSyncEffect: ff,
        withAsyncContext: Vg,
        withCtx: Fl,
        withDefaults: Pg,
        withDirectives: Km,
        withKeys: bv,
        withMemo: wy,
        withModifiers: yv,
        withScopeId: Wm,
      },
      Symbol.toStringTag,
      { value: "Module" }
    )
  );
/**
 * @vue/compiler-core v3.5.34
 * (c) 2018-present Yuxi (Evan) You and Vue contributors
 * @license MIT
 **/ const vr = Symbol(""),
  er = Symbol(""),
  tc = Symbol(""),
  Ni = Symbol(""),
  Fh = Symbol(""),
  Xn = Symbol(""),
  Lh = Symbol(""),
  Vh = Symbol(""),
  nc = Symbol(""),
  sc = Symbol(""),
  Dr = Symbol(""),
  rc = Symbol(""),
  Bh = Symbol(""),
  ic = Symbol(""),
  oc = Symbol(""),
  lc = Symbol(""),
  cc = Symbol(""),
  ac = Symbol(""),
  uc = Symbol(""),
  Hh = Symbol(""),
  jh = Symbol(""),
  oo = Symbol(""),
  xi = Symbol(""),
  fc = Symbol(""),
  hc = Symbol(""),
  br = Symbol(""),
  Fr = Symbol(""),
  dc = Symbol(""),
  rl = Symbol(""),
  Tv = Symbol(""),
  il = Symbol(""),
  Ri = Symbol(""),
  wv = Symbol(""),
  Cv = Symbol(""),
  pc = Symbol(""),
  Av = Symbol(""),
  Ov = Symbol(""),
  mc = Symbol(""),
  $h = Symbol(""),
  xs = {
    [vr]: "Fragment",
    [er]: "Teleport",
    [tc]: "Suspense",
    [Ni]: "KeepAlive",
    [Fh]: "BaseTransition",
    [Xn]: "openBlock",
    [Lh]: "createBlock",
    [Vh]: "createElementBlock",
    [nc]: "createVNode",
    [sc]: "createElementVNode",
    [Dr]: "createCommentVNode",
    [rc]: "createTextVNode",
    [Bh]: "createStaticVNode",
    [ic]: "resolveComponent",
    [oc]: "resolveDynamicComponent",
    [lc]: "resolveDirective",
    [cc]: "resolveFilter",
    [ac]: "withDirectives",
    [uc]: "renderList",
    [Hh]: "renderSlot",
    [jh]: "createSlots",
    [oo]: "toDisplayString",
    [xi]: "mergeProps",
    [fc]: "normalizeClass",
    [hc]: "normalizeStyle",
    [br]: "normalizeProps",
    [Fr]: "guardReactiveProps",
    [dc]: "toHandlers",
    [rl]: "camelize",
    [Tv]: "capitalize",
    [il]: "toHandlerKey",
    [Ri]: "setBlockTracking",
    [wv]: "pushScopeId",
    [Cv]: "popScopeId",
    [pc]: "withCtx",
    [Av]: "unref",
    [Ov]: "isRef",
    [mc]: "withMemo",
    [$h]: "isMemoSame",
  };
function Nv(e) {
  Object.getOwnPropertySymbols(e).forEach((t) => {
    xs[t] = e[t];
  });
}
const Tt = {
  start: { line: 1, column: 1, offset: 0 },
  end: { line: 1, column: 1, offset: 0 },
  source: "",
};
function xv(e, t = "") {
  return {
    type: 0,
    source: t,
    children: e,
    helpers: new Set(),
    components: [],
    directives: [],
    hoists: [],
    imports: [],
    cached: [],
    temps: 0,
    codegenNode: void 0,
    loc: Tt,
  };
}
function _r(e, t, n, s, r, i, o, l = !1, c = !1, u = !1, a = Tt) {
  return (
    e &&
      (l ? (e.helper(Xn), e.helper(Ps(e.inSSR, u))) : e.helper(Is(e.inSSR, u)), o && e.helper(ac)),
    {
      type: 13,
      tag: t,
      props: n,
      children: s,
      patchFlag: r,
      dynamicProps: i,
      directives: o,
      isBlock: l,
      disableTracking: c,
      isComponent: u,
      loc: a,
    }
  );
}
function Gn(e, t = Tt) {
  return { type: 17, loc: t, elements: e };
}
function xt(e, t = Tt) {
  return { type: 15, loc: t, properties: e };
}
function Fe(e, t) {
  return { type: 16, loc: Tt, key: ne(e) ? ie(e, !0) : e, value: t };
}
function ie(e, t = !1, n = Tt, s = 0) {
  return { type: 4, loc: n, content: e, isStatic: t, constType: t ? 3 : s };
}
function Ft(e, t = Tt) {
  return { type: 8, loc: t, children: e };
}
function $e(e, t = [], n = Tt) {
  return { type: 14, loc: n, callee: e, arguments: t };
}
function Rs(e, t = void 0, n = !1, s = !1, r = Tt) {
  return { type: 18, params: e, returns: t, newline: n, isSlot: s, loc: r };
}
function ol(e, t, n, s = !0) {
  return { type: 19, test: e, consequent: t, alternate: n, newline: s, loc: Tt };
}
function Rv(e, t, n = !1, s = !1) {
  return {
    type: 20,
    index: e,
    value: t,
    needPauseTracking: n,
    inVOnce: s,
    needArraySpread: !1,
    loc: Tt,
  };
}
function Iv(e) {
  return { type: 21, body: e, loc: Tt };
}
function Is(e, t) {
  return e || t ? nc : sc;
}
function Ps(e, t) {
  return e || t ? Lh : Vh;
}
function gc(e, { helper: t, removeHelper: n, inSSR: s }) {
  e.isBlock || ((e.isBlock = !0), n(Is(s, e.isComponent)), t(Xn), t(Ps(s, e.isComponent)));
}
const Na = new Uint8Array([123, 123]),
  xa = new Uint8Array([125, 125]);
function Ra(e) {
  return (e >= 97 && e <= 122) || (e >= 65 && e <= 90);
}
function bt(e) {
  return e === 32 || e === 10 || e === 9 || e === 12 || e === 13;
}
function gn(e) {
  return e === 47 || e === 62 || bt(e);
}
function Ii(e) {
  const t = new Uint8Array(e.length);
  for (let n = 0; n < e.length; n++) t[n] = e.charCodeAt(n);
  return t;
}
const Xe = {
  Cdata: new Uint8Array([67, 68, 65, 84, 65, 91]),
  CdataEnd: new Uint8Array([93, 93, 62]),
  CommentEnd: new Uint8Array([45, 45, 62]),
  ScriptEnd: new Uint8Array([60, 47, 115, 99, 114, 105, 112, 116]),
  StyleEnd: new Uint8Array([60, 47, 115, 116, 121, 108, 101]),
  TitleEnd: new Uint8Array([60, 47, 116, 105, 116, 108, 101]),
  TextareaEnd: new Uint8Array([60, 47, 116, 101, 120, 116, 97, 114, 101, 97]),
};
class Pv {
  constructor(t, n) {
    (this.stack = t),
      (this.cbs = n),
      (this.state = 1),
      (this.buffer = ""),
      (this.sectionStart = 0),
      (this.index = 0),
      (this.entityStart = 0),
      (this.baseState = 1),
      (this.inRCDATA = !1),
      (this.inXML = !1),
      (this.inVPre = !1),
      (this.newlines = []),
      (this.mode = 0),
      (this.delimiterOpen = Na),
      (this.delimiterClose = xa),
      (this.delimiterIndex = -1),
      (this.currentSequence = void 0),
      (this.sequenceIndex = 0);
  }
  get inSFCRoot() {
    return this.mode === 2 && this.stack.length === 0;
  }
  reset() {
    (this.state = 1),
      (this.mode = 0),
      (this.buffer = ""),
      (this.sectionStart = 0),
      (this.index = 0),
      (this.baseState = 1),
      (this.inRCDATA = !1),
      (this.currentSequence = void 0),
      (this.newlines.length = 0),
      (this.delimiterOpen = Na),
      (this.delimiterClose = xa);
  }
  getPos(t) {
    let n = 1,
      s = t + 1;
    const r = this.newlines.length;
    let i = -1;
    if (r > 100) {
      let o = -1,
        l = r;
      for (; o + 1 < l; ) {
        const c = (o + l) >>> 1;
        this.newlines[c] < t ? (o = c) : (l = c);
      }
      i = o;
    } else
      for (let o = r - 1; o >= 0; o--)
        if (t > this.newlines[o]) {
          i = o;
          break;
        }
    return i >= 0 && ((n = i + 2), (s = t - this.newlines[i])), { column: s, line: n, offset: t };
  }
  peek() {
    return this.buffer.charCodeAt(this.index + 1);
  }
  stateText(t) {
    t === 60
      ? (this.index > this.sectionStart && this.cbs.ontext(this.sectionStart, this.index),
        (this.state = 5),
        (this.sectionStart = this.index))
      : !this.inVPre &&
        t === this.delimiterOpen[0] &&
        ((this.state = 2), (this.delimiterIndex = 0), this.stateInterpolationOpen(t));
  }
  stateInterpolationOpen(t) {
    if (t === this.delimiterOpen[this.delimiterIndex])
      if (this.delimiterIndex === this.delimiterOpen.length - 1) {
        const n = this.index + 1 - this.delimiterOpen.length;
        n > this.sectionStart && this.cbs.ontext(this.sectionStart, n),
          (this.state = 3),
          (this.sectionStart = n);
      } else this.delimiterIndex++;
    else
      this.inRCDATA
        ? ((this.state = 32), this.stateInRCDATA(t))
        : ((this.state = 1), this.stateText(t));
  }
  stateInterpolation(t) {
    t === this.delimiterClose[0] &&
      ((this.state = 4), (this.delimiterIndex = 0), this.stateInterpolationClose(t));
  }
  stateInterpolationClose(t) {
    t === this.delimiterClose[this.delimiterIndex]
      ? this.delimiterIndex === this.delimiterClose.length - 1
        ? (this.cbs.oninterpolation(this.sectionStart, this.index + 1),
          this.inRCDATA ? (this.state = 32) : (this.state = 1),
          (this.sectionStart = this.index + 1))
        : this.delimiterIndex++
      : ((this.state = 3), this.stateInterpolation(t));
  }
  stateSpecialStartSequence(t) {
    const n = this.sequenceIndex === this.currentSequence.length;
    if (!(n ? gn(t) : (t | 32) === this.currentSequence[this.sequenceIndex])) this.inRCDATA = !1;
    else if (!n) {
      this.sequenceIndex++;
      return;
    }
    (this.sequenceIndex = 0), (this.state = 6), this.stateInTagName(t);
  }
  stateInRCDATA(t) {
    if (this.sequenceIndex === this.currentSequence.length) {
      if (t === 62 || bt(t)) {
        const n = this.index - this.currentSequence.length;
        if (this.sectionStart < n) {
          const s = this.index;
          (this.index = n), this.cbs.ontext(this.sectionStart, n), (this.index = s);
        }
        (this.sectionStart = n + 2), this.stateInClosingTagName(t), (this.inRCDATA = !1);
        return;
      }
      this.sequenceIndex = 0;
    }
    (t | 32) === this.currentSequence[this.sequenceIndex]
      ? (this.sequenceIndex += 1)
      : this.sequenceIndex === 0
        ? this.currentSequence === Xe.TitleEnd ||
          (this.currentSequence === Xe.TextareaEnd && !this.inSFCRoot)
          ? !this.inVPre &&
            t === this.delimiterOpen[0] &&
            ((this.state = 2), (this.delimiterIndex = 0), this.stateInterpolationOpen(t))
          : this.fastForwardTo(60) && (this.sequenceIndex = 1)
        : (this.sequenceIndex = +(t === 60));
  }
  stateCDATASequence(t) {
    t === Xe.Cdata[this.sequenceIndex]
      ? ++this.sequenceIndex === Xe.Cdata.length &&
        ((this.state = 28),
        (this.currentSequence = Xe.CdataEnd),
        (this.sequenceIndex = 0),
        (this.sectionStart = this.index + 1))
      : ((this.sequenceIndex = 0), (this.state = 23), this.stateInDeclaration(t));
  }
  fastForwardTo(t) {
    for (; ++this.index < this.buffer.length; ) {
      const n = this.buffer.charCodeAt(this.index);
      if ((n === 10 && this.newlines.push(this.index), n === t)) return !0;
    }
    return (this.index = this.buffer.length - 1), !1;
  }
  stateInCommentLike(t) {
    t === this.currentSequence[this.sequenceIndex]
      ? ++this.sequenceIndex === this.currentSequence.length &&
        (this.currentSequence === Xe.CdataEnd
          ? this.cbs.oncdata(this.sectionStart, this.index - 2)
          : this.cbs.oncomment(this.sectionStart, this.index - 2),
        (this.sequenceIndex = 0),
        (this.sectionStart = this.index + 1),
        (this.state = 1))
      : this.sequenceIndex === 0
        ? this.fastForwardTo(this.currentSequence[0]) && (this.sequenceIndex = 1)
        : t !== this.currentSequence[this.sequenceIndex - 1] && (this.sequenceIndex = 0);
  }
  startSpecial(t, n) {
    this.enterRCDATA(t, n), (this.state = 31);
  }
  enterRCDATA(t, n) {
    (this.inRCDATA = !0), (this.currentSequence = t), (this.sequenceIndex = n);
  }
  stateBeforeTagName(t) {
    t === 33
      ? ((this.state = 22), (this.sectionStart = this.index + 1))
      : t === 63
        ? ((this.state = 24), (this.sectionStart = this.index + 1))
        : Ra(t)
          ? ((this.sectionStart = this.index),
            this.mode === 0
              ? (this.state = 6)
              : this.inSFCRoot
                ? (this.state = 34)
                : this.inXML
                  ? (this.state = 6)
                  : t === 116
                    ? (this.state = 30)
                    : (this.state = t === 115 ? 29 : 6))
          : t === 47
            ? (this.state = 8)
            : ((this.state = 1), this.stateText(t));
  }
  stateInTagName(t) {
    gn(t) && this.handleTagName(t);
  }
  stateInSFCRootTagName(t) {
    if (gn(t)) {
      const n = this.buffer.slice(this.sectionStart, this.index);
      n !== "template" && this.enterRCDATA(Ii(`</${  n}`), 0), this.handleTagName(t);
    }
  }
  handleTagName(t) {
    this.cbs.onopentagname(this.sectionStart, this.index),
      (this.sectionStart = -1),
      (this.state = 11),
      this.stateBeforeAttrName(t);
  }
  stateBeforeClosingTagName(t) {
    bt(t) ||
      (t === 62
        ? ((this.state = 1), (this.sectionStart = this.index + 1))
        : ((this.state = Ra(t) ? 9 : 27), (this.sectionStart = this.index)));
  }
  stateInClosingTagName(t) {
    (t === 62 || bt(t)) &&
      (this.cbs.onclosetag(this.sectionStart, this.index),
      (this.sectionStart = -1),
      (this.state = 10),
      this.stateAfterClosingTagName(t));
  }
  stateAfterClosingTagName(t) {
    t === 62 && ((this.state = 1), (this.sectionStart = this.index + 1));
  }
  stateBeforeAttrName(t) {
    t === 62
      ? (this.cbs.onopentagend(this.index),
        this.inRCDATA ? (this.state = 32) : (this.state = 1),
        (this.sectionStart = this.index + 1))
      : t === 47
        ? (this.state = 7)
        : t === 60 && this.peek() === 47
          ? (this.cbs.onopentagend(this.index), (this.state = 5), (this.sectionStart = this.index))
          : bt(t) || this.handleAttrStart(t);
  }
  handleAttrStart(t) {
    t === 118 && this.peek() === 45
      ? ((this.state = 13), (this.sectionStart = this.index))
      : t === 46 || t === 58 || t === 64 || t === 35
        ? (this.cbs.ondirname(this.index, this.index + 1),
          (this.state = 14),
          (this.sectionStart = this.index + 1))
        : ((this.state = 12), (this.sectionStart = this.index));
  }
  stateInSelfClosingTag(t) {
    t === 62
      ? (this.cbs.onselfclosingtag(this.index),
        (this.state = 1),
        (this.sectionStart = this.index + 1),
        (this.inRCDATA = !1))
      : bt(t) || ((this.state = 11), this.stateBeforeAttrName(t));
  }
  stateInAttrName(t) {
    (t === 61 || gn(t)) &&
      (this.cbs.onattribname(this.sectionStart, this.index), this.handleAttrNameEnd(t));
  }
  stateInDirName(t) {
    t === 61 || gn(t)
      ? (this.cbs.ondirname(this.sectionStart, this.index), this.handleAttrNameEnd(t))
      : t === 58
        ? (this.cbs.ondirname(this.sectionStart, this.index),
          (this.state = 14),
          (this.sectionStart = this.index + 1))
        : t === 46 &&
          (this.cbs.ondirname(this.sectionStart, this.index),
          (this.state = 16),
          (this.sectionStart = this.index + 1));
  }
  stateInDirArg(t) {
    t === 61 || gn(t)
      ? (this.cbs.ondirarg(this.sectionStart, this.index), this.handleAttrNameEnd(t))
      : t === 91
        ? (this.state = 15)
        : t === 46 &&
          (this.cbs.ondirarg(this.sectionStart, this.index),
          (this.state = 16),
          (this.sectionStart = this.index + 1));
  }
  stateInDynamicDirArg(t) {
    t === 93
      ? (this.state = 14)
      : (t === 61 || gn(t)) &&
        (this.cbs.ondirarg(this.sectionStart, this.index + 1), this.handleAttrNameEnd(t));
  }
  stateInDirModifier(t) {
    t === 61 || gn(t)
      ? (this.cbs.ondirmodifier(this.sectionStart, this.index), this.handleAttrNameEnd(t))
      : t === 46 &&
        (this.cbs.ondirmodifier(this.sectionStart, this.index),
        (this.sectionStart = this.index + 1));
  }
  handleAttrNameEnd(t) {
    (this.sectionStart = this.index),
      (this.state = 17),
      this.cbs.onattribnameend(this.index),
      this.stateAfterAttrName(t);
  }
  stateAfterAttrName(t) {
    t === 61
      ? (this.state = 18)
      : t === 47 || t === 62
        ? (this.cbs.onattribend(0, this.sectionStart),
          (this.sectionStart = -1),
          (this.state = 11),
          this.stateBeforeAttrName(t))
        : bt(t) || (this.cbs.onattribend(0, this.sectionStart), this.handleAttrStart(t));
  }
  stateBeforeAttrValue(t) {
    t === 34
      ? ((this.state = 19), (this.sectionStart = this.index + 1))
      : t === 39
        ? ((this.state = 20), (this.sectionStart = this.index + 1))
        : bt(t) ||
          ((this.sectionStart = this.index), (this.state = 21), this.stateInAttrValueNoQuotes(t));
  }
  handleInAttrValue(t, n) {
    (t === n || this.fastForwardTo(n)) &&
      (this.cbs.onattribdata(this.sectionStart, this.index),
      (this.sectionStart = -1),
      this.cbs.onattribend(n === 34 ? 3 : 2, this.index + 1),
      (this.state = 11));
  }
  stateInAttrValueDoubleQuotes(t) {
    this.handleInAttrValue(t, 34);
  }
  stateInAttrValueSingleQuotes(t) {
    this.handleInAttrValue(t, 39);
  }
  stateInAttrValueNoQuotes(t) {
    bt(t) || t === 62
      ? (this.cbs.onattribdata(this.sectionStart, this.index),
        (this.sectionStart = -1),
        this.cbs.onattribend(1, this.index),
        (this.state = 11),
        this.stateBeforeAttrName(t))
      : (t === 39 || t === 60 || t === 61 || t === 96) && this.cbs.onerr(18, this.index);
  }
  stateBeforeDeclaration(t) {
    t === 91 ? ((this.state = 26), (this.sequenceIndex = 0)) : (this.state = t === 45 ? 25 : 23);
  }
  stateInDeclaration(t) {
    (t === 62 || this.fastForwardTo(62)) &&
      ((this.state = 1), (this.sectionStart = this.index + 1));
  }
  stateInProcessingInstruction(t) {
    (t === 62 || this.fastForwardTo(62)) &&
      (this.cbs.onprocessinginstruction(this.sectionStart, this.index),
      (this.state = 1),
      (this.sectionStart = this.index + 1));
  }
  stateBeforeComment(t) {
    t === 45
      ? ((this.state = 28),
        (this.currentSequence = Xe.CommentEnd),
        (this.sequenceIndex = 2),
        (this.sectionStart = this.index + 1))
      : (this.state = 23);
  }
  stateInSpecialComment(t) {
    (t === 62 || this.fastForwardTo(62)) &&
      (this.cbs.oncomment(this.sectionStart, this.index),
      (this.state = 1),
      (this.sectionStart = this.index + 1));
  }
  stateBeforeSpecialS(t) {
    t === Xe.ScriptEnd[3]
      ? this.startSpecial(Xe.ScriptEnd, 4)
      : t === Xe.StyleEnd[3]
        ? this.startSpecial(Xe.StyleEnd, 4)
        : ((this.state = 6), this.stateInTagName(t));
  }
  stateBeforeSpecialT(t) {
    t === Xe.TitleEnd[3]
      ? this.startSpecial(Xe.TitleEnd, 4)
      : t === Xe.TextareaEnd[3]
        ? this.startSpecial(Xe.TextareaEnd, 4)
        : ((this.state = 6), this.stateInTagName(t));
  }
  startEntity() {}
  stateInEntity() {}
  parse(t) {
    for (this.buffer = t; this.index < this.buffer.length; ) {
      const n = this.buffer.charCodeAt(this.index);
      switch ((n === 10 && this.state !== 33 && this.newlines.push(this.index), this.state)) {
        case 1: {
          this.stateText(n);
          break;
        }
        case 2: {
          this.stateInterpolationOpen(n);
          break;
        }
        case 3: {
          this.stateInterpolation(n);
          break;
        }
        case 4: {
          this.stateInterpolationClose(n);
          break;
        }
        case 31: {
          this.stateSpecialStartSequence(n);
          break;
        }
        case 32: {
          this.stateInRCDATA(n);
          break;
        }
        case 26: {
          this.stateCDATASequence(n);
          break;
        }
        case 19: {
          this.stateInAttrValueDoubleQuotes(n);
          break;
        }
        case 12: {
          this.stateInAttrName(n);
          break;
        }
        case 13: {
          this.stateInDirName(n);
          break;
        }
        case 14: {
          this.stateInDirArg(n);
          break;
        }
        case 15: {
          this.stateInDynamicDirArg(n);
          break;
        }
        case 16: {
          this.stateInDirModifier(n);
          break;
        }
        case 28: {
          this.stateInCommentLike(n);
          break;
        }
        case 27: {
          this.stateInSpecialComment(n);
          break;
        }
        case 11: {
          this.stateBeforeAttrName(n);
          break;
        }
        case 6: {
          this.stateInTagName(n);
          break;
        }
        case 34: {
          this.stateInSFCRootTagName(n);
          break;
        }
        case 9: {
          this.stateInClosingTagName(n);
          break;
        }
        case 5: {
          this.stateBeforeTagName(n);
          break;
        }
        case 17: {
          this.stateAfterAttrName(n);
          break;
        }
        case 20: {
          this.stateInAttrValueSingleQuotes(n);
          break;
        }
        case 18: {
          this.stateBeforeAttrValue(n);
          break;
        }
        case 8: {
          this.stateBeforeClosingTagName(n);
          break;
        }
        case 10: {
          this.stateAfterClosingTagName(n);
          break;
        }
        case 29: {
          this.stateBeforeSpecialS(n);
          break;
        }
        case 30: {
          this.stateBeforeSpecialT(n);
          break;
        }
        case 21: {
          this.stateInAttrValueNoQuotes(n);
          break;
        }
        case 7: {
          this.stateInSelfClosingTag(n);
          break;
        }
        case 23: {
          this.stateInDeclaration(n);
          break;
        }
        case 22: {
          this.stateBeforeDeclaration(n);
          break;
        }
        case 25: {
          this.stateBeforeComment(n);
          break;
        }
        case 24: {
          this.stateInProcessingInstruction(n);
          break;
        }
        case 33: {
          this.stateInEntity();
          break;
        }
      }
      this.index++;
    }
    this.cleanup(), this.finish();
  }
  cleanup() {
    this.sectionStart !== this.index &&
      (this.state === 1 || (this.state === 32 && this.sequenceIndex === 0)
        ? (this.cbs.ontext(this.sectionStart, this.index), (this.sectionStart = this.index))
        : (this.state === 19 || this.state === 20 || this.state === 21) &&
          (this.cbs.onattribdata(this.sectionStart, this.index), (this.sectionStart = this.index)));
  }
  finish() {
    this.handleTrailingData(), this.cbs.onend();
  }
  handleTrailingData() {
    const t = this.buffer.length;
    this.sectionStart >= t ||
      (this.state === 28
        ? this.currentSequence === Xe.CdataEnd
          ? this.cbs.oncdata(this.sectionStart, t)
          : this.cbs.oncomment(this.sectionStart, t)
        : this.state === 6 ||
          this.state === 11 ||
          this.state === 18 ||
          this.state === 17 ||
          this.state === 12 ||
          this.state === 13 ||
          this.state === 14 ||
          this.state === 15 ||
          this.state === 16 ||
          this.state === 20 ||
          this.state === 19 ||
          this.state === 21 ||
          this.state === 9 ||
          this.cbs.ontext(this.sectionStart, t));
  }
  emitCodePoint(t, n) {}
}
function Ia(e, { compatConfig: t }) {
  const n = t && t[e];
  return e === "MODE" ? n || 3 : n;
}
function zn(e, t) {
  const n = Ia("MODE", t),
    s = Ia(e, t);
  return n === 3 ? s === !0 : s !== !1;
}
function Sr(e, t, n, ...s) {
  return zn(e, t);
}
function yc(e) {
  throw e;
}
function Uh(e) {}
function Ce(e, t, n, s) {
  const r = `https://vuejs.org/error-reference/#compiler-${e}`,
    i = new SyntaxError(String(r));
  return (i.code = e), (i.loc = t), i;
}
const pt = (e) => e.type === 4 && e.isStatic;
function Wh(e) {
  switch (e) {
    case "Teleport":
    case "teleport":
      return er;
    case "Suspense":
    case "suspense":
      return tc;
    case "KeepAlive":
    case "keep-alive":
      return Ni;
    case "BaseTransition":
    case "base-transition":
      return Fh;
  }
}
const Mv = /^$|^\d|[^\$\w\xA0-\uFFFF]/,
  vc = (e) => !Mv.test(e),
  Kh = /[A-Za-z_$\xA0-\uFFFF]/,
  kv = /[\.\?\w$\xA0-\uFFFF]/,
  Dv = /\s+[.[]\s*|\s*[.[]\s+/g,
  qh = (e) => (e.type === 4 ? e.content : e.loc.source),
  Fv = (e) => {
    const t = qh(e)
      .trim()
      .replace(Dv, (l) => l.trim());
    let n = 0,
      s = [],
      r = 0,
      i = 0,
      o = null;
    for (let l = 0; l < t.length; l++) {
      const c = t.charAt(l);
      switch (n) {
        case 0:
          if (c === "[") s.push(n), (n = 1), r++;
          else if (c === "(") s.push(n), (n = 2), i++;
          else if (!(l === 0 ? Kh : kv).test(c)) return !1;
          break;
        case 1:
          c === "'" || c === '"' || c === "`"
            ? (s.push(n), (n = 3), (o = c))
            : c === "["
              ? r++
              : c === "]" && (--r || (n = s.pop()));
          break;
        case 2:
          if (c === "'" || c === '"' || c === "`") s.push(n), (n = 3), (o = c);
          else if (c === "(") i++;
          else if (c === ")") {
            if (l === t.length - 1) return !1;
            --i || (n = s.pop());
          }
          break;
        case 3:
          c === o && ((n = s.pop()), (o = null));
          break;
      }
    }
    return !r && !i;
  },
  Gh = Fv,
  Lv =
    /^\s*(?:async\s*)?(?:\([^)]*?\)|[\w$_]+)\s*(?::[^=]+)?=>|^\s*(?:async\s+)?function(?:\s+[\w$]+)?\s*\(/,
  Vv = (e) => Lv.test(qh(e)),
  Bv = Vv;
function Ot(e, t, n = !1) {
  for (let s = 0; s < e.props.length; s++) {
    const r = e.props[s];
    if (r.type === 7 && (n || r.exp) && (ne(t) ? r.name === t : t.test(r.name))) return r;
  }
}
function lo(e, t, n = !1, s = !1) {
  for (let r = 0; r < e.props.length; r++) {
    const i = e.props[r];
    if (i.type === 6) {
      if (n) continue;
      if (i.name === t && (i.value || s)) return i;
    } else if (i.name === "bind" && (i.exp || s) && Hn(i.arg, t)) return i;
  }
}
function Hn(e, t) {
  return !!(e && pt(e) && e.content === t);
}
function Hv(e) {
  return e.props.some(
    (t) => t.type === 7 && t.name === "bind" && (!t.arg || t.arg.type !== 4 || !t.arg.isStatic)
  );
}
function Oo(e) {
  return e.type === 5 || e.type === 2;
}
function Pa(e) {
  return e.type === 7 && e.name === "pre";
}
function jv(e) {
  return e.type === 7 && e.name === "slot";
}
function Pi(e) {
  return e.type === 1 && e.tagType === 3;
}
function Mi(e) {
  return e.type === 1 && e.tagType === 2;
}
const $v = new Set([br, Fr]);
function zh(e, t = []) {
  if (e && !ne(e) && e.type === 14) {
    const n = e.callee;
    if (!ne(n) && $v.has(n)) return zh(e.arguments[0], t.concat(e));
  }
  return [e, t];
}
function ki(e, t, n) {
  let s,
    r = e.type === 13 ? e.props : e.arguments[2],
    i = [],
    o;
  if (r && !ne(r) && r.type === 14) {
    const l = zh(r);
    (r = l[0]), (i = l[1]), (o = i[i.length - 1]);
  }
  if (r == null || ne(r)) s = xt([t]);
  else if (r.type === 14) {
    const l = r.arguments[0];
    !ne(l) && l.type === 15
      ? Ma(t, l) || l.properties.unshift(t)
      : r.callee === dc
        ? (s = $e(n.helper(xi), [xt([t]), r]))
        : r.arguments.unshift(xt([t])),
      !s && (s = r);
  } else
    r.type === 15
      ? (Ma(t, r) || r.properties.unshift(t), (s = r))
      : ((s = $e(n.helper(xi), [xt([t]), r])), o && o.callee === Fr && (o = i[i.length - 2]));
  e.type === 13
    ? o
      ? (o.arguments[0] = s)
      : (e.props = s)
    : o
      ? (o.arguments[0] = s)
      : (e.arguments[2] = s);
}
function Ma(e, t) {
  let n = !1;
  if (e.key.type === 4) {
    const s = e.key.content;
    n = t.properties.some((r) => r.key.type === 4 && r.key.content === s);
  }
  return n;
}
function Er(e, t) {
  return `_${t}_${e.replace(/[^\w]/g, (n, s) => (n === "-" ? "_" : e.charCodeAt(s).toString()))}`;
}
function Uv(e) {
  return e.type === 14 && e.callee === mc ? e.arguments[1].returns : e;
}
const Wv = /([\s\S]*?)\s+(?:in|of)\s+(\S[\s\S]*)/;
function Yh(e) {
  for (let t = 0; t < e.length; t++) if (!bt(e.charCodeAt(t))) return !1;
  return !0;
}
function bc(e) {
  return (e.type === 2 && Yh(e.content)) || (e.type === 12 && bc(e.content));
}
function Jh(e) {
  return e.type === 3 || bc(e);
}
const Xh = {
  parseMode: "base",
  ns: 0,
  delimiters: ["{{", "}}"],
  getNamespace: () => 0,
  isVoidTag: fs,
  isPreTag: fs,
  isIgnoreNewlineTag: fs,
  isCustomElement: fs,
  onError: yc,
  onWarn: Uh,
  comments: !1,
  prefixIdentifiers: !1,
};
let ve = Xh,
  Tr = null,
  ln = "",
  Ze = null,
  ue = null,
  at = "",
  Xt = -1,
  Ln = -1,
  c = 0,
  En = !1,
  ll = null;
const Oe = [],
  Re = new Pv(Oe, {
    onerr: Yt,
    ontext(e, t) {
      Zr(qe(e, t), e, t);
    },
    ontextentity(e, t, n) {
      Zr(e, t, n);
    },
    oninterpolation(e, t) {
      if (En) return Zr(qe(e, t), e, t);
      let n = e + Re.delimiterOpen.length,
        s = t - Re.delimiterClose.length;
      for (; bt(ln.charCodeAt(n)); ) n++;
      for (; bt(ln.charCodeAt(s - 1)); ) s--;
      let r = qe(n, s);
      r.includes("&") && (r = ve.decodeEntities(r, !1)),
        cl({ type: 5, content: li(r, !1, Ie(n, s)), loc: Ie(e, t) });
    },
    onopentagname(e, t) {
      const n = qe(e, t);
      Ze = {
        type: 1,
        tag: n,
        ns: ve.getNamespace(n, Oe[0], ve.ns),
        tagType: 0,
        props: [],
        children: [],
        loc: Ie(e - 1, t),
        codegenNode: void 0,
      };
    },
    onopentagend(e) {
      Da(e);
    },
    onclosetag(e, t) {
      const n = qe(e, t);
      if (!ve.isVoidTag(n)) {
        let s = !1;
        for (let r = 0; r < Oe.length; r++)
          if (Oe[r].tag.toLowerCase() === n.toLowerCase()) {
            (s = !0), r > 0 && Yt(24, Oe[0].loc.start.offset);
            for (let o = 0; o <= r; o++) {
              const l = Oe.shift();
              oi(l, t, o < r);
            }
            break;
          }
        s || Yt(23, Zh(e, 60));
      }
    },
    onselfclosingtag(e) {
      const t = Ze.tag;
      (Ze.isSelfClosing = !0), Da(e), Oe[0] && Oe[0].tag === t && oi(Oe.shift(), e);
    },
    onattribname(e, t) {
      ue = { type: 6, name: qe(e, t), nameLoc: Ie(e, t), value: void 0, loc: Ie(e) };
    },
    ondirname(e, t) {
      const n = qe(e, t),
        s = n === "." || n === ":" ? "bind" : n === "@" ? "on" : n === "#" ? "slot" : n.slice(2);
      if ((!En && s === "" && Yt(26, e), En || s === ""))
        ue = { type: 6, name: n, nameLoc: Ie(e, t), value: void 0, loc: Ie(e) };
      else if (
        ((ue = {
          type: 7,
          name: s,
          rawName: n,
          exp: void 0,
          arg: void 0,
          modifiers: n === "." ? [ie("prop")] : [],
          loc: Ie(e),
        }),
        s === "pre")
      ) {
        (En = Re.inVPre = !0), (ll = Ze);
        const r = Ze.props;
        for (let i = 0; i < r.length; i++) r[i].type === 7 && (r[i] = e0(r[i]));
      }
    },
    ondirarg(e, t) {
      if (e === t) return;
      const n = qe(e, t);
      if (En && !Pa(ue)) (ue.name += n), jn(ue.nameLoc, t);
      else {
        const s = n[0] !== "[";
        ue.arg = li(s ? n : n.slice(1, -1), s, Ie(e, t), s ? 3 : 0);
      }
    },
    ondirmodifier(e, t) {
      const n = qe(e, t);
      if (En && !Pa(ue)) (ue.name += `.${  n}`), jn(ue.nameLoc, t);
      else if (ue.name === "slot") {
        const s = ue.arg;
        s && ((s.content += `.${  n}`), jn(s.loc, t));
      } else {
        const s = ie(n, !0, Ie(e, t));
        ue.modifiers.push(s);
      }
    },
    onattribdata(e, t) {
      (at += qe(e, t)), Xt < 0 && (Xt = e), (Ln = t);
    },
    onattribentity(e, t, n) {
      (at += e), Xt < 0 && (Xt = t), (Ln = n);
    },
    onattribnameend(e) {
      const t = ue.loc.start.offset,
        n = qe(t, e);
      ue.type === 7 && (ue.rawName = n),
        Ze.props.some((s) => (s.type === 7 ? s.rawName : s.name) === n) && Yt(2, t);
    },
    onattribend(e, t) {
      if (Ze && ue) {
        if ((jn(ue.loc, t), e !== 0))
          if ((at.includes("&") && (at = ve.decodeEntities(at, !0)), ue.type === 6))
            ue.name === "class" && (at = ed(at).trim()),
              e === 1 && !at && Yt(13, t),
              (ue.value = { type: 2, content: at, loc: e === 1 ? Ie(Xt, Ln) : Ie(Xt - 1, Ln + 1) }),
              Re.inSFCRoot &&
                Ze.tag === "template" &&
                ue.name === "lang" &&
                at &&
                at !== "html" &&
                Re.enterRCDATA(Ii("</template"), 0);
          else {
            const n = 0;
            (ue.exp = li(at, !1, Ie(Xt, Ln), 0, n)),
              ue.name === "for" && (ue.forParseResult = qv(ue.exp));
            let s = -1;
            ue.name === "bind" &&
              (s = ue.modifiers.findIndex((r) => r.content === "sync")) > -1 &&
              Sr("COMPILER_V_BIND_SYNC", ve, ue.loc, ue.arg.loc.source) &&
              ((ue.name = "model"), ue.modifiers.splice(s, 1));
          }
        (ue.type !== 7 || ue.name !== "pre") && Ze.props.push(ue);
      }
      (at = ""), (Xt = Ln = -1);
    },
    oncomment(e, t) {
      ve.comments && cl({ type: 3, content: qe(e, t), loc: Ie(e - 4, t + 3) });
    },
    onend() {
      const e = ln.length;
      for (let t = 0; t < Oe.length; t++) oi(Oe[t], e - 1), Yt(24, Oe[t].loc.start.offset);
    },
    oncdata(e, t) {
      Oe[0].ns !== 0 ? Zr(qe(e, t), e, t) : Yt(1, e - 9);
    },
    onprocessinginstruction(e) {
      (Oe[0] ? Oe[0].ns : ve.ns) === 0 && Yt(21, e - 1);
    },
  }),
  ka = /,([^,\}\]]*)(?:,([^,\}\]]*))?$/,
  Kv = /^\(|\)$/g;
function qv(e) {
  const t = e.loc,
    n = e.content,
    s = n.match(Wv);
  if (!s) return;
  const [, r, i] = s,
    o = (f, d, h = !1) => {
      const m = t.start.offset + d,
        v = m + f.length;
      return li(f, !1, Ie(m, v), 0, h ? 1 : 0);
    },
    l = {
      source: o(i.trim(), n.indexOf(i, r.length)),
      value: void 0,
      key: void 0,
      index: void 0,
      finalized: !1,
    };
  let c = r.trim().replace(Kv, "").trim();
  const u = r.indexOf(c),
    a = c.match(ka);
  if (a) {
    c = c.replace(ka, "").trim();
    const f = a[1].trim();
    let d;
    if ((f && ((d = n.indexOf(f, u + c.length)), (l.key = o(f, d, !0))), a[2])) {
      const h = a[2].trim();
      h && (l.index = o(h, n.indexOf(h, l.key ? d + f.length : u + c.length), !0));
    }
  }
  return c && (l.value = o(c, u, !0)), l;
}
function qe(e, t) {
  return ln.slice(e, t);
}
function Da(e) {
  Re.inSFCRoot && (Ze.innerLoc = Ie(e + 1, e + 1)), cl(Ze);
  const { tag: t, ns: n } = Ze;
  n === 0 && ve.isPreTag(t) && _c++,
    ve.isVoidTag(t) ? oi(Ze, e) : (Oe.unshift(Ze), (n === 1 || n === 2) && (Re.inXML = !0)),
    (Ze = null);
}
function Zr(e, t, n) {
  {
    const i = Oe[0] && Oe[0].tag;
    i !== "script" && i !== "style" && e.includes("&") && (e = ve.decodeEntities(e, !1));
  }
  const s = Oe[0] || Tr,
    r = s.children[s.children.length - 1];
  r && r.type === 2
    ? ((r.content += e), jn(r.loc, n))
    : s.children.push({ type: 2, content: e, loc: Ie(t, n) });
}
function oi(e, t, n = !1) {
  n ? jn(e.loc, Zh(t, 60)) : jn(e.loc, Gv(t, 62) + 1),
    Re.inSFCRoot &&
      (e.children.length
        ? (e.innerLoc.end = ce({}, e.children[e.children.length - 1].loc.end))
        : (e.innerLoc.end = ce({}, e.innerLoc.start)),
      (e.innerLoc.source = qe(e.innerLoc.start.offset, e.innerLoc.end.offset)));
  const { tag: s, ns: r, children: i } = e;
  if (
    (En || (s === "slot" ? (e.tagType = 2) : Fa(e) ? (e.tagType = 3) : Yv(e) && (e.tagType = 1)),
    Re.inRCDATA || (e.children = Qh(i)),
    r === 0 && ve.isIgnoreNewlineTag(s))
  ) {
    const o = i[0];
    o && o.type === 2 && (o.content = o.content.replace(/^\r?\n/, ""));
  }
  r === 0 && ve.isPreTag(s) && _c--,
    ll === e && ((En = Re.inVPre = !1), (ll = null)),
    Re.inXML && (Oe[0] ? Oe[0].ns : ve.ns) === 0 && (Re.inXML = !1);
  {
    const o = e.props;
    if (!Re.inSFCRoot && zn("COMPILER_NATIVE_TEMPLATE", ve) && e.tag === "template" && !Fa(e)) {
      const c = Oe[0] || Tr,
        u = c.children.indexOf(e);
      c.children.splice(u, 1, ...e.children);
    }
    const l = o.find((c) => c.type === 6 && c.name === "inline-template");
    l &&
      Sr("COMPILER_INLINE_TEMPLATE", ve, l.loc) &&
      e.children.length &&
      (l.value = {
        type: 2,
        content: qe(
          e.children[0].loc.start.offset,
          e.children[e.children.length - 1].loc.end.offset
        ),
        loc: l.loc,
      });
  }
}
function Gv(e, t) {
  let n = e;
  for (; ln.charCodeAt(n) !== t && n < ln.length - 1; ) n++;
  return n;
}
function Zh(e, t) {
  let n = e;
  for (; ln.charCodeAt(n) !== t && n >= 0; ) n--;
  return n;
}
const zv = new Set(["if", "else", "else-if", "for", "slot"]);
function Fa({ tag: e, props: t }) {
  if (e === "template") {
    for (let n = 0; n < t.length; n++) if (t[n].type === 7 && zv.has(t[n].name)) return !0;
  }
  return !1;
}
function Yv({ tag: e, props: t }) {
  if (ve.isCustomElement(e)) return !1;
  if (
    e === "component" ||
    Jv(e.charCodeAt(0)) ||
    Wh(e) ||
    (ve.isBuiltInComponent && ve.isBuiltInComponent(e)) ||
    (ve.isNativeTag && !ve.isNativeTag(e))
  )
    return !0;
  for (let n = 0; n < t.length; n++) {
    const s = t[n];
    if (s.type === 6) {
      if (s.name === "is" && s.value) {
        if (s.value.content.startsWith("vue:")) return !0;
        if (Sr("COMPILER_IS_ON_ELEMENT", ve, s.loc)) return !0;
      }
    } else if (s.name === "bind" && Hn(s.arg, "is") && Sr("COMPILER_IS_ON_ELEMENT", ve, s.loc))
      return !0;
  }
  return !1;
}
function Jv(e) {
  return e > 64 && e < 91;
}
const Xv = /\r\n/g;
function Qh(e) {
  const t = ve.whitespace !== "preserve";
  let n = !1;
  for (let s = 0; s < e.length; s++) {
    const r = e[s];
    if (r.type === 2)
      if (_c)
        r.content = r.content.replace(
          Xv,
          `
`
        );
      else if (Yh(r.content)) {
        const i = e[s - 1] && e[s - 1].type,
          o = e[s + 1] && e[s + 1].type;
        !i ||
        !o ||
        (t &&
          ((i === 3 && (o === 3 || o === 1)) ||
            (i === 1 && (o === 3 || (o === 1 && Zv(r.content))))))
          ? ((n = !0), (e[s] = null))
          : (r.content = " ");
      } else t && (r.content = ed(r.content));
  }
  return n ? e.filter(Boolean) : e;
}
function Zv(e) {
  for (let t = 0; t < e.length; t++) {
    const n = e.charCodeAt(t);
    if (n === 10 || n === 13) return !0;
  }
  return !1;
}
function ed(e) {
  let t = "",
    n = !1;
  for (let s = 0; s < e.length; s++)
    bt(e.charCodeAt(s)) ? n || ((t += " "), (n = !0)) : ((t += e[s]), (n = !1));
  return t;
}
function cl(e) {
  (Oe[0] || Tr).children.push(e);
}
function Ie(e, t) {
  return {
    start: Re.getPos(e),
    end: t == null ? t : Re.getPos(t),
    source: t == null ? t : qe(e, t),
  };
}
function Qv(e) {
  return Ie(e.start.offset, e.end.offset);
}
function jn(e, t) {
  (e.end = Re.getPos(t)), (e.source = qe(e.start.offset, t));
}
function e0(e) {
  const t = {
    type: 6,
    name: e.rawName,
    nameLoc: Ie(e.loc.start.offset, e.loc.start.offset + e.rawName.length),
    value: void 0,
    loc: e.loc,
  };
  if (e.exp) {
    const n = e.exp.loc;
    n.end.offset < e.loc.end.offset &&
      (n.start.offset--, n.start.column--, n.end.offset++, n.end.column++),
      (t.value = { type: 2, content: e.exp.content, loc: n });
  }
  return t;
}
function li(e, t = !1, n, s = 0, r = 0) {
  return ie(e, t, n, s);
}
function Yt(e, t, n) {
  ve.onError(Ce(e, Ie(t, t)));
}
function t0() {
  Re.reset(), (Ze = null), (ue = null), (at = ""), (Xt = -1), (Ln = -1), (Oe.length = 0);
}
function n0(e, t) {
  if ((t0(), (ln = e), (ve = ce({}, Xh)), t)) {
    let r;
    for (r in t) t[r] != null && (ve[r] = t[r]);
  }
  (Re.mode = ve.parseMode === "html" ? 1 : ve.parseMode === "sfc" ? 2 : 0),
    (Re.inXML = ve.ns === 1 || ve.ns === 2);
  const n = t && t.delimiters;
  n && ((Re.delimiterOpen = Ii(n[0])), (Re.delimiterClose = Ii(n[1])));
  const s = (Tr = xv([], e));
  return Re.parse(ln), (s.loc = Ie(0, e.length)), (s.children = Qh(s.children)), (Tr = null), s;
}
function s0(e, t) {
  ci(e, void 0, t, !!td(e));
}
function td(e) {
  const t = e.children.filter((n) => n.type !== 3);
  return t.length === 1 && t[0].type === 1 && !Mi(t[0]) ? t[0] : null;
}
function ci(e, t, n, s = !1, r = !1) {
  const { children: i } = e,
    o = [];
  for (let a = 0; a < i.length; a++) {
    const f = i[a];
    if (f.type === 1 && f.tagType === 0) {
      const d = s ? 0 : _t(f, n);
      if (d > 0) {
        if (d >= 2) {
          (f.codegenNode.patchFlag = -1), o.push(f);
          continue;
        }
      } else {
        const h = f.codegenNode;
        if (h.type === 13) {
          const m = h.patchFlag;
          if ((m === void 0 || m === 512 || m === 1) && sd(f, n) >= 2) {
            const v = rd(f);
            v && (h.props = n.hoist(v));
          }
          h.dynamicProps && (h.dynamicProps = n.hoist(h.dynamicProps));
        }
      }
    } else if (f.type === 12 && (s ? 0 : _t(f, n)) >= 2) {
      f.codegenNode.type === 14 &&
        f.codegenNode.arguments.length > 0 &&
        f.codegenNode.arguments.push("-1"),
        o.push(f);
      continue;
    }
    if (f.type === 1) {
      const d = f.tagType === 1;
      d && n.scopes.vSlot++, ci(f, e, n, !1, r), d && n.scopes.vSlot--;
    } else if (f.type === 11) ci(f, e, n, f.children.length === 1, !0);
    else if (f.type === 9)
      for (let d = 0; d < f.branches.length; d++)
        ci(f.branches[d], e, n, f.branches[d].children.length === 1, r);
  }
  let l = !1;
  if (o.length === i.length && e.type === 1) {
    if (e.tagType === 0 && e.codegenNode && e.codegenNode.type === 13 && K(e.codegenNode.children))
      (e.codegenNode.children = c(Gn(e.codegenNode.children))), (l = !0);
    else if (
      e.tagType === 1 &&
      e.codegenNode &&
      e.codegenNode.type === 13 &&
      e.codegenNode.children &&
      !K(e.codegenNode.children) &&
      e.codegenNode.children.type === 15
    ) {
      const a = u(e.codegenNode, "default");
      a && ((a.returns = c(Gn(a.returns))), (l = !0));
    } else if (
      e.tagType === 3 &&
      t &&
      t.type === 1 &&
      t.tagType === 1 &&
      t.codegenNode &&
      t.codegenNode.type === 13 &&
      t.codegenNode.children &&
      !K(t.codegenNode.children) &&
      t.codegenNode.children.type === 15
    ) {
      const a = Ot(e, "slot", !0),
        f = a && a.arg && u(t.codegenNode, a.arg);
      f && ((f.returns = c(Gn(f.returns))), (l = !0));
    }
  }
  if (!l) for (const a of o) a.codegenNode = n.cache(a.codegenNode);
  function c(a) {
    const f = n.cache(a);
    return (f.needArraySpread = !0), f;
  }
  function u(a, f) {
    if (a.children && !K(a.children) && a.children.type === 15) {
      const d = a.children.properties.find((h) => h.key === f || h.key.content === f);
      return d && d.value;
    }
  }
  o.length && n.transformHoist && n.transformHoist(i, n, e);
}
function _t(e, t) {
  const { constantCache: n } = t;
  switch (e.type) {
    case 1:
      if (e.tagType !== 0) return 0;
      const s = n.get(e);
      if (s !== void 0) return s;
      const r = e.codegenNode;
      if (
        r.type !== 13 ||
        (r.isBlock && e.tag !== "svg" && e.tag !== "foreignObject" && e.tag !== "math")
      )
        return 0;
      if (r.patchFlag === void 0) {
        let o = 3;
        const l = sd(e, t);
        if (l === 0) return n.set(e, 0), 0;
        l < o && (o = l);
        for (let c = 0; c < e.children.length; c++) {
          const u = _t(e.children[c], t);
          if (u === 0) return n.set(e, 0), 0;
          u < o && (o = u);
        }
        if (o > 1)
          for (let c = 0; c < e.props.length; c++) {
            const u = e.props[c];
            if (u.type === 7 && u.name === "bind" && u.exp) {
              const a = _t(u.exp, t);
              if (a === 0) return n.set(e, 0), 0;
              a < o && (o = a);
            }
          }
        if (r.isBlock) {
          for (let c = 0; c < e.props.length; c++) if (e.props[c].type === 7) return n.set(e, 0), 0;
          t.removeHelper(Xn),
            t.removeHelper(Ps(t.inSSR, r.isComponent)),
            (r.isBlock = !1),
            t.helper(Is(t.inSSR, r.isComponent));
        }
        return n.set(e, o), o;
      } else return n.set(e, 0), 0;
    case 2:
    case 3:
      return 3;
    case 9:
    case 11:
    case 10:
      return 0;
    case 5:
    case 12:
      return _t(e.content, t);
    case 4:
      return e.constType;
    case 8:
      let i = 3;
      for (let o = 0; o < e.children.length; o++) {
        const l = e.children[o];
        if (ne(l) || nt(l)) continue;
        const c = _t(l, t);
        if (c === 0) return 0;
        c < i && (i = c);
      }
      return i;
    case 20:
      return 2;
    default:
      return 0;
  }
}
const r0 = new Set([fc, hc, br, Fr]);
function nd(e, t) {
  if (e.type === 14 && !ne(e.callee) && r0.has(e.callee)) {
    const n = e.arguments[0];
    if (n.type === 4) return _t(n, t);
    if (n.type === 14) return nd(n, t);
  }
  return 0;
}
function sd(e, t) {
  let n = 3;
  const s = rd(e);
  if (s && s.type === 15) {
    const { properties: r } = s;
    for (let i = 0; i < r.length; i++) {
      const { key: o, value: l } = r[i],
        c = _t(o, t);
      if (c === 0) return c;
      c < n && (n = c);
      let u;
      if ((l.type === 4 ? (u = _t(l, t)) : l.type === 14 ? (u = nd(l, t)) : (u = 0), u === 0))
        return u;
      u < n && (n = u);
    }
  }
  return n;
}
function rd(e) {
  const t = e.codegenNode;
  if (t.type === 13) return t.props;
}
function i0(
  e,
  {
    filename: t = "",
    prefixIdentifiers: n = !1,
    hoistStatic: s = !1,
    hmr: r = !1,
    cacheHandlers: i = !1,
    nodeTransforms: o = [],
    directiveTransforms: l = {},
    transformHoist: c = null,
    isBuiltInComponent: u = Je,
    isCustomElement: a = Je,
    expressionPlugins: f = [],
    scopeId: d = null,
    slotted: h = !0,
    ssr: m = !1,
    inSSR: v = !1,
    ssrCssVars: _ = "",
    bindingMetadata: S = he,
    inline: g = !1,
    isTS: p = !1,
    onError: b = yc,
    onWarn: T = Uh,
    compatConfig: R,
  }
) {
  const C = t.replace(/\?.*$/, "").match(/([^/\\]+)\.\w+$/),
    A = {
      filename: t,
      selfName: C && es(_e(C[1])),
      prefixIdentifiers: n,
      hoistStatic: s,
      hmr: r,
      cacheHandlers: i,
      nodeTransforms: o,
      directiveTransforms: l,
      transformHoist: c,
      isBuiltInComponent: u,
      isCustomElement: a,
      expressionPlugins: f,
      scopeId: d,
      slotted: h,
      ssr: m,
      inSSR: v,
      ssrCssVars: _,
      bindingMetadata: S,
      inline: g,
      isTS: p,
      onError: b,
      onWarn: T,
      compatConfig: R,
      root: e,
      helpers: new Map(),
      components: new Set(),
      directives: new Set(),
      hoists: [],
      imports: [],
      cached: [],
      constantCache: new WeakMap(),
      temps: 0,
      identifiers: Object.create(null),
      scopes: { vFor: 0, vSlot: 0, vPre: 0, vOnce: 0 },
      parent: null,
      grandParent: null,
      currentNode: e,
      childIndex: 0,
      inVOnce: !1,
      helper(w) {
        const N = A.helpers.get(w) || 0;
        return A.helpers.set(w, N + 1), w;
      },
      removeHelper(w) {
        const N = A.helpers.get(w);
        if (N) {
          const P = N - 1;
          P ? A.helpers.set(w, P) : A.helpers.delete(w);
        }
      },
      helperString(w) {
        return `_${xs[A.helper(w)]}`;
      },
      replaceNode(w) {
        A.parent.children[A.childIndex] = A.currentNode = w;
      },
      removeNode(w) {
        const N = A.parent.children,
          P = w ? N.indexOf(w) : A.currentNode ? A.childIndex : -1;
        !w || w === A.currentNode
          ? ((A.currentNode = null), A.onNodeRemoved())
          : A.childIndex > P && (A.childIndex--, A.onNodeRemoved()),
          A.parent.children.splice(P, 1);
      },
      onNodeRemoved: Je,
      addIdentifiers(w) {},
      removeIdentifiers(w) {},
      hoist(w) {
        ne(w) && (w = ie(w)), A.hoists.push(w);
        const N = ie(`_hoisted_${A.hoists.length}`, !1, w.loc, 2);
        return (N.hoisted = w), N;
      },
      cache(w, N = !1, P = !1) {
        const O = Rv(A.cached.length, w, N, P);
        return A.cached.push(O), O;
      },
    };
  return (A.filters = new Set()), A;
}
function o0(e, t) {
  const n = i0(e, t);
  co(e, n),
    t.hoistStatic && s0(e, n),
    t.ssr || l0(e, n),
    (e.helpers = new Set([...n.helpers.keys()])),
    (e.components = [...n.components]),
    (e.directives = [...n.directives]),
    (e.imports = n.imports),
    (e.hoists = n.hoists),
    (e.temps = n.temps),
    (e.cached = n.cached),
    (e.transformed = !0),
    (e.filters = [...n.filters]);
}
function l0(e, t) {
  const { helper: n } = t,
    { children: s } = e;
  if (s.length === 1) {
    const r = td(e);
    if (r && r.codegenNode) {
      const i = r.codegenNode;
      i.type === 13 && gc(i, t), (e.codegenNode = i);
    } else e.codegenNode = s[0];
  } else if (s.length > 1) {
    const r = 64;
    e.codegenNode = _r(t, n(vr), void 0, e.children, r, void 0, void 0, !0, void 0, !1);
  }
}
function c0(e, t) {
  let n = 0;
  const s = () => {
    n--;
  };
  for (; n < e.children.length; n++) {
    const r = e.children[n];
    ne(r) ||
      ((t.grandParent = t.parent),
      (t.parent = e),
      (t.childIndex = n),
      (t.onNodeRemoved = s),
      co(r, t));
  }
}
function co(e, t) {
  t.currentNode = e;
  const { nodeTransforms: n } = t,
    s = [];
  for (let i = 0; i < n.length; i++) {
    const o = n[i](e, t);
    if ((o && (K(o) ? s.push(...o) : s.push(o)), t.currentNode)) e = t.currentNode;
    else return;
  }
  switch (e.type) {
    case 3:
      t.ssr || t.helper(Dr);
      break;
    case 5:
      t.ssr || t.helper(oo);
      break;
    case 9:
      for (let i = 0; i < e.branches.length; i++) co(e.branches[i], t);
      break;
    case 10:
    case 11:
    case 1:
    case 0:
      c0(e, t);
      break;
  }
  t.currentNode = e;
  let r = s.length;
  for (; r--; ) s[r]();
}
function id(e, t) {
  const n = ne(e) ? (s) => s === e : (s) => e.test(s);
  return (s, r) => {
    if (s.type === 1) {
      const { props: i } = s;
      if (s.tagType === 3 && i.some(jv)) return;
      const o = [];
      for (let l = 0; l < i.length; l++) {
        const c = i[l];
        if (c.type === 7 && n(c.name)) {
          i.splice(l, 1), l--;
          const u = t(s, c, r);
          u && o.push(u);
        }
      }
      return o;
    }
  };
}
const ao = "/*@__PURE__*/",
  od = (e) => `${xs[e]}: _${xs[e]}`;
function a0(
  e,
  {
    mode: t = "function",
    prefixIdentifiers: n = t === "module",
    sourceMap: s = !1,
    filename: r = "template.vue.html",
    scopeId: i = null,
    optimizeImports: o = !1,
    runtimeGlobalName: l = "Vue",
    runtimeModuleName: c = "vue",
    ssrRuntimeModuleName: u = "vue/server-renderer",
    ssr: a = !1,
    isTS: f = !1,
    inSSR: d = !1,
  }
) {
  const h = {
    mode: t,
    prefixIdentifiers: n,
    sourceMap: s,
    filename: r,
    scopeId: i,
    optimizeImports: o,
    runtimeGlobalName: l,
    runtimeModuleName: c,
    ssrRuntimeModuleName: u,
    ssr: a,
    isTS: f,
    inSSR: d,
    source: e.source,
    code: "",
    column: 1,
    line: 1,
    offset: 0,
    indentLevel: 0,
    pure: !1,
    map: void 0,
    helper(v) {
      return `_${xs[v]}`;
    },
    push(v, _ = -2, S) {
      h.code += v;
    },
    indent() {
      m(++h.indentLevel);
    },
    deindent(v = !1) {
      v ? --h.indentLevel : m(--h.indentLevel);
    },
    newline() {
      m(h.indentLevel);
    },
  };
  function m(v) {
    h.push(
      `
${  "  ".repeat(v)}`,
      0
    );
  }
  return h;
}
function u0(e, t = {}) {
  const n = a0(e, t);
  t.onContextCreated && t.onContextCreated(n);
  const {
      mode: s,
      push: r,
      prefixIdentifiers: i,
      indent: o,
      deindent: l,
      newline: c,
      scopeId: u,
      ssr: a,
    } = n,
    f = Array.from(e.helpers),
    d = f.length > 0,
    h = !i && s !== "module";
  f0(e, n);
  const v = a ? "ssrRender" : "render",
    S = (a ? ["_ctx", "_push", "_parent", "_attrs"] : ["_ctx", "_cache"]).join(", ");
  if (
    (r(`function ${v}(${S}) {`),
    o(),
    h &&
      (r("with (_ctx) {"),
      o(),
      d &&
        (r(
          `const { ${f.map(od).join(", ")} } = _Vue
`,
          -1
        ),
        c())),
    e.components.length &&
      (No(e.components, "component", n), (e.directives.length || e.temps > 0) && c()),
    e.directives.length && (No(e.directives, "directive", n), e.temps > 0 && c()),
    e.filters && e.filters.length && (c(), No(e.filters, "filter", n), c()),
    e.temps > 0)
  ) {
    r("let ");
    for (let g = 0; g < e.temps; g++) r(`${g > 0 ? ", " : ""}_temp${g}`);
  }
  return (
    (e.components.length || e.directives.length || e.temps) &&
      (r(
        `
`,
        0
      ),
      c()),
    a || r("return "),
    e.codegenNode ? tt(e.codegenNode, n) : r("null"),
    h && (l(), r("}")),
    l(),
    r("}"),
    { ast: e, code: n.code, preamble: "", map: n.map ? n.map.toJSON() : void 0 }
  );
}
function f0(e, t) {
  const {
      ssr: n,
      prefixIdentifiers: s,
      push: r,
      newline: i,
      runtimeModuleName: o,
      runtimeGlobalName: l,
      ssrRuntimeModuleName: c,
    } = t,
    u = l,
    a = Array.from(e.helpers);
  if (
    a.length > 0 &&
    (r(
      `const _Vue = ${u}
`,
      -1
    ),
    e.hoists.length)
  ) {
    const f = [nc, sc, Dr, rc, Bh]
      .filter((d) => a.includes(d))
      .map(od)
      .join(", ");
    r(
      `const { ${f} } = _Vue
`,
      -1
    );
  }
  h0(e.hoists, t), i(), r("return ");
}
function No(e, t, { helper: n, push: s, newline: r, isTS: i }) {
  const o = n(t === "filter" ? cc : t === "component" ? ic : lc);
  for (let l = 0; l < e.length; l++) {
    let c = e[l];
    const u = c.endsWith("__self");
    u && (c = c.slice(0, -6)),
      s(`const ${Er(c, t)} = ${o}(${JSON.stringify(c)}${u ? ", true" : ""})${i ? "!" : ""}`),
      l < e.length - 1 && r();
  }
}
function h0(e, t) {
  if (!e.length) return;
  t.pure = !0;
  const { push: n, newline: s } = t;
  s();
  for (let r = 0; r < e.length; r++) {
    const i = e[r];
    i && (n(`const _hoisted_${r + 1} = `), tt(i, t), s());
  }
  t.pure = !1;
}
function Sc(e, t) {
  const n = e.length > 3 || !1;
  t.push("["), n && t.indent(), Lr(e, t, n), n && t.deindent(), t.push("]");
}
function Lr(e, t, n = !1, s = !0) {
  const { push: r, newline: i } = t;
  for (let o = 0; o < e.length; o++) {
    const l = e[o];
    ne(l) ? r(l, -3) : K(l) ? Sc(l, t) : tt(l, t),
      o < e.length - 1 && (n ? (s && r(","), i()) : s && r(", "));
  }
}
function tt(e, t) {
  if (ne(e)) {
    t.push(e, -3);
    return;
  }
  if (nt(e)) {
    t.push(t.helper(e));
    return;
  }
  switch (e.type) {
    case 1:
    case 9:
    case 11:
      tt(e.codegenNode, t);
      break;
    case 2:
      d0(e, t);
      break;
    case 4:
      ld(e, t);
      break;
    case 5:
      p0(e, t);
      break;
    case 12:
      tt(e.codegenNode, t);
      break;
    case 8:
      cd(e, t);
      break;
    case 3:
      g0(e, t);
      break;
    case 13:
      y0(e, t);
      break;
    case 14:
      b0(e, t);
      break;
    case 15:
      _0(e, t);
      break;
    case 17:
      S0(e, t);
      break;
    case 18:
      E0(e, t);
      break;
    case 19:
      T0(e, t);
      break;
    case 20:
      w0(e, t);
      break;
    case 21:
      Lr(e.body, t, !0, !1);
      break;
  }
}
function d0(e, t) {
  t.push(JSON.stringify(e.content), -3, e);
}
function ld(e, t) {
  const { content: n, isStatic: s } = e;
  t.push(s ? JSON.stringify(n) : n, -3, e);
}
function p0(e, t) {
  const { push: n, helper: s, pure: r } = t;
  r && n(ao), n(`${s(oo)}(`), tt(e.content, t), n(")");
}
function cd(e, t) {
  for (let n = 0; n < e.children.length; n++) {
    const s = e.children[n];
    ne(s) ? t.push(s, -3) : tt(s, t);
  }
}
function m0(e, t) {
  const { push: n } = t;
  if (e.type === 8) n("["), cd(e, t), n("]");
  else if (e.isStatic) {
    const s = vc(e.content) ? e.content : JSON.stringify(e.content);
    n(s, -2, e);
  } else n(`[${e.content}]`, -3, e);
}
function g0(e, t) {
  const { push: n, helper: s, pure: r } = t;
  r && n(ao), n(`${s(Dr)}(${JSON.stringify(e.content)})`, -3, e);
}
function y0(e, t) {
  const { push: n, helper: s, pure: r } = t,
    {
      tag: i,
      props: o,
      children: l,
      patchFlag: c,
      dynamicProps: u,
      directives: a,
      isBlock: f,
      disableTracking: d,
      isComponent: h,
    } = e;
  let m;
  c && (m = String(c)), a && n(`${s(ac)  }(`), f && n(`(${s(Xn)}(${d ? "true" : ""}), `), r && n(ao);
  const v = f ? Ps(t.inSSR, h) : Is(t.inSSR, h);
  n(`${s(v)  }(`, -2, e),
    Lr(v0([i, o, l, m, u]), t),
    n(")"),
    f && n(")"),
    a && (n(", "), tt(a, t), n(")"));
}
function v0(e) {
  let t = e.length;
  for (; t-- && e[t] == null; );
  return e.slice(0, t + 1).map((n) => n || "null");
}
function b0(e, t) {
  const { push: n, helper: s, pure: r } = t,
    i = ne(e.callee) ? e.callee : s(e.callee);
  r && n(ao), n(`${i  }(`, -2, e), Lr(e.arguments, t), n(")");
}
function _0(e, t) {
  const { push: n, indent: s, deindent: r, newline: i } = t,
    { properties: o } = e;
  if (!o.length) {
    n("{}", -2, e);
    return;
  }
  const l = o.length > 1 || !1;
  n(l ? "{" : "{ "), l && s();
  for (let c = 0; c < o.length; c++) {
    const { key: u, value: a } = o[c];
    m0(u, t), n(": "), tt(a, t), c < o.length - 1 && (n(","), i());
  }
  l && r(), n(l ? "}" : " }");
}
function S0(e, t) {
  Sc(e.elements, t);
}
function E0(e, t) {
  const { push: n, indent: s, deindent: r } = t,
    { params: i, returns: o, body: l, newline: c, isSlot: u } = e;
  u && n(`_${xs[pc]}(`),
    n("(", -2, e),
    K(i) ? Lr(i, t) : i && tt(i, t),
    n(") => "),
    (c || l) && (n("{"), s()),
    o ? (c && n("return "), K(o) ? Sc(o, t) : tt(o, t)) : l && tt(l, t),
    (c || l) && (r(), n("}")),
    u && (e.isNonScopedSlot && n(", undefined, true"), n(")"));
}
function T0(e, t) {
  const { test: n, consequent: s, alternate: r, newline: i } = e,
    { push: o, indent: l, deindent: c, newline: u } = t;
  if (n.type === 4) {
    const f = !vc(n.content);
    f && o("("), ld(n, t), f && o(")");
  } else o("("), tt(n, t), o(")");
  i && l(),
    t.indentLevel++,
    i || o(" "),
    o("? "),
    tt(s, t),
    t.indentLevel--,
    i && u(),
    i || o(" "),
    o(": ");
  const a = r.type === 19;
  a || t.indentLevel++, tt(r, t), a || t.indentLevel--, i && c(!0);
}
function w0(e, t) {
  const { push: n, helper: s, indent: r, deindent: i, newline: o } = t,
    { needPauseTracking: l, needArraySpread: c } = e;
  c && n("[...("),
    n(`_cache[${e.index}] || (`),
    l && (r(), n(`${s(Ri)}(-1`), e.inVOnce && n(", true"), n("),"), o(), n("(")),
    n(`_cache[${e.index}] = `),
    tt(e.value, t),
    l &&
      (n(`).cacheIndex = ${e.index},`), o(), n(`${s(Ri)}(1),`), o(), n(`_cache[${e.index}]`), i()),
    n(")"),
    c && n(")]");
}
new RegExp(
  `\\b${ 
    "arguments,await,break,case,catch,class,const,continue,debugger,default,delete,do,else,export,extends,finally,for,function,if,import,let,new,return,super,switch,throw,try,var,void,while,with,yield"
      .split(",")
      .join("\\b|\\b") 
    }\\b`
);
const C0 = id(/^(?:if|else|else-if)$/, (e, t, n) =>
  A0(e, t, n, (s, r, i) => {
    const o = n.parent.children;
    let l = o.indexOf(s),
      c = 0;
    for (; l-- >= 0; ) {
      const u = o[l];
      u && u.type === 9 && (c += u.branches.length);
    }
    return () => {
      if (i) s.codegenNode = Va(r, c, n);
      else {
        const u = O0(s.codegenNode);
        u.alternate = Va(r, c + s.branches.length - 1, n);
      }
    };
  })
);
function A0(e, t, n, s) {
  if (t.name !== "else" && (!t.exp || !t.exp.content.trim())) {
    const r = t.exp ? t.exp.loc : e.loc;
    n.onError(Ce(28, t.loc)), (t.exp = ie("true", !1, r));
  }
  if (t.name === "if") {
    const r = La(e, t),
      i = { type: 9, loc: Qv(e.loc), branches: [r] };
    if ((n.replaceNode(i), s)) return s(i, r, !0);
  } else {
    const r = n.parent.children;
    let i = r.indexOf(e);
    for (; i-- >= -1; ) {
      const o = r[i];
      if (o && Jh(o)) {
        n.removeNode(o);
        continue;
      }
      if (o && o.type === 9) {
        (t.name === "else-if" || t.name === "else") &&
          o.branches[o.branches.length - 1].condition === void 0 &&
          n.onError(Ce(30, e.loc)),
          n.removeNode();
        const l = La(e, t);
        o.branches.push(l);
        const c = s && s(o, l, !1);
        co(l, n), c && c(), (n.currentNode = null);
      } else n.onError(Ce(30, e.loc));
      break;
    }
  }
}
function La(e, t) {
  const n = e.tagType === 3;
  return {
    type: 10,
    loc: e.loc,
    condition: t.name === "else" ? void 0 : t.exp,
    children: n && !Ot(e, "for") ? e.children : [e],
    userKey: lo(e, "key"),
    isTemplateIf: n,
  };
}
function Va(e, t, n) {
  return e.condition ? ol(e.condition, Ba(e, t, n), $e(n.helper(Dr), ['""', "true"])) : Ba(e, t, n);
}
function Ba(e, t, n) {
  const { helper: s } = n,
    r = Fe("key", ie(`${t}`, !1, Tt, 2)),
    { children: i } = e,
    o = i[0];
  if (i.length !== 1 || o.type !== 1)
    if (i.length === 1 && o.type === 11) {
      const c = o.codegenNode;
      return ki(c, r, n), c;
    } else return _r(n, s(vr), xt([r]), i, 64, void 0, void 0, !0, !1, !1, e.loc);
  else {
    const c = o.codegenNode,
      u = Uv(c);
    return u.type === 13 && gc(u, n), ki(u, r, n), c;
  }
}
function O0(e) {
  for (;;)
    if (e.type === 19)
      if (e.alternate.type === 19) e = e.alternate;
      else return e;
    else e.type === 20 && (e = e.value);
}
const N0 = id("for", (e, t, n) => {
  const { helper: s, removeHelper: r } = n;
  return x0(e, t, n, (i) => {
    const o = $e(s(uc), [i.source]),
      l = Pi(e),
      c = Ot(e, "memo"),
      u = lo(e, "key", !1, !0);
    u && u.type;
    const a = u && (u.type === 6 ? (u.value ? ie(u.value.content, !0) : void 0) : u.exp);
    const f = u && a ? Fe("key", a) : null,
      d = i.source.type === 4 && i.source.constType > 0,
      h = d ? 64 : u ? 128 : 256;
    return (
      (i.codegenNode = _r(n, s(vr), void 0, o, h, void 0, void 0, !0, !d, !1, e.loc)),
      () => {
        let m;
        const { children: v } = i,
          _ = v.length !== 1 || v[0].type !== 1,
          S = Mi(e) ? e : l && e.children.length === 1 && Mi(e.children[0]) ? e.children[0] : null;
        if (
          (S
            ? ((m = S.codegenNode), l && f && ki(m, f, n))
            : _
              ? (m = _r(
                  n,
                  s(vr),
                  f ? xt([f]) : void 0,
                  e.children,
                  64,
                  void 0,
                  void 0,
                  !0,
                  void 0,
                  !1
                ))
              : ((m = v[0].codegenNode),
                l && f && ki(m, f, n),
                m.isBlock !== !d &&
                  (m.isBlock
                    ? (r(Xn), r(Ps(n.inSSR, m.isComponent)))
                    : r(Is(n.inSSR, m.isComponent))),
                (m.isBlock = !d),
                m.isBlock ? (s(Xn), s(Ps(n.inSSR, m.isComponent))) : s(Is(n.inSSR, m.isComponent))),
          c)
        ) {
          const g = Rs(al(i.parseResult, [ie("_cached")]));
          (g.body = Iv([
            Ft(["const _memo = (", c.exp, ")"]),
            Ft([
              "if (_cached && _cached.el",
              ...(a ? [" && _cached.key === ", a] : []),
              ` && ${n.helperString($h)}(_cached, _memo)) return _cached`,
            ]),
            Ft(["const _item = ", m]),
            ie("_item.memo = _memo"),
            ie("return _item"),
          ])),
            o.arguments.push(g, ie("_cache"), ie(String(n.cached.length))),
            n.cached.push(null);
        } else o.arguments.push(Rs(al(i.parseResult), m, !0));
      }
    );
  });
});
function x0(e, t, n, s) {
  if (!t.exp) {
    n.onError(Ce(31, t.loc));
    return;
  }
  const r = t.forParseResult;
  if (!r) {
    n.onError(Ce(32, t.loc));
    return;
  }
  ad(r);
  const { addIdentifiers: i, removeIdentifiers: o, scopes: l } = n,
    { source: c, value: u, key: a, index: f } = r,
    d = {
      type: 11,
      loc: t.loc,
      source: c,
      valueAlias: u,
      keyAlias: a,
      objectIndexAlias: f,
      parseResult: r,
      children: Pi(e) ? e.children : [e],
    };
  n.replaceNode(d), l.vFor++;
  const h = s && s(d);
  return () => {
    l.vFor--, h && h();
  };
}
function ad(e, t) {
  e.finalized || (e.finalized = !0);
}
function al({ value: e, key: t, index: n }, s = []) {
  return R0([e, t, n, ...s]);
}
function R0(e) {
  let t = e.length;
  for (; t-- && !e[t]; );
  return e.slice(0, t + 1).map((n, s) => n || ie("_".repeat(s + 1), !1));
}
const Ha = ie("undefined", !1),
  I0 = (e, t) => {
    if (e.type === 1 && (e.tagType === 1 || e.tagType === 3)) {
      const n = Ot(e, "slot");
      if (n)
        return (
          n.exp,
          t.scopes.vSlot++,
          () => {
            t.scopes.vSlot--;
          }
        );
    }
  },
  P0 = (e, t, n, s) => Rs(e, n, !1, !0, n.length ? n[0].loc : s);
function M0(e, t, n = P0) {
  t.helper(pc);
  const { children: s, loc: r } = e,
    i = [],
    o = [];
  let l = t.scopes.vSlot > 0 || t.scopes.vFor > 0;
  const c = Ot(e, "slot", !0);
  if (c) {
    const { arg: _, exp: S } = c;
    _ && !pt(_) && (l = !0), i.push(Fe(_ || ie("default", !0), n(S, void 0, s, r)));
  }
  let u = !1,
    a = !1;
  const f = [],
    d = new Set();
  let h = 0;
  for (let _ = 0; _ < s.length; _++) {
    const S = s[_];
    let g;
    if (!Pi(S) || !(g = Ot(S, "slot", !0))) {
      S.type !== 3 && f.push(S);
      continue;
    }
    if (c) {
      t.onError(Ce(37, g.loc));
      break;
    }
    u = !0;
    const { children: p, loc: b } = S,
      { arg: T = ie("default", !0), exp: R, loc: C } = g;
    let A;
    pt(T) ? (A = T ? T.content : "default") : (l = !0);
    const w = Ot(S, "for"),
      N = n(R, w, p, b);
    let P, O;
    if ((P = Ot(S, "if"))) (l = !0), o.push(ol(P.exp, Qr(T, N, h++), Ha));
    else if ((O = Ot(S, /^else(?:-if)?$/, !0))) {
      let V = _,
        k;
      for (; V-- && ((k = s[V]), !!Jh(k)); );
      if (k && Pi(k) && Ot(k, /^(?:else-)?if$/)) {
        let $ = o[o.length - 1];
        for (; $.alternate.type === 19; ) $ = $.alternate;
        $.alternate = O.exp ? ol(O.exp, Qr(T, N, h++), Ha) : Qr(T, N, h++);
      } else t.onError(Ce(30, O.loc));
    } else if (w) {
      l = !0;
      const V = w.forParseResult;
      V
        ? (ad(V), o.push($e(t.helper(uc), [V.source, Rs(al(V), Qr(T, N), !0)])))
        : t.onError(Ce(32, w.loc));
    } else {
      if (A) {
        if (d.has(A)) {
          t.onError(Ce(38, C));
          continue;
        }
        d.add(A), A === "default" && (a = !0);
      }
      i.push(Fe(T, N));
    }
  }
  if (!c) {
    const _ = (S, g) => {
      const p = n(S, void 0, g, r);
      return t.compatConfig && (p.isNonScopedSlot = !0), Fe("default", p);
    };
    u
      ? f.length && !f.every(bc) && (a ? t.onError(Ce(39, f[0].loc)) : i.push(_(void 0, f)))
      : i.push(_(void 0, s));
  }
  const m = l ? 2 : ai(e.children) ? 3 : 1;
  let v = xt(i.concat(Fe("_", ie(`${m  }`, !1))), r);
  return o.length && (v = $e(t.helper(jh), [v, Gn(o)])), { slots: v, hasDynamicSlots: l };
}
function Qr(e, t, n) {
  const s = [Fe("name", e), Fe("fn", t)];
  return n != null && s.push(Fe("key", ie(String(n), !0))), xt(s);
}
function ai(e) {
  for (let t = 0; t < e.length; t++) {
    const n = e[t];
    switch (n.type) {
      case 1:
        if (n.tagType === 2 || ai(n.children)) return !0;
        break;
      case 9:
        if (ai(n.branches)) return !0;
        break;
      case 10:
      case 11:
        if (ai(n.children)) return !0;
        break;
    }
  }
  return !1;
}
const ud = new WeakMap(),
  k0 = (e, t) =>
    function () {
      if (((e = t.currentNode), !(e.type === 1 && (e.tagType === 0 || e.tagType === 1)))) return;
      const { tag: s, props: r } = e,
        i = e.tagType === 1;
      const o = i ? D0(e, t) : `"${s}"`;
      const l = ge(o) && o.callee === oc;
      let c,
        u,
        a = 0,
        f,
        d,
        h,
        m =
          l ||
          o === er ||
          o === tc ||
          (!i && (s === "svg" || s === "foreignObject" || s === "math"));
      if (r.length > 0) {
        const v = fd(e, t, void 0, i, l);
        (c = v.props), (a = v.patchFlag), (d = v.dynamicPropNames);
        const _ = v.directives;
        (h = _ && _.length ? Gn(_.map((S) => L0(S, t))) : void 0), v.shouldUseBlock && (m = !0);
      }
      if (e.children.length > 0)
        if ((o === Ni && ((m = !0), (a |= 1024)), i && o !== er && o !== Ni)) {
          const { slots: _, hasDynamicSlots: S } = M0(e, t);
          (u = _), S && (a |= 1024);
        } else if (e.children.length === 1 && o !== er) {
          const _ = e.children[0],
            S = _.type,
            g = S === 5 || S === 8;
          g && _t(_, t) === 0 && (a |= 1), g || S === 2 ? (u = _) : (u = e.children);
        } else u = e.children;
      d && d.length && (f = V0(d)),
        (e.codegenNode = _r(t, o, c, u, a === 0 ? void 0 : a, f, h, !!m, !1, i, e.loc));
    };
function D0(e, t, n = !1) {
  let { tag: s } = e;
  const r = ul(s),
    i = lo(e, "is", !1, !0);
  if (i)
    if (r || zn("COMPILER_IS_ON_ELEMENT", t)) {
      let l;
      if (
        (i.type === 6
          ? (l = i.value && ie(i.value.content, !0))
          : ((l = i.exp), l || (l = ie("is", !1, i.arg.loc))),
        l)
      )
        return $e(t.helper(oc), [l]);
    } else i.type === 6 && i.value.content.startsWith("vue:") && (s = i.value.content.slice(4));
  const o = Wh(s) || t.isBuiltInComponent(s);
  return o ? (n || t.helper(o), o) : (t.helper(ic), t.components.add(s), Er(s, "component"));
}
function fd(e, t, n = e.props, s, r, i = !1) {
  const { tag: o, loc: l, children: c } = e;
  let u = [];
  const a = [],
    f = [],
    d = c.length > 0;
  let h = !1,
    m = 0,
    v = !1,
    _ = !1,
    S = !1,
    g = !1,
    p = !1,
    b = !1;
  const T = [],
    R = (N) => {
      u.length && (a.push(xt(ja(u), l)), (u = [])), N && a.push(N);
    },
    C = () => {
      t.scopes.vFor > 0 && u.push(Fe(ie("ref_for", !0), ie("true")));
    },
    A = ({ key: N, value: P }) => {
      if (pt(N)) {
        const O = N.content,
          V = Zn(O);
        if (
          (V &&
            (!s || r) &&
            O.toLowerCase() !== "onclick" &&
            O !== "onUpdate:modelValue" &&
            !sn(O) &&
            (g = !0),
          V && sn(O) && (b = !0),
          V && P.type === 14 && (P = P.arguments[0]),
          P.type === 20 || ((P.type === 4 || P.type === 8) && _t(P, t) > 0))
        )
          return;
        O === "ref"
          ? (v = !0)
          : O === "class"
            ? (_ = !0)
            : O === "style"
              ? (S = !0)
              : O !== "key" && !T.includes(O) && T.push(O),
          s && (O === "class" || O === "style") && !T.includes(O) && T.push(O);
      } else p = !0;
    };
  for (let N = 0; N < n.length; N++) {
    const P = n[N];
    if (P.type === 6) {
      const { loc: O, name: V, nameLoc: k, value: $ } = P;
      const B = !0;
      if (
        (V === "ref" && ((v = !0), C()),
        V === "is" &&
          (ul(o) || ($ && $.content.startsWith("vue:")) || zn("COMPILER_IS_ON_ELEMENT", t)))
      )
        continue;
      u.push(Fe(ie(V, !0, k), ie($ ? $.content : "", B, $ ? $.loc : O)));
    } else {
      const { name: O, arg: V, exp: k, loc: $, modifiers: B } = P,
        J = O === "bind",
        q = O === "on";
      if (O === "slot") {
        s || t.onError(Ce(40, $));
        continue;
      }
      if (
        O === "once" ||
        O === "memo" ||
        O === "is" ||
        (J && Hn(V, "is") && (ul(o) || zn("COMPILER_IS_ON_ELEMENT", t))) ||
        (q && i)
      )
        continue;
      if (
        (((J && Hn(V, "key")) || (q && d && Hn(V, "vue:before-update"))) && (h = !0),
        J && Hn(V, "ref") && C(),
        !V && (J || q))
      ) {
        if (((p = !0), k))
          if (J) {
            if ((R(), zn("COMPILER_V_BIND_OBJECT_ORDER", t))) {
              a.unshift(k);
              continue;
            }
            C(), R(), a.push(k);
          } else R({ type: 14, loc: $, callee: t.helper(dc), arguments: s ? [k] : [k, "true"] });
        else t.onError(Ce(J ? 34 : 35, $));
        continue;
      }
      J && B.some((ot) => ot.content === "prop") && (m |= 32);
      const pe = t.directiveTransforms[O];
      if (pe) {
        const { props: ot, needRuntime: lt } = pe(P, e, t);
        !i && ot.forEach(A),
          q && V && !pt(V) ? R(xt(ot, l)) : u.push(...ot),
          lt && (f.push(P), nt(lt) && ud.set(P, lt));
      } else kp(O) || (f.push(P), d && (h = !0));
    }
  }
  let w;
  if (
    (a.length
      ? (R(), a.length > 1 ? (w = $e(t.helper(xi), a, l)) : (w = a[0]))
      : u.length && (w = xt(ja(u), l)),
    p
      ? (m |= 16)
      : (_ && !s && (m |= 2), S && !s && (m |= 4), T.length && (m |= 8), g && (m |= 32)),
    !h && (m === 0 || m === 32) && (v || b || f.length > 0) && (m |= 512),
    !t.inSSR && w)
  )
    switch (w.type) {
      case 15:
        let N = -1,
          P = -1,
          O = !1;
        for (let $ = 0; $ < w.properties.length; $++) {
          const B = w.properties[$].key;
          pt(B)
            ? B.content === "class"
              ? (N = $)
              : B.content === "style" && (P = $)
            : B.isHandlerKey || (O = !0);
        }
        const V = w.properties[N],
          k = w.properties[P];
        O
          ? (w = $e(t.helper(br), [w]))
          : (V && !pt(V.value) && (V.value = $e(t.helper(fc), [V.value])),
            k &&
              (S ||
                (k.value.type === 4 && k.value.content.trim()[0] === "[") ||
                k.value.type === 17) &&
              (k.value = $e(t.helper(hc), [k.value])));
        break;
      case 14:
        break;
      default:
        w = $e(t.helper(br), [$e(t.helper(Fr), [w])]);
        break;
    }
  return { props: w, directives: f, patchFlag: m, dynamicPropNames: T, shouldUseBlock: h };
}
function ja(e) {
  const t = new Map(),
    n = [];
  for (let s = 0; s < e.length; s++) {
    const r = e[s];
    if (r.key.type === 8 || !r.key.isStatic) {
      n.push(r);
      continue;
    }
    const i = r.key.content,
      o = t.get(i);
    o ? (i === "style" || i === "class" || Zn(i)) && F0(o, r) : (t.set(i, r), n.push(r));
  }
  return n;
}
function F0(e, t) {
  e.value.type === 17 ? e.value.elements.push(t.value) : (e.value = Gn([e.value, t.value], e.loc));
}
function L0(e, t) {
  const n = [],
    s = ud.get(e);
  s
    ? n.push(t.helperString(s))
    : (t.helper(lc), t.directives.add(e.name), n.push(Er(e.name, "directive")));
  const { loc: r } = e;
  if (
    (e.exp && n.push(e.exp),
    e.arg && (e.exp || n.push("void 0"), n.push(e.arg)),
    Object.keys(e.modifiers).length)
  ) {
    e.arg || (e.exp || n.push("void 0"), n.push("void 0"));
    const i = ie("true", !1, r);
    n.push(
      xt(
        e.modifiers.map((o) => Fe(o, i)),
        r
      )
    );
  }
  return Gn(n, e.loc);
}
function V0(e) {
  let t = "[";
  for (let n = 0, s = e.length; n < s; n++) (t += JSON.stringify(e[n])), n < s - 1 && (t += ", ");
  return `${t  }]`;
}
function ul(e) {
  return e === "component" || e === "Component";
}
const B0 = (e, t) => {
  if (Mi(e)) {
    const { children: n, loc: s } = e,
      { slotName: r, slotProps: i } = H0(e, t),
      o = [t.prefixIdentifiers ? "_ctx.$slots" : "$slots", r, "{}", "undefined", "true"];
    let l = 2;
    i && ((o[2] = i), (l = 3)),
      n.length && ((o[3] = Rs([], n, !1, !1, s)), (l = 4)),
      t.scopeId && !t.slotted && (l = 5),
      o.splice(l),
      (e.codegenNode = $e(t.helper(Hh), o, s));
  }
};
function H0(e, t) {
  let n = '"default"',
    s;
  const r = [];
  for (let i = 0; i < e.props.length; i++) {
    const o = e.props[i];
    if (o.type === 6)
      o.value &&
        (o.name === "name"
          ? (n = JSON.stringify(o.value.content))
          : ((o.name = _e(o.name)), r.push(o)));
    else if (o.name === "bind" && Hn(o.arg, "name")) {
      if (o.exp) n = o.exp;
      else if (o.arg && o.arg.type === 4) {
        const l = _e(o.arg.content);
        n = o.exp = ie(l, !1, o.arg.loc);
      }
    } else
      o.name === "bind" && o.arg && pt(o.arg) && (o.arg.content = _e(o.arg.content)), r.push(o);
  }
  if (r.length > 0) {
    const { props: i, directives: o } = fd(e, t, r, !1, !1);
    (s = i), o.length && t.onError(Ce(36, o[0].loc));
  }
  return { slotName: n, slotProps: s };
}
const hd = (e, t, n, s) => {
    const { loc: r, modifiers: i, arg: o } = e;
    !e.exp && !i.length && n.onError(Ce(35, r));
    let l;
    if (o.type === 4)
      if (o.isStatic) {
        let f = o.content;
        f.startsWith("vue:") && (f = `vnode-${f.slice(4)}`);
        const d =
          t.tagType !== 0 || f.startsWith("vnode") || !/[A-Z]/.test(f) ? ms(_e(f)) : `on:${f}`;
        l = ie(d, !0, o.loc);
      } else l = Ft([`${n.helperString(il)}(`, o, ")"]);
    else (l = o), l.children.unshift(`${n.helperString(il)}(`), l.children.push(")");
    let c = e.exp;
    c && !c.content.trim() && (c = void 0);
    const u = n.cacheHandlers && !c && !n.inVOnce;
    if (c) {
      const f = Gh(c),
        d = !(f || Bv(c)),
        h = c.content.includes(";");
      (d || (u && f)) &&
        (c = Ft([`${d ? "$event" : "(...args)"} => ${h ? "{" : "("}`, c, h ? "}" : ")"]));
    }
    let a = { props: [Fe(l, c || ie("() => {}", !1, r))] };
    return (
      s && (a = s(a)),
      u && (a.props[0].value = n.cache(a.props[0].value)),
      a.props.forEach((f) => (f.key.isHandlerKey = !0)),
      a
    );
  },
  j0 = (e, t, n) => {
    const { modifiers: s, loc: r } = e,
      i = e.arg;
    let { exp: o } = e;
    return (
      o && o.type === 4 && !o.content.trim() && (o = void 0),
      i.type !== 4
        ? (i.children.unshift("("), i.children.push(') || ""'))
        : i.isStatic || (i.content = i.content ? `${i.content} || ""` : '""'),
      s.some((l) => l.content === "camel") &&
        (i.type === 4
          ? i.isStatic
            ? (i.content = _e(i.content))
            : (i.content = `${n.helperString(rl)}(${i.content})`)
          : (i.children.unshift(`${n.helperString(rl)}(`), i.children.push(")"))),
      n.inSSR ||
        (s.some((l) => l.content === "prop") && $a(i, "."),
        s.some((l) => l.content === "attr") && $a(i, "^")),
      { props: [Fe(i, o)] }
    );
  },
  $a = (e, t) => {
    e.type === 4
      ? e.isStatic
        ? (e.content = t + e.content)
        : (e.content = `\`${t}\${${e.content}}\``)
      : (e.children.unshift(`'${t}' + (`), e.children.push(")"));
  },
  $0 = (e, t) => {
    if (e.type === 0 || e.type === 1 || e.type === 11 || e.type === 10)
      return () => {
        const n = e.children;
        let s,
          r = !1;
        for (let i = 0; i < n.length; i++) {
          const o = n[i];
          if (Oo(o)) {
            r = !0;
            for (let l = i + 1; l < n.length; l++) {
              const c = n[l];
              if (Oo(c))
                s || (s = n[i] = Ft([o], o.loc)), s.children.push(" + ", c), n.splice(l, 1), l--;
              else {
                s = void 0;
                break;
              }
            }
          }
        }
        if (
          !(
            !r ||
            (n.length === 1 &&
              (e.type === 0 ||
                (e.type === 1 &&
                  e.tagType === 0 &&
                  !e.props.find((i) => i.type === 7 && !t.directiveTransforms[i.name]) &&
                  e.tag !== "template")))
          )
        )
          for (let i = 0; i < n.length; i++) {
            const o = n[i];
            if (Oo(o) || o.type === 8) {
              const l = [];
              (o.type !== 2 || o.content !== " ") && l.push(o),
                !t.ssr && _t(o, t) === 0 && l.push("1"),
                (n[i] = { type: 12, content: o, loc: o.loc, codegenNode: $e(t.helper(rc), l) });
            }
          }
      };
  },
  Ua = new WeakSet(),
  U0 = (e, t) => {
    if (e.type === 1 && Ot(e, "once", !0))
      return Ua.has(e) || t.inVOnce || t.inSSR
        ? void 0
        : (Ua.add(e),
          (t.inVOnce = !0),
          t.helper(Ri),
          () => {
            t.inVOnce = !1;
            const n = t.currentNode;
            n.codegenNode && (n.codegenNode = t.cache(n.codegenNode, !0, !0));
          });
  },
  dd = (e, t, n) => {
    const { exp: s, arg: r } = e;
    if (!s) return n.onError(Ce(41, e.loc)), Us();
    const i = s.loc.source.trim(),
      o = s.type === 4 ? s.content : i,
      l = n.bindingMetadata[i];
    if (l === "props" || l === "props-aliased") return n.onError(Ce(44, s.loc)), Us();
    if (l === "literal-const" || l === "setup-const") return n.onError(Ce(45, s.loc)), Us();
    if (!o.trim() || !Gh(s)) return n.onError(Ce(42, s.loc)), Us();
    const c = r || ie("modelValue", !0),
      u = r
        ? pt(r)
          ? `onUpdate:${_e(r.content)}`
          : Ft(['"onUpdate:" + ', r])
        : "onUpdate:modelValue";
    let a;
    const f = n.isTS ? "($event: any)" : "$event";
    a = Ft([`${f} => ((`, s, ") = $event)"]);
    const d = [Fe(c, e.exp), Fe(u, a)];
    if (e.modifiers.length && t.tagType === 1) {
      const h = e.modifiers
          .map((v) => v.content)
          .map((v) => `${vc(v) ? v : JSON.stringify(v)  }: true`)
          .join(", "),
        m = r ? (pt(r) ? `${r.content}Modifiers` : Ft([r, ' + "Modifiers"'])) : "modelModifiers";
      d.push(Fe(m, ie(`{ ${h} }`, !1, e.loc, 2)));
    }
    return Us(d);
  };
function Us(e = []) {
  return { props: e };
}
const W0 = /[\w).+\-_$\]]/,
  K0 = (e, t) => {
    zn("COMPILER_FILTERS", t) &&
      (e.type === 5
        ? Di(e.content, t)
        : e.type === 1 &&
          e.props.forEach((n) => {
            n.type === 7 && n.name !== "for" && n.exp && Di(n.exp, t);
          }));
  };
function Di(e, t) {
  if (e.type === 4) Wa(e, t);
  else
    for (let n = 0; n < e.children.length; n++) {
      const s = e.children[n];
      typeof s == "object" &&
        (s.type === 4 ? Wa(s, t) : s.type === 8 ? Di(e, t) : s.type === 5 && Di(s.content, t));
    }
}
function Wa(e, t) {
  const n = e.content;
  let s = !1,
    r = !1,
    i = !1,
    o = !1,
    l = 0,
    c = 0,
    u = 0,
    a = 0,
    f,
    d,
    h,
    m,
    v = [];
  for (h = 0; h < n.length; h++)
    if (((d = f), (f = n.charCodeAt(h)), s)) f === 39 && d !== 92 && (s = !1);
    else if (r) f === 34 && d !== 92 && (r = !1);
    else if (i) f === 96 && d !== 92 && (i = !1);
    else if (o) f === 47 && d !== 92 && (o = !1);
    else if (
      f === 124 &&
      n.charCodeAt(h + 1) !== 124 &&
      n.charCodeAt(h - 1) !== 124 &&
      !l &&
      !c &&
      !u
    )
      m === void 0 ? ((a = h + 1), (m = n.slice(0, h).trim())) : _();
    else {
      switch (f) {
        case 34:
          r = !0;
          break;
        case 39:
          s = !0;
          break;
        case 96:
          i = !0;
          break;
        case 40:
          u++;
          break;
        case 41:
          u--;
          break;
        case 91:
          c++;
          break;
        case 93:
          c--;
          break;
        case 123:
          l++;
          break;
        case 125:
          l--;
          break;
      }
      if (f === 47) {
        let S = h - 1,
          g;
        for (; S >= 0 && ((g = n.charAt(S)), g === " "); S--);
        (!g || !W0.test(g)) && (o = !0);
      }
    }
  m === void 0 ? (m = n.slice(0, h).trim()) : a !== 0 && _();
  function _() {
    v.push(n.slice(a, h).trim()), (a = h + 1);
  }
  if (v.length) {
    for (h = 0; h < v.length; h++) m = q0(m, v[h], t);
    (e.content = m), (e.ast = void 0);
  }
}
function q0(e, t, n) {
  n.helper(cc);
  const s = t.indexOf("(");
  if (s < 0) return n.filters.add(t), `${Er(t, "filter")}(${e})`;
  {
    const r = t.slice(0, s),
      i = t.slice(s + 1);
    return n.filters.add(r), `${Er(r, "filter")}(${e}${i !== ")" ? `,${  i}` : i}`;
  }
}
const Ka = new WeakSet(),
  G0 = (e, t) => {
    if (e.type === 1) {
      const n = Ot(e, "memo");
      return !n || Ka.has(e) || t.inSSR
        ? void 0
        : (Ka.add(e),
          () => {
            const s = e.codegenNode || t.currentNode.codegenNode;
            s &&
              s.type === 13 &&
              (e.tagType !== 1 && gc(s, t),
              (e.codegenNode = $e(t.helper(mc), [
                n.exp,
                Rs(void 0, s),
                "_cache",
                String(t.cached.length),
              ])),
              t.cached.push(null));
          });
    }
  },
  z0 = (e, t) => {
    if (e.type === 1) {
      for (const n of e.props)
        if (
          n.type === 7 &&
          n.name === "bind" &&
          (!n.exp || (n.exp.type === 4 && !n.exp.content.trim())) &&
          n.arg
        ) {
          const s = n.arg;
          if (s.type !== 4 || !s.isStatic) t.onError(Ce(53, s.loc)), (n.exp = ie("", !0, s.loc));
          else {
            const r = _e(s.content);
            (Kh.test(r[0]) || r[0] === "-") && (n.exp = ie(r, !1, s.loc));
          }
        }
    }
  };
function Y0(e) {
  return [[z0, U0, C0, G0, N0, K0, B0, k0, I0, $0], { on: hd, bind: j0, model: dd }];
}
function J0(e, t = {}) {
  const n = t.onError || yc,
    s = t.mode === "module";
  t.prefixIdentifiers === !0 ? n(Ce(48)) : s && n(Ce(49));
  const r = !1;
  t.cacheHandlers && n(Ce(50)), t.scopeId && !s && n(Ce(51));
  const i = ce({}, t, { prefixIdentifiers: r }),
    o = ne(e) ? n0(e, i) : e,
    [l, c] = Y0();
  return (
    o0(
      o,
      ce({}, i, {
        nodeTransforms: [...l, ...(t.nodeTransforms || [])],
        directiveTransforms: ce({}, c, t.directiveTransforms || {}),
      })
    ),
    u0(o, i)
  );
}
const X0 = () => ({ props: [] });
/**
 * @vue/compiler-dom v3.5.34
 * (c) 2018-present Yuxi (Evan) You and Vue contributors
 * @license MIT
 **/ const pd = Symbol(""),
  md = Symbol(""),
  gd = Symbol(""),
  yd = Symbol(""),
  fl = Symbol(""),
  vd = Symbol(""),
  bd = Symbol(""),
  d = Symbol(""),
  Sd = Symbol(""),
  Ed = Symbol("");
Nv({
  [pd]: "vModelRadio",
  [md]: "vModelCheckbox",
  [gd]: "vModelText",
  [yd]: "vModelSelect",
  [fl]: "vModelDynamic",
  [vd]: "withModifiers",
  [bd]: "withKeys",
  [_d]: "vShow",
  [Sd]: "Transition",
  [Ed]: "TransitionGroup",
});
let ls;
function Z0(e, t = !1) {
  return (
    ls || (ls = document.createElement("div")),
    t
      ? ((ls.innerHTML = `<div foo="${e.replace(/"/g, "&quot;")}">`),
        ls.children[0].getAttribute("foo"))
      : ((ls.innerHTML = e), ls.textContent)
  );
}
const Q0 = {
    parseMode: "html",
    isVoidTag: Xp,
    isNativeTag: (e) => zp(e) || Yp(e) || Jp(e),
    isPreTag: (e) => e === "pre",
    isIgnoreNewlineTag: (e) => e === "pre" || e === "textarea",
    decodeEntities: Z0,
    isBuiltInComponent: (e) => {
      if (e === "Transition" || e === "transition") return Sd;
      if (e === "TransitionGroup" || e === "transition-group") return Ed;
    },
    getNamespace(e, t, n) {
      let s = t ? t.ns : n;
      if (t && s === 2)
        if (t.tag === "annotation-xml") {
          if (e === "svg") return 1;
          t.props.some(
            (r) =>
              r.type === 6 &&
              r.name === "encoding" &&
              r.value != null &&
              (r.value.content === "text/html" || r.value.content === "application/xhtml+xml")
          ) && (s = 0);
        } else /^m(?:[ions]|text)$/.test(t.tag) && e !== "mglyph" && e !== "malignmark" && (s = 0);
      else
        t &&
          s === 1 &&
          (t.tag === "foreignObject" || t.tag === "desc" || t.tag === "title") &&
          (s = 0);
      if (s === 0) {
        if (e === "svg") return 1;
        if (e === "math") return 2;
      }
      return s;
    },
  },
  eb = (e) => {
    e.type === 1 &&
      e.props.forEach((t, n) => {
        t.type === 6 &&
          t.name === "style" &&
          t.value &&
          (e.props[n] = {
            type: 7,
            name: "bind",
            arg: ie("style", !0, t.loc),
            exp: tb(t.value.content, t.loc),
            modifiers: [],
            loc: t.loc,
          });
      });
  },
  tb = (e, t) => {
    const n = xu(e);
    return ie(JSON.stringify(n), !1, t, 3);
  };
function An(e, t) {
  return Ce(e, t);
}
const nb = (e, t, n) => {
    const { exp: s, loc: r } = e;
    return (
      s || n.onError(An(54, r)),
      t.children.length && (n.onError(An(55, r)), (t.children.length = 0)),
      { props: [Fe(ie("innerHTML", !0, r), s || ie("", !0))] }
    );
  },
  sb = (e, t, n) => {
    const { exp: s, loc: r } = e;
    return (
      s || n.onError(An(56, r)),
      t.children.length && (n.onError(An(57, r)), (t.children.length = 0)),
      {
        props: [
          Fe(
            ie("textContent", !0),
            s ? (_t(s, n) > 0 ? s : $e(n.helperString(oo), [s], r)) : ie("", !0)
          ),
        ],
      }
    );
  },
  rb = (e, t, n) => {
    const s = dd(e, t, n);
    if (!s.props.length || t.tagType === 1) return s;
    e.arg && n.onError(An(59, e.arg.loc));
    const { tag: r } = t,
      i = n.isCustomElement(r);
    if (r === "input" || r === "textarea" || r === "select" || i) {
      let o = gd,
        l = !1;
      if (r === "input" || i) {
        const c = lo(t, "type");
        if (c) {
          if (c.type === 7) o = fl;
          else if (c.value)
            switch (c.value.content) {
              case "radio":
                o = pd;
                break;
              case "checkbox":
                o = md;
                break;
              case "file":
                (l = !0), n.onError(An(60, e.loc));
                break;
            }
        } else Hv(t) && (o = fl);
      } else r === "select" && (o = yd);
      l || (s.needRuntime = n.helper(o));
    } else n.onError(An(58, e.loc));
    return (
      (s.props = s.props.filter((o) => !(o.key.type === 4 && o.key.content === "modelValue"))), s
    );
  },
  ib = Et("passive,once,capture"),
  ob = Et("stop,prevent,self,ctrl,shift,alt,meta,exact,middle"),
  lb = Et("left,right"),
  Td = Et("onkeyup,onkeydown,onkeypress"),
  cb = (e, t, n, s) => {
    const r = [],
      i = [],
      o = [];
    for (let l = 0; l < t.length; l++) {
      const c = t[l].content;
      (c === "native" && Sr("COMPILER_V_ON_NATIVE", n)) || ib(c)
        ? o.push(c)
        : lb(c)
          ? pt(e)
            ? Td(e.content.toLowerCase())
              ? r.push(c)
              : i.push(c)
            : (r.push(c), i.push(c))
          : ob(c)
            ? i.push(c)
            : r.push(c);
    }
    return { keyModifiers: r, nonKeyModifiers: i, eventOptionModifiers: o };
  },
  qa = (e, t) =>
    pt(e) && e.content.toLowerCase() === "onclick"
      ? ie(t, !0)
      : e.type !== 4
        ? Ft(["(", e, `) === "onClick" ? "${t}" : (`, e, ")"])
        : e,
  ab = (e, t, n) =>
    hd(e, t, n, (s) => {
      const { modifiers: r } = e;
      if (!r.length) return s;
      let { key: i, value: o } = s.props[0];
      const { keyModifiers: l, nonKeyModifiers: c, eventOptionModifiers: u } = cb(i, r, n, e.loc);
      if (
        (c.includes("right") && (i = qa(i, "onContextmenu")),
        c.includes("middle") && (i = qa(i, "onMouseup")),
        c.length && (o = $e(n.helper(vd), [o, JSON.stringify(c)])),
        l.length &&
          (!pt(i) || Td(i.content.toLowerCase())) &&
          (o = $e(n.helper(bd), [o, JSON.stringify(l)])),
        u.length)
      ) {
        const a = u.map(es).join("");
        i = pt(i) ? ie(`${i.content}${a}`, !0) : Ft(["(", i, `) + "${a}"`]);
      }
      return { props: [Fe(i, o)] };
    }),
  ub = (e, t, n) => {
    const { exp: s, loc: r } = e;
    return s || n.onError(An(62, r)), { props: [], needRuntime: n.helper(_d) };
  },
  fb = (e, t) => {
    e.type === 1 && e.tagType === 0 && (e.tag === "script" || e.tag === "style") && t.removeNode();
  },
  hb = [eb],
  db = { cloak: X0, html: nb, text: sb, model: rb, on: ab, show: ub };
function pb(e, t = {}) {
  return J0(
    e,
    ce({}, Q0, t, {
      nodeTransforms: [fb, ...hb, ...(t.nodeTransforms || [])],
      directiveTransforms: ce({}, db, t.directiveTransforms || {}),
      transformHoist: null,
    })
  );
}
/**
 * vue v3.5.34
 * (c) 2018-present Yuxi (Evan) You and Vue contributors
 * @license MIT
 **/ const Ga = Object.create(null);
function mb(e, t) {
  if (!ne(e))
    if (e.nodeType) e = e.innerHTML;
    else return Je;
  const n = Lp(e, t),
    s = Ga[n];
  if (s) return s;
  if (e[0] === "#") {
    const l = document.querySelector(e);
    e = l ? l.innerHTML : "";
  }
  const r = ce({ hoistStatic: !0, onError: void 0, onWarn: Je }, t);
  !r.isCustomElement &&
    typeof customElements < "u" &&
    (r.isCustomElement = (l) => !!customElements.get(l));
  const { code: i } = pb(e, r),
    o = new Function("Vue", i)(Ev);
  return (o._rc = !0), (Ga[n] = o);
}
ih(mb);
/*!
 * vue-router v4.6.4
 * (c) 2025 Eduardo San Martin Morote
 * @license MIT
 */ const us = typeof document < "u";
function wd(e) {
  return typeof e == "object" || "displayName" in e || "props" in e || "__vccOpts" in e;
}
function gb(e) {
  return e.__esModule || e[Symbol.toStringTag] === "Module" || (e.default && wd(e.default));
}
const be = Object.assign;
function xo(e, t) {
  const n = {};
  for (const s in t) {
    const r = t[s];
    n[s] = Vt(r) ? r.map(e) : e(r);
  }
  return n;
}
const tr = () => {},
  Vt = Array.isArray;
function za(e, t) {
  const n = {};
  for (const s in e) n[s] = s in t ? t[s] : e[s];
  return n;
}
const Cd = /#/g,
  yb = /&/g,
  vb = /\//g,
  bb = /=/g,
  b = /\?/g,
  Ad = /\+/g,
  Sb = /%5B/g,
  Eb = /%5D/g,
  Od = /%5E/g,
  Tb = /%60/g,
  Nd = /%7B/g,
  wb = /%7C/g,
  xd = /%7D/g,
  Cb = /%20/g;
function Ec(e) {
  return e == null
    ? ""
    : encodeURI(`${  e}`)
        .replace(wb, "|")
        .replace(Sb, "[")
        .replace(Eb, "]");
}
function Ab(e) {
  return Ec(e).replace(Nd, "{").replace(xd, "}").replace(Od, "^");
}
function hl(e) {
  return Ec(e)
    .replace(Ad, "%2B")
    .replace(Cb, "+")
    .replace(Cd, "%23")
    .replace(yb, "%26")
    .replace(Tb, "`")
    .replace(Nd, "{")
    .replace(xd, "}")
    .replace(Od, "^");
}
function Ob(e) {
  return hl(e).replace(bb, "%3D");
}
function Nb(e) {
  return Ec(e).replace(Cd, "%23").replace(_b, "%3F");
}
function xb(e) {
  return Nb(e).replace(vb, "%2F");
}
function wr(e) {
  if (e == null) return null;
  try {
    return decodeURIComponent(`${  e}`);
  } catch {}
  return `${  e}`;
}
const Rb = /\/$/,
  Ib = (e) => e.replace(Rb, "");
function Ro(e, t, n = "/") {
  let s,
    r = {},
    i = "",
    o = "";
  const l = t.indexOf("#");
  let c = t.indexOf("?");
  return (
    (c = l >= 0 && c > l ? -1 : c),
    c >= 0 && ((s = t.slice(0, c)), (i = t.slice(c, l > 0 ? l : t.length)), (r = e(i.slice(1)))),
    l >= 0 && ((s = s || t.slice(0, l)), (o = t.slice(l, t.length))),
    (s = Db(s ?? t, n)),
    { fullPath: s + i + o, path: s, query: r, hash: wr(o) }
  );
}
function Pb(e, t) {
  const n = t.query ? e(t.query) : "";
  return t.path + (n && "?") + n + (t.hash || "");
}
function Ya(e, t) {
  return !t || !e.toLowerCase().startsWith(t.toLowerCase()) ? e : e.slice(t.length) || "/";
}
function Mb(e, t, n) {
  const s = t.matched.length - 1,
    r = n.matched.length - 1;
  return (
    s > -1 &&
    s === r &&
    Ms(t.matched[s], n.matched[r]) &&
    Rd(t.params, n.params) &&
    e(t.query) === e(n.query) &&
    t.hash === n.hash
  );
}
function Ms(e, t) {
  return (e.aliasOf || e) === (t.aliasOf || t);
}
function Rd(e, t) {
  if (Object.keys(e).length !== Object.keys(t).length) return !1;
  for (const n in e) if (!kb(e[n], t[n])) return !1;
  return !0;
}
function kb(e, t) {
  return Vt(e)
    ? Ja(e, t)
    : Vt(t)
      ? Ja(t, e)
      : (e == null ? void 0 : e.valueOf()) === (t == null ? void 0 : t.valueOf());
}
function Ja(e, t) {
  return Vt(t)
    ? e.length === t.length && e.every((n, s) => n === t[s])
    : e.length === 1 && e[0] === t;
}
function Db(e, t) {
  if (e.startsWith("/")) return e;
  if (!e) return t;
  const n = t.split("/"),
    s = e.split("/"),
    r = s[s.length - 1];
  (r === ".." || r === ".") && s.push("");
  let i = n.length - 1,
    o,
    l;
  for (o = 0; o < s.length; o++)
    if (((l = s[o]), l !== "."))
      if (l === "..") i > 1 && i--;
      else break;
  return `${n.slice(0, i).join("/")  }/${  s.slice(o).join("/")}`;
}
const yn = {
  path: "/",
  name: void 0,
  params: {},
  query: {},
  hash: "",
  fullPath: "/",
  matched: [],
  meta: {},
  redirectedFrom: void 0,
};
const dl = (function (e) {
    return (e.pop = "pop"), (e.push = "push"), e;
  })({}),
  Io = (function (e) {
    return (e.back = "back"), (e.forward = "forward"), (e.unknown = ""), e;
  })({});
function Fb(e) {
  if (!e)
    if (us) {
      const t = document.querySelector("base");
      (e = (t && t.getAttribute("href")) || "/"), (e = e.replace(/^\w+:\/\/[^\/]+/, ""));
    } else e = "/";
  return e[0] !== "/" && e[0] !== "#" && (e = `/${  e}`), Ib(e);
}
const Lb = /^[^#]+#/;
function Vb(e, t) {
  return e.replace(Lb, "#") + t;
}
function Bb(e, t) {
  const n = document.documentElement.getBoundingClientRect(),
    s = e.getBoundingClientRect();
  return {
    behavior: t.behavior,
    left: s.left - n.left - (t.left || 0),
    top: s.top - n.top - (t.top || 0),
  };
}
const uo = () => ({ left: window.scrollX, top: window.scrollY });
function Hb(e) {
  let t;
  if ("el" in e) {
    const n = e.el,
      s = typeof n == "string" && n.startsWith("#"),
      r =
        typeof n == "string"
          ? s
            ? document.getElementById(n.slice(1))
            : document.querySelector(n)
          : n;
    if (!r) return;
    t = Bb(r, e);
  } else t = e;
  "scrollBehavior" in document.documentElement.style
    ? window.scrollTo(t)
    : window.scrollTo(
        t.left != null ? t.left : window.scrollX,
        t.top != null ? t.top : window.scrollY
      );
}
function Xa(e, t) {
  return (history.state ? history.state.position - t : -1) + e;
}
const pl = new Map();
function jb(e, t) {
  pl.set(e, t);
}
function $b(e) {
  const t = pl.get(e);
  return pl.delete(e), t;
}
function Ub(e) {
  return typeof e == "string" || (e && typeof e == "object");
}
function Id(e) {
  return typeof e == "string" || typeof e == "symbol";
}
const xe = (function (e) {
  return (
    (e[(e.MATCHER_NOT_FOUND = 1)] = "MATCHER_NOT_FOUND"),
    (e[(e.NAVIGATION_GUARD_REDIRECT = 2)] = "NAVIGATION_GUARD_REDIRECT"),
    (e[(e.NAVIGATION_ABORTED = 4)] = "NAVIGATION_ABORTED"),
    (e[(e.NAVIGATION_CANCELLED = 8)] = "NAVIGATION_CANCELLED"),
    (e[(e.NAVIGATION_DUPLICATED = 16)] = "NAVIGATION_DUPLICATED"),
    e
  );
})({});
const Pd = Symbol("");
`${xe.MATCHER_NOT_FOUND  }`,
  `${xe.NAVIGATION_GUARD_REDIRECT  }`,
  `${xe.NAVIGATION_ABORTED  }`,
  `${xe.NAVIGATION_CANCELLED  }`,
  `${xe.NAVIGATION_DUPLICATED  }`;
function ks(e, t) {
  return be(new Error(), { type: e, [Pd]: !0 }, t);
}
function Jt(e, t) {
  return e instanceof Error && Pd in e && (t == null || !!(e.type & t));
}
const Wb = ["params", "query", "hash"];
function Kb(e) {
  if (typeof e == "string") return e;
  if (e.path != null) return e.path;
  const t = {};
  for (const n of Wb) n in e && (t[n] = e[n]);
  return JSON.stringify(t, null, 2);
}
function qb(e) {
  const t = {};
  if (e === "" || e === "?") return t;
  const n = (e[0] === "?" ? e.slice(1) : e).split("&");
  for (let s = 0; s < n.length; ++s) {
    const r = n[s].replace(Ad, " "),
      i = r.indexOf("="),
      o = wr(i < 0 ? r : r.slice(0, i)),
      l = i < 0 ? null : wr(r.slice(i + 1));
    if (o in t) {
      let c = t[o];
      Vt(c) || (c = t[o] = [c]), c.push(l);
    } else t[o] = l;
  }
  return t;
}
function Za(e) {
  let t = "";
  for (let n in e) {
    const s = e[n];
    if (((n = Ob(n)), s == null)) {
      s !== void 0 && (t += (t.length ? "&" : "") + n);
      continue;
    }
    (Vt(s) ? s.map((r) => r && hl(r)) : [s && hl(s)]).forEach((r) => {
      r !== void 0 && ((t += (t.length ? "&" : "") + n), r != null && (t += `=${  r}`));
    });
  }
  return t;
}
function Gb(e) {
  const t = {};
  for (const n in e) {
    const s = e[n];
    s !== void 0 &&
      (t[n] = Vt(s) ? s.map((r) => (r == null ? null : `${  r}`)) : s == null ? s : `${  s}`);
  }
  return t;
}
const zb = Symbol(""),
  Qa = Symbol(""),
  fo = Symbol(""),
  Tc = Symbol(""),
  ml = Symbol("");
function Ws() {
  let e = [];
  function t(s) {
    return (
      e.push(s),
      () => {
        const r = e.indexOf(s);
        r > -1 && e.splice(r, 1);
      }
    );
  }
  function n() {
    e = [];
  }
  return { add: t, list: () => e.slice(), reset: n };
}
function Tn(e, t, n, s, r, i = (o) => o()) {
  const o = s && (s.enterCallbacks[r] = s.enterCallbacks[r] || []);
  return () =>
    new Promise((l, c) => {
      const u = (d) => {
          d === !1
            ? c(ks(xe.NAVIGATION_ABORTED, { from: n, to: t }))
            : d instanceof Error
              ? c(d)
              : Ub(d)
                ? c(ks(xe.NAVIGATION_GUARD_REDIRECT, { from: t, to: d }))
                : (o && s.enterCallbacks[r] === o && typeof d == "function" && o.push(d), l());
        },
        a = i(() => e.call(s && s.instances[r], t, n, u));
      let f = Promise.resolve(a);
      e.length < 3 && (f = f.then(u)), f.catch((d) => c(d));
    });
}
function Po(e, t, n, s, r = (i) => i()) {
  const i = [];
  for (const o of e)
    for (const l in o.components) {
      const c = o.components[l];
      if (!(t !== "beforeRouteEnter" && !o.instances[l]))
        if (wd(c)) {
          const u = (c.__vccOpts || c)[t];
          u && i.push(Tn(u, n, s, o, l, r));
        } else {
          const u = c();
          i.push(() =>
            u.then((a) => {
              if (!a) throw new Error(`Couldn't resolve component "${l}" at "${o.path}"`);
              const f = gb(a) ? a.default : a;
              (o.mods[l] = a), (o.components[l] = f);
              const d = (f.__vccOpts || f)[t];
              return d && Tn(d, n, s, o, l, r)();
            })
          );
        }
    }
  return i;
}
function Yb(e, t) {
  const n = [],
    s = [],
    r = [],
    i = Math.max(t.matched.length, e.matched.length);
  for (let o = 0; o < i; o++) {
    const l = t.matched[o];
    l && (e.matched.find((u) => Ms(u, l)) ? s.push(l) : n.push(l));
    const c = e.matched[o];
    c && (t.matched.find((u) => Ms(u, c)) || r.push(c));
  }
  return [n, s, r];
}
/*!
 * vue-router v4.6.4
 * (c) 2025 Eduardo San Martin Morote
 * @license MIT
 */const Jb=()=>`${location.protocol}//${location.host}`;function Md(e,t){const{pathname:n,search:s,hash:r}=t,i=e.indexOf("#");if(i>-1){let o=r.includes(e.slice(i))?e.slice(i).length:1,l=r.slice(o);return l[0]!=="/"&&(l=`/${l}`),Ya(l,"")}return Ya(n,e)+s+r}function Xb(e,t,n,s){let r=[],i=[],o=null;const l=({state:d})=>{const h=Md(e,location),m=n.value,v=t.value;let _=0;if(d){if(n.value=h,t.value=d,o&&o===m){o=null;return}_=v?d.position-v.position:0}else s(h);r.forEach(S=>{S(n.value,m,{delta:_,type:dl.pop,direction:_?_>0?Io.forward:Io.back:Io.unknown})})};function c(){o=n.value}function u(d){r.push(d);const h=()=>{const m=r.indexOf(d);m>-1&&r.splice(m,1)};return i.push(h),h}function a(){if(document.visibilityState==="hidden"){const{history:d}=window;if(!d.state)return;d.replaceState(be({},d.state,{scroll:uo()}),"")}}function f(){for(const d of i)d();i=[],window.removeEventListener("popstate",l),window.removeEventListener("pagehide",a),document.removeEventListener("visibilitychange",a)}return window.addEventListener("popstate",l),window.addEventListener("pagehide",a),document.addEventListener("visibilitychange",a),{pauseListeners:c,listen:u,destroy:f}}function eu(e,t,n,s=!1,r=!1){return{back:e,current:t,forward:n,replaced:s,position:window.history.length,scroll:r?uo():null}}function Zb(e){const{history:t,location:n}=window,s={value:Md(e,n)},r={value:t.state};r.value||i(s.value,{back:null,current:s.value,forward:null,position:t.length-1,replaced:!0,scroll:null},!0);function i(c,u,a){const f=e.indexOf("#"),d=f>-1?(n.host&&document.querySelector("base")?e:e.slice(f))+c:Jb()+e+c;try{t[a?"replaceState":"pushState"](u,"",d),r.value=u}catch(h){console.error(h),n[a?"replace":"assign"](d)}}function o(c,u){i(c,be({},t.state,eu(r.value.back,c,r.value.forward,!0),u,{position:r.value.position}),!0),s.value=c}function l(c,u){const a=be({},r.value,t.state,{forward:c,scroll:uo()});i(a.current,a,!0),i(c,be({},eu(s.value,c,null),{position:a.position+1},u),!1),s.value=c}return{location:s,state:r,push:l,replace:o}}function s1(e){e=Fb(e);const t=Zb(e),n=Xb(e,t.state,t.location,t.replace);function s(i,o=!0){o||n.pauseListeners(),history.go(i)}const r=be({location:"",base:e,go:s,createHref:Vb.bind(null,e)},t,n);return Object.defineProperty(r,"location",{enumerable:!0,get:()=>t.location.value}),Object.defineProperty(r,"state",{enumerable:!0,get:()=>t.state.value}),r}const $n=(function(e){return e[e.Static=0]="Static",e[e.Param=1]="Param",e[e.Group=2]="Group",e})({});var He=(function(e){return e[e.Static=0]="Static",e[e.Param=1]="Param",e[e.ParamRegExp=2]="ParamRegExp",e[e.ParamRegExpEnd=3]="ParamRegExpEnd",e[e.EscapeNext=4]="EscapeNext",e})(He||{});const Qb={type:$n.Static,value:""},e_=/[a-zA-Z0-9_]/;function t_(e){if(!e)return[[]];if(e==="/")return[[Qb]];if(!e.startsWith("/"))throw new Error(`Invalid path "${e}"`);function t(h){throw new Error(`ERR (${n})/"${u}": ${h}`)}let n=He.Static,s=n;const r=[];let i;function o(){i&&r.push(i),i=[]}let l=0,c,u="",a="";function f(){u&&(n===He.Static?i.push({type:$n.Static,value:u}):n===He.Param||n===He.ParamRegExp||n===He.ParamRegExpEnd?(i.length>1&&(c==="*"||c==="+")&&t(`A repeatable param (${u}) must be alone in its segment. eg: '/:ids+.`),i.push({type:$n.Param,value:u,regexp:a,repeatable:c==="*"||c==="+",optional:c==="*"||c==="?"})):t("Invalid state to consume buffer"),u="")}function d(){u+=c}for(;l<e.length;){if(c=e[l++],c==="\\"&&n!==He.ParamRegExp){s=n,n=He.EscapeNext;continue}switch(n){case He.Static:c==="/"?(u&&f(),o()):c===":"?(f(),n=He.Param):d();break;case He.EscapeNext:d(),n=s;break;case He.Param:c==="("?n=He.ParamRegExp:e_.test(c)?d():(f(),n=He.Static,c!=="*"&&c!=="?"&&c!=="+"&&l--);break;case He.ParamRegExp:c===")"?a[a.length-1]=="\\"?a=a.slice(0,-1)+c:n=He.ParamRegExpEnd:a+=c;break;case He.ParamRegExpEnd:f(),n=He.Static,c!=="*"&&c!=="?"&&c!=="+"&&l--,a="";break;default:t("Unknown state");break}}return n===He.ParamRegExp&&t(`Unfinished custom RegExp for param "${u}"`),f(),o(),r}const tu="[^/]+?",n_={sensitive:!1,strict:!1,start:!0,end:!0};var rt=(function(e){return e[e._multiplier=10]="_multiplier",e[e.Root=90]="Root",e[e.Segment=40]="Segment",e[e.SubSegment=30]="SubSegment",e[e.Static=40]="Static",e[e.Dynamic=20]="Dynamic",e[e.BonusCustomRegExp=10]="BonusCustomRegExp",e[e.BonusWildcard=-50]="BonusWildcard",e[e.BonusRepeatable=-20]="BonusRepeatable",e[e.BonusOptional=-8]="BonusOptional",e[e.BonusStrict=.7000000000000001]="BonusStrict",e[e.BonusCaseSensitive=.25]="BonusCaseSensitive",e})(rt||{});const s_=/[.+*?^${}()[\]/\\]/g;function r_(e,t){const n=be({},n_,t),s=[];let r=n.start?"^":"";const i=[];for(const u of e){const a=u.length?[]:[rt.Root];n.strict&&!u.length&&(r+="/");for(let f=0;f<u.length;f++){const d=u[f];let h=rt.Segment+(n.sensitive?rt.BonusCaseSensitive:0);if(d.type===$n.Static)f||(r+="/"),r+=d.value.replace(s_,"\\$&"),h+=rt.Static;else if(d.type===$n.Param){const{value:m,repeatable:v,optional:_,regexp:S}=d;i.push({name:m,repeatable:v,optional:_});const g=S||tu;if(g!==tu){h+=rt.BonusCustomRegExp;try{`${g}`}catch(b){throw new Error(`Invalid custom RegExp for param "${m}" (${g}): ${b.message}`)}}let p=v?`((?:${g})(?:/(?:${g}))*)`:`(${g})`;f||(p=_&&u.length<2?`(?:/${p})`:`/${p}`),_&&(p+="?"),r+=p,h+=rt.Dynamic,_&&(h+=rt.BonusOptional),v&&(h+=rt.BonusRepeatable),g===".*"&&(h+=rt.BonusWildcard)}a.push(h)}s.push(a)}if(n.strict&&n.end){const u=s.length-1;s[u][s[u].length-1]+=rt.BonusStrict}n.strict||(r+="/?"),n.end?r+="$":n.strict&&!r.endsWith("/")&&(r+="(?:/|$)");const o=new RegExp(r,n.sensitive?"":"i");function l(u){const a=u.match(o),f={};if(!a)return null;for(let d=1;d<a.length;d++){const h=a[d]||"",m=i[d-1];f[m.name]=h&&m.repeatable?h.split("/"):h}return f}function c(u){let a="",f=!1;for(const d of e){(!f||!a.endsWith("/"))&&(a+="/"),f=!1;for(const h of d)if(h.type===$n.Static)a+=h.value;else if(h.type===$n.Param){const{value:m,repeatable:v,optional:_}=h,S=m in u?u[m]:"";if(Vt(S)&&!v)throw new Error(`Provided param "${m}" is an array but it is not repeatable (* or + modifiers)`);const g=Vt(S)?S.join("/"):S;if(!g)if(_)d.length<2&&(a.endsWith("/")?a=a.slice(0,-1):f=!0);else throw new Error(`Missing required param "${m}"`);a+=g}}return a||"/"}return{re:o,score:s,keys:i,parse:l,stringify:c}}function i_(e,t){let n=0;for(;n<e.length&&n<t.length;){const s=t[n]-e[n];if(s)return s;n++}return e.length<t.length?e.length===1&&e[0]===rt.Static+rt.Segment?-1:1:e.length>t.length?t.length===1&&t[0]===rt.Static+rt.Segment?1:-1:0}function kd(e,t){let n=0;const s=e.score,r=t.score;for(;n<s.length&&n<r.length;){const i=i_(s[n],r[n]);if(i)return i;n++}if(Math.abs(r.length-s.length)===1){if(nu(s))return 1;if(nu(r))return-1}return r.length-s.length}function nu(e){const t=e[e.length-1];return e.length>0&&t[t.length-1]<0}const o_={strict:!1,end:!0,sensitive:!1};function l_(e,t,n){const s=r_(t_(e.path),n),r=be(s,{record:e,parent:t,children:[],alias:[]});return t&&!r.record.aliasOf==!t.record.aliasOf&&t.children.push(r),r}function c_(e,t){const n=[],s=new Map;t=za(o_,t);function r(f){return s.get(f)}function i(f,d,h){const m=!h,v=ru(f);v.aliasOf=h&&h.record;const _=za(t,f),S=[v];if("alias"in f){const b=typeof f.alias=="string"?[f.alias]:f.alias;for(const T of b)S.push(ru(be({},v,{components:h?h.record.components:v.components,path:T,aliasOf:h?h.record:v})))}let g,p;for(const b of S){const{path:T}=b;if(d&&T[0]!=="/"){const R=d.record.path,C=R[R.length-1]==="/"?"":"/";b.path=d.record.path+(T&&C+T)}if(g=l_(b,d,_),h?h.alias.push(g):(p=p||g,p!==g&&p.alias.push(g),m&&f.name&&!iu(g)&&o(f.name)),Dd(g)&&c(g),v.children){const R=v.children;for(let C=0;C<R.length;C++)i(R[C],g,h&&h.children[C])}h=h||g}return p?()=>{o(p)}:tr}function o(f){if(Id(f)){const d=s.get(f);d&&(s.delete(f),n.splice(n.indexOf(d),1),d.children.forEach(o),d.alias.forEach(o))}else{const d=n.indexOf(f);d>-1&&(n.splice(d,1),f.record.name&&s.delete(f.record.name),f.children.forEach(o),f.alias.forEach(o))}}function l(){return n}function c(f){const d=f_(f,n);n.splice(d,0,f),f.record.name&&!iu(f)&&s.set(f.record.name,f)}function u(f,d){let h,m={},v,_;if("name"in f&&f.name){if(h=s.get(f.name),!h)throw ks(xe.MATCHER_NOT_FOUND,{location:f});_=h.record.name,m=be(su(d.params,h.keys.filter(p=>!p.optional).concat(h.parent?h.parent.keys.filter(p=>p.optional):[]).map(p=>p.name)),f.params&&su(f.params,h.keys.map(p=>p.name))),v=h.stringify(m)}else if(f.path!=null)v=f.path,h=n.find(p=>p.re.test(v)),h&&(m=h.parse(v),_=h.record.name);else{if(h=d.name?s.get(d.name):n.find(p=>p.re.test(d.path)),!h)throw ks(xe.MATCHER_NOT_FOUND,{location:f,currentLocation:d});_=h.record.name,m=be({},d.params,f.params),v=h.stringify(m)}const S=[];let g=h;for(;g;)S.unshift(g.record),g=g.parent;return{name:_,path:v,params:m,matched:S,meta:u_(S)}}e.forEach(f=>i(f));function a(){n.length=0,s.clear()}return{addRoute:i,resolve:u,removeRoute:o,clearRoutes:a,getRoutes:l,getRecordMatcher:r}}function su(e,t){const n={};for(const s of t)s in e&&(n[s]=e[s]);return n}function ru(e){const t={path:e.path,redirect:e.redirect,name:e.name,meta:e.meta||{},aliasOf:e.aliasOf,beforeEnter:e.beforeEnter,props:a_(e),children:e.children||[],instances:{},leaveGuards:new Set,updateGuards:new Set,enterCallbacks:{},components:"components"in e?e.components||null:e.component&&{default:e.component}};return Object.defineProperty(t,"mods",{value:{}}),t}function a_(e){const t={},n=e.props||!1;if("component"in e)t.default=n;else for(const s in e.components)t[s]=typeof n=="object"?n[s]:n;return t}function iu(e){for(;e;){if(e.record.aliasOf)return!0;e=e.parent}return!1}function u_(e){return e.reduce((t,n)=>be(t,n.meta),{})}function f_(e,t){let n=0,s=t.length;for(;n!==s;){const i=n+s>>1;kd(e,t[i])<0?s=i:n=i+1}const r=h_(e);return r&&(s=t.lastIndexOf(r,s-1)),s}function h_(e){let t=e;for(;t=t.parent;)if(Dd(t)&&kd(e,t)===0)return t}function Dd({record:e}){return!!(e.name||e.components&&Object.keys(e.components).length||e.redirect)}function ou(e){const t=St(fo),n=St(Tc),s=oe(()=>{const c=Ke(e.to);return t.resolve(c)}),r=oe(()=>{const{matched:c}=s.value,{length:u}=c,a=c[u-1],f=n.matched;if(!a||!f.length)return-1;const d=f.findIndex(Ms.bind(null,a));if(d>-1)return d;const h=lu(c[u-2]);return u>1&&lu(a)===h&&f[f.length-1].path!==h?f.findIndex(Ms.bind(null,c[u-2])):d}),i=oe(()=>r.value>-1&&y_(n.params,s.value.params)),o=oe(()=>r.value>-1&&r.value===n.matched.length-1&&Rd(n.params,s.value.params));function l(c={}){if(g_(c)){const u=t[Ke(e.replace)?"replace":"push"](Ke(e.to)).catch(tr);return e.viewTransition&&typeof document<"u"&&"startViewTransition"in document&&document.startViewTransition(()=>u),u}return Promise.resolve()}return{route:s,href:oe(()=>s.value.href),isActive:i,isExactActive:o,navigate:l}}function d_(e){return e.length===1?e[0]:e}const p_=Ir({name:"RouterLink",compatConfig:{MODE:3},props:{to:{type:[String,Object],required:!0},replace:Boolean,activeClass:String,exactActiveClass:String,custom:Boolean,ariaCurrentValue:{type:String,default:"page"},viewTransition:Boolean},useLink:ou,setup(e,{slots:t}){const n=gt(ou(e)),{options:s}=St(fo),r=oe(()=>({[cu(e.activeClass,s.linkActiveClass,"router-link-active")]:n.isActive,[cu(e.exactActiveClass,s.linkExactActiveClass,"router-link-exact-active")]:n.isExactActive}));return()=>{const i=t.default&&d_(t.default(n));return e.custom?i:ro("a",{"aria-current":n.isExactActive?e.ariaCurrentValue:null,href:n.href,onClick:n.navigate,class:r.value},i)}}}),m_=p_;function g_(e){if(!(e.metaKey||e.altKey||e.ctrlKey||e.shiftKey)&&!e.defaultPrevented&&!(e.button!==void 0&&e.button!==0)){if(e.currentTarget&&e.currentTarget.getAttribute){const t=e.currentTarget.getAttribute("target");if(/\b_blank\b/i.test(t))return}return e.preventDefault&&e.preventDefault(),!0}}function y_(e,t){for(const n in t){const s=t[n],r=e[n];if(typeof s=="string"){if(s!==r)return!1}else if(!Vt(r)||r.length!==s.length||s.some((i,o)=>i.valueOf()!==r[o].valueOf()))return!1}return!0}function lu(e){return e?e.aliasOf?e.aliasOf.path:e.path:""}const cu=(e,t,n)=>e??t??n,v_=Ir({name:"RouterView",inheritAttrs:!1,props:{name:{type:String,default:"default"},route:Object},compatConfig:{MODE:3},setup(e,{attrs:t,slots:n}){const s=St(ml),r=oe(()=>e.route||s.value),i=St(Qa,0),o=oe(()=>{let u=Ke(i);const{matched:a}=r.value;let f;for(;(f=a[u])&&!f.components;)u++;return u}),l=oe(()=>r.value.matched[o.value]);vs(Qa,oe(()=>o.value+1)),vs(zb,l),vs(ml,r);const c=Le();return de(()=>[c.value,l.value,e.name],([u,a,f],[d,h,m])=>{a&&(a.instances[f]=u,h&&h!==a&&u&&u===d&&(a.leaveGuards.size||(a.leaveGuards=h.leaveGuards),a.updateGuards.size||(a.updateGuards=h.updateGuards))),u&&a&&(!h||!Ms(a,h)||!d)&&(a.enterCallbacks[f]||[]).forEach(v=>v(u))},{flush:"post"}),()=>{const u=r.value,a=e.name,f=l.value,d=f&&f.components[a];if(!d)return au(n.default,{Component:d,route:u});const h=f.props[a],m=h?h===!0?u.params:typeof h=="function"?h(u):h:null,_=ro(d,be({},m,t,{onVnodeUnmounted:S=>{S.component.isUnmounted&&(f.instances[a]=null)},ref:c}));return au(n.default,{Component:_,route:u})||_}}});function au(e,t){if(!e)return null;const n=e(t);return n.length===1?n[0]:n}const b_=v_;function r1(e){const t=c_(e.routes,e),n=e.parseQuery||qb,s=e.stringifyQuery||Za,r=e.history,i=Ws(),o=Ws(),l=Ws(),c=te(yn);let u=yn;us&&e.scrollBehavior&&"scrollRestoration"in history&&(history.scrollRestoration="manual");const a=xo.bind(null,M=>`${M}`),f=xo.bind(null,xb),d=xo.bind(null,wr);function h(M,z){let W,X;return Id(M)?(W=t.getRecordMatcher(M),X=z):X=M,t.addRoute(X,W)}function m(M){const z=t.getRecordMatcher(M);z&&t.removeRoute(z)}function v(){return t.getRoutes().map(M=>M.record)}function _(M){return!!t.getRecordMatcher(M)}function S(M,z){if(z=be({},z||c.value),typeof M=="string"){const E=Ro(n,M,z.path),x=t.resolve({path:E.path},z),D=r.createHref(E.fullPath);return be(E,x,{params:d(x.params),hash:wr(E.hash),redirectedFrom:void 0,href:D})}let W;if(M.path!=null)W=be({},M,{path:Ro(n,M.path,z.path).path});else{const E=be({},M.params);for(const x in E)E[x]==null&&delete E[x];W=be({},M,{params:f(E)}),z.params=f(z.params)}const X=t.resolve(W,z),ae=M.hash||"";X.params=a(d(X.params));const Ae=Pb(s,be({},M,{hash:Ab(ae),path:X.path})),y=r.createHref(Ae);return be({fullPath:Ae,hash:ae,query:s===Za?Gb(M.query):M.query||{}},X,{redirectedFrom:void 0,href:y})}function g(M){return typeof M=="string"?Ro(n,M,c.value.path):be({},M)}function p(M,z){if(u!==M)return ks(xe.NAVIGATION_CANCELLED,{from:z,to:M})}function b(M){return C(M)}function T(M){return b(be(g(M),{replace:!0}))}function R(M,z){const W=M.matched[M.matched.length-1];if(W&&W.redirect){const{redirect:X}=W;let ae=typeof X=="function"?X(M,z):X;return typeof ae=="string"&&(ae=ae.includes("?")||ae.includes("#")?ae=g(ae):{path:ae},ae.params={}),be({query:M.query,hash:M.hash,params:ae.path!=null?{}:M.params},ae)}}function C(M,z){const W=u=S(M),X=c.value,ae=M.state,Ae=M.force,y=M.replace===!0,E=R(W,X);if(E)return C(be(g(E),{state:typeof E=="object"?be({},ae,E.state):ae,force:Ae,replace:y}),z||W);const x=W;x.redirectedFrom=z;let D;return!Ae&&Mb(s,X,W)&&(D=ks(xe.NAVIGATION_DUPLICATED,{to:x,from:X}),lt(X,X,!0,!1)),(D?Promise.resolve(D):N(x,X)).catch(I=>Jt(I)?Jt(I,xe.NAVIGATION_GUARD_REDIRECT)?I:ot(I):q(I,x,X)).then(I=>{if(I){if(Jt(I,xe.NAVIGATION_GUARD_REDIRECT))return C(be({replace:y},g(I.to),{state:typeof I.to=="object"?be({},ae,I.to.state):ae,force:Ae}),z||x)}else I=O(x,X,!0,y,ae);return P(x,X,I),I})}function A(M,z){const W=p(M,z);return W?Promise.reject(W):Promise.resolve()}function w(M){const z=rs.values().next().value;return z&&typeof z.runWithContext=="function"?z.runWithContext(M):M()}function N(M,z){let W;const[X,ae,Ae]=Yb(M,z);W=Po(X.reverse(),"beforeRouteLeave",M,z);for(const E of X)E.leaveGuards.forEach(x=>{W.push(Tn(x,M,z))});const y=A.bind(null,M,z);return W.push(y),wt(W).then(()=>{W=[];for(const E of i.list())W.push(Tn(E,M,z));return W.push(y),wt(W)}).then(()=>{W=Po(ae,"beforeRouteUpdate",M,z);for(const E of ae)E.updateGuards.forEach(x=>{W.push(Tn(x,M,z))});return W.push(y),wt(W)}).then(()=>{W=[];for(const E of Ae)if(E.beforeEnter)if(Vt(E.beforeEnter))for(const x of E.beforeEnter)W.push(Tn(x,M,z));else W.push(Tn(E.beforeEnter,M,z));return W.push(y),wt(W)}).then(()=>(M.matched.forEach(E=>E.enterCallbacks={}),W=Po(Ae,"beforeRouteEnter",M,z,w),W.push(y),wt(W))).then(()=>{W=[];for(const E of o.list())W.push(Tn(E,M,z));return W.push(y),wt(W)}).catch(E=>Jt(E,xe.NAVIGATION_CANCELLED)?E:Promise.reject(E))}function P(M,z,W){l.list().forEach(X=>w(()=>X(M,z,W)))}function O(M,z,W,X,ae){const Ae=p(M,z);if(Ae)return Ae;const y=z===yn,E=us?history.state:{};W&&(X||y?r.replace(M.fullPath,be({scroll:y&&E&&E.scroll},ae)):r.push(M.fullPath,ae)),c.value=M,lt(M,z,W,y),ot()}let V;function k(){V||(V=r.listen((M,z,W)=>{if(!Pn.listening)return;const X=S(M),ae=R(X,Pn.currentRoute.value);if(ae){C(be(ae,{replace:!0,force:!0}),X).catch(tr);return}u=X;const Ae=c.value;us&&jb(Xa(Ae.fullPath,W.delta),uo()),N(X,Ae).catch(y=>Jt(y,xe.NAVIGATION_ABORTED|xe.NAVIGATION_CANCELLED)?y:Jt(y,xe.NAVIGATION_GUARD_REDIRECT)?(C(be(g(y.to),{force:!0}),X).then(E=>{Jt(E,xe.NAVIGATION_ABORTED|xe.NAVIGATION_DUPLICATED)&&!W.delta&&W.type===dl.pop&&r.go(-1,!1)}).catch(tr),Promise.reject()):(W.delta&&r.go(-W.delta,!1),q(y,X,Ae))).then(y=>{y=y||O(X,Ae,!1),y&&(W.delta&&!Jt(y,xe.NAVIGATION_CANCELLED)?r.go(-W.delta,!1):W.type===dl.pop&&Jt(y,xe.NAVIGATION_ABORTED|xe.NAVIGATION_DUPLICATED)&&r.go(-1,!1)),P(X,Ae,y)}).catch(tr)}))}let $=Ws(),B=Ws(),J;function q(M,z,W){ot(M);const X=B.list();return X.length?X.forEach(ae=>ae(M,z,W)):console.error(M),Promise.reject(M)}function pe(){return J&&c.value!==yn?Promise.resolve():new Promise((M,z)=>{$.add([M,z])})}function ot(M){return J||(J=!M,k(),$.list().forEach(([z,W])=>M?W(M):z()),$.reset()),M}function lt(M,z,W,X){const{scrollBehavior:ae}=e;if(!us||!ae)return Promise.resolve();const Ae=!W&&$b(Xa(M.fullPath,0))||(X||!W)&&history.state&&history.state.scroll||null;return xn().then(()=>ae(M,z,Ae)).then(y=>y&&Hb(y)).catch(y=>q(y,M,z))}const ct=M=>r.go(M);let ss;const rs=new Set,Pn={currentRoute:c,listening:!0,addRoute:h,removeRoute:m,clearRoutes:t.clearRoutes,hasRoute:_,getRoutes:v,resolve:S,options:e,push:b,replace:T,go:ct,back:()=>ct(-1),forward:()=>ct(1),beforeEach:i.add,beforeResolve:o.add,afterEach:l.add,onError:B.add,isReady:pe,install(M){M.component("RouterLink",m_),M.component("RouterView",b_),M.config.globalProperties.$router=Pn,Object.defineProperty(M.config.globalProperties,"$route",{enumerable:!0,get:()=>Ke(c)}),us&&!ss&&c.value===yn&&(ss=!0,b(r.location).catch(X=>{}));const z={};for(const X in yn)Object.defineProperty(z,X,{get:()=>c.value[X],enumerable:!0});M.provide(fo,Pn),M.provide(Tc,Ml(z)),M.provide(ml,c);const W=M.unmount;rs.add(M),M.unmount=function(){rs.delete(M),rs.size<1&&(u=yn,V&&V(),V=null,c.value=yn,ss=!1,J=!1),W()}}};function wt(M){return M.reduce((z,W)=>z.then(()=>w(W)),Promise.resolve())}return Pn}function i1(){return St(fo)}function o1(e){return St(Tc)}function Bt(e){return xl()?(Du(e),!0):!1}const Es=new WeakMap,_=(...e)=>{let t;const n=e[0],s=(t=Ve())==null?void 0:t.proxy;if(s==null&&!Ll())throw new Error("injectLocal must be called in setup");return s&&Es.has(s)&&n in Es.get(s)?Es.get(s)[n]:St(...e)};function l1(e,t){let n;const s=(n=Ve())==null?void 0:n.proxy;if(s==null)throw new Error("provideLocal must be called in setup");Es.has(s)||Es.set(s,Object.create(null));const r=Es.get(s);return r[e]=t,vs(e,t)}function c1(e){let t=0,n,s;const r=()=>{t-=1,s&&t<=0&&(s.stop(),n=void 0,s=void 0)};return(...i)=>(t+=1,s||(s=ku(!0),n=s.run(()=>e(...i))),Bt(r),n)}function a1(e){if(!we(e))return gt(e);const t=new Proxy({},{get(n,s,r){return Ke(Reflect.get(e.value,s,r))},set(n,s,r){return we(e.value[s])&&!we(r)?e.value[s].value=r:e.value[s]=r,!0},deleteProperty(n,s){return Reflect.deleteProperty(e.value,s)},has(n,s){return Reflect.has(e.value,s)},ownKeys(){return Object.keys(e.value)},getOwnPropertyDescriptor(){return{enumerable:!0,configurable:!0}}});return gt(t)}const Nn=typeof window<"u"&&typeof document<"u";typeof WorkerGlobalScope<"u"&&globalThis instanceof WorkerGlobalScope;const S_=e=>typeof e<"u",Fd=e=>e!=null,E_=Object.prototype.toString,Fi=e=>E_.call(e)==="[object Object]",u1=()=>+Date.now(),Nt=()=>{},T_=w_();function w_(){let e,t;return Nn&&((e=window==null?void 0:window.navigator)==null?void 0:e.userAgent)&&(/iP(?:ad|hone|od)/.test(window.navigator.userAgent)||((t=window==null?void 0:window.navigator)==null?void 0:t.maxTouchPoints)>2&&/iPad|Macintosh/.test(window==null?void 0:window.navigator.userAgent))}function Ld(...e){if(e.length!==1)return ef(...e);const t=e[0];return typeof t=="function"?kt(Ji(()=>({get:t,set:Nt}))):Le(t)}function Vd(e,t){function n(...s){return new Promise((r,i)=>{Promise.resolve(e(()=>t.apply(this,s),{fn:t,thisArg:this,args:s})).then(r).catch(i)})}return n}const wc=e=>e();function C_(e=wc,t={}){const{initialState:n="active"}=t,s=Ld(n==="active");function r(){s.value=!1}function i(){s.value=!0}return{isActive:kt(s),pause:r,resume:i,eventFilter:(...l)=>{s.value&&e(...l)}}}function A_(e){let t;function n(){return t||(t=e()),t}return n.reset=async()=>{const s=t;t=void 0,s&&await s},n}function O_(e,t){let n;if(typeof e=="number")return e+t;const s=((n=e.match(/^-?\d+\.?\d*/))==null?void 0:n[0])||"",r=e.slice(s.length),i=Number.parseFloat(s)+t;return Number.isNaN(i)?e:i+r}function nr(e){return e.endsWith("rem")?Number.parseFloat(e)*16:Number.parseFloat(e)}function f1(e,t,n=!1){return Object.fromEntries(Object.entries(e).filter(([s,r])=>(!n||r!==void 0)&&!t.includes(s)))}function Ts(e){return Array.isArray(e)?e:[e]}function Bd(e){return Ve()}function N_(e,t,n={}){const{eventFilter:s=wc,...r}=n;return de(e,Vd(s,t),r)}function x_(e,t,n={}){const{eventFilter:s,initialState:r="active",...i}=n,{eventFilter:o,pause:l,resume:c,isActive:u}=C_(s,{initialState:r});return{stop:N_(e,t,{...i,eventFilter:o}),pause:l,resume:c,isActive:u}}function R_(e,t={}){if(!we(e))return Qu(e);const n=Array.isArray(e.value)?Array.from({length:e.value.length}):{};for(const s in e.value)n[s]=Ji(()=>({get(){return e.value[s]},set(r){let i;if((i=re(t.replaceRef))!=null?i:!0)if(Array.isArray(e.value)){const l=[...e.value];l[s]=r,e.value=l}else{const l={...e.value,[s]:r};Object.setPrototypeOf(l,Object.getPrototypeOf(e.value)),e.value=l}else e.value[s]=r}}));return n}function Rn(e,t=!0,n){Bd()?ns(e,n):t?e():xn(e)}function I_(e,t){Bd()&&Mr(e,t)}function P_(e,t=1e3,n={}){const{immediate:s=!0,immediateCallback:r=!1}=n;let i=null;const o=te(!1);function l(){i&&(clearInterval(i),i=null)}function c(){o.value=!1,l()}function u(){const a=re(t);a<=0||(o.value=!0,r&&e(),l(),o.value&&(i=setInterval(e,a)))}if(s&&Nn&&u(),we(t)||typeof t=="function"){const a=de(t,()=>{o.value&&Nn&&u()});Bt(a)}return Bt(c),{isActive:ar(o),pause:c,resume:u}}function h1(e=1e3,t={}){const{controls:n=!1,immediate:s=!0,callback:r}=t,i=te(0),o=()=>i.value+=1,l=()=>{i.value=0},c=P_(r?()=>{o(),r(i.value)}:o,e,{immediate:s});return n?{counter:ar(i),reset:l,...c}:ar(i)}function M_(e,t,n={}){const{immediate:s=!0,immediateCallback:r=!1}=n,i=te(!1);let o;function l(){o&&(clearTimeout(o),o=void 0)}function c(){i.value=!1,l()}function u(...a){r&&e(),l(),i.value=!0,o=setTimeout(()=>{i.value=!1,o=void 0,e(...a)},re(t))}return s&&(i.value=!0,Nn&&u()),Bt(c),{isPending:ar(i),start:u,stop:c}}function d1(e=!1,t={}){const{truthyValue:n=!0,falsyValue:s=!1}=t,r=we(e),i=te(e);function o(l){if(arguments.length)return i.value=l,i.value;{const c=re(n);return i.value=i.value===c?re(s):c,i.value}}return r?o:[i,o]}function p1(e,t,n={}){const{eventFilter:s=wc,...r}=n,i=Vd(s,t);let o,l,c;if(r.flush==="sync"){let u=!1;l=()=>{},o=a=>{u=!0,a(),u=!1},c=de(e,(...a)=>{u||i(...a)},r)}else{const u=[];let a=0,f=0;l=()=>{a=f},u.push(de(e,()=>{f++},{...r,flush:"sync"})),o=d=>{const h=f;d(),a+=f-h},u.push(de(e,(...d)=>{const h=a>0&&a===f;a=0,f=0,!h&&i(...d)},r)),c=()=>{u.forEach(d=>d())}}return{stop:c,ignoreUpdates:o,ignorePrevAsyncUpdates:l}}function k_(e,t,n){return de(e,t,{...n,immediate:!0})}function D_(e,t,n){return de(e,(r,i,o)=>{r&&t(r,i,o)},{...n,once:!1})}const Ue=Nn?window:void 0,ho=Nn?window.document:void 0,Cc=Nn?window.navigator:void 0;function Me(e){let t;const n=re(e);return(t=n==null?void 0:n.$el)!=null?t:n}function se(...e){const t=[],n=()=>{t.forEach(l=>l()),t.length=0},s=(l,c,u,a)=>(l.addEventListener(c,u,a),()=>l.removeEventListener(c,u,a)),r=oe(()=>{const l=Ts(re(e[0])).filter(c=>c!=null);return l.every(c=>typeof c!="string")?l:void 0}),i=k_(()=>{let l,c;return[(c=(l=r.value)==null?void 0:l.map(u=>Me(u)))!=null?c:[Ue].filter(u=>u!=null),Ts(re(r.value?e[1]:e[0])),Ts(Ke(r.value?e[2]:e[1])),re(r.value?e[3]:e[2])]},([l,c,u,a])=>{if(n(),!(l!=null&&l.length)||!(c!=null&&c.length)||!(u!=null&&u.length))return;const f=Fi(a)?{...a}:a;t.push(...l.flatMap(d=>c.flatMap(h=>u.map(m=>s(d,h,m,f)))))},{flush:"post"}),o=()=>{i(),n()};return Bt(n),o}let uu=!1;function m1(e,t,n={}){const{window:s=Ue,ignore:r=[],capture:i=!0,detectIframe:o=!1,controls:l=!1}=n;if(!s)return l?{stop:Nt,cancel:Nt,trigger:Nt}:Nt;if(T_&&!uu){uu=!0;const _={passive:!0};Array.from(s.document.body.children).forEach(S=>S.addEventListener("click",Nt,_)),s.document.documentElement.addEventListener("click",Nt,_)}let c=!0;const u=_=>re(r).some(S=>{if(typeof S=="string")return Array.from(s.document.querySelectorAll(S)).some(g=>g===_.target||_.composedPath().includes(g));{const g=Me(S);return g&&(_.target===g||_.composedPath().includes(g))}});function a(_){const S=re(_);return S&&S.$.subTree.shapeFlag===16}function f(_,S){const g=re(_),p=g.$.subTree&&g.$.subTree.children;return p==null||!Array.isArray(p)?!1:p.some(b=>b.el===S.target||S.composedPath().includes(b.el))}const d=_=>{const S=Me(e);if(_.target!=null&&!(!(S instanceof Element)&&a(e)&&f(e,_))&&!(!S||S===_.target||_.composedPath().includes(S))){if("detail"in _&&_.detail===0&&(c=!u(_)),!c){c=!0;return}t(_)}};let h=!1;const m=[se(s,"click",_=>{h||(h=!0,setTimeout(()=>{h=!1},0),d(_))},{passive:!0,capture:i}),se(s,"pointerdown",_=>{const S=Me(e);c=!u(_)&&!!(S&&!_.composedPath().includes(S))},{passive:!0}),o&&se(s,"blur",_=>{setTimeout(()=>{let S;const g=Me(e);((S=s.document.activeElement)==null?void 0:S.tagName)==="IFRAME"&&!(g!=null&&g.contains(s.document.activeElement))&&t(_)},0)},{passive:!0})].filter(Boolean),v=()=>m.forEach(_=>_());return l?{stop:v,cancel:()=>{c=!1},trigger:_=>{c=!0,d(_),c=!1}}:v}function F_(){const e=te(!1),t=Ve();return t&&ns(()=>{e.value=!0},t),e}function In(e){const t=F_();return oe(()=>(t.value,!!e()))}function Hd(e,t,n={}){const{window:s=Ue,...r}=n;let i;const o=In(()=>s&&"MutationObserver"in s),l=()=>{i&&(i.disconnect(),i=void 0)},c=oe(()=>{const d=re(e),h=Ts(d).map(Me).filter(Fd);return new Set(h)}),u=de(c,d=>{l(),o.value&&d.size&&(i=new MutationObserver(t),d.forEach(h=>i.observe(h,r)))},{immediate:!0,flush:"post"}),a=()=>i==null?void 0:i.takeRecords(),f=()=>{u(),l()};return Bt(f),{isSupported:o,stop:f,takeRecords:a}}function L_(e,t,n={}){const{window:s=Ue,document:r=s==null?void 0:s.document,flush:i="sync"}=n;if(!s||!r)return Nt;let o;const l=a=>{o==null||o(),o=a},c=Vl(()=>{const a=Me(e);if(a){const{stop:f}=Hd(r,d=>{d.map(m=>[...m.removedNodes]).flat().some(m=>m===a||m.contains(a))&&t(d)},{window:s,childList:!0,subtree:!0});l(f)}},{flush:i}),u=()=>{c(),l()};return Bt(u),u}function V_(e){return typeof e=="function"?e:typeof e=="string"?t=>t.key===e:Array.isArray(e)?t=>e.includes(t.key):()=>!0}function g1(...e){let t,n,s={};e.length===3?(t=e[0],n=e[1],s=e[2]):e.length===2?typeof e[1]=="object"?(t=!0,n=e[0],s=e[1]):(t=e[0],n=e[1]):(t=!0,n=e[0]);const{target:r=Ue,eventName:i="keydown",passive:o=!1,dedupe:l=!1}=s,c=V_(t);return se(r,i,a=>{a.repeat&&re(l)||c(a)&&n(a)},o)}function y1(e={}){let t;const{window:n=Ue,deep:s=!0,triggerOnRemoval:r=!1}=e,i=(t=e.document)!=null?t:n==null?void 0:n.document,o=()=>{let u;let a=i==null?void 0:i.activeElement;if(s)for(;a!=null&&a.shadowRoot;)a=(u=a==null?void 0:a.shadowRoot)==null?void 0:u.activeElement;return a},l=te(),c=()=>{l.value=o()};if(n){const u={capture:!0,passive:!0};se(n,"blur",a=>{a.relatedTarget===null&&c()},u),se(n,"focus",c,u)}return r&&L_(l,c,{document:i}),c(),l}const B_=Symbol("vueuse-ssr-width");function jd(){const e=Ll()?__(B_,null):null;return typeof e=="number"?e:void 0}function Bn(e,t={}){const{window:n=Ue,ssrWidth:s=jd()}=t,r=In(()=>n&&"matchMedia"in n&&typeof n.matchMedia=="function"),i=te(typeof s=="number"),o=te(),l=te(!1),c=u=>{l.value=u.matches};return Vl(()=>{if(i.value){i.value=!r.value;const u=re(e).split(",");l.value=u.some(a=>{const f=a.includes("not all"),d=a.match(/\(\s*min-width:\s*(-?\d+(?:\.\d*)?[a-z]+\s*)\)/),h=a.match(/\(\s*max-width:\s*(-?\d+(?:\.\d*)?[a-z]+\s*)\)/);let m=!!(d||h);return d&&m&&(m=s>=nr(d[1])),h&&m&&(m=s<=nr(h[1])),f?!m:m});return}r.value&&(o.value=n.matchMedia(re(e)),l.value=o.value.matches)}),se(o,"change",c,{passive:!0}),oe(()=>l.value)}const v1={sm:640,md:768,lg:1024,xl:1280,"2xl":1536};function b1(e,t={}){function n(h,m){let v=re(e[re(h)]);return m!=null&&(v=O_(v,m)),typeof v=="number"&&(v=`${v}px`),v}const{window:s=Ue,strategy:r="min-width",ssrWidth:i=jd()}=t,o=typeof i=="number",l=o?te(!1):{value:!0};o&&Rn(()=>l.value=!!s);function c(h,m){return!l.value&&o?h==="min"?i>=nr(m):i<=nr(m):s?s.matchMedia(`(${h}-width: ${m})`).matches:!1}const u=h=>Bn(()=>`(min-width: ${n(h)})`,t),a=h=>Bn(()=>`(max-width: ${n(h)})`,t),f=Object.keys(e).reduce((h,m)=>(Object.defineProperty(h,m,{get:()=>r==="min-width"?u(m):a(m),enumerable:!0,configurable:!0}),h),{});function d(){const h=Object.keys(e).map(m=>[m,f[m],nr(n(m))]).sort((m,v)=>m[2]-v[2]);return oe(()=>h.filter(([,m])=>m.value).map(([m])=>m))}return Object.assign(f,{greaterOrEqual:u,smallerOrEqual:a,greater(h){return Bn(()=>`(min-width: ${n(h,.1)})`,t)},smaller(h){return Bn(()=>`(max-width: ${n(h,-.1)})`,t)},between(h,m){return Bn(()=>`(min-width: ${n(h)}) and (max-width: ${n(m,-.1)})`,t)},isGreater(h){return c("min",n(h,.1))},isGreaterOrEqual(h){return c("min",n(h))},isSmaller(h){return c("max",n(h,-.1))},isSmallerOrEqual(h){return c("max",n(h))},isInBetween(h,m){return c("min",n(h))&&c("max",n(m,-.1))},current:d,active(){const h=d();return oe(()=>h.value.length===0?"":h.value.at(r==="min-width"?-1:0))}})}function fu(e,t={}){const{controls:n=!1,navigator:s=Cc}=t,r=In(()=>s&&"permissions"in s),i=te(),o=typeof e=="string"?{name:e}:e,l=te(),c=()=>{let a,f;l.value=(f=(a=i.value)==null?void 0:a.state)!=null?f:"prompt"};se(i,"change",c,{passive:!0});const u=A_(async()=>{if(r.value){if(!i.value)try{i.value=await s.permissions.query(o)}catch{i.value=void 0}finally{c()}if(n)return fe(i.value)}});return u(),n?{state:l,isSupported:r,query:u}:l}function _1(e={}){const{navigator:t=Cc,read:n=!1,source:s,copiedDuring:r=1500,legacy:i=!1}=e,o=In(()=>t&&"clipboard"in t),l=fu("clipboard-read"),c=fu("clipboard-write"),u=oe(()=>o.value||i),a=te(""),f=te(!1),d=M_(()=>f.value=!1,r,{immediate:!1});async function h(){let g=!(o.value&&S(l.value));if(!g)try{a.value=await t.clipboard.readText()}catch{g=!0}g&&(a.value=_())}u.value&&n&&se(["copy","cut"],h,{passive:!0});async function m(g=re(s)){if(u.value&&g!=null){let p=!(o.value&&S(c.value));if(!p)try{await t.clipboard.writeText(g)}catch{p=!0}p&&v(g),a.value=g,f.value=!0,d.start()}}function v(g){const p=document.createElement("textarea");p.value=g??"",p.style.position="absolute",p.style.opacity="0",document.body.appendChild(p),p.select(),document.execCommand("copy"),p.remove()}function _(){let g,p,b;return(b=(p=(g=document==null?void 0:document.getSelection)==null?void 0:g.call(document))==null?void 0:p.toString())!=null?b:""}function S(g){return g==="granted"||g==="prompt"}return{isSupported:u,text:a,copied:f,copy:m}}function H_(e){return JSON.parse(JSON.stringify(e))}const ei=typeof globalThis<"u"?globalThis:typeof window<"u"?window:typeof global<"u"?global:typeof self<"u"?self:{},ti="__vueuse_ssr_handlers__",j_=$_();function $_(){return ti in ei||(ei[ti]=ei[ti]||{}),ei[ti]}function U_(e,t){return j_[e]||t}function S1(e){return Bn("(prefers-color-scheme: dark)",e)}function W_(e){return e==null?"any":e instanceof Set?"set":e instanceof Map?"map":e instanceof Date?"date":typeof e=="boolean"?"boolean":typeof e=="string"?"string":typeof e=="object"?"object":Number.isNaN(e)?"any":"number"}const K_={boolean:{read:e=>e==="true",write:e=>String(e)},object:{read:e=>JSON.parse(e),write:e=>JSON.stringify(e)},number:{read:e=>Number.parseFloat(e),write:e=>String(e)},any:{read:e=>e,write:e=>String(e)},string:{read:e=>e,write:e=>String(e)},map:{read:e=>new Map(JSON.parse(e)),write:e=>JSON.stringify(Array.from(e.entries()))},set:{read:e=>new Set(JSON.parse(e)),write:e=>JSON.stringify(Array.from(e))},date:{read:e=>new Date(e),write:e=>e.toISOString()}},hu="vueuse-storage";function q_(e,t,n,s={}){let r;const{flush:i="pre",deep:o=!0,listenToStorageChanges:l=!0,writeDefaults:c=!0,mergeDefaults:u=!1,shallow:a,window:f=Ue,eventFilter:d,onError:h=k=>{console.error(k)},initOnMounted:m}=s,v=(a?te:Le)(typeof t=="function"?t():t),_=oe(()=>re(e));if(!n)try{n=U_("getDefaultStorage",()=>{let k;return(k=Ue)==null?void 0:k.localStorage})()}catch(k){h(k)}if(!n)return v;const S=re(t),g=W_(S),p=(r=s.serializer)!=null?r:K_[g],{pause:b,resume:T}=x_(v,k=>N(k),{flush:i,deep:o,eventFilter:d});de(_,()=>O(),{flush:i});let R=!1;const C=k=>{m&&!R||O(k)},A=k=>{m&&!R||V(k)};f&&l&&(n instanceof Storage?se(f,"storage",C,{passive:!0}):se(f,hu,A)),m?Rn(()=>{R=!0,O()}):O();function w(k,$){if(f){const B={key:_.value,oldValue:k,newValue:$,storageArea:n};f.dispatchEvent(n instanceof Storage?new StorageEvent("storage",B):new CustomEvent(hu,{detail:B}))}}function N(k){try{const $=n.getItem(_.value);if(k==null)w($,null),n.removeItem(_.value);else{const B=p.write(k);$!==B&&(n.setItem(_.value,B),w($,B))}}catch($){h($)}}function P(k){const $=k?k.newValue:n.getItem(_.value);if($==null)return c&&S!=null&&n.setItem(_.value,p.write(S)),S;if(!k&&u){const B=p.read($);return typeof u=="function"?u(B,S):g==="object"&&!Array.isArray(B)?{...S,...B}:B}else return typeof $!="string"?$:p.read($)}function O(k){if(!(k&&k.storageArea!==n)){if(k&&k.key==null){v.value=S;return}if(!(k&&k.key!==_.value)){b();try{const $=p.write(v.value);(k===void 0||(k==null?void 0:k.newValue)!==$)&&(v.value=P(k))}catch($){h($)}finally{k?xn(T):T()}}}}function V(k){O(k.detail)}return v}function G_(e={}){const{document:t=ho}=e;if(!t)return te("visible");const n=te(t.visibilityState);return se(t,"visibilitychange",()=>{n.value=t.visibilityState},{passive:!0}),n}function E1(e,t={}){let n;const{pointerTypes:s,preventDefault:r,stopPropagation:i,exact:o,onMove:l,onEnd:c,onStart:u,initialValue:a,axis:f="both",draggingElement:d=Ue,containerElement:h,handle:m=e,buttons:v=[0]}=t,_=Le((n=re(a))!=null?n:{x:0,y:0}),S=Le(),g=C=>s?s.includes(C.pointerType):!0,p=C=>{re(r)&&C.preventDefault(),re(i)&&C.stopPropagation()},b=C=>{let A;if(!re(v).includes(C.button)||re(t.disabled)||!g(C)||re(o)&&C.target!==re(e))return;const w=re(h),N=(A=w==null?void 0:w.getBoundingClientRect)==null?void 0:A.call(w),P=re(e).getBoundingClientRect(),O={x:C.clientX-(w?P.left-N.left+w.scrollLeft:P.left),y:C.clientY-(w?P.top-N.top+w.scrollTop:P.top)};(u==null?void 0:u(O,C))!==!1&&(S.value=O,p(C))},T=C=>{if(re(t.disabled)||!g(C)||!S.value)return;const A=re(h),w=re(e).getBoundingClientRect();let{x:N,y:P}=_.value;(f==="x"||f==="both")&&(N=C.clientX-S.value.x,A&&(N=Math.min(Math.max(0,N),A.scrollWidth-w.width))),(f==="y"||f==="both")&&(P=C.clientY-S.value.y,A&&(P=Math.min(Math.max(0,P),A.scrollHeight-w.height))),_.value={x:N,y:P},l==null||l(_.value,C),p(C)},R=C=>{re(t.disabled)||!g(C)||S.value&&(S.value=void 0,c==null||c(_.value,C),p(C))};if(Nn){const C=()=>{let A;return{capture:(A=t.capture)!=null?A:!0,passive:!re(r)}};se(m,"pointerdown",b,C),se(d,"pointermove",T,C),se(d,"pointerup",R,C)}return{...R_(_),position:_,isDragging:oe(()=>!!S.value),style:oe(()=>`left:${_.value.x}px;top:${_.value.y}px;`)}}function $d(e,t,n={}){const{window:s=Ue,...r}=n;let i;const o=In(()=>s&&"ResizeObserver"in s),l=()=>{i&&(i.disconnect(),i=void 0)},c=oe(()=>{const f=re(e);return Array.isArray(f)?f.map(d=>Me(d)):[Me(f)]}),u=de(c,f=>{if(l(),o.value&&s){i=new ResizeObserver(t);for(const d of f)d&&i.observe(d,r)}},{immediate:!0,flush:"post"}),a=()=>{l(),u()};return Bt(a),{isSupported:o,stop:a}}function T1(e,t={}){const{reset:n=!0,windowResize:s=!0,windowScroll:r=!0,immediate:i=!0,updateTiming:o="sync"}=t,l=te(0),c=te(0),u=te(0),a=te(0),f=te(0),d=te(0),h=te(0),m=te(0);function v(){const S=Me(e);if(!S){n&&(l.value=0,c.value=0,u.value=0,a.value=0,f.value=0,d.value=0,h.value=0,m.value=0);return}const g=S.getBoundingClientRect();l.value=g.height,c.value=g.bottom,u.value=g.left,a.value=g.right,f.value=g.top,d.value=g.width,h.value=g.x,m.value=g.y}function _(){o==="sync"?v():o==="next-frame"&&requestAnimationFrame(()=>v())}return $d(e,_),de(()=>Me(e),S=>!S&&_()),Hd(e,_,{attributeFilter:["style","class"]}),r&&se("scroll",_,{capture:!0,passive:!0}),s&&se("resize",_,{passive:!0}),Rn(()=>{i&&_()}),{height:l,bottom:c,left:u,right:a,top:f,width:d,x:h,y:m,update:_}}function w1(e,t={width:0,height:0},n={}){const{window:s=Ue,box:r="content-box"}=n,i=oe(()=>{let f,d;return(d=(f=Me(e))==null?void 0:f.namespaceURI)==null?void 0:d.includes("svg")}),o=te(t.width),l=te(t.height),{stop:c}=$d(e,([f])=>{const d=r==="border-box"?f.borderBoxSize:r==="content-box"?f.contentBoxSize:f.devicePixelContentBoxSize;if(s&&i.value){const h=Me(e);if(h){const m=h.getBoundingClientRect();o.value=m.width,l.value=m.height}}else if(d){const h=Ts(d);o.value=h.reduce((m,{inlineSize:v})=>m+v,0),l.value=h.reduce((m,{blockSize:v})=>m+v,0)}else o.value=f.contentRect.width,l.value=f.contentRect.height},n);Rn(()=>{const f=Me(e);f&&(o.value="offsetWidth"in f?f.offsetWidth:t.width,l.value="offsetHeight"in f?f.offsetHeight:t.height)});const u=de(()=>Me(e),f=>{o.value=f?t.width:0,l.value=f?t.height:0});function a(){c(),u()}return{width:o,height:l,stop:a}}function z_(e,t,n={}){const{root:s,rootMargin:r="0px",threshold:i=0,window:o=Ue,immediate:l=!0}=n,c=In(()=>o&&"IntersectionObserver"in o),u=oe(()=>{const m=re(e);return Ts(m).map(Me).filter(Fd)});let a=Nt;const f=te(l),d=c.value?de(()=>[u.value,Me(s),f.value],([m,v])=>{if(a(),!f.value||!m.length)return;const _=new IntersectionObserver(t,{root:Me(v),rootMargin:r,threshold:i});m.forEach(S=>S&&_.observe(S)),a=()=>{_.disconnect(),a=Nt}},{immediate:l,flush:"post"}):Nt,h=()=>{a(),d(),f.value=!1};return Bt(h),{isSupported:c,isActive:f,pause(){a(),f.value=!1},resume(){f.value=!0},stop:h}}const du=["fullscreenchange","webkitfullscreenchange","webkitendfullscreen","mozfullscreenchange","MSFullscreenChange"];function C1(e,t={}){const{document:n=ho,autoExit:s=!1}=t,r=oe(()=>{let g;return(g=Me(e))!=null?g:n==null?void 0:n.documentElement}),i=te(!1),o=oe(()=>["requestFullscreen","webkitRequestFullscreen","webkitEnterFullscreen","webkitEnterFullScreen","webkitRequestFullScreen","mozRequestFullScreen","msRequestFullscreen"].find(g=>n&&g in n||r.value&&g in r.value)),l=oe(()=>["exitFullscreen","webkitExitFullscreen","webkitExitFullScreen","webkitCancelFullScreen","mozCancelFullScreen","msExitFullscreen"].find(g=>n&&g in n||r.value&&g in r.value)),c=oe(()=>["fullScreen","webkitIsFullScreen","webkitDisplayingFullscreen","mozFullScreen","msFullscreenElement"].find(g=>n&&g in n||r.value&&g in r.value)),u=["fullscreenElement","webkitFullscreenElement","mozFullScreenElement","msFullscreenElement"].find(g=>n&&g in n),a=In(()=>r.value&&n&&o.value!==void 0&&l.value!==void 0&&c.value!==void 0),f=()=>u?(n==null?void 0:n[u])===r.value:!1,d=()=>{if(c.value){if(n&&n[c.value]!=null)return n[c.value];{const g=r.value;if((g==null?void 0:g[c.value])!=null)return!!g[c.value]}}return!1};async function h(){if(!(!a.value||!i.value)){if(l.value)if((n==null?void 0:n[l.value])!=null)await n[l.value]();else{const g=r.value;(g==null?void 0:g[l.value])!=null&&await g[l.value]()}i.value=!1}}async function m(){if(!a.value||i.value)return;d()&&await h();const g=r.value;o.value&&(g==null?void 0:g[o.value])!=null&&(await g[o.value](),i.value=!0)}async function v(){await(i.value?h():m())}const _=()=>{const g=d();(!g||g&&f())&&(i.value=g)},S={capture:!1,passive:!0};return se(n,du,_,S),se(()=>Me(r),du,_,S),Rn(_,!1),s&&Bt(h),{isSupported:a,isFullscreen:i,enter:m,exit:h,toggle:v}}function A1(e,t,n={}){const{window:s=Ue}=n;return q_(e,t,s==null?void 0:s.localStorage,n)}const Y_={ctrl:"control",command:"meta",cmd:"meta",option:"alt",up:"arrowup",down:"arrowdown",left:"arrowleft",right:"arrowright"};function O1(e={}){const{reactive:t=!1,target:n=Ue,aliasMap:s=Y_,passive:r=!0,onEventFired:i=Nt}=e,o=gt(new Set),l={toJSON(){return{}},current:o},c=t?gt(l):l,u=new Set,a=new Set,f=new Set;function d(_,S){_ in c&&(t?c[_]=S:c[_].value=S)}function h(){o.clear();for(const _ of f)d(_,!1)}function m(_,S){let g,p;const b=(g=_.key)==null?void 0:g.toLowerCase(),R=[(p=_.code)==null?void 0:p.toLowerCase(),b].filter(Boolean);b&&(S?o.add(b):o.delete(b));for(const C of R)f.add(C),d(C,S);if(b==="shift"&&!S){const C=Array.from(a),A=C.indexOf("shift");C.forEach((w,N)=>{N>=A&&(o.delete(w),d(w,!1))}),a.clear()}else typeof _.getModifierState=="function"&&_.getModifierState("Shift")&&S&&[...o,...R].forEach(C=>a.add(C));b==="meta"&&!S?(u.forEach(C=>{o.delete(C),d(C,!1)}),u.clear()):typeof _.getModifierState=="function"&&_.getModifierState("Meta")&&S&&[...o,...R].forEach(C=>u.add(C))}se(n,"keydown",_=>(m(_,!0),i(_)),{passive:r}),se(n,"keyup",_=>(m(_,!1),i(_)),{passive:r}),se("blur",h,{passive:r}),se("focus",h,{passive:r});const v=new Proxy(c,{get(_,S,g){if(typeof S!="string")return Reflect.get(_,S,g);if(S=S.toLowerCase(),S in s&&(S=s[S]),!(S in c))if(/[+_-]/.test(S)){const b=S.split(/[+_-]/g).map(T=>T.trim());c[S]=oe(()=>b.map(T=>re(v[T])).every(Boolean))}else c[S]=te(!1);const p=Reflect.get(_,S,g);return t?re(p):p}});return v}const J_={page:e=>[e.pageX,e.pageY],client:e=>[e.clientX,e.clientY],screen:e=>[e.screenX,e.screenY],movement:e=>e instanceof MouseEvent?[e.movementX,e.movementY]:null};function N1(e={}){const{type:t="page",touch:n=!0,resetOnTouchEnds:s=!1,initialValue:r={x:0,y:0},window:i=Ue,target:o=i,scroll:l=!0,eventFilter:c}=e;let u=null,a=0,f=0;const d=te(r.x),h=te(r.y),m=te(null),v=typeof t=="function"?t:J_[t],_=C=>{const A=v(C);u=C,A&&([d.value,h.value]=A,m.value="mouse"),i&&(a=i.scrollX,f=i.scrollY)},S=C=>{if(C.touches.length>0){const A=v(C.touches[0]);A&&([d.value,h.value]=A,m.value="touch")}},g=()=>{if(!u||!i)return;const C=v(u);u instanceof MouseEvent&&C&&(d.value=C[0]+i.scrollX-a,h.value=C[1]+i.scrollY-f)},p=()=>{d.value=r.x,h.value=r.y},b=c?C=>c(()=>_(C),{}):C=>_(C),T=c?C=>c(()=>S(C),{}):C=>S(C),R=c?()=>c(()=>g(),{}):()=>g();if(o){const C={passive:!0};se(o,["mousemove","dragover"],b,C),n&&t!=="movement"&&(se(o,["touchstart","touchmove"],T,C),s&&se(o,"touchend",p,C)),l&&t==="page"&&se(i,"scroll",R,C)}return{x:d,y:h,sourceType:m}}function x1(e,t={}){const n=Ld(e),{threshold:s=50,onSwipe:r,onSwipeEnd:i,onSwipeStart:o,disableTextSelect:l=!1}=t,c=gt({x:0,y:0}),u=(A,w)=>{c.x=A,c.y=w},a=gt({x:0,y:0}),f=(A,w)=>{a.x=A,a.y=w},d=oe(()=>c.x-a.x),h=oe(()=>c.y-a.y),{max:m,abs:v}=Math,_=oe(()=>m(v(d.value),v(h.value))>=s),S=te(!1),g=te(!1),p=oe(()=>_.value?v(d.value)>v(h.value)?d.value>0?"left":"right":h.value>0?"up":"down":"none"),b=A=>{let w,N,P;const O=A.buttons===0,V=A.buttons===1;return(P=(N=(w=t.pointerTypes)==null?void 0:w.includes(A.pointerType))!=null?N:O||V)!=null?P:!0},T={passive:!0},R=[se(e,"pointerdown",A=>{if(!b(A))return;g.value=!0;const w=A.target;w==null||w.setPointerCapture(A.pointerId);const{clientX:N,clientY:P}=A;u(N,P),f(N,P),o==null||o(A)},T),se(e,"pointermove",A=>{if(!b(A)||!g.value)return;const{clientX:w,clientY:N}=A;f(w,N),!S.value&&_.value&&(S.value=!0),S.value&&(r==null||r(A))},T),se(e,"pointerup",A=>{b(A)&&(S.value&&(i==null||i(A,p.value)),g.value=!1,S.value=!1)},T)];return Rn(()=>{let A,w,N,P,O,V,k,$;(w=(A=n.value)==null?void 0:A.style)==null||w.setProperty("touch-action","pan-y"),l&&((P=(N=n.value)==null?void 0:N.style)==null||P.setProperty("-webkit-user-select","none"),(V=(O=n.value)==null?void 0:O.style)==null||V.setProperty("-ms-user-select","none"),($=(k=n.value)==null?void 0:k.style)==null||$.setProperty("user-select","none"))}),{isSwiping:kt(S),direction:kt(p),posStart:kt(c),posEnd:kt(a),distanceX:d,distanceY:h,stop:()=>R.forEach(A=>A())}}let X_=0;function R1(e,t={}){const n=te(!1),{document:s=ho,immediate:r=!0,manual:i=!1,id:o=`vueuse_styletag_${++X_}`}=t,l=te(e);let c=()=>{};const u=()=>{if(!s)return;const f=s.getElementById(o)||s.createElement("style");f.isConnected||(f.id=o,t.nonce&&(f.nonce=t.nonce),t.media&&(f.media=t.media),s.head.appendChild(f)),!n.value&&(c=de(l,d=>{f.textContent=d},{immediate:!0}),n.value=!0)},a=()=>{!s||!n.value||(c(),s.head.removeChild(s.getElementById(o)),n.value=!1)};return r&&!i&&Rn(u),i||Bt(a),{id:o,css:l,unload:a,load:u,isLoaded:kt(n)}}function I1(e,t,n,s={}){let r,i,o;const{clone:l=!1,passive:c=!1,eventName:u,deep:a=!1,defaultValue:f,shouldEmit:d}=s,h=Ve(),m=n||(h==null?void 0:h.emit)||((r=h==null?void 0:h.$emit)==null?void 0:r.bind(h))||((o=(i=h==null?void 0:h.proxy)==null?void 0:i.$emit)==null?void 0:o.bind(h==null?void 0:h.proxy));let v=u;t||(t="modelValue"),v=v||`update:${t.toString()}`;const _=p=>l?typeof l=="function"?l(p):H_(p):p,S=()=>S_(e[t])?_(e[t]):f,g=p=>{d?d(p)&&m(v,p):m(v,p)};if(c){const p=S(),b=Le(p);let T=!1;return de(()=>e[t],R=>{T||(T=!0,b.value=_(R),xn(()=>T=!1))}),de(b,R=>{!T&&(R!==e[t]||a)&&g(R)},{deep:a}),b}else return oe({get(){return S()},set(p){g(p)}})}function P1(e={}){const{navigator:t=Cc,document:n=ho}=e,s=te(!1),r=te(null),i=G_({document:n}),o=In(()=>t&&"wakeLock"in t),l=oe(()=>!!r.value&&i.value==="visible");o.value&&(se(r,"release",()=>{let f,d;s.value=(d=(f=r.value)==null?void 0:f.type)!=null?d:!1},{passive:!0}),D_(()=>i.value==="visible"&&(n==null?void 0:n.visibilityState)==="visible"&&s.value,f=>{s.value=!1,c(f)}));async function c(f){let d;await((d=r.value)==null?void 0:d.release()),r.value=o.value?await t.wakeLock.request(f):null}async function u(f){i.value==="visible"?await c(f):s.value=f}async function a(){s.value=!1;const f=r.value;r.value=null,await(f==null?void 0:f.release())}return{sentinel:r,isSupported:o,isActive:l,request:u,forceRequest:c,release:a}}function M1(e={}){const{window:t=Ue}=e;if(!t)return te(!1);const n=te(t.document.hasFocus()),s={passive:!0};return se(t,"blur",()=>{n.value=!1},s),se(t,"focus",()=>{n.value=!0},s),n}function k1(e={}){const{window:t=Ue,initialWidth:n=Number.POSITIVE_INFINITY,initialHeight:s=Number.POSITIVE_INFINITY,listenOrientation:r=!0,includeScrollbar:i=!0,type:o="inner"}=e,l=te(n),c=te(s),u=()=>{if(t)if(o==="outer")l.value=t.outerWidth,c.value=t.outerHeight;else if(o==="visual"&&t.visualViewport){const{width:f,height:d,scale:h}=t.visualViewport;l.value=Math.round(f*h),c.value=Math.round(d*h)}else i?(l.value=t.innerWidth,c.value=t.innerHeight):(l.value=t.document.documentElement.clientWidth,c.value=t.document.documentElement.clientHeight)};u(),Rn(u);const a={passive:!0};if(se("resize",u,a),t&&o==="visual"&&t.visualViewport&&se(t.visualViewport,"resize",u,a),r){const f=Bn("(orientation: portrait)");de(f,()=>u())}return{width:l,height:c}}function Mo(e){if(e===null||typeof e!="object")return!1;const t=Object.getPrototypeOf(e);return t!==null&&t!==Object.prototype&&Object.getPrototypeOf(t)!==null||Symbol.iterator in e?!1:Symbol.toStringTag in e?Object.prototype.toString.call(e)==="[object Module]":!0}function gl(e,t,n=".",s){if(!Mo(t))return gl(e,{},n,s);const r={...t};for(const i of Object.keys(e)){if(i==="__proto__"||i==="constructor")continue;const o=e[i];o!=null&&(s&&s(r,i,o,n)||(Array.isArray(o)&&Array.isArray(r[i])?r[i]=[...o,...r[i]]:Mo(o)&&Mo(r[i])?r[i]=gl(o,r[i],(n?`${n}.`:"")+i.toString(),s):r[i]=o))}return r}function Z_(e){return(...t)=>t.reduce((n,s)=>gl(n,s,"",e),{})}const Q_=Z_(),Ud=1/60*1e3,eS=typeof performance<"u"?()=>performance.now():()=>Date.now(),Wd=typeof window<"u"?e=>window.requestAnimationFrame(e):e=>setTimeout(()=>e(eS()),Ud);function tS(e){let t=[],n=[],s=0,r=!1,i=!1;const o=new WeakSet,l={schedule:(c,u=!1,a=!1)=>{const f=a&&r,d=f?t:n;return u&&o.add(c),d.indexOf(c)===-1&&(d.push(c),f&&r&&(s=t.length)),c},cancel:c=>{const u=n.indexOf(c);u!==-1&&n.splice(u,1),o.delete(c)},process:c=>{if(r){i=!0;return}if(r=!0,[t,n]=[n,t],n.length=0,s=t.length,s)for(let u=0;u<s;u++){const a=t[u];a(c),o.has(a)&&(l.schedule(a),e())}r=!1,i&&(i=!1,l.process(c))}};return l}const nS=40;let yl=!0,Cr=!1,vl=!1;const ws={delta:0,timestamp:0},Vr=["read","update","preRender","render","postRender"],po=Vr.reduce((e,t)=>(e[t]=tS(()=>Cr=!0),e),{}),bl=Vr.reduce((e,t)=>{const n=po[t];return e[t]=(s,r=!1,i=!1)=>(Cr||iS(),n.schedule(s,r,i)),e},{}),sS=Vr.reduce((e,t)=>(e[t]=po[t].cancel,e),{});Vr.reduce((e,t)=>(e[t]=()=>po[t].process(ws),e),{});const rS=e=>po[e].process(ws),Kd=e=>{Cr=!1,ws.delta=yl?Ud:Math.max(Math.min(e-ws.timestamp,nS),1),ws.timestamp=e,vl=!0,Vr.forEach(rS),vl=!1,Cr&&(yl=!1,Wd(Kd))},iS=()=>{Cr=!0,yl=!0,vl||Wd(Kd)},qd=()=>ws;function Gd(e,t){const n={};for(var s in e)Object.prototype.hasOwnProperty.call(e,s)&&t.indexOf(s)<0&&(n[s]=e[s]);if(e!=null&&typeof Object.getOwnPropertySymbols=="function")for(var r=0,s=Object.getOwnPropertySymbols(e);r<s.length;r++)t.indexOf(s[r])<0&&Object.prototype.propertyIsEnumerable.call(e,s[r])&&(n[s[r]]=e[s[r]]);return n}const pu=function(){};const l=(e,t,n)=>Math.min(Math.max(n,e),t),ko=.001,oS=.01,lS=10,cS=.05,aS=1;function uS({duration:e=800,bounce:t=.25,velocity:n=0,mass:s=1}){let r,i,o=1-t;o=_l(cS,aS,o),e=_l(oS,lS,e/1e3),o<1?(r=u=>{const a=u*o,f=a*e,d=a-n,h=Sl(u,o),m=Math.exp(-f);return ko-d/h*m},i=u=>{const f=u*o*e,d=f*n+n,h=Math.pow(o,2)*Math.pow(u,2)*e,m=Math.exp(-f),v=Sl(Math.pow(u,2),o);return(-r(u)+ko>0?-1:1)*((d-h)*m)/v}):(r=u=>{const a=Math.exp(-u*e),f=(u-n)*e+1;return-ko+a*f},i=u=>{const a=Math.exp(-u*e),f=(n-u)*(e*e);return a*f});const l=5/e,c=hS(r,i,l);if(e=e*1e3,isNaN(c))return{stiffness:100,damping:10,duration:e};{const u=Math.pow(c,2)*s;return{stiffness:u,damping:o*2*Math.sqrt(s*u),duration:e}}}const fS=12;function hS(e,t,n){let s=n;for(let r=1;r<fS;r++)s=s-e(s)/t(s);return s}function Sl(e,t){return e*Math.sqrt(1-t*t)}const dS=["duration","bounce"],pS=["stiffness","damping","mass"];function mu(e,t){return t.some(n=>e[n]!==void 0)}function mS(e){let t=Object.assign({velocity:0,stiffness:100,damping:10,mass:1,isResolvedFromDuration:!1},e);if(!mu(e,pS)&&mu(e,dS)){const n=uS(e);t=Object.assign(Object.assign(Object.assign({},t),n),{velocity:0,mass:1}),t.isResolvedFromDuration=!0}return t}function Ac(e){let{from:t=0,to:n=1,restSpeed:s=2,restDelta:r}=e,i=Gd(e,["from","to","restSpeed","restDelta"]);const o={done:!1,value:t};let{stiffness:l,damping:c,mass:u,velocity:a,duration:f,isResolvedFromDuration:d}=mS(i),h=gu,m=gu;function v(){const _=a?-(a/1e3):0,S=n-t,g=c/(2*Math.sqrt(l*u)),p=Math.sqrt(l/u)/1e3;if(r===void 0&&(r=Math.min(Math.abs(n-t)/100,.4)),g<1){const b=Sl(p,g);h=T=>{const R=Math.exp(-g*p*T);return n-R*((_+g*p*S)/b*Math.sin(b*T)+S*Math.cos(b*T))},m=T=>{const R=Math.exp(-g*p*T);return g*p*R*(Math.sin(b*T)*(_+g*p*S)/b+S*Math.cos(b*T))-R*(Math.cos(b*T)*(_+g*p*S)-b*S*Math.sin(b*T))}}else if(g===1)h=b=>n-Math.exp(-p*b)*(S+(_+p*S)*b);else{const b=p*Math.sqrt(g*g-1);h=T=>{const R=Math.exp(-g*p*T),C=Math.min(b*T,300);return n-R*((_+g*p*S)*Math.sinh(C)+b*S*Math.cosh(C))/b}}}return v(),{next:_=>{const S=h(_);if(d)o.done=_>=f;else{const g=m(_)*1e3,p=Math.abs(g)<=s,b=Math.abs(n-S)<=r;o.done=p&&b}return o.value=o.done?n:S,o},flipTarget:()=>{a=-a,[t,n]=[n,t],v()}}}Ac.needsInterpolation=(e,t)=>typeof e=="string"||typeof t=="string";const gu=e=>0,zd=(e,t,n)=>{const s=t-e;return s===0?1:(n-e)/s},Oc=(e,t,n)=>-n*e+n*t+e,Yd=(e,t)=>n=>Math.max(Math.min(n,t),e),sr=e=>e%1?Number(e.toFixed(5)):e,Ar=/(-)?([\d]*\.?[\d])+/g,El=/(#[0-9a-f]{6}|#[0-9a-f]{3}|#(?:[0-9a-f]{2}){2,4}|(rgb|hsl)a?\((-?[\d\.]+%?[,\s]+){2}(-?[\d\.]+%?)\s*[\,\/]?\s*[\d\.]*%?\))/gi,gS=/^(#[0-9a-f]{3}|#(?:[0-9a-f]{2}){2,4}|(rgb|hsl)a?\((-?[\d\.]+%?[,\s]+){2}(-?[\d\.]+%?)\s*[\,\/]?\s*[\d\.]*%?\))$/i;function Br(e){return typeof e=="string"}const Hr={test:e=>typeof e=="number",parse:parseFloat,transform:e=>e},rr=Object.assign(Object.assign({},Hr),{transform:Yd(0,1)}),ni=Object.assign(Object.assign({},Hr),{default:1}),Nc=e=>({test:t=>Br(t)&&t.endsWith(e)&&t.split(" ").length===1,parse:parseFloat,transform:t=>`${t}${e}`}),Dn=Nc("deg"),ir=Nc("%"),le=Nc("px"),yu=Object.assign(Object.assign({},ir),{parse:e=>ir.parse(e)/100,transform:e=>ir.transform(e*100)}),xc=(e,t)=>n=>!!(Br(n)&&gS.test(n)&&n.startsWith(e)||t&&Object.prototype.hasOwnProperty.call(n,t)),Jd=(e,t,n)=>s=>{if(!Br(s))return s;const[r,i,o,l]=s.match(Ar);return{[e]:parseFloat(r),[t]:parseFloat(i),[n]:parseFloat(o),alpha:l!==void 0?parseFloat(l):1}},Un={test:xc("hsl","hue"),parse:Jd("hue","saturation","lightness"),transform:({hue:e,saturation:t,lightness:n,alpha:s=1})=>`hsla(${Math.round(e)}, ${ir.transform(sr(t))}, ${ir.transform(sr(n))}, ${sr(rr.transform(s))})`},yS=Yd(0,255),Do=Object.assign(Object.assign({},Hr),{transform:e=>Math.round(yS(e))}),wn={test:xc("rgb","red"),parse:Jd("red","green","blue"),transform:({red:e,green:t,blue:n,alpha:s=1})=>`rgba(${Do.transform(e)}, ${Do.transform(t)}, ${Do.transform(n)}, ${sr(rr.transform(s))})`};function vS(e){let t="",n="",s="",r="";return e.length>5?(t=e.substr(1,2),n=e.substr(3,2),s=e.substr(5,2),r=e.substr(7,2)):(t=e.substr(1,1),n=e.substr(2,1),s=e.substr(3,1),r=e.substr(4,1),t+=t,n+=n,s+=s,r+=r),{red:parseInt(t,16),green:parseInt(n,16),blue:parseInt(s,16),alpha:r?parseInt(r,16)/255:1}}const Tl={test:xc("#"),parse:vS,transform:wn.transform},ft={test:e=>wn.test(e)||Tl.test(e)||Un.test(e),parse:e=>wn.test(e)?wn.parse(e):Un.test(e)?Un.parse(e):Tl.parse(e),transform:e=>Br(e)?e:e.hasOwnProperty("red")?wn.transform(e):Un.transform(e)},Xd="${c}",Zd="${n}";function bS(e){let t,n,s,r;return isNaN(e)&&Br(e)&&((n=(t=e.match(Ar))===null||t===void 0?void 0:t.length)!==null&&n!==void 0?n:0)+((r=(s=e.match(El))===null||s===void 0?void 0:s.length)!==null&&r!==void 0?r:0)>0}function Qd(e){typeof e=="number"&&(e=`${e}`);const t=[];let n=0;const s=e.match(El);s&&(n=s.length,e=e.replace(El,Xd),t.push(...s.map(ft.parse)));const r=e.match(Ar);return r&&(e=e.replace(Ar,Zd),t.push(...r.map(Hr.parse))),{values:t,numColors:n,tokenised:e}}function ep(e){return Qd(e).values}function tp(e){const{values:t,numColors:n,tokenised:s}=Qd(e),r=t.length;return i=>{let o=s;for(let l=0;l<r;l++)o=o.replace(l<n?Xd:Zd,l<n?ft.transform(i[l]):sr(i[l]));return o}}const S=e=>typeof e=="number"?0:e;function SS(e){const t=ep(e);return tp(e)(t.map(_S))}const jr={test:bS,parse:ep,createTransformer:tp,getAnimatableNone:SS},ES=new Set(["brightness","contrast","saturate","opacity"]);function TS(e){const[t,n]=e.slice(0,-1).split("(");if(t==="drop-shadow")return e;const[s]=n.match(Ar)||[];if(!s)return e;const r=n.replace(s,"");let i=ES.has(t)?1:0;return s!==n&&(i*=100),`${t}(${i}${r})`}const wS=/([a-z-]*)\(.*?\)/g,wl=Object.assign(Object.assign({},jr),{getAnimatableNone:e=>{const t=e.match(wS);return t?t.map(TS).join(" "):e}});function Fo(e,t,n){return n<0&&(n+=1),n>1&&(n-=1),n<1/6?e+(t-e)*6*n:n<1/2?t:n<2/3?e+(t-e)*(2/3-n)*6:e}function vu({hue:e,saturation:t,lightness:n,alpha:s}){e/=360,t/=100,n/=100;let r=0,i=0,o=0;if(!t)r=i=o=n;else{const l=n<.5?n*(1+t):n+t-n*t,c=2*n-l;r=Fo(c,l,e+1/3),i=Fo(c,l,e),o=Fo(c,l,e-1/3)}return{red:Math.round(r*255),green:Math.round(i*255),blue:Math.round(o*255),alpha:s}}const CS=(e,t,n)=>{const s=e*e,r=t*t;return Math.sqrt(Math.max(0,n*(r-s)+s))},AS=[Tl,wn,Un],bu=e=>AS.find(t=>t.test(e)),np=(e,t)=>{let n=bu(e),s=bu(t),r=n.parse(e),i=s.parse(t);n===Un&&(r=vu(r),n=wn),s===Un&&(i=vu(i),s=wn);const o=Object.assign({},r);return l=>{for(const c in o)c!=="alpha"&&(o[c]=CS(r[c],i[c],l));return o.alpha=Oc(r.alpha,i.alpha,l),n.transform(o)}},OS=e=>typeof e=="number",NS=(e,t)=>n=>t(e(n)),sp=(...e)=>e.reduce(NS);function rp(e,t){return OS(e)?n=>Oc(e,t,n):ft.test(e)?np(e,t):op(e,t)}const ip=(e,t)=>{const n=[...e],s=n.length,r=e.map((i,o)=>rp(i,t[o]));return i=>{for(let o=0;o<s;o++)n[o]=r[o](i);return n}},xS=(e,t)=>{const n=Object.assign(Object.assign({},e),t),s={};for(const r in n)e[r]!==void 0&&t[r]!==void 0&&(s[r]=rp(e[r],t[r]));return r=>{for(const i in s)n[i]=s[i](r);return n}};function _u(e){const t=jr.parse(e),n=t.length;let s=0,r=0,i=0;for(let o=0;o<n;o++)s||typeof t[o]=="number"?s++:t[o].hue!==void 0?i++:r++;return{parsed:t,numNumbers:s,numRGB:r,numHSL:i}}const op=(e,t)=>{const n=jr.createTransformer(t),s=_u(e),r=_u(t);return s.numHSL===r.numHSL&&s.numRGB===r.numRGB&&s.numNumbers>=r.numNumbers?sp(ip(s.parsed,r.parsed),n):o=>`${o>0?t:e}`},RS=(e,t)=>n=>Oc(e,t,n);function IS(e){if(typeof e=="number")return RS;if(typeof e=="string")return ft.test(e)?np:op;if(Array.isArray(e))return ip;if(typeof e=="object")return xS}function PS(e,t,n){const s=[],r=n||IS(e[0]),i=e.length-1;for(let o=0;o<i;o++){let l=r(e[o],e[o+1]);if(t){const c=Array.isArray(t)?t[o]:t;l=sp(c,l)}s.push(l)}return s}function MS([e,t],[n]){return s=>n(zd(e,t,s))}function kS(e,t){const n=e.length,s=n-1;return r=>{let i=0,o=!1;if(r<=e[0]?o=!0:r>=e[s]&&(i=s-1,o=!0),!o){let c=1;for(;c<n&&!(e[c]>r||c===s);c++);i=c-1}const l=zd(e[i],e[i+1],r);return t[i](l)}}function lp(e,t,{clamp:n=!0,ease:s,mixer:r}={}){const i=e.length;pu(i===t.length),pu(!s||!Array.isArray(s)||s.length===i-1),e[0]>e[i-1]&&(e=[].concat(e),t=[].concat(t),e.reverse(),t.reverse());const o=PS(t,s,r),l=i===2?MS(e,o):kS(e,o);return n?c=>l(_l(e[0],e[i-1],c)):l}const mo=e=>t=>1-e(1-t),Rc=e=>t=>t<=.5?e(2*t)/2:(2-e(2*(1-t)))/2,DS=e=>t=>Math.pow(t,e),cp=e=>t=>t*t*((e+1)*t-e),FS=e=>{const t=cp(e);return n=>(n*=2)<1?.5*t(n):.5*(2-Math.pow(2,-10*(n-1)))},ap=1.525,LS=4/11,VS=8/11,BS=9/10,up=e=>e,Ic=DS(2),HS=mo(Ic),fp=Rc(Ic),hp=e=>1-Math.sin(Math.acos(e)),dp=mo(hp),jS=Rc(dp),Pc=cp(ap),$S=mo(Pc),US=Rc(Pc),WS=FS(ap),KS=4356/361,qS=35442/1805,GS=16061/1805,Li=e=>{if(e===1||e===0)return e;const t=e*e;return e<LS?7.5625*t:e<VS?9.075*t-9.9*e+3.4:e<BS?KS*t-qS*e+GS:10.8*e*e-20.52*e+10.72},zS=mo(Li),YS=e=>e<.5?.5*(1-Li(1-e*2)):.5*Li(e*2-1)+.5;function JS(e,t){return e.map(()=>t||fp).splice(0,e.length-1)}function XS(e){const t=e.length;return e.map((n,s)=>s!==0?s/(t-1):0)}function ZS(e,t){return e.map(n=>n*t)}function ui({from:e=0,to:t=1,ease:n,offset:s,duration:r=300}){const i={done:!1,value:e},o=Array.isArray(t)?t:[e,t],l=ZS(s&&s.length===o.length?s:XS(o),r);function c(){return lp(l,o,{ease:Array.isArray(n)?n:JS(o,n)})}let u=c();return{next:a=>(i.value=u(a),i.done=a>=r,i),flipTarget:()=>{o.reverse(),u=c()}}}function QS({velocity:e=0,from:t=0,power:n=.8,timeConstant:s=350,restDelta:r=.5,modifyTarget:i}){const o={done:!1,value:t};let l=n*e;const c=t+l,u=i===void 0?c:i(c);return u!==c&&(l=u-t),{next:a=>{const f=-l*Math.exp(-a/s);return o.done=!(f>r||f<-r),o.value=o.done?u:u+f,o},flipTarget:()=>{}}}const Su={keyframes:ui,spring:Ac,decay:QS};function eE(e){if(Array.isArray(e.to))return ui;if(Su[e.type])return Su[e.type];const t=new Set(Object.keys(e));return t.has("ease")||t.has("duration")&&!t.has("dampingRatio")?ui:t.has("dampingRatio")||t.has("stiffness")||t.has("mass")||t.has("damping")||t.has("restSpeed")||t.has("restDelta")?Ac:ui}function pp(e,t,n=0){return e-t-n}function tE(e,t,n=0,s=!0){return s?pp(t+-e,t,n):t-(e-t)+n}function nE(e,t,n,s){return s?e>=t+n:e<=-n}const sE=e=>{const t=({delta:n})=>e(n);return{start:()=>bl.update(t,!0),stop:()=>sS.update(t)}};function mp(e){let t,n,{from:s,autoplay:r=!0,driver:i=sE,elapsed:o=0,repeat:l=0,repeatType:c="loop",repeatDelay:u=0,onPlay:a,onStop:f,onComplete:d,onRepeat:h,onUpdate:m}=e,v=Gd(e,["from","autoplay","driver","elapsed","repeat","repeatType","repeatDelay","onPlay","onStop","onComplete","onRepeat","onUpdate"]);let{to:_}=v,S,g=0,p=v.duration,b,T=!1,R=!0,C;const A=eE(v);!((n=(t=A).needsInterpolation)===null||n===void 0)&&n.call(t,s,_)&&(C=lp([0,100],[s,_],{clamp:!1}),s=0,_=100);const w=A(Object.assign(Object.assign({},v),{from:s,to:_}));function N(){g++,c==="reverse"?(R=g%2===0,o=tE(o,p,u,R)):(o=pp(o,p,u),c==="mirror"&&w.flipTarget()),T=!1,h&&h()}function P(){S.stop(),d&&d()}function O(k){if(R||(k=-k),o+=k,!T){const $=w.next(Math.max(0,o));b=$.value,C&&(b=C(b)),T=R?$.done:o<=0}m==null||m(b),T&&(g===0&&(p??(p=o)),g<l?nE(o,p,u,R)&&N():P())}function V(){a==null||a(),S=i(O),S.start()}return r&&V(),{stop:()=>{f==null||f(),S.stop()}}}function gp(e,t){return t?e*(1e3/t):0}function rE({from:e=0,velocity:t=0,min:n,max:s,power:r=.8,timeConstant:i=750,bounceStiffness:o=500,bounceDamping:l=10,restDelta:c=1,modifyTarget:u,driver:a,onUpdate:f,onComplete:d,onStop:h}){let m;function v(p){return n!==void 0&&p<n||s!==void 0&&p>s}function _(p){return n===void 0?s:s===void 0||Math.abs(n-p)<Math.abs(s-p)?n:s}function S(p){m==null||m.stop(),m=mp(Object.assign(Object.assign({},p),{driver:a,onUpdate:b=>{let T;f==null||f(b),(T=p.onUpdate)===null||T===void 0||T.call(p,b)},onComplete:d,onStop:h}))}function g(p){S(Object.assign({type:"spring",stiffness:o,damping:l,restDelta:c},p))}if(v(e))g({from:e,velocity:t,to:_(e)});else{let p=r*t+e;typeof u<"u"&&(p=u(p));const b=_(p),T=b===n?-1:1;let R,C;const A=w=>{R=C,C=w,t=gp(w-R,qd().delta),(T===1&&w>b||T===-1&&w<b)&&g({from:w,to:b,velocity:t})};S({type:"decay",from:e,velocity:t,timeConstant:i,power:r,restDelta:c,modifyTarget:u,onUpdate:v(p)?A:void 0})}return{stop:()=>m==null?void 0:m.stop()}}const yp=(e,t)=>1-3*t+3*e,vp=(e,t)=>3*t-6*e,bp=e=>3*e,Vi=(e,t,n)=>((yp(t,n)*e+vp(t,n))*e+bp(t))*e,p=(e,t,n)=>3*yp(t,n)*e*e+2*vp(t,n)*e+bp(t),iE=1e-7,oE=10;function lE(e,t,n,s,r){let i,o,l=0;do o=t+(n-t)/2,i=Vi(o,s,r)-e,i>0?n=o:t=o;while(Math.abs(i)>iE&&++l<oE);return o}const cE=8,aE=.001;function uE(e,t,n,s){for(let r=0;r<cE;++r){const i=_p(t,n,s);if(i===0)return t;const o=Vi(t,n,s)-e;t-=o/i}return t}const fi=11,si=1/(fi-1);function fE(e,t,n,s){if(e===t&&n===s)return up;const r=new Float32Array(fi);for(let o=0;o<fi;++o)r[o]=Vi(o*si,e,n);function i(o){let l=0,c=1;const u=fi-1;for(;c!==u&&r[c]<=o;++c)l+=si;--c;const a=(o-r[c])/(r[c+1]-r[c]),f=l+a*si,d=_p(f,e,n);return d>=aE?uE(o,f,e,n):d===0?f:lE(o,l,l+si,e,n)}return o=>o===0||o===1?o:Vi(i(o),t,s)}const cn={},Lo={};class hE{constructor(){Ct(this,"subscriptions",new Set)}add(t){return this.subscriptions.add(t),()=>this.subscriptions.delete(t)}notify(t,n,s){if(this.subscriptions.size)for(const r of this.subscriptions)r(t,n,s)}clear(){this.subscriptions.clear()}}function Eu(e){return!Number.isNaN(Number.parseFloat(e))}class dE{constructor(t){Ct(this,"current");Ct(this,"prev");Ct(this,"timeDelta",0);Ct(this,"lastUpdated",0);Ct(this,"updateSubscribers",new hE);Ct(this,"stopAnimation");Ct(this,"canTrackVelocity",!1);Ct(this,"updateAndNotify",t=>{this.prev=this.current,this.current=t;const{delta:n,timestamp:s}=qd();this.lastUpdated!==s&&(this.timeDelta=n,this.lastUpdated=s),bl.postRender(this.scheduleVelocityCheck),this.updateSubscribers.notify(this.current)});Ct(this,"scheduleVelocityCheck",()=>bl.postRender(this.velocityCheck));Ct(this,"velocityCheck",({timestamp:t})=>{this.canTrackVelocity||(this.canTrackVelocity=Eu(this.current)),t!==this.lastUpdated&&(this.prev=this.current)});this.prev=this.current=t,this.canTrackVelocity=Eu(this.current)}onChange(t){return this.updateSubscribers.add(t)}clearListeners(){this.updateSubscribers.clear()}set(t){this.updateAndNotify(t)}get(){return this.current}getPrevious(){return this.prev}getVelocity(){return this.canTrackVelocity?gp(Number.parseFloat(this.current)-Number.parseFloat(this.prev),this.timeDelta):0}start(t){return this.stop(),new Promise(n=>{const{stop:s}=t(n);this.stopAnimation=s}).then(()=>this.clearAnimation())}stop(){this.stopAnimation&&this.stopAnimation(),this.clearAnimation()}isAnimating(){return!!this.stopAnimation}clearAnimation(){this.stopAnimation=null}destroy(){this.updateSubscribers.clear(),this.stop()}}function pE(e){return new dE(e)}const{isArray:mE}=Array;function gE(){const e=Le({}),t=s=>{const r=i=>{e.value[i]&&(e.value[i].stop(),e.value[i].destroy(),delete e.value[i])};s?mE(s)?s.forEach(r):r(s):Object.keys(e.value).forEach(r)},n=(s,r,i)=>{if(e.value[s])return e.value[s];const o=pE(r);return o.onChange(l=>i[s]=l),e.value[s]=o,o};return I_(t),{motionValues:e,get:n,stop:t}}function yE(e){return Array.isArray(e)}function Fn(){return{type:"spring",stiffness:500,damping:25,restDelta:.5,restSpeed:10}}function Vo(e){return{type:"spring",stiffness:550,damping:e===0?2*Math.sqrt(550):30,restDelta:.01,restSpeed:10}}function vE(e){return{type:"spring",stiffness:550,damping:e===0?100:30,restDelta:.01,restSpeed:10}}function Bo(){return{type:"keyframes",ease:"linear",duration:300}}function bE(e){return{type:"keyframes",duration:800,values:e}}const Tu={default:vE,x:Fn,y:Fn,z:Fn,rotate:Fn,rotateX:Fn,rotateY:Fn,rotateZ:Fn,scaleX:Vo,scaleY:Vo,scale:Vo,backgroundColor:Bo,color:Bo,opacity:Bo};function Sp(e,t){let n;return yE(t)?n=bE:n=Tu[e]||Tu.default,{to:t,...n(t)}}const wu={...Hr,transform:Math.round},Ep={color:ft,backgroundColor:ft,outlineColor:ft,fill:ft,stroke:ft,borderColor:ft,borderTopColor:ft,borderRightColor:ft,borderBottomColor:ft,borderLeftColor:ft,borderWidth:le,borderTopWidth:le,borderRightWidth:le,borderBottomWidth:le,borderLeftWidth:le,borderRadius:le,radius:le,borderTopLeftRadius:le,borderTopRightRadius:le,borderBottomRightRadius:le,borderBottomLeftRadius:le,width:le,maxWidth:le,height:le,maxHeight:le,size:le,top:le,right:le,bottom:le,left:le,padding:le,paddingTop:le,paddingRight:le,paddingBottom:le,paddingLeft:le,margin:le,marginTop:le,marginRight:le,marginBottom:le,marginLeft:le,rotate:Dn,rotateX:Dn,rotateY:Dn,rotateZ:Dn,scale:ni,scaleX:ni,scaleY:ni,scaleZ:ni,skew:Dn,skewX:Dn,skewY:Dn,distance:le,translateX:le,translateY:le,translateZ:le,x:le,y:le,z:le,perspective:le,transformPerspective:le,opacity:rr,originX:yu,originY:yu,originZ:le,zIndex:wu,filter:wl,WebkitFilter:wl,fillOpacity:rr,strokeOpacity:rr,numOctaves:wu},Mc=e=>Ep[e];function Cl(e,t){return t&&typeof e=="number"&&t.transform?t.transform(e):e}function _E(e,t){let n=Mc(e);return n!==wl&&(n=jr),n.getAnimatableNone?n.getAnimatableNone(t):void 0}const SE={linear:up,easeIn:Ic,easeInOut:fp,easeOut:HS,circIn:hp,circInOut:jS,circOut:dp,backIn:Pc,backInOut:US,backOut:$S,anticipate:WS,bounceIn:zS,bounceInOut:YS,bounceOut:Li};function Cu(e){if(Array.isArray(e)){const[t,n,s,r]=e;return fE(t,n,s,r)}else if(typeof e=="string")return SE[e];return e}function EE(e){return Array.isArray(e)&&typeof e[0]!="number"}function Au(e,t){return e==="zIndex"?!1:!!(typeof t=="number"||Array.isArray(t)||typeof t=="string"&&jr.test(t)&&!t.startsWith("url("))}function TE(e){return Array.isArray(e.to)&&e.to[0]===null&&(e.to=[...e.to],e.to[0]=e.from),e}function wE({ease:e,times:t,delay:n,...s}){const r={...s};return t&&(r.offset=t),e&&(r.ease=EE(e)?e.map(Cu):Cu(e)),n&&(r.elapsed=-n),r}function CE(e,t,n){return Array.isArray(t.to)&&(e.duration||(e.duration=800)),TE(t),AE(e)||(e={...e,...Sp(n,t.to)}),{...t,...wE(e)}}function AE({delay:e,repeat:t,repeatType:n,repeatDelay:s,from:r,...i}){return!!Object.keys(i).length}function OE(e,t){return e[t]||e.default||e}function NE(e,t,n,s,r){const i=OE(s,e);let o=i.from===null||i.from===void 0?t.get():i.from;const l=Au(e,n);o==="none"&&l&&typeof n=="string"&&(o=_E(e,n));const c=Au(e,o);function u(f){const d={from:o,to:n,velocity:s.velocity?s.velocity:t.getVelocity(),onUpdate:h=>t.set(h)};return i.type==="inertia"||i.type==="decay"?rE({...d,...i}):mp({...CE(i,d,e),onUpdate:h=>{d.onUpdate(h),i.onUpdate&&i.onUpdate(h)},onComplete:()=>{r&&r(),f&&f()}})}function a(f){return t.set(n),r&&r(),f&&f(),{stop:()=>{}}}return!c||!l||i.type===!1?a:u}function xE(){const{motionValues:e,stop:t,get:n}=gE();return{motionValues:e,stop:t,push:(r,i,o,l={},c)=>{const u=o[r],a=n(r,u,o);if(l&&l.immediate){a.set(i);return}const f=NE(r,a,i,l,c);a.start(f)}}}function RE(e,t={},{motionValues:n,push:s,stop:r}=xE()){const i=Ke(t),o=Le(!1);de(n,f=>{o.value=Object.values(f).filter(d=>d.isAnimating()).length>0},{immediate:!0,deep:!0});const l=f=>{if(!i||!i[f])throw new Error(`The variant ${f} does not exist.`);return i[f]},c=f=>{typeof f=="string"&&(f=l(f));const d=Object.entries(f).map(([m,v])=>{if(m!=="transition")return new Promise(_=>s(m,v,e,f.transition||Sp(m,f[m]),_))}).filter(Boolean);async function h(){let m,v;await Promise.all(d),(v=(m=f.transition)==null?void 0:m.onComplete)==null||v.call(m)}return Promise.all([h()])};return{isAnimating:o,apply:c,set:f=>{const d=Fi(f)?f:l(f);Object.entries(d).forEach(([h,m])=>{h!=="transition"&&s(h,m,e,{immediate:!0})})},leave:async f=>{let d;if(i&&(i.leave&&(d=i.leave),!i.leave&&i.initial&&(d=i.initial)),!d){f();return}await c(d),f()},stop:r}}const kc=typeof window<"u",IE=()=>kc&&(window.onpointerdown===null||(cn==null?void 0:cn.TEST)),PE=()=>kc&&(window.ontouchstart===null||(cn==null?void 0:cn.TEST)),ME=()=>kc&&(window.onmousedown===null||(cn==null?void 0:cn.TEST));function kE({target:e,state:t,variants:n,apply:s}){const r=Ke(n),i=Le(!1),o=Le(!1),l=Le(!1),c=oe(()=>{let a=[...Object.keys(t.value||{})];return r&&(r.hovered&&(a=[...a,...Object.keys(r.hovered)]),r.tapped&&(a=[...a,...Object.keys(r.tapped)]),r.focused&&(a=[...a,...Object.keys(r.focused)])),a}),u=oe(()=>{const a={};Object.assign(a,t.value),i.value&&r.hovered&&Object.assign(a,r.hovered),o.value&&r.tapped&&Object.assign(a,r.tapped),l.value&&r.focused&&Object.assign(a,r.focused);for(const f in a)c.value.includes(f)||delete a[f];return a});r.hovered&&(se(e,"mouseenter",()=>i.value=!0),se(e,"mouseleave",()=>{i.value=!1,o.value=!1})),r.tapped&&(ME()&&(se(e,"mousedown",()=>o.value=!0),se(e,"mouseup",()=>o.value=!1)),IE()&&(se(e,"pointerdown",()=>o.value=!0),se(e,"pointerup",()=>o.value=!1)),PE()&&(se(e,"touchstart",()=>o.value=!0),se(e,"touchend",()=>o.value=!1))),r.focused&&(se(e,"focus",()=>l.value=!0),se(e,"blur",()=>l.value=!1)),de([i,o,l],()=>{s(u.value)})}function DE({set:e,target:t,variants:n,variant:s}){const r=Ke(n);de(()=>t,()=>{r&&(r.initial&&(e("initial"),s.value="initial"),r.enter&&(s.value="enter"))},{immediate:!0,flush:"pre"})}function FE({state:e,apply:t}){de(e,n=>{n&&t(n)},{immediate:!0})}function Tp({target:e,variants:t,variant:n}){const s=Ke(t);s&&(s.visible||s.visibleOnce)&&z_(e,([{isIntersecting:r}])=>{s.visible?r?n.value="visible":n.value="initial":s.visibleOnce&&(r&&n.value!=="visibleOnce"?n.value="visibleOnce":n.value||(n.value="initial"))})}function LE(e,t={syncVariants:!0,lifeCycleHooks:!0,visibilityHooks:!0,eventListeners:!0}){t.lifeCycleHooks&&DE(e),t.syncVariants&&FE(e),t.visibilityHooks&&Tp(e),t.eventListeners&&kE(e)}function wp(e={}){const t=gt({...e}),n=Le({});return de(t,()=>{const s={};for(const[r,i]of Object.entries(t)){const o=Mc(r),l=Cl(i,o);s[r]=l}n.value=s},{immediate:!0,deep:!0}),{state:t,style:n}}function Dc(e,t){de(()=>Me(e),n=>{n&&t(n)},{immediate:!0})}const VE={x:"translateX",y:"translateY",z:"translateZ"};function Cp(e={},t=!0){const n=gt({...e}),s=Le("");return de(n,r=>{let i="",o=!1;if(t&&(r.x||r.y||r.z)){const l=[r.x||0,r.y||0,r.z||0].map(c=>Cl(c,le)).join(",");i+=`translate3d(${l}) `,o=!0}for(const[l,c]of Object.entries(r)){if(t&&(l==="x"||l==="y"||l==="z"))continue;const u=Mc(l),a=Cl(c,u);i+=`${VE[l]||l}(${a}) `}t&&!o&&(i+="translateZ(0px) "),s.value=i.trim()},{immediate:!0,deep:!0}),{state:n,transform:s}}const BE=["","X","Y","Z"],HE=["perspective","translate","scale","rotate","skew"],Ap=["transformPerspective","x","y","z"];HE.forEach(e=>{BE.forEach(t=>{const n=e+t;Ap.push(n)})});const jE=new Set(Ap);function Fc(e){return jE.has(e)}const $E=new Set(["originX","originY","originZ"]);function Op(e){return $E.has(e)}function UE(e){const t={},n={};return Object.entries(e).forEach(([s,r])=>{Fc(s)||Op(s)?t[s]=r:n[s]=r}),{transform:t,style:n}}function WE(e){const{transform:t,style:n}=UE(e),{transform:s}=Cp(t),{style:r}=wp(n);return s.value&&(r.value.transform=s.value),r.value}function KE(e,t){let n,s;const{state:r,style:i}=wp();return Dc(e,o=>{s=o;for(const l of Object.keys(Ep))o.style[l]===null||o.style[l]===""||Fc(l)||Op(l)||(r[l]=o.style[l]);n&&Object.entries(n).forEach(([l,c])=>o.style[l]=c),t&&t(r)}),de(i,o=>{if(!s){n=o;return}for(const l in o)s.style[l]=o[l]},{immediate:!0}),{style:r}}function qE(e){const t=e.trim().split(/\) |\)/);if(t.length===1)return{};const n=s=>s.endsWith("px")||s.endsWith("deg")?Number.parseFloat(s):Number.isNaN(Number(s))?Number(s):s;return t.reduce((s,r)=>{if(!r)return s;const[i,o]=r.split("("),c=o.split(",").map(a=>n(a.endsWith(")")?a.replace(")",""):a.trim())),u=c.length===1?c[0]:c;return{...s,[i]:u}},{})}function GE(e,t){Object.entries(qE(t)).forEach(([n,s])=>{const r=["x","y","z"];if(n==="translate3d"){if(s===0){r.forEach(i=>e[i]=0);return}s.forEach((i,o)=>e[r[o]]=i);return}if(s=Number.parseFloat(`${s}`),n==="translateX"){e.x=s;return}if(n==="translateY"){e.y=s;return}if(n==="translateZ"){e.z=s;return}e[n]=s})}function zE(e,t){let n,s;const{state:r,transform:i}=Cp();return Dc(e,o=>{s=o,o.style.transform&&GE(r,o.style.transform),n&&(o.style.transform=n),t&&t(r)}),de(i,o=>{if(!s){n=o;return}s.style.transform=o},{immediate:!0}),{transform:r}}function YE(e){return Object.entries(e)}function JE(e,t){const n=gt({}),s=o=>Object.entries(o).forEach(([l,c])=>n[l]=c),{style:r}=KE(e,s),{transform:i}=zE(e,s);return de(n,o=>{YE(o).forEach(([l,c])=>{const u=Fc(l)?i:r;u[l]&&u[l]===c||(u[l]=c)})},{immediate:!0,deep:!0}),Dc(e,()=>t),{motionProperties:n,style:r,transform:i}}function XE(e={}){const t=Ke(e),n=Le();return{state:oe(()=>{if(n.value)return t[n.value]}),variant:n}}function ZE(e,t={},n){const{motionProperties:s}=JE(e),{variant:r,state:i}=XE(t),o=RE(s,t),l={target:e,variant:r,variants:t,state:i,motionProperties:s,...o};return LE(l,n),l}const Np=["delay","duration"],QE=["initial","enter","leave","visible","visible-once","visibleOnce","hovered","tapped","focused",...Np];function e1(e){return Np.includes(e)}function t1(e,t){const n=e.props?e.props:e.data&&e.data.attrs?e.data.attrs:{};if(n){n.variants&&Fi(n.variants)&&(t.value={...t.value,...n.variants});for(let s of QE)if(!(!n||!n[s])){if(e1(s)&&typeof n[s]=="number"){for(const r of["enter","visible","visibleOnce"]){const i=t.value[r];i!=null&&(i.transition??(i.transition={}),i.transition[s]=n[s])}continue}if(Fi(n[s])){const r=n[s];s==="visible-once"&&(s="visibleOnce"),t.value[s]=r}}}}function D1(e,t=!1){return{created:(r,i,o)=>{const l=i.value&&typeof i.value=="string"?i.value:o.key;l&&Lo[l]&&Lo[l].stop();const c=t?structuredClone(fe(e)||{}):{},u=Le(c);typeof i.value=="object"&&(u.value=i.value),t1(o,u);const f=ZE(r,u,{eventListeners:!0,lifeCycleHooks:!0,syncVariants:!0,visibilityHooks:!1});r.motionInstance=f,l&&(Lo[l]=f)},mounted:(r,i,o)=>{r.motionInstance&&Tp(r.motionInstance)},getSSRProps(r,i){let{initial:o}=r.value||i&&(i==null?void 0:i.props)||{};o=Ke(o);const l=Q_({},{},o||{});return!l||Object.keys(l).length===0?void 0:{style:WE(l)}}}}function F1(...e){return oe(()=>e.every(t=>re(t)))}function L1(e){return oe(()=>!re(e))}function V1(...e){return oe(()=>e.some(t=>re(t)))}export{$m as $,dn as A,F1 as B,Pe as C,L1 as D,V1 as E,We as F,Xu as G,Fg as H,th as I,xn as J,mg as K,Nr as L,Up as M,Or as N,f1 as O,bf as P,to as Q,m1 as R,_f as S,Cn as T,g1 as U,ns as V,Du as W,Mr as X,mr as Y,Um as Z,l1 as _,Ly as a,gt as a0,Le as a1,Sg as a2,Tg as a3,vg as a4,_g as a5,bg as a6,Ml as a7,te as a8,u1 as a9,d1 as aA,I1 as aB,P1 as aC,M1 as aD,k1 as aE,Ql as aF,Oi as aG,yh as aH,de as aI,Vl as aJ,p1 as aK,Fl as aL,Km as aM,bv as aN,yv as aO,Wm as aP,Pu as aa,fe as ab,a1 as ac,ef as ad,re as ae,Ke as af,y1 as ag,b1 as ah,_1 as ai,E1 as aj,T1 as ak,w1 as al,se as am,C1 as an,h1 as ao,P_ as ap,A1 as aq,O1 as ar,qg as as,N1 as at,x1 as au,S1 as av,o1 as aw,i1 as ax,R1 as ay,eg as az,cv as b,v1 as c,oe as d,sl as e,Jl as f,Si as g,eh as h,dy as i,r1 as j,c1 as k,Xl as l,Ne as m,s1 as n,dg as o,Ir as p,D1 as q,Ve as r,Qf as s,ro as t,Ll as u,St as v,__ as w,Nn as x,qt as y,we as z};
