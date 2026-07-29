// ── Shared Utility Functions ──────────────────────────────────

/**
 * showToast — two call styles:
 *
 *   1. Legacy:   showToast("Saved!")                   -> 3.5s info
 *   2. Legacy:   showToast("Saved!", 5000)             -> 5s info
 *   3. Options:  showToast("Save failed: EACCES", {
 *                  type: 'error',   // 'info' | 'error' | 'warn'
 *                  sticky: true,    // stays until dismissed
 *                  duration: 12000, // override default duration
 *                  copy: "Full stack trace..."  // text copied by the ⧉ button
 *                })
 *
 * Error toasts are sticky by default (until the user clicks ×) and get a
 * "Copy" button so long error strings can be grabbed for support tickets.
 * Info toasts behave like before: auto-dismiss at 3.5s, no buttons.
 */
function showToast(msg, opts) {
  // Back-compat: second arg as a number = duration override.
  if (typeof opts === 'number') opts = { duration: opts };
  opts = opts || {};
  const type = opts.type || 'info';
  const sticky = opts.sticky !== undefined ? opts.sticky : type === 'error';
  const duration =
    opts.duration !== undefined
      ? opts.duration
      : type === 'error' ? 12000
      : type === 'warn'  ? 6000
      : 3500;
  const copyText = opts.copy != null ? String(opts.copy) : null;

  const t = document.getElementById('toast');
  if (!t) return; // no toast container on this page

  // Clear any pending auto-dismiss from a previous toast.
  if (t._dismissTimer) { clearTimeout(t._dismissTimer); t._dismissTimer = null; }

  // Flip border color based on type so errors visually pop.
  if (type === 'error') {
    t.style.borderColor = 'rgba(239,68,85,0.7)';
    t.style.background = 'rgba(40,18,22,0.94)';
  } else if (type === 'warn') {
    t.style.borderColor = 'rgba(240,173,78,0.7)';
    t.style.background = 'rgba(38,30,18,0.94)';
  } else {
    t.style.borderColor = '';
    t.style.background = '';
  }

  // Build the content. For error/copyable toasts we use a small flex layout
  // with the message + action buttons on the right.
  const showActions = sticky || copyText != null || type === 'error';
  if (!showActions) {
    t.textContent = msg;
  } else {
    t.innerHTML = '';
    const msgEl = document.createElement('div');
    msgEl.style.cssText =
      'flex:1;min-width:0;word-break:break-word;white-space:pre-wrap;max-height:160px;overflow-y:auto;';
    msgEl.textContent = msg;

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin-left:12px;';

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.textContent = 'Copy';
    copyBtn.style.cssText =
      'background:rgba(255,255,255,0.08);color:#fff;border:1px solid rgba(255,255,255,0.18);' +
      'border-radius:6px;padding:3px 10px;font-size:11px;cursor:pointer;font-family:inherit;';
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const text = copyText != null ? copyText : msg;
      navigator.clipboard.writeText(text).then(
        () => { copyBtn.textContent = 'Copied!'; setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1200); },
        () => { copyBtn.textContent = 'Failed'; }
      );
    });
    actions.appendChild(copyBtn);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = '×';
    closeBtn.setAttribute('aria-label', 'Dismiss');
    closeBtn.style.cssText =
      'background:transparent;color:rgba(255,255,255,0.7);border:1px solid rgba(255,255,255,0.18);' +
      'border-radius:6px;padding:2px 9px;font-size:14px;line-height:1;cursor:pointer;font-family:inherit;';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      t.classList.remove('show');
    });
    actions.appendChild(closeBtn);

    // Wrap into a flex row
    t.style.display = 'flex';
    t.style.alignItems = 'flex-start';
    t.appendChild(msgEl);
    t.appendChild(actions);
  }

  t.classList.add('show');

  if (!sticky) {
    t._dismissTimer = setTimeout(() => {
      t.classList.remove('show');
    }, duration);
  }
}

function setStatus(id, msg, type = '') {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.className = 'action-status' + (type ? ` ${type}` : '');
}

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

function fmtTs(ts) {
  if (!ts) return '';
  const d = new Date(ts.replace(' ', 'T') + 'Z');
  if (isNaN(d)) return ts;
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit'
  });
}

/** Full timestamp (for expanded accordion views). */
function fmtTsFull(ts) {
  if (!ts) return '';
  const d = new Date(ts.replace(' ', 'T') + 'Z');
  if (isNaN(d)) return ts;
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit'
  });
}

