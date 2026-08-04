/**
 * SheetView — the DOM/interaction controller. It owns the shadow-root DOM, drives
 * the SheetMachine, wires the host callbacks, and implements a11y (focus trap +
 * restore, roles, keyboard, aria-live) and motion (F1-D8,D9). It never touches the
 * network — only `host.*`.
 */
import { EMOJI_FACES } from './assets/emoji.js';
import type { NormalizedConfig } from './config.js';
import type { DismissReason, SheetHost } from './host.js';
import { SheetMachine } from './machine.js';
import { MAX_BYTES, processPhoto } from './photo.js';
import type { Answer } from './types.js';

const COMMENT_MAX = 2000;

/** Defaults for the post-submit "Thanks" state when the action carries no message. */
const DEFAULT_THANKS_TITLE = 'Thanks — that helps.';
const DEFAULT_THANKS_SUB = 'Your feedback goes straight to the product team.';

/** Green check mark inside the pale-green circle (matches the reference). */
const CHECK_SVG =
  '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">' +
  '<path d="M5 12.5 L10 17.5 L19 7" fill="none" stroke="#2E8F52" stroke-width="2.6" ' +
  'stroke-linecap="round" stroke-linejoin="round"/></svg>';

export interface SheetViewOptions {
  /** Called once the sheet is fully removed (singleton cleanup in mount). */
  onTeardown?: () => void;
}

export class SheetView {
  private readonly machine: SheetMachine;
  private readonly root: ShadowRoot;
  private readonly backdrop: HTMLDivElement;
  private readonly sheet: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly live: HTMLDivElement;
  private readonly previouslyFocused: Element | null;
  private readonly opts: SheetViewOptions;
  private closed = false;
  private objectUrl: string | null = null;
  private uploading = false;
  private autoCloseTimer: ReturnType<typeof setTimeout> | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private readonly onKeydown: EventListener;

  constructor(
    root: ShadowRoot,
    private readonly cfg: NormalizedConfig,
    private readonly host: SheetHost,
    opts: SheetViewOptions = {},
  ) {
    this.root = root;
    this.opts = opts;
    this.machine = new SheetMachine(cfg);
    // Focus to restore on close: the host document's active element before open.
    const hostDoc = root.host.ownerDocument;
    this.previouslyFocused = hostDoc?.activeElement ?? null;

    this.backdrop = document.createElement('div');
    this.backdrop.className = 'sig-backdrop';
    this.backdrop.setAttribute('data-open', 'false');

    this.sheet = document.createElement('div');
    this.sheet.className = 'sig-sheet';
    this.sheet.setAttribute('role', 'dialog');
    this.sheet.setAttribute('aria-modal', 'true');
    this.sheet.setAttribute('aria-label', cfg.header);

    const grabber = document.createElement('div');
    grabber.className = 'sig-grabber';
    this.sheet.appendChild(grabber);

    this.body = document.createElement('div');
    this.sheet.appendChild(this.body);

    this.live = document.createElement('div');
    this.live.className = 'sig-visually-hidden';
    this.live.setAttribute('aria-live', 'polite');
    this.live.setAttribute('role', 'status');
    this.sheet.appendChild(this.live);

    this.backdrop.appendChild(this.sheet);
    root.appendChild(this.backdrop);

    this.backdrop.addEventListener('pointerdown', (e) => {
      if (e.target === this.backdrop) this.dismiss('backdrop');
    });

    this.onKeydown = (e) => this.handleKeydown(e as KeyboardEvent);
    this.backdrop.addEventListener('keydown', this.onKeydown, true);

    if (typeof ResizeObserver !== 'undefined' && this.host.onResize) {
      this.resizeObserver = new ResizeObserver(() => {
        this.host.onResize?.(this.sheet.offsetHeight);
      });
      this.resizeObserver.observe(this.sheet);
    }

    this.renderRating();
    // Open on next frame so the enter transition runs.
    requestAnimationFrame(() => {
      this.backdrop.setAttribute('data-open', 'true');
      this.focusFirst();
    });
  }

