// Minimal DOM stub for vm-loaded frontend modules (skill-editor, skill-md-editor tests).
// ---- minimal DOM stub: elements built with createElement; querySelector on [attr="v"] / [attr] / tag ----
export class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null; this.attributes = {};
    this.style = {}; this._l = {}; this._text = ''; this.value = ''; this.hidden = false; this.disabled = false;
    this.readOnly = false; this.className = '';
    const self = this;
    this.classList = {
      add: (...c) => { const s = new Set(self.className.split(/\s+/).filter(Boolean)); c.forEach((x) => s.add(x)); self.className = [...s].join(' '); },
      remove: (...c) => { self.className = self.className.split(/\s+/).filter((x) => x && !c.includes(x)).join(' '); },
      contains: (c) => self.className.split(/\s+/).includes(c),
      toggle: (c, on) => { const has = self.classList.contains(c); const want = on === undefined ? !has : !!on; if (want && !has) self.classList.add(c); if (!want && has) self.classList.remove(c); return want; },
    };
  }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
  append(...cs) { for (const c of cs) this.appendChild(typeof c === 'string' ? Object.assign(new El('#text'), { _text: c }) : c); }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  replaceChildren(...cs) { for (const c of [...this.children]) this.removeChild(c); this.append(...cs); }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; }
  addEventListener(t, f) { (this._l[t] = this._l[t] || []).push(f); }
  dispatch(t, extra = {}) { for (const f of this._l[t] || []) f({ type: t, target: this, preventDefault() {}, stopPropagation() {}, ...extra }); }
  click() { if (!this.disabled) this.dispatch('click'); }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this.children = []; this._text = String(v); }
  get id() { return this.attributes.id || ''; }
  set id(v) { this.attributes.id = v; }
  get dataset() { return {}; }
  focus() {}
  *walk() { for (const c of this.children) { yield c; yield* c.walk(); } }
  matches(sel) {
    if (sel.includes(',')) return sel.split(',').some((x) => this.matches(x.trim()));
    const m = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(sel);
    if (m) return m[2] === undefined ? m[1] in this.attributes : this.attributes[m[1]] === m[2];
    return this.tagName === sel.toUpperCase();
  }
  querySelector(sel) { for (const e of this.walk()) if (e.matches(sel)) return e; return null; }
  querySelectorAll(sel) { return [...this.walk()].filter((e) => e.matches(sel)); }
}

export function makeDom() {
  const body = new El('body');
  const document = {
    body,
    createElement: (t) => new El(t),
    getElementById: (id) => body.querySelector(`[id="${id}"]`),
    addEventListener() {}, removeEventListener() {},
  };
  return document;
}