// ── Nav builder (single source of truth for the top bar) ─────────────────────
// All 11 pages used to ship their own hand-coded nav HTML, which drifted
// (e.g. /pricebook was missing the Monthly Review tab) and made it expensive
// to add or rename pages. shared.js now wipes whatever's inside .nav-container
// and rebuilds the bar from one canonical definition. Active state is derived
// from window.location.pathname — no more hand-edited .active classes per
// page.
//
// Structure (grouped by job-to-be-done, not by data type):
//   [Logo → /]  Call Reviews  PDF Parser  Operations ▾  Customers ▾  Financials ▾  Audits & Tools ▾  Users
//
// Pinned flat:      Call Reviews, PDF Parser — kept one click away by request.
// Operations group: Open Jobs, Job Lookup (/scoreboard), Fleet, Job Videos, Timesheet
// Customers group:  Memberships, Review Requests (/reviews), Customer Review, Backflow
// Financials group: Monthly Review, FY Review, Supplier Invoices, Pricebook
// Audits & Tools:   Address Audit, Contract Compare
// Users:            always rendered; auth widget removes it for non-admins.
(function initNav() {
  function buildNav() {
    const container = document.querySelector('.nav-container');
    if (!container) return;

    // Wipe any pre-existing inline nav. Pages may still ship the old hand-
    // coded version during a partial deploy — we want to be the source of
    // truth regardless of what HTML happens to live there.
    container.innerHTML = '';

    const path = window.location.pathname;
    const isOn = (route) => path === route;

    // ── Logo (acts as the Dashboard button) ────────────────────────────
    const logo = document.createElement('a');
    logo.href = '/';
    logo.className = 'nav-logo' + (isOn('/') ? ' active' : '');
    logo.title = 'Back to Dashboard';
    logo.innerHTML =
      '<div>' +
        '<div><span class="nav-logo-service">SERVICE</span><span class="nav-logo-ops">OPS</span></div>' +
        '<div class="nav-logo-sub">Command Center</div>' +
      '</div>';
    container.appendChild(logo);

    // ── Tabs container (the pill row) ──────────────────────────────────
    const tabs = document.createElement('div');
    tabs.className = 'nav-tabs';
    container.appendChild(tabs);

    // Helper: a flat top-level link that matches the existing .nav-tab style.
    const makeTab = (label, href) => {
      const a = document.createElement('a');
      a.href = href;
      a.className = 'nav-tab' + (isOn(href) ? ' active' : '');
      a.textContent = label;
      return a;
    };

    // Helper: a dropdown group. The trigger looks like a regular nav-tab
    // (with a caret) and gets the active treatment when any of its child
    // routes is the current page, so the user always sees where they are.
    const makeGroup = (label, children) => {
      const wrap = document.createElement('div');
      wrap.className = 'nav-group';

      const trigger = document.createElement('button');
      trigger.type = 'button';
      const childPaths = children.map(c => c.href);
      const groupActive = childPaths.includes(path);
      trigger.className = 'nav-tab nav-group-trigger' + (groupActive ? ' active' : '');
      trigger.setAttribute('aria-expanded', 'false');
      trigger.setAttribute('aria-haspopup', 'true');
      trigger.innerHTML = label + ' <span class="nav-group-caret" aria-hidden="true">▾</span>';

      const menu = document.createElement('div');
      menu.className = 'nav-group-menu';
      menu.setAttribute('role', 'menu');
      for (const c of children) {
        const item = document.createElement('a');
        item.href = c.href;
        item.className = 'nav-group-item' + (isOn(c.href) ? ' active' : '');
        item.setAttribute('role', 'menuitem');
        item.textContent = c.label;
        menu.appendChild(item);
      }

      trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        const willOpen = !wrap.classList.contains('open');
        // Close any other open groups so only one is ever open at a time.
        document.querySelectorAll('.nav-group.open').forEach(el => {
          el.classList.remove('open');
          const t = el.querySelector('.nav-group-trigger');
          if (t) t.setAttribute('aria-expanded', 'false');
        });
        if (willOpen) {
          wrap.classList.add('open');
          trigger.setAttribute('aria-expanded', 'true');
        }
      });

      wrap.appendChild(trigger);
      wrap.appendChild(menu);
      return wrap;
    };

    // ── Top-level structure ────────────────────────────────────────────
    // Two pinned flat tabs, kept out of the dropdowns for one-click access:
    // Call Reviews (office QA queue) and PDF Parser (used ad hoc all day).
    tabs.appendChild(makeTab('Call Reviews', '/calls'));
    tabs.appendChild(makeTab('PDF Parser',   '/pdf-parser'));

    // Grouped by job-to-be-done rather than by data type.
    tabs.appendChild(makeGroup('Operations', [
      { label: 'Open Jobs',       href: '/open-jobs' },
      { label: 'Install Tracker', href: '/install-tracker' },
      { label: 'Job Lookup',      href: '/scoreboard' },
      { label: 'Fleet',           href: '/fleet' },
      { label: 'Job Videos',      href: '/videos' },
      { label: 'Timesheet',       href: '/timesheet' },
    ]));

    tabs.appendChild(makeGroup('Customers', [
      { label: 'Memberships',     href: '/memberships' },
      { label: 'Review Requests', href: '/reviews' },
      { label: 'Customer Review', href: '/customer-review' },
      { label: 'Backflow',        href: '/backflow' },
    ]));

    tabs.appendChild(makeGroup('Financials', [
      { label: 'Monthly Review',    href: '/monthly-review' },
      { label: 'FY Review',         href: '/fy-review' },
      { label: 'Supplier Invoices', href: '/invoices' },
      { label: 'Payment Invoices',  href: '/payment-invoices' },
      { label: 'Pricebook',         href: '/pricebook' },
    ]));

    tabs.appendChild(makeGroup('Audits & Tools', [
      { label: 'Address Audit',    href: '/address' },
      { label: 'Contract Compare', href: '/contract-compare' },
    ]));

    // Users — always rendered. The auth widget below removes the link for
    // non-admins after /api/auth/me resolves.
    tabs.appendChild(makeTab('Users', '/users'));

    // Click-outside-to-close for any open dropdown.
    document.addEventListener('click', () => {
      document.querySelectorAll('.nav-group.open').forEach(el => {
        el.classList.remove('open');
        const t = el.querySelector('.nav-group-trigger');
        if (t) t.setAttribute('aria-expanded', 'false');
      });
    });

    // Esc closes any open dropdown.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        document.querySelectorAll('.nav-group.open').forEach(el => {
          el.classList.remove('open');
          const t = el.querySelector('.nav-group-trigger');
          if (t) t.setAttribute('aria-expanded', 'false');
        });
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildNav);
  } else {
    buildNav();
  }
})();