  // ---- rendering per state ------------------------------------------------

  private clearBody(): void {
    this.body.replaceChildren();
  }

  private header(withClose = true): HTMLDivElement {
    const header = document.createElement('div');
    header.className = 'sig-header';
    const q = document.createElement('h2');
    q.className = 'sig-question';
    q.textContent = this.cfg.header;
    header.appendChild(q);
    if (withClose) {
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'sig-close';
      close.setAttribute('aria-label', 'Dismiss');
      // Glyph is drawn via CSS (.sig-close::before) so the 44px touch target
      // wraps a 26px visible circle.
      close.addEventListener('click', () => this.dismiss('backdrop'));
      header.appendChild(close);
    }
    return header;
  }

  private renderRating(): void {
    this.clearBody();
    this.body.appendChild(this.header());

    const group = document.createElement('div');
    group.className = 'sig-faces';
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', this.cfg.header);

    EMOJI_FACES.forEach((face, idx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sig-face';
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', 'false');
      btn.setAttribute('aria-label', face.label);
      btn.dataset.value = String(face.value);
      btn.tabIndex = idx === 0 ? 0 : -1;
      btn.innerHTML = face.svg;
      btn.addEventListener('click', () => this.pickRating(face.value));
      group.appendChild(btn);
    });

    this.body.appendChild(group);

    const hint = document.createElement('p');
    hint.className = 'sig-hint';
    hint.textContent = 'One tap';
    this.body.appendChild(hint);
  }

  private faces(): HTMLButtonElement[] {
    return Array.from(this.body.querySelectorAll<HTMLButtonElement>('.sig-face'));
  }

  private pickRating(value: number): void {
    if (this.machine.state !== 'rating') return; // debounce double-tap
    this.machine.selectRating(value);
    for (const b of this.faces()) {
      const checked = Number(b.dataset.value) === value;
      b.setAttribute('aria-checked', checked ? 'true' : 'false');
      b.tabIndex = checked ? 0 : -1;
    }
    // Advance: tapping a face is the advance affordance (F1 rating edge cases).
    const next = this.machine.advanceFromRating();
    if (next === 'detail') this.renderDetail();
    else if (next === 'submitting') this.runSubmit();
  }

  private renderDetail(): void {
    this.clearBody();
    this.body.appendChild(this.header());

    const branch = document.createElement('div');
    branch.className = 'sig-branch';

    let textarea: HTMLTextAreaElement | null = null;
    let errorEl: HTMLDivElement | null = null;

    // Comment (shown when required or when image not the only capture).
    const showComment = true; // negative branch always offers a comment in v1
    if (showComment) {
      const field = document.createElement('div');
      field.className = 'sig-field';
      const label = document.createElement('label');
      label.className = 'sig-label';
      label.textContent = this.cfg.other_requires_text ? 'Tell us more (required)' : 'Tell us more';
      const ta = document.createElement('textarea');
      ta.className = 'sig-textarea';
      ta.maxLength = COMMENT_MAX;
      ta.setAttribute('aria-label', 'Comment');
      label.htmlFor = 'sig-comment';
      ta.id = 'sig-comment';
      const counter = document.createElement('div');
      counter.className = 'sig-counter';
      counter.textContent = `0 / ${COMMENT_MAX}`;
      ta.addEventListener('input', () => {
        this.machine.setComment(ta.value);
        counter.textContent = `${ta.value.length} / ${COMMENT_MAX}`;
        if (errorEl) errorEl.textContent = '';
        this.syncDetailSubmit(submitBtn);
      });
      field.append(label, ta, counter);
      errorEl = document.createElement('div');
      errorEl.className = 'sig-error';
      errorEl.setAttribute('role', 'alert');
      field.appendChild(errorEl);
      branch.appendChild(field);
      textarea = ta;
    }

    // Photo (F1-D7) — only if allowed.
    if (this.cfg.other_allows_image) {
      branch.appendChild(this.buildPhotoField());
    }

    // Actions
    const actions = document.createElement('div');
    actions.className = 'sig-actions';
    const submitBtn = document.createElement('button');
    submitBtn.type = 'button';
    submitBtn.className = 'sig-btn sig-btn-primary';
    submitBtn.textContent = 'Submit';
    submitBtn.addEventListener('click', () => {
      if (this.uploading) return;
      if (!this.machine.canSubmitDetail()) {
        if (errorEl) errorEl.textContent = 'Please add a comment before submitting.';
        textarea?.focus();
        return;
      }
      const next = this.machine.advanceFromDetail();
      if (next === 'submitting') this.runSubmit();
    });
    actions.appendChild(submitBtn);
    branch.appendChild(actions);

    this.body.appendChild(branch);
    this.syncDetailSubmit(submitBtn);
    textarea?.focus();
  }

