(() => {
  'use strict';

  const state = { me: null, tickets: [], notifications: [], activeTicket: null, notificationTimer: null };
  const $ = selector => document.querySelector(selector);
  const loginView = $('#loginView');
  const appView = $('#appView');
  const createDialog = $('#createDialog');
  const detailDialog = $('#detailDialog');
  const notificationsDialog = $('#notificationsDialog');

  const statusLabels = { Pending: 'Pendiente', 'Under Review': 'En revisión', Escalated: 'Escalado', Complete: 'Completado', Cancelled: 'Cancelado' };
  const priorityLabels = { Low: 'Baja', Medium: 'Media', High: 'Alta', Critical: 'Crítica' };
  const fieldLabels = { title: 'título', customerName: 'cliente', customerTpid: 'TPID', category: 'categoría', priority: 'prioridad', description: 'descripción', evidenceLinks: 'evidencia', status: 'estado', assigneeEmail: 'agente asignado', adminNotes: 'notas administrativas' };

  function esc(value) {
    return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
  }

  function formatDate(value) {
    if (!value) return '—';
    return new Intl.DateTimeFormat('es-CO', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
  }

  function showToast(message, isError = false) {
    const toast = $('#toast');
    toast.textContent = message;
    toast.className = `toast show${isError ? ' error' : ''}`;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => { toast.className = 'toast'; }, 4200);
  }

  async function api(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body && !headers['content-type']) headers['content-type'] = 'application/json';

    const response = await fetch(`/api${path}`, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...options,
      headers
    });
    const type = response.headers.get('content-type') || '';
    const payload = type.includes('application/json') ? await response.json() : {};
    if (!response.ok) {
      const error = new Error(payload.message || `Error ${response.status}`);
      error.status = response.status;
      error.code = payload.error;
      throw error;
    }
    return payload;
  }

  async function getStaticWebAppsPrincipal() {
    const response = await fetch('/.auth/me', {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/json' }
    });

    if (!response.ok) {
      const error = new Error(`No fue posible consultar la sesión (${response.status}).`);
      error.status = response.status;
      throw error;
    }

    const auth = await response.json();
    return auth && auth.clientPrincipal ? auth.clientPrincipal : null;
  }

  function claimValue(principal, claimNames) {
    const names = new Set(claimNames.map(name => name.toLowerCase()));
    const claim = (principal.claims || []).find(item => names.has(String(item.typ || item.type || '').toLowerCase()));
    return claim ? (claim.val || claim.value || '') : '';
  }

  function profileFromPrincipal(principal) {
    const email = String(
      principal.userDetails ||
      claimValue(principal, [
        'preferred_username',
        'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
        'emails',
        'upn'
      ]) || ''
    ).trim().toLowerCase();

    const displayName = claimValue(principal, [
      'name',
      'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name'
    ]) || email.split('@')[0] || 'Usuario';

    const roles = Array.isArray(principal.userRoles) ? principal.userRoles : [];
    return {
      id: principal.userId || email,
      email,
      displayName,
      roles,
      isAdmin: roles.some(role => ['admin', 'administrator', 'administradora'].includes(String(role).toLowerCase()))
    };
  }

  function showLogin() {
    if (loginView) loginView.classList.remove('hidden');
    if (appView) appView.classList.add('hidden');
  }

  function setRoleVisibility() {
    const isAdmin = Boolean(state.me && state.me.isAdmin);

    // Compatible con una sola appView y también con secciones separadas ya
    // existentes en el HTML. Si un selector no existe, no modifica nada.
    document.querySelectorAll('#adminView, .admin-only, [data-role-view="admin"]').forEach(element => {
      element.classList.toggle('hidden', !isAdmin);
      element.setAttribute('aria-hidden', String(!isAdmin));
    });
    document.querySelectorAll('#agentView, .agent-only, [data-role-view="agent"]').forEach(element => {
      element.classList.toggle('hidden', isAdmin);
      element.setAttribute('aria-hidden', String(isAdmin));
    });

    document.body.dataset.userRole = isAdmin ? 'admin' : 'agent';
  }

  function showApp() {
    if (loginView) loginView.classList.add('hidden');
    if (appView) appView.classList.remove('hidden');
    setRoleVisibility();
    if ($('#userName')) $('#userName').textContent = state.me.displayName;
    if ($('#userRole')) $('#userRole').textContent = state.me.isAdmin ? 'Administradora' : state.me.email;
    if ($('#welcomeTitle')) $('#welcomeTitle').textContent = state.me.isAdmin ? 'Panel de administración' : `Hola, ${state.me.displayName}`;
    if ($('#welcomeCopy')) $('#welcomeCopy').textContent = state.me.isAdmin ? 'Revisa, asigna y actualiza las solicitudes del equipo.' : 'Crea un ticket y consulta cada actualización en un solo lugar.';
  }

  function configureAuthenticationLinks() {
    const loginLink = document.querySelector(
      '#loginButton, #loginBtn, [data-action="login"], a[href^="/.auth/login/"]'
    );
    if (loginLink) loginLink.setAttribute('href', '/.auth/login/aad?post_login_redirect_uri=/');

    const logoutLink = document.querySelector(
      '#logoutButton, #logoutBtn, [data-action="logout"], a[href^="/.auth/logout"]'
    );
    if (logoutLink) logoutLink.setAttribute('href', '/.auth/logout?post_logout_redirect_uri=/');
  }

  async function boot() {
    configureAuthenticationLinks();

    try {
      // /.auth/me is the source of truth for the browser session. Never use
      // /api/me to decide whether the login view or the app view is shown.
      const principal = await getStaticWebAppsPrincipal();
      if (!principal) {
        state.me = null;
        showLogin();
        return;
      }

      state.me = profileFromPrincipal(principal);
      showApp();

      // The API profile is optional enrichment (for example, isAdmin). A
      // temporary API error must not send an authenticated user back to login.
      try {
        const apiProfile = await api('/me');
        const apiRoles = Array.isArray(apiProfile.roles) ? apiProfile.roles : [];
        const isAdmin = apiProfile.isAdmin === true || apiProfile.isAdmin === 'true' ||
          apiRoles.some(role => ['admin', 'administrator', 'administradora'].includes(String(role).toLowerCase()));
        state.me = { ...state.me, ...apiProfile, isAdmin };
        showApp();
      } catch (error) {
        console.warn('Sesión válida; no se pudo cargar /api/me:', error.message);
        showToast('Sesión iniciada. La API todavía no está disponible.', true);
      }

      await Promise.allSettled([loadTickets(), loadNotifications()]);
      clearInterval(state.notificationTimer);
      state.notificationTimer = setInterval(loadNotifications, 30000);
    } catch (error) {
      // A failure while reading /.auth/me is not proof that the user is signed
      // out, so the app does not start another automatic login redirect.
      showLogin();
      showToast(error.message || 'No fue posible comprobar la sesión.', true);
    }
  }

  async function loadTickets() {
    $('#loadingState').classList.remove('hidden');
    try {
      const data = await api('/tickets');
      state.tickets = data.tickets || [];
      renderMetrics();
      renderTickets();
    } catch (error) {
      showToast(error.message, true);
    } finally {
      $('#loadingState').classList.add('hidden');
    }
  }

  function renderMetrics() {
    $('#metricTotal').textContent = state.tickets.length;
    $('#metricPending').textContent = state.tickets.filter(t => t.status === 'Pending').length;
    $('#metricProgress').textContent = state.tickets.filter(t => ['Under Review', 'Escalated'].includes(t.status)).length;
    $('#metricComplete').textContent = state.tickets.filter(t => t.status === 'Complete').length;
  }

  function filteredTickets() {
    const search = $('#searchInput').value.trim().toLowerCase();
    const status = $('#statusFilter').value;
    const priority = $('#priorityFilter').value;
    return state.tickets.filter(ticket => {
      const haystack = [ticket.ticketNumber, ticket.title, ticket.customerName, ticket.customerTpid, ticket.creatorEmail, ticket.assigneeEmail].join(' ').toLowerCase();
      return (!search || haystack.includes(search)) && (!status || ticket.status === status) && (!priority || ticket.priority === priority);
    });
  }

  function renderTickets() {
    const tickets = filteredTickets();
    $('#ticketCount').textContent = `${tickets.length} resultado${tickets.length === 1 ? '' : 's'}`;
    $('#emptyState').classList.toggle('hidden', tickets.length > 0);
    $('#ticketList').innerHTML = tickets.map(ticket => `
      <button class="ticket-row" type="button" data-ticket-id="${esc(ticket.id)}">
        <span class="ticket-main"><span class="ticket-id">${esc(ticket.ticketNumber)}</span><strong>${esc(ticket.title)}</strong><small>${esc(ticket.customerName)}${ticket.customerTpid ? ` · TPID ${esc(ticket.customerTpid)}` : ''}</small></span>
        <span class="ticket-meta"><span class="status status-${esc(ticket.status.toLowerCase().replaceAll(' ', '-'))}">${esc(statusLabels[ticket.status] || ticket.status)}</span><span class="priority priority-${esc(ticket.priority.toLowerCase())}">${esc(priorityLabels[ticket.priority] || ticket.priority)}</span></span>
        <span class="ticket-owner"><small>Creado por</small><span>${esc(ticket.creatorName || ticket.creatorEmail)}</span></span>
        <span class="ticket-date"><small>Actualizado</small><span>${esc(formatDate(ticket.updatedAt))}</span></span>
        <span class="chevron" aria-hidden="true">›</span>
      </button>
    `).join('');
    document.querySelectorAll('[data-ticket-id]').forEach(button => button.addEventListener('click', () => openTicket(button.dataset.ticketId)));
  }

  async function openTicket(id) {
    try {
      const data = await api(`/tickets/${encodeURIComponent(id)}`);
      state.activeTicket = data.ticket;
      renderTicketDetail();
      detailDialog.showModal();
    } catch (error) {
      showToast(error.message, true);
    }
  }

  function options(values, current, labels = {}) {
    return values.map(value => `<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(labels[value] || value)}</option>`).join('');
  }

  function evidenceText(ticket) { return (ticket.evidenceLinks || []).join('\n'); }

  function renderActivity(ticket) {
    const items = [...(ticket.activities || [])].reverse();
    if (!items.length) return '<div class="empty-inline">Sin actividad.</div>';
    return items.map(item => `
      <article class="activity-item ${item.visibility === 'internal' ? 'internal' : ''}">
        <span class="activity-dot"></span>
        <div><div class="activity-heading"><strong>${esc(item.byName || item.byEmail)}</strong><time>${esc(formatDate(item.at))}</time></div><p>${esc(item.text)}</p>${item.visibility === 'internal' ? '<small>Nota visible solo para administración</small>' : ''}</div>
      </article>
    `).join('');
  }

  function renderTicketDetail() {
    const ticket = state.activeTicket;
    const editable = ticket.canEdit;
    const admin = state.me.isAdmin;
    const links = (ticket.evidenceLinks || []).map(url => `<li><a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a></li>`).join('');
    $('#ticketDetail').innerHTML = `
      <div class="modal-heading print-heading">
        <div><p class="eyebrow">${esc(ticket.ticketNumber)}</p><h2>${esc(ticket.title)}</h2><p>${esc(ticket.customerName)} · ${esc(ticket.category)}</p></div>
        <div class="heading-actions"><button id="printTicketButton" class="button ghost compact" type="button">Imprimir / PDF</button><button class="icon-button close-detail" type="button" aria-label="Cerrar">✕</button></div>
      </div>
      <div class="detail-layout">
        <section>
          <form id="editTicketForm">
            <div class="form-grid">
              <label class="full"><span>Título</span><input name="title" maxlength="120" value="${esc(ticket.title)}" ${editable ? '' : 'disabled'} required></label>
              <label><span>Cliente</span><input name="customerName" maxlength="120" value="${esc(ticket.customerName)}" ${editable ? '' : 'disabled'} required></label>
              <label><span>TPID</span><input name="customerTpid" maxlength="40" value="${esc(ticket.customerTpid)}" ${editable ? '' : 'disabled'}></label>
              <label><span>Categoría</span><select name="category" ${editable ? '' : 'disabled'}>${options(['Azure','Microsoft 365','MSX / Opportunity','Partner / Nomination','Billing / Support','Compliance / Security','Other'], ticket.category)}</select></label>
              <label><span>Prioridad</span><select name="priority" ${editable ? '' : 'disabled'}>${options(['Low','Medium','High','Critical'], ticket.priority, priorityLabels)}</select></label>
              <label><span>Estado</span><select name="status" ${admin ? '' : 'disabled'}>${options(['Pending','Under Review','Escalated','Complete','Cancelled'], ticket.status, statusLabels)}</select></label>
              ${admin ? `<label><span>Asignar a</span><input name="assigneeEmail" maxlength="160" value="${esc(ticket.assigneeEmail)}" placeholder="v-alias@microsoft.com"></label>` : `<label><span>Asignado a</span><input value="${esc(ticket.assigneeEmail || 'Sin asignar')}" disabled></label>`}
              <label class="full"><span>Descripción</span><textarea name="description" rows="6" maxlength="5000" ${editable ? '' : 'disabled'} required>${esc(ticket.description)}</textarea></label>
              <label class="full"><span>Enlaces de evidencia</span><textarea name="evidenceLinks" rows="3" ${editable ? '' : 'disabled'}>${esc(evidenceText(ticket))}</textarea></label>
              ${admin ? `<label class="full"><span>Notas administrativas</span><textarea name="adminNotes" rows="4" maxlength="5000">${esc(ticket.adminNotes || '')}</textarea></label>` : ''}
            </div>
            <input type="hidden" name="etag" value="${esc(ticket.etag)}">
            ${editable ? '<div class="form-actions"><button id="saveTicketButton" class="button primary" type="submit">Guardar cambios</button></div>' : '<p class="permission-note">Puedes consultar este ticket, pero solo el creador o la administradora pueden modificarlo.</p>'}
          </form>
          <div class="evidence-print"><h3>Evidencia</h3>${links ? `<ul>${links}</ul>` : '<p>Sin enlaces.</p>'}</div>
        </section>
        <aside class="timeline">
          <div class="timeline-heading"><div><h3>Actividad</h3><p>Historial del ticket</p></div><span class="status status-${esc(ticket.status.toLowerCase().replaceAll(' ', '-'))}">${esc(statusLabels[ticket.status])}</span></div>
          ${editable ? `<form id="messageForm" class="message-form"><label><span>Nueva interacción</span><textarea name="message" rows="3" maxlength="3000" required placeholder="Escribe una actualización clara…"></textarea></label>${admin ? '<label class="check"><input type="checkbox" name="internal"><span>Nota solo para administración</span></label>' : ''}<button class="button secondary" type="submit">Agregar interacción</button></form>` : ''}
          <div class="activity-list">${renderActivity(ticket)}</div>
          <dl class="ticket-facts"><div><dt>Creado</dt><dd>${esc(formatDate(ticket.createdAt))}</dd></div><div><dt>Creador</dt><dd>${esc(ticket.creatorEmail)}</dd></div><div><dt>Asignado</dt><dd>${esc(ticket.assigneeEmail || 'Sin asignar')}</dd></div></dl>
        </aside>
      </div>
    `;

    $('.close-detail').addEventListener('click', () => detailDialog.close());
    $('#printTicketButton').addEventListener('click', () => window.print());
    const editForm = $('#editTicketForm');
    if (editable) editForm.addEventListener('submit', saveTicket);
    const messageForm = $('#messageForm');
    if (messageForm) messageForm.addEventListener('submit', addMessage);
  }

  async function saveTicket(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const payload = {
      etag: form.get('etag'), title: form.get('title'), customerName: form.get('customerName'), customerTpid: form.get('customerTpid'),
      category: form.get('category'), priority: form.get('priority'), description: form.get('description'), evidenceLinks: form.get('evidenceLinks')
    };
    if (state.me.isAdmin) {
      payload.status = form.get('status');
      payload.assigneeEmail = form.get('assigneeEmail');
      payload.adminNotes = form.get('adminNotes');
    }
    const button = $('#saveTicketButton');
    button.disabled = true;
    button.textContent = 'Guardando…';
    try {
      const data = await api(`/tickets/${encodeURIComponent(state.activeTicket.id)}`, { method: 'PUT', body: JSON.stringify(payload) });
      state.activeTicket = data.ticket;
      showToast(data.unchanged ? 'No había cambios para guardar.' : 'Ticket actualizado.');
      renderTicketDetail();
      await loadTickets();
    } catch (error) {
      showToast(error.message, true);
      button.disabled = false;
      button.textContent = 'Guardar cambios';
    }
  }

  async function addMessage(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const submit = event.currentTarget.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      const data = await api(`/tickets/${encodeURIComponent(state.activeTicket.id)}/messages`, {
        method: 'POST', body: JSON.stringify({ message: form.get('message'), visibility: form.get('internal') ? 'internal' : 'public' })
      });
      state.activeTicket = data.ticket;
      showToast('Interacción agregada.');
      renderTicketDetail();
      await loadTickets();
    } catch (error) {
      showToast(error.message, true);
      submit.disabled = false;
    }
  }

  function readCreateField(formElement, names) {
    for (const name of names) {
      const field = formElement.elements.namedItem(name) || formElement.querySelector(`#${CSS.escape(name)}`);
      if (!field) continue;

      if (typeof RadioNodeList !== 'undefined' && field instanceof RadioNodeList) {
        const value = String(field.value || '').trim();
        if (value) return value;
        continue;
      }

      if (field.type === 'checkbox') {
        if (field.checked) return String(field.value || 'true').trim();
        continue;
      }

      const value = String(field.value ?? '').trim();
      if (value) return value;
    }
    return '';
  }

  function normalizeCategory(value) {
    const key = String(value || '').trim().toLowerCase();
    if (!key) return '';
    if (key.includes('azure')) return 'Azure';
    if (key.includes('microsoft 365') || key === 'm365' || key.includes('office 365')) return 'Microsoft 365';
    if (key.includes('msx') || key.includes('opportun')) return 'MSX / Opportunity';
    if (key.includes('partner') || key.includes('nomination') || key.includes('nominación')) return 'Partner / Nomination';
    if (key.includes('billing') || key.includes('factura') || key.includes('support') || key.includes('soporte')) return 'Billing / Support';
    if (key.includes('compliance') || key.includes('security') || key.includes('seguridad')) return 'Compliance / Security';
    if (key === 'other' || key === 'otro' || key === 'otros') return 'Other';
    return 'Other';
  }

  function normalizePriority(value) {
    const key = String(value || '').trim().toLowerCase();
    if (['low', 'baja', 'bajo'].includes(key)) return 'Low';
    if (['high', 'alta', 'alto', 'urgent', 'urgente'].includes(key)) return 'High';
    if (['critical', 'crítica', 'critica', 'crítico', 'critico'].includes(key)) return 'Critical';
    return 'Medium';
  }

  function buildCreateTicketPayload(formElement) {
    // Lee tanto los nombres canónicos como los nombres usados por versiones
    // anteriores del formulario. Envía únicamente el contrato de /api/tickets.
    return {
      title: readCreateField(formElement, ['title', 'ticketTitle', 'subject']),
      customerName: readCreateField(formElement, ['customerName', 'customer', 'accountName', 'company']),
      customerTpid: readCreateField(formElement, ['customerTpid', 'tpid', 'TPID', 'customerId']),
      category: normalizeCategory(readCreateField(formElement, ['category', 'requestType', 'ticketType', 'service'])),
      priority: normalizePriority(readCreateField(formElement, ['priority', 'urgency', 'severity'])),
      description: readCreateField(formElement, ['description', 'details', 'issue', 'requestDescription']),
      evidenceLinks: readCreateField(formElement, ['evidenceLinks', 'evidence', 'links', 'supportingLinks'])
    };
  }

  async function createTicket(event) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const payload = buildCreateTicketPayload(formElement);
    const button = $('#createSubmit') || formElement.querySelector('[type="submit"]');

    const missing = [];
    if (!payload.title) missing.push('título');
    if (!payload.customerName) missing.push('cliente');
    if (!payload.category) missing.push('categoría');
    if (!payload.description) missing.push('descripción');
    if (missing.length) {
      showToast(`Completa estos campos: ${missing.join(', ')}.`, true);
      return;
    }

    if (button) {
      button.disabled = true;
      button.textContent = 'Creando…';
    }

    try {
      const data = await api('/tickets', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      formElement.reset();
      if (createDialog && createDialog.open) createDialog.close();
      showToast(`Ticket ${data.ticket.ticketNumber} creado.`);
      await loadTickets();
      await openTicket(data.ticket.id);
    } catch (error) {
      showToast(error.message, true);
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = 'Crear ticket';
      }
    }
  }

  async function loadNotifications() {
    if (!state.me) return;
    try {
      const data = await api('/notifications');
      state.notifications = data.notifications || [];
      const badge = $('#notificationBadge');
      badge.textContent = data.unread > 99 ? '99+' : data.unread;
      badge.classList.toggle('hidden', !data.unread);
      renderNotifications();
    } catch (error) {
      console.warn('Notifications unavailable', error.message);
    }
  }

  function renderNotifications() {
    const list = $('#notificationList');
    if (!state.notifications.length) {
      list.innerHTML = '<div class="empty-state"><strong>No tienes notificaciones.</strong></div>';
      return;
    }
    list.innerHTML = state.notifications.map(item => `
      <button type="button" class="notification ${item.read ? '' : 'unread'}" data-notification-id="${esc(item.id)}" data-notification-ticket="${esc(item.ticketId)}">
        <span class="notification-dot"></span><span><small>${esc(item.ticketNumber)}</small><strong>${esc(item.message)}</strong><span>${esc(item.title)}</span><time>${esc(formatDate(item.createdAt))}</time></span>
      </button>
    `).join('');
    document.querySelectorAll('[data-notification-id]').forEach(button => button.addEventListener('click', async () => {
      try {
        await api(`/notifications/${encodeURIComponent(button.dataset.notificationId)}/read`, { method: 'PATCH', body: '{}' });
        notificationsDialog.close();
        await Promise.all([loadNotifications(), openTicket(button.dataset.notificationTicket)]);
      } catch (error) { showToast(error.message, true); }
    }));
  }

  async function markAllRead() {
    try {
      await api('/notifications/read-all', { method: 'PATCH', body: '{}' });
      await loadNotifications();
    } catch (error) { showToast(error.message, true); }
  }

  function wireEvents() {
    $('#newTicketButton').addEventListener('click', () => createDialog.showModal());
    $('#createForm').addEventListener('submit', createTicket);
    $('#refreshButton').addEventListener('click', loadTickets);
    $('#searchInput').addEventListener('input', renderTickets);
    $('#statusFilter').addEventListener('change', renderTickets);
    $('#priorityFilter').addEventListener('change', renderTickets);
    $('#notificationsButton').addEventListener('click', () => { renderNotifications(); notificationsDialog.showModal(); });
    $('#markAllReadButton').addEventListener('click', markAllRead);
    document.querySelectorAll('.close-dialog').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
    [createDialog, detailDialog, notificationsDialog].forEach(dialog => dialog.addEventListener('click', event => {
      if (event.target === dialog) dialog.close();
    }));
  }

  wireEvents();
  boot();
})();