// ── Auth widget (auto-injects into the nav-bar on every page) ─────────────────
// Hits /api/auth/me on load, then renders a small "user@email · Sign out" pill
// inside .nav-container. Also intercepts any 401 from fetch so an expired
// session bounces the user to /login automatically.
(function initAuthWidget() {
  // Patch fetch so any 401 from an /api/* call sends the user back to /login.
  // Skips POST /login itself so the login error message can render.
  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const res = await origFetch(input, init);
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const isLoginPost = url.endsWith('/login') && (init?.method || '').toUpperCase() === 'POST';
      if (res.status === 401 && !isLoginPost && url.startsWith('/api/')) {
        const next = encodeURIComponent(window.location.pathname + window.location.search);
        window.location.href = `/login?next=${next}`;
      }
    } catch (_) {}
    return res;
  };

  async function render() {
    const container = document.querySelector('.nav-container');
    if (!container) return;

    let me;
    try {
      const r = await fetch('/api/auth/me');
      if (!r.ok) return; // 401 already handled by the patched fetch
      const data = await r.json();
      me = data.user;
    } catch (_) { return; }
    if (!me) return;

    // Hide the Users nav tab from non-admins. The /users page itself also
    // redirects non-admins server-side, but hiding the link keeps the UI
    // honest about what they can actually use.
    if (!me.isAdmin) {
      document.querySelectorAll('.nav-tab[href="/users"]').forEach(el => el.remove());
    }

    // Build the widget once.
    if (document.getElementById('auth-widget')) return;
    const w = document.createElement('div');
    w.id = 'auth-widget';
    w.style.cssText =
      'display:flex;align-items:center;gap:10px;margin-left:auto;padding-left:14px;' +
      'font-size:12px;color:var(--muted);';
    // Show just the first name in the top-right widget. Falls back to the
    // capitalized local-part of the email if no display name has been set
    // (so "priya.raghunathan@groundedhs.example" → "Priya" until they set a real name).
    const firstNameOf = (name, email) => {
      if (name && String(name).trim()) return String(name).trim().split(/\s+/)[0];
      const local = String(email || '').split('@')[0];
      const stub = local.split(/[._-]/)[0] || '';
      return stub ? stub.charAt(0).toUpperCase() + stub.slice(1) : '';
    };
    const label = firstNameOf(me.displayName, me.email);
    w.innerHTML =
      `<span title="${escHtml(me.email)}" style="color:var(--text);font-weight:500;">${escHtml(label)}</span>` +
      `<a href="/change-password" title="Change password" ` +
      ` style="color:var(--muted);text-decoration:none;border:1px solid var(--border-strong);` +
      ` border-radius:6px;padding:3px 8px;font-size:11px;">⚙</a>` +
      `<button type="button" id="auth-logout" ` +
      ` style="background:transparent;color:var(--muted);border:1px solid var(--border-strong);` +
      ` border-radius:6px;padding:3px 10px;font-size:11px;cursor:pointer;font-family:inherit;">` +
      `Sign out</button>`;
    container.appendChild(w);
    document.getElementById('auth-logout').addEventListener('click', async () => {
      try { await fetch('/logout', { method: 'POST' }); } catch (_) {}
      window.location.href = '/login';
    });

    // If the server says we still need to rotate the seeded password, nudge.
    if (me.mustChangePw && window.location.pathname !== '/change-password') {
      const banner = document.createElement('div');
      banner.style.cssText =
        'background:rgba(232,168,56,0.12);border:1px solid rgba(232,168,56,0.45);' +
        'color:#f6d28b;font-size:12px;padding:8px 12px;border-radius:8px;' +
        'margin:14px 24px 0;text-align:center;';
      banner.innerHTML =
        'You\'re still on the seeded starter password. ' +
        '<a href="/change-password?forced=1" style="color:#fff;font-weight:600;">Change it now →</a>';
      document.body.insertBefore(banner, document.body.firstChild.nextSibling);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', render);
  } else {
    render();
  }
})();
