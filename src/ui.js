const $ = (sel) => document.querySelector(sel);
const MAX_CARDS = 3;

/** All DOM-side presentation: cards, captions, toasts, mic button. */
export class UI {
  constructor() {
    this.content = $('#content');
    this.cards = $('#cards');
    this.slot = $('#sketch-slot');
    this.title = $('#sketch-title');
    this.caption = $('#caption');
    this.mic = $('#mic');
    this.badge = $('#badge');
    this.toastEl = $('#toast');
    this.heard = $('#heard'); // no longer on the page: the transcript is trusted and not shown
    this.onHeardClick = () => {};
    this.dock = $('#dock');
    this.textInput = $('#text');
    this.sendBtn = $('#send');
    this.skipBtn = $('#skip');
    this.placeholder = this.textInput.placeholder;
    this.sketchOn = false;
    this.onCardClick = () => {};
    this.onClearContent = () => {};
    this.stepsEl = null;
    this.toastTimer = null;
  }

  hasContent() {
    return this.cards.children.length > 0 || this.sketchOn;
  }

  updateLayout() {
    const c = this.cards.children.length > 0;
    const s = this.sketchOn;
    this.content.dataset.layout = c && s ? 'both' : c ? 'cards' : s ? 'sketch' : 'none';
  }

  addCard({ target, transliteration, english, note }) {
    if (!target) return;
    const el = document.createElement('div');
    el.className = 'card';
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', `Hear ${target} again`);
    const part = (cls, text) => {
      if (!text) return;
      const d = document.createElement('div');
      d.className = cls;
      d.textContent = text;
      el.appendChild(d);
    };
    part('ka', target);
    part('tr', transliteration);
    part('en', english);
    part('note', note);
    const play = document.createElement('div');
    play.className = 'play';
    play.textContent = '🔊';
    el.appendChild(play);
    const fire = () => this.onCardClick(target);
    el.addEventListener('click', fire);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') fire();
    });
    this.cards.appendChild(el);
    while (this.cards.children.length > MAX_CARDS) this.cards.firstElementChild.remove();
    this.updateLayout();
  }

  /** A read-only list card (shopping, todo...). Replaces an earlier card for the same list. */
  addChecklist({ title, items }) {
    const list = Array.isArray(items) ? items.map(String).slice(0, 30) : [];
    for (const old of [...this.cards.querySelectorAll('.checklist')]) if (old.dataset.title === String(title)) old.remove();
    const el = document.createElement('div');
    el.className = 'card checklist';
    el.dataset.title = String(title || '');
    const h = document.createElement('div');
    h.className = 'list-title';
    h.textContent = (title || 'List').replace(/^./, (c) => c.toUpperCase());
    el.appendChild(h);
    if (!list.length) {
      const e = document.createElement('div');
      e.className = 'note';
      e.textContent = 'Nothing here yet.';
      el.appendChild(e);
    }
    for (const it of list) {
      const row = document.createElement('div');
      row.className = 'check-row';
      row.textContent = '☐  ' + it;
      el.appendChild(row);
    }
    this.cards.appendChild(el);
    while (this.cards.children.length > MAX_CARDS) this.cards.firstElementChild.remove();
    this.updateLayout();
  }

  /** The one-step-at-a-time card for recipes and instructions. */
  setSteps(state, { onPrev, onNext, onClose } = {}) {
    if (!state) {
      this.stepsEl?.remove();
      this.stepsEl = null;
      this.updateLayout();
      return;
    }
    if (!this.stepsEl) {
      for (const old of [...this.cards.children]) old.remove();
      const el = document.createElement('div');
      el.className = 'card steps';
      el.innerHTML = '<div class="steps-head"><span class="steps-title"></span><span class="steps-count"></span></div><div class="step-text"></div><div class="steps-bar"><div class="steps-fill"></div></div><div class="steps-actions"><button type="button" data-a="prev">◀ Back</button><button type="button" data-a="next">Next ▶</button><button type="button" data-a="close">✕</button></div>';
      el.addEventListener('click', (e) => {
        const a = e.target.closest('button')?.dataset.a;
        if (a === 'prev') onPrev?.();
        else if (a === 'next') onNext?.();
        else if (a === 'close') onClose?.();
      });
      this.cards.appendChild(el);
      this.stepsEl = el;
    }
    const el = this.stepsEl;
    el.querySelector('.steps-title').textContent = state.title;
    el.querySelector('.steps-count').textContent = `Step ${state.index} of ${state.total}`;
    el.querySelector('.step-text').textContent = state.text;
    el.querySelector('.steps-fill').style.width = `${(state.index / state.total) * 100}%`;
    el.querySelector('[data-a="prev"]').disabled = state.index <= 1;
    el.querySelector('[data-a="next"]').disabled = state.index >= state.total;
    this.updateLayout();
  }

  showSketch(spec) {
    this.sketchOn = true;
    this.title.textContent = spec?.title || '';
    this.updateLayout();
  }

  clearContent() {
    this.stepsEl = null;
    this.onClearContent();
    for (const el of [...this.cards.children]) {
      el.classList.add('out');
      setTimeout(() => {
        el.remove();
        this.updateLayout();
      }, 250);
    }
    this.sketchOn = false;
    this.title.textContent = '';
    this.updateLayout();
  }

  setCaption(text, kind = '') {
    this.caption.textContent = text || '';
    this.caption.className = kind;
  }

  /** Shows what speech recognition heard, so she can see (and fix) mistakes. */
  setHeard(text, { uncertain = false } = {}) {
    if (!this.heard) return;
    this.heard.textContent = '';
    this.heard.classList.toggle('uncertain', uncertain);
    if (!text) return;
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = uncertain ? 'Heard (not sure):' : 'Heard:';
    const q = document.createElement('span');
    q.className = 'said';
    q.textContent = ' ' + text;
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.textContent = 'edit';
    edit.addEventListener('click', () => this.onHeardClick(text));
    this.heard.append(label, q, edit);
  }

  /** While the companion is thinking/speaking (or her speech is being transcribed) input is locked. */
  setLocked(locked, canSkip) {
    this.dock.classList.toggle('locked', locked);
    this.mic.disabled = locked;
    this.sendBtn.disabled = locked;
    this.textInput.disabled = locked;
    this.textInput.placeholder = locked ? (canSkip ? 'Let me finish, or press Skip…' : 'One moment…') : this.placeholder;
    this.skipBtn.hidden = !(locked && canSkip);
  }

  setMicActive(on) {
    this.mic.classList.toggle('active', on);
  }

  setBadge(text) {
    this.badge.hidden = !text;
    this.badge.textContent = text || '';
  }

  toast(msg) {
    this.toastEl.textContent = msg;
    this.toastEl.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => (this.toastEl.hidden = true), 6000);
  }
}
