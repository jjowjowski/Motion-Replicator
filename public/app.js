'use strict';

(() => {
  const TZ = 'Pacific/Auckland';
  const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };
  const PRIORITY_LABEL = { high: 'High', medium: 'Medium', low: 'Low' };
  const STATUS_LABEL = {
    scheduled: 'Scheduled',
    partial: 'Partly planned',
    at_risk: 'At risk',
    overdue: 'Overdue',
  };

  const state = {
    tasks: [],
    schedule: null,
    sort: readPref('sort', 'deadline'),
    showDone: readPref('showDone', 'false') === 'true',
    highlightTask: null,
  };

  // ---------- helpers ----------

  const $ = (sel) => document.querySelector(sel);

  function readPref(key, fallback) {
    try {
      return localStorage.getItem(`mr.${key}`) ?? fallback;
    } catch {
      return fallback;
    }
  }

  function writePref(key, value) {
    try {
      localStorage.setItem(`mr.${key}`, String(value));
    } catch {
      /* storage unavailable */
    }
  }

  /** Create an element. Children may be strings (inserted as text) or nodes. */
  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === false || v === null || v === undefined) continue;
      if (k === 'class') node.className = v;
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  class HttpError extends Error {
    constructor(status, message) {
      super(message);
      this.status = status;
    }
  }

  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined || method !== 'GET' ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : method !== 'GET' ? '{}' : undefined,
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* non-JSON response */
    }
    if (res.status === 401 && path !== '/api/login') {
      showLogin();
      throw new HttpError(401, 'Not logged in');
    }
    if (!res.ok) throw new HttpError(res.status, (data && data.error) || `Request failed (${res.status})`);
    return data;
  }

  const timeFmt = new Intl.DateTimeFormat('en-NZ', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
  const dayFmt = new Intl.DateTimeFormat('en-NZ', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'short' });
  const shortFmt = new Intl.DateTimeFormat('en-NZ', {
    timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
  });
  const isoDayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

  const tidy = (text) => text.replace(/\s?([ap]m)/gi, (_, ap) => ap.toLowerCase());
  const fmtTime = (d) => tidy(timeFmt.format(new Date(d)));
  const fmtShort = (d) => tidy(shortFmt.format(new Date(d)));
  const localDay = (d) => isoDayFmt.format(new Date(d));
  const todayLocal = () => localDay(new Date());

  function fmtDeadline(task) {
    const [y, m, d] = task.deadline_date.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    const dayText = new Intl.DateTimeFormat('en-NZ', {
      timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short',
      year: y !== new Date().getFullYear() ? 'numeric' : undefined,
    }).format(date);
    if (!task.deadline_time) return dayText;
    const [hh, mm] = task.deadline_time.split(':').map(Number);
    const t = new Date(Date.UTC(2000, 0, 1, hh, mm));
    const timeText = new Intl.DateTimeFormat('en-NZ', { timeZone: 'UTC', hour: 'numeric', minute: '2-digit' })
      .format(t).replace(/\s/g, '').toLowerCase();
    return `${dayText}, ${timeText}`;
  }

  function fmtDuration(min) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return [h ? `${h}h` : '', m ? `${m}m` : ''].filter(Boolean).join(' ') || '0m';
  }

  function flash(message, isError = false) {
    const box = $('#flash');
    box.textContent = message;
    box.classList.toggle('error-flash', isError);
    box.hidden = false;
    clearTimeout(flash.timer);
    flash.timer = setTimeout(() => (box.hidden = true), isError ? 10000 : 5000);
  }

  // ---------- views ----------

  function showLogin() {
    $('#app-view').hidden = true;
    $('#login-view').hidden = false;
    $('#password').focus();
  }

  async function showApp() {
    $('#login-view').hidden = true;
    $('#app-view').hidden = false;
    await refresh();
  }

  async function refresh() {
    try {
      const status = state.showDone ? 'all' : 'open';
      const [tasks, schedule] = await Promise.all([api(`/api/tasks?status=${status}`), api('/api/schedule')]);
      state.tasks = tasks.tasks;
      state.schedule = schedule;
      render();
    } catch (err) {
      if (err.status !== 401) flash(navigator.onLine ? err.message : 'You are offline.', true);
    }
  }

  function render() {
    renderGoogle();
    renderWarnings();
    renderTasks();
    renderSchedule();
  }

  function renderGoogle() {
    const card = $('#google-card');
    const g = state.schedule.google;
    card.replaceChildren();
    if (!g.configured) {
      card.append(el('p', {}, 'Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.'));
      return;
    }
    if (g.connected) {
      card.append(
        el('p', {}, '✅ Connected to Google Calendar as ', el('strong', {}, g.email || 'your account'),
          `. Blocks go to the “${g.calendar_name}” calendar.`),
        el('button', { class: 'btn ghost small', type: 'button', onclick: disconnectGoogle }, 'Disconnect'),
      );
    } else {
      card.append(
        el('p', {}, g.needs_reauth
          ? '⚠️ Google access expired or was revoked. Reconnect to keep planning.'
          : 'Connect Google Calendar so tasks can be planned around your meetings.'),
        el('a', { class: 'btn primary', href: '/auth/google' }, g.needs_reauth ? 'Reconnect Google' : 'Connect Google Calendar'),
      );
    }
    $('#replan-btn').disabled = !g.connected;
    $('#stale-banner').hidden = !(g.connected && state.schedule.stale);
  }

  function renderWarnings() {
    const box = $('#warnings');
    const flagged = state.tasks.filter(
      (t) => t.status === 'open' && (t.schedule_status === 'at_risk' || t.schedule_status === 'overdue'),
    );
    box.replaceChildren();
    if (!flagged.length) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    box.append(
      el('h2', {}, `⚠️ ${flagged.length} task${flagged.length > 1 ? 's' : ''} won't make the deadline`),
      el('ul', {}, flagged.map((t) =>
        el('li', {},
          el('a', { href: `?task=${t.id}`, onclick: (e) => { e.preventDefault(); focusTask(t.id); } }, t.title),
          ` — ${t.schedule_warning || STATUS_LABEL[t.schedule_status]}`))),
    );
  }

  function sortedTasks() {
    const deadlineKey = (t) => `${t.deadline_date}T${t.deadline_time || '24:00'}`;
    const byDeadline = (a, b) => deadlineKey(a).localeCompare(deadlineKey(b));
    const byPriority = (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    const byCreated = (a, b) => a.created_at.localeCompare(b.created_at);
    const primary = state.sort === 'priority' ? [byPriority, byDeadline] : [byDeadline, byPriority];
    const comparators = [(a, b) => (a.status === b.status ? 0 : a.status === 'open' ? -1 : 1), ...primary, byCreated];
    return [...state.tasks].sort((a, b) => {
      for (const c of comparators) {
        const r = c(a, b);
        if (r) return r;
      }
      return 0;
    });
  }

  function renderTasks() {
    const list = $('#task-list');
    const tasks = sortedTasks();
    list.replaceChildren(...tasks.map(renderTask));
    $('#task-empty').hidden = tasks.length > 0;
    if (state.highlightTask) {
      const node = list.querySelector(`[data-id="${state.highlightTask}"]`);
      if (node) {
        node.classList.add('highlight');
        node.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(() => node.classList.remove('highlight'), 2500);
      }
      state.highlightTask = null;
    }
  }

  function renderTask(t) {
    const done = t.status === 'done';
    const meta = [
      el('span', {}, `⏱ ${fmtDuration(t.duration_minutes)}`),
      el('span', {}, `📅 Due ${fmtDeadline(t)}`),
    ];
    if (!done && t.schedule_status) {
      meta.push(el('span', { class: `status ${t.schedule_status}` }, STATUS_LABEL[t.schedule_status]));
    }
    const isWarning = t.schedule_status === 'at_risk' || t.schedule_status === 'overdue';
    const upcoming = (t.blocks || []).slice(0, 4);

    return el('li', { class: `task p-${t.priority}${done ? ' done' : ''}`, dataset: { id: t.id } },
      el('div', { class: 'task-top' },
        el('span', { class: 'task-title' }, t.title),
        el('span', { class: `badge ${t.priority}` }, PRIORITY_LABEL[t.priority])),
      el('div', { class: 'task-meta' }, meta),
      t.notes ? el('p', { class: 'task-notes' }, t.notes) : null,
      !done && t.schedule_warning
        ? el('p', { class: isWarning ? 'task-warning' : 'task-info' }, t.schedule_warning)
        : null,
      !done && upcoming.length
        ? el('ul', { class: 'task-blocks' }, upcoming.map((b) =>
          el('li', {}, `${fmtShort(b.start)} – ${fmtTime(b.end)}${b.late ? ' (late)' : ''}`)))
        : null,
      el('div', { class: 'task-actions' },
        done
          ? el('button', { class: 'btn small', type: 'button', onclick: () => reopenTask(t) }, 'Reopen')
          : [
            el('button', { class: 'btn small', type: 'button', onclick: () => markDone(t) }, '✓ Done'),
            el('button', { class: 'btn small ghost', type: 'button', onclick: () => editTask(t) }, 'Edit'),
          ],
        el('button', { class: 'btn small ghost danger', type: 'button', onclick: () => deleteTask(t) }, 'Delete')),
    );
  }

  function renderSchedule() {
    const container = $('#schedule');
    const { blocks, last_run: run } = state.schedule;
    container.replaceChildren();

    if (run) {
      const when = fmtShort(run.started_at);
      const how = run.trigger === 'cron' ? 'daily run' : 'manual re-plan';
      $('#last-run').textContent = run.status === 'error'
        ? `Last ${how} failed (${when}): ${run.error}`
        : run.status === 'running'
          ? `Planning in progress (started ${when})…`
          : `Last planned ${when} (${how}).`;
    } else {
      $('#last-run').textContent = 'Not planned yet.';
    }

    if (!blocks.length) {
      container.append(el('p', { class: 'empty' }, 'Nothing scheduled. Add tasks and press “Re-plan now”.'));
      return;
    }

    const days = new Map();
    for (const b of blocks) {
      const key = localDay(b.start);
      if (!days.has(key)) days.set(key, []);
      days.get(key).push(b);
    }
    const today = todayLocal();
    for (const [key, list] of days) {
      const label = key === today ? `Today · ${dayFmt.format(new Date(list[0].start))}` : dayFmt.format(new Date(list[0].start));
      container.append(el('div', { class: 'day' },
        el('h3', {}, label),
        list.map((b) => el('div', { class: `block p-${b.priority || 'medium'}${b.late ? ' late' : ''}` },
          el('span', { class: 'block-time' }, `${fmtTime(b.start)} – ${fmtTime(b.end)}`),
          el('a', {
            href: `?task=${b.task_id}`,
            onclick: (e) => { e.preventDefault(); if (b.task_id) focusTask(b.task_id); },
          }, b.title, b.chunk_count > 1 ? ` (${b.chunk_index}/${b.chunk_count})` : '', b.late ? ' ⚠️ late' : '')))));
    }
  }

  function focusTask(id) {
    state.highlightTask = id;
    if (!state.tasks.some((t) => t.id === id) && !state.showDone) {
      state.showDone = true;
      $('#show-done').checked = true;
      refresh();
      return;
    }
    renderTasks();
  }

  // ---------- task form ----------

  function resetForm() {
    const form = $('#task-form');
    form.reset();
    form.elements.id.value = '';
    form.elements.deadline_date.value = todayLocal();
    $('#form-title').textContent = 'New task';
    $('#form-submit').textContent = 'Add task';
    $('#form-cancel').hidden = true;
    $('#form-error').hidden = true;
  }

  function editTask(t) {
    const f = $('#task-form').elements;
    f.id.value = t.id;
    f.title.value = t.title;
    f.priority.value = t.priority;
    f.duration_minutes.value = t.duration_minutes;
    f.deadline_date.value = t.deadline_date;
    f.deadline_time.value = t.deadline_time || '';
    f.notes.value = t.notes || '';
    $('#form-title').textContent = 'Edit task';
    $('#form-submit').textContent = 'Save changes';
    $('#form-cancel').hidden = false;
    $('#form-error').hidden = true;
    $('#task-form-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    f.title.focus({ preventScroll: true });
  }

  async function submitTask(e) {
    e.preventDefault();
    const f = e.target.elements;
    const errBox = $('#form-error');
    errBox.hidden = true;
    const payload = {
      title: f.title.value.trim(),
      priority: f.priority.value,
      duration_minutes: Number(f.duration_minutes.value),
      deadline_date: f.deadline_date.value,
      deadline_time: f.deadline_time.value || null,
      notes: f.notes.value.trim() || null,
    };
    if (!payload.title) return showFormError('Please enter a title.');
    if (!Number.isInteger(payload.duration_minutes) || payload.duration_minutes < 5) {
      return showFormError('Duration must be at least 5 minutes.');
    }
    if (!payload.deadline_date) return showFormError('Please choose a deadline date.');

    const submit = $('#form-submit');
    submit.disabled = true;
    try {
      if (f.id.value) {
        await api(`/api/tasks/${f.id.value}`, { method: 'PATCH', body: payload });
        flash('Task updated. Re-plan to update your calendar.');
      } else {
        await api('/api/tasks', { method: 'POST', body: payload });
        flash('Task added. Re-plan to put it on your calendar.');
      }
      resetForm();
      await refresh();
    } catch (err) {
      if (err.status !== 401) showFormError(err.message);
    } finally {
      submit.disabled = false;
    }

    function showFormError(message) {
      errBox.textContent = message;
      errBox.hidden = false;
    }
  }

  async function markDone(t) {
    try {
      await api(`/api/tasks/${t.id}/done`, { method: 'POST' });
      flash(`“${t.title}” marked done.`);
      await refresh();
    } catch (err) {
      if (err.status !== 401) flash(err.message, true);
    }
  }

  async function reopenTask(t) {
    try {
      await api(`/api/tasks/${t.id}/reopen`, { method: 'POST' });
      await refresh();
    } catch (err) {
      if (err.status !== 401) flash(err.message, true);
    }
  }

  async function deleteTask(t) {
    if (!confirm(`Delete “${t.title}”? Its upcoming calendar blocks will be removed.`)) return;
    try {
      await api(`/api/tasks/${t.id}`, { method: 'DELETE' });
      if ($('#task-form').elements.id.value === String(t.id)) resetForm();
      await refresh();
    } catch (err) {
      if (err.status !== 401) flash(err.message, true);
    }
  }

  async function replan() {
    const buttons = [$('#replan-btn'), $('#stale-replan')];
    buttons.forEach((b) => (b.disabled = true));
    $('#replan-btn').textContent = 'Planning…';
    try {
      const { result } = await api('/api/schedule/replan', { method: 'POST' });
      flash(`Planned ${result.tasks} task${result.tasks === 1 ? '' : 's'}: ${result.eventsCreated} calendar blocks` +
        (result.warnings ? `, ${result.warnings} warning${result.warnings === 1 ? '' : 's'}.` : '.'), result.warnings > 0);
      await refresh();
    } catch (err) {
      if (err.status !== 401) flash(err.message, true);
      await refresh();
    } finally {
      buttons.forEach((b) => (b.disabled = false));
      $('#replan-btn').textContent = 'Re-plan now';
    }
  }

  async function disconnectGoogle() {
    if (!confirm('Disconnect Google Calendar? Existing blocks stay on your calendar until the next plan.')) return;
    try {
      await api('/api/google/disconnect', { method: 'POST' });
      await refresh();
    } catch (err) {
      if (err.status !== 401) flash(err.message, true);
    }
  }

  // ---------- startup ----------

  function readUrlParams() {
    const params = new URLSearchParams(location.search);
    if (params.get('task')) state.highlightTask = Number(params.get('task'));
    if (params.get('google') === 'connected') flash('Google Calendar connected. Press “Re-plan now” to schedule your tasks.');
    if (params.get('google_error')) flash(`Google connection failed: ${params.get('google_error')}`, true);
    if ([...params.keys()].length) history.replaceState(null, '', location.pathname);
  }

  function bindEvents() {
    $('#login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const errBox = $('#login-error');
      errBox.hidden = true;
      try {
        await api('/api/login', { method: 'POST', body: { password: $('#password').value } });
        $('#password').value = '';
        await showApp();
      } catch (err) {
        errBox.textContent = err.message;
        errBox.hidden = false;
      }
    });

    $('#logout-btn').addEventListener('click', async () => {
      await api('/api/logout', { method: 'POST' }).catch(() => {});
      showLogin();
    });

    $('#task-form').addEventListener('submit', submitTask);
    $('#form-cancel').addEventListener('click', resetForm);
    $('#duration-chips').addEventListener('click', (e) => {
      const min = e.target.dataset && e.target.dataset.min;
      if (min) $('#f-duration').value = min;
    });

    $('#replan-btn').addEventListener('click', replan);
    $('#stale-replan').addEventListener('click', replan);

    const sort = $('#sort');
    sort.value = state.sort;
    sort.addEventListener('change', () => {
      state.sort = sort.value;
      writePref('sort', state.sort);
      renderTasks();
    });

    const showDone = $('#show-done');
    showDone.checked = state.showDone;
    showDone.addEventListener('change', () => {
      state.showDone = showDone.checked;
      writePref('showDone', state.showDone);
      refresh();
    });

    // Refresh when returning to the app (e.g. after the morning cron run).
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && !$('#app-view').hidden) refresh();
    });
  }

  async function init() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('SW registration failed', err));
    }
    bindEvents();
    resetForm();
    readUrlParams();
    try {
      const me = await api('/api/me');
      if (me.authenticated) await showApp();
      else showLogin();
    } catch {
      showLogin();
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