  private syncDetailSubmit(btn: HTMLButtonElement): void {
    btn.disabled = this.uploading || !this.machine.canSubmitDetail();
  }

  private buildPhotoField(): HTMLDivElement {
    const field = document.createElement('div');
    field.className = 'sig-field';
    const label = document.createElement('div');
    label.className = 'sig-label';
    label.textContent = 'Add a photo';
    field.appendChild(label);

    const row = document.createElement('div');
    row.className = 'sig-photo-row';

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/jpeg,image/png,image/webp';
    input.className = 'sig-hidden-file';

    const attachBtn = document.createElement('button');
    attachBtn.type = 'button';
    attachBtn.className = 'sig-btn sig-btn-ghost';
    attachBtn.textContent = 'Attach';
    attachBtn.style.flex = 'none';
    attachBtn.addEventListener('click', () => input.click());

    const thumb = document.createElement('img');
    thumb.className = 'sig-thumb';
    thumb.alt = 'Attached photo preview';
    thumb.hidden = true;

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'sig-btn sig-btn-ghost';
    removeBtn.textContent = 'Remove';
    removeBtn.style.flex = 'none';
    removeBtn.hidden = true;

    const status = document.createElement('div');
    status.className = 'sig-error sig-photo-status';
    status.setAttribute('role', 'alert');

    const submitBtn = () => this.body.querySelector<HTMLButtonElement>('.sig-btn-primary') ?? null;

    const clearPhoto = () => {
      this.machine.setImageUrl(null);
      if (this.objectUrl) {
        URL.revokeObjectURL(this.objectUrl);
        this.objectUrl = null;
      }
      thumb.hidden = true;
      thumb.removeAttribute('src');
      removeBtn.hidden = true;
      input.value = '';
    };

    removeBtn.addEventListener('click', clearPhoto);

    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      status.textContent = '';
      const processed = await processPhoto(file);
      if (!processed.ok) {
        status.textContent =
          processed.reason === 'type'
            ? 'Please attach a JPG, PNG, or WebP image.'
            : processed.reason === 'too_large'
              ? `That image is too large (max ${Math.round(MAX_BYTES / (1024 * 1024))} MB).`
              : "Couldn't read that image. Try another.";
        input.value = '';
        return;
      }
      // Preview immediately; upload via host.
      if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = URL.createObjectURL(processed.file);
      thumb.src = this.objectUrl;
      thumb.hidden = false;
      removeBtn.hidden = false;
      this.uploading = true;
      const primary = submitBtn();
      if (primary) primary.disabled = true;
      try {
        const url = await this.host.requestUpload(processed.file);
        this.machine.setImageUrl(url);
        status.textContent = '';
      } catch {
        // Never block the whole response on an image (F1-D7 edge case).
        this.machine.setImageUrl(null);
        status.textContent = "Couldn't attach the image — you can still submit without it.";
      } finally {
        this.uploading = false;
        const p = submitBtn();
        if (p) p.disabled = !this.machine.canSubmitDetail();
      }
    });

    row.append(attachBtn, thumb, removeBtn);
    field.append(row, input, status);
    return field;
  }

  private renderSubmitting(): void {
    this.clearBody();
    const center = document.createElement('div');
    center.className = 'sig-center';
    const spinner = document.createElement('div');
    spinner.className = 'sig-spinner';
    const msg = document.createElement('p');
    msg.className = 'sig-done-msg';
    msg.textContent = 'Sending…';
    center.append(spinner, msg);
    this.body.appendChild(center);
    this.announce('Sending your feedback');
  }

  private renderRetry(): void {
    this.clearBody();
    this.body.appendChild(this.header());
    const center = document.createElement('div');
    center.className = 'sig-center';
    const msg = document.createElement('p');
    msg.className = 'sig-done-msg';
    msg.textContent = "Couldn't send your feedback.";
    center.appendChild(msg);
    const actions = document.createElement('div');
    actions.className = 'sig-actions';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'sig-btn sig-btn-primary';
    retry.textContent = 'Retry';
    retry.addEventListener('click', () => this.runSubmit());
    actions.appendChild(retry);
    center.appendChild(actions);
    this.body.appendChild(center);
    this.announce("Couldn't send your feedback. Retry available.");
    retry.focus();
  }

  private renderDone(): void {
    const resolved = this.machine.ctx.resolved;
    if (!resolved) return;
    if (resolved.kind === 'close') {
      this.close('submit-close');
      return;
    }
    if (resolved.kind === 'redirect') {
      // Record already happened before this (runSubmit). The redirect is now an
      // OUTLINED button the user taps — never auto-fired (F1-D4).
      this.showThanks(resolved.message ?? DEFAULT_THANKS_TITLE, {
        label: resolved.message ?? 'Learn more',
        onClick: () => this.host.openUrl(resolved.url),
      });
      return;
    }
    if (resolved.kind === 'store_review') {
      // The review prompt is an OUTLINED button the user taps — not auto-fired.
      this.showThanks(DEFAULT_THANKS_TITLE, {
        label: '★ Rate us on the Play Store',
        onClick: () => this.host.openReview(),
      });
      return;
    }
    // thanks — configured message drives the bold line; no button.
    this.showThanks(resolved.message);
  }

  /**
   * The post-submit "Thanks" state: pale-green circle + green check, a bold title,
   * a gray subtext line, and (for redirect/store_review) an outlined action button
   * the user taps. For thanks/none there is no button and the sheet auto-closes.
   */
  private showThanks(title: string, action?: { label: string; onClick: () => void }): void {
    this.clearBody();
    const wrap = document.createElement('div');
    wrap.className = 'sig-thanks';

    const circle = document.createElement('div');
    circle.className = 'sig-check-circle';
    circle.setAttribute('aria-hidden', 'true');
    circle.innerHTML = CHECK_SVG;

    const titleEl = document.createElement('p');
    titleEl.className = 'sig-thanks-title';
    titleEl.textContent = title;

    const sub = document.createElement('p');
    sub.className = 'sig-thanks-sub';
    sub.textContent = DEFAULT_THANKS_SUB;

    wrap.append(circle, titleEl, sub);

    if (action) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sig-thanks-action';
      btn.textContent = action.label;
      btn.addEventListener('click', () => action.onClick());
      wrap.appendChild(btn);
    }

    this.body.appendChild(wrap);
    this.announce(title);

    // No follow-up action ⇒ auto-close after a short dwell. When there IS a button
    // we keep the sheet open so the user can tap it (F1 positive thanks edge case).
    if (!action) {
      this.autoCloseTimer = setTimeout(() => this.close('thanks-dwell'), 2200);
    }
  }

  // ---- submit flow --------------------------------------------------------

  private buildAnswer(): Answer {
    const ctx = this.machine.ctx;
    const answer: Answer = {
      trigger_id: this.cfg.trigger_id,
      rating_value: ctx.rating ?? this.cfg.rating_min,
      positive: ctx.positive,
    };
    const comment = ctx.comment.trim();
    if (comment) answer.other_text = comment;
    if (ctx.imageUrl) answer.other_image_url = ctx.imageUrl;
    return answer;
  }

  private runSubmit(): void {
    if (!this.machine.beginSubmit()) return; // guards double-submit
    this.renderSubmitting();
    const answer = this.buildAnswer();
    // Record BEFORE any redirect (F1-D4): the redirect only fires in renderDone,
    // which runs after submit resolves.
    this.host
      .submit(answer)
      .then(() => {
        this.machine.submitResolved();
        this.renderDone();
      })
      .catch(() => {
        this.machine.submitFailed();
        this.renderRetry();
      });
  }

  // ---- a11y / keyboard / focus -------------------------------------------

  private focusable(): HTMLElement[] {
    const sel =
      'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';
    return Array.from(this.sheet.querySelectorAll<HTMLElement>(sel)).filter(
      (el) => el.offsetParent !== null || el === this.root.activeElement,
    );
  }

  private focusFirst(): void {
    const target =
      this.sheet.querySelector<HTMLElement>('.sig-face[tabindex="0"]') ??
      this.focusable()[0] ??
      this.sheet;
    target.focus();
  }

  private handleKeydown(e: KeyboardEvent): void {
    if (this.closed) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      this.dismiss('esc');
      return;
    }
    // Arrow-key rating selection (with wrap) in the rating step.
    if (this.machine.state === 'rating' && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      e.preventDefault();
      const faces = this.faces();
      const current = faces.findIndex((f) => f.getAttribute('aria-checked') === 'true');
      const delta = e.key === 'ArrowRight' ? 1 : -1;
      // Nothing selected yet ⇒ the first arrow lands on the first face.
      const nextIdx = current === -1 ? 0 : (current + delta + faces.length) % faces.length;
      const next = faces[nextIdx];
      if (next) {
        this.machine.selectRating(Number(next.dataset.value));
        for (const b of faces) {
          const checked = b === next;
          b.setAttribute('aria-checked', checked ? 'true' : 'false');
          b.tabIndex = checked ? 0 : -1;
        }
        next.focus();
      }
      return;
    }
    // Focus trap on Tab.
    if (e.key === 'Tab') {
      const items = this.focusable();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = this.root.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first?.focus();
      }
    }
  }

  private announce(text: string): void {
    this.live.textContent = '';
    // Force the live region to re-announce.
    requestAnimationFrame(() => {
      this.live.textContent = text;
    });
  }

  // ---- lifecycle ----------------------------------------------------------

  dismiss(reason: DismissReason): void {
    if (this.closed) return;
    this.machine.dismiss();
    this.host.dismiss(reason);
    this.teardown();
  }

  /** Programmatic / post-submit close (no host.dismiss — the submit already
   *  reported the outcome). */
  close(_reason: string): void {
    if (this.closed) return;
    this.teardown();
  }

  private teardown(): void {
    this.closed = true;
    if (this.autoCloseTimer) clearTimeout(this.autoCloseTimer);
    this.resizeObserver?.disconnect();
    this.backdrop.removeEventListener('keydown', this.onKeydown, true);
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
    // Exit animation, then remove.
    this.backdrop.setAttribute('data-open', 'false');
    const remove = () => {
      this.backdrop.remove();
      this.opts.onTeardown?.();
    };
    const reduced =
      typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) remove();
    else setTimeout(remove, 320);
    // Restore focus to the host element that was focused before we opened.
    if (this.previouslyFocused instanceof HTMLElement) {
      this.previouslyFocused.focus?.();
    }
  }
}
