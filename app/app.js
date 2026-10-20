(() => {
  "use strict";

  const state = {
    me: null,
    tickets: [],
    notifications: [],
    activeTicket: null,
    notificationTimer: null
  };

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => document.querySelectorAll(selector);

  const loginView = $("#loginView");
  const appView = $("#appView");
  const createDialog = $("#createDialog");
  const detailDialog = $("#detailDialog");
  const notificationsDialog = $("#notificationsDialog");

  const statusLabels = {
    Pending: "Pendiente",
    "Under Review": "En revision",
    Escalated: "Escalado",
    Complete: "Completado",
    Cancelled: "Cancelado"
  };

  const priorityLabels = {
    Low: "Baja",
    Medium: "Media",
    High: "Alta",
    Critical: "Critica"
  };

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, (character) => {
      const entities = {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "'": "&#39;",
        '"': "&quot;"
      };

      return entities[character];
    });
  }

  function formatDate(value) {
    if (!value) {
      return "-";
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
      return "-";
    }

    return new Intl.DateTimeFormat("es-CO", {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(date);
  }

  function showToast(message, isError = false) {
    const toast = $("#toast");

    if (!toast) {
      console.log(message);
      return;
    }

    toast.textContent = message;
    toast.className = `toast show${isError ? " error" : ""}`;

    clearTimeout(showToast.timer);

    showToast.timer = setTimeout(() => {
      toast.className = "toast";
    }, 4200);
  }

  async function api(path, options = {}) {
    const headers = {
      ...(options.headers || {})
    };

    if (options.body && !headers["content-type"]) {
      headers["content-type"] = "application/json";
    }

    const response = await fetch(`/api${path}`, {
      credentials: "same-origin",
      cache: "no-store",
      ...options,
      headers
    });

    const contentType = response.headers.get("content-type") || "";

    let payload = {};

    if (contentType.includes("application/json")) {
      payload = await response.json();
    }

    if (!response.ok) {
      const error = new Error(
        payload.message || `Error ${response.status}`
      );

      error.status = response.status;
      error.code = payload.error;

      throw error;
    }

    return payload;
  }

  async function getAuthenticatedUser() {
    const response = await fetch("/.auth/me", {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        accept: "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(
        `No fue posible consultar la sesion. Error ${response.status}.`
      );
    }

    const authentication = await response.json();

    if (!authentication || !authentication.clientPrincipal) {
      return null;
    }

    return authentication.clientPrincipal;
  }

  function getClaim(principal, acceptedNames) {
    const claimNames = acceptedNames.map((name) =>
      String(name).toLowerCase()
    );

    const claim = (principal.claims || []).find((item) => {
      const type = String(item.typ || item.type || "").toLowerCase();
      return claimNames.includes(type);
    });

    if (!claim) {
      return "";
    }

    return claim.val || claim.value || "";
  }

  function createProfile(principal) {
    const email = String(
      principal.userDetails ||
        getClaim(principal, [
          "preferred_username",
          "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
          "emails",
          "upn"
        ]) ||
        ""
    )
      .trim()
      .toLowerCase();

    const displayName =
      getClaim(principal, [
        "name",
        "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name"
      ]) ||
      email.split("@")[0] ||
      "Usuario";

    const roles = Array.isArray(principal.userRoles)
      ? principal.userRoles
      : [];

    const isAdmin = roles.some((role) =>
      ["admin", "administrator", "administradora"].includes(
        String(role).toLowerCase()
      )
    );

    return {
      id: principal.userId || email,
      email,
      displayName,
      roles,
      isAdmin
    };
  }

  function showLogin() {
    if (loginView) {
      loginView.classList.remove("hidden");
    }

    if (appView) {
      appView.classList.add("hidden");
    }
  }

  function showApp() {
    if (loginView) {
      loginView.classList.add("hidden");
    }

    if (appView) {
      appView.classList.remove("hidden");
    }

    const userName = $("#userName");
    const userRole = $("#userRole");
    const welcomeTitle = $("#welcomeTitle");
    const welcomeCopy = $("#welcomeCopy");

    if (userName) {
      userName.textContent = state.me.displayName;
    }

    if (userRole) {
      userRole.textContent = state.me.isAdmin
        ? "Administradora"
        : state.me.email;
    }

    if (welcomeTitle) {
      welcomeTitle.textContent = state.me.isAdmin
        ? "Panel de administracion"
        : `Hola, ${state.me.displayName}`;
    }

    if (welcomeCopy) {
      welcomeCopy.textContent = state.me.isAdmin
        ? "Revisa, asigna y actualiza las solicitudes del equipo."
        : "Crea un ticket y consulta cada actualizacion en un solo lugar.";
    }
  }

  function configureAuthenticationLinks() {
    const loginLink = document.querySelector(
      'a[href^="/.auth/login/"]'
    );

    const logoutLink = document.querySelector(
      'a[href^="/.auth/logout"]'
    );

    if (loginLink) {
      loginLink.href =
        "/.auth/login/aad?post_login_redirect_uri=/";
    }

    if (logoutLink) {
      logoutLink.href =
        "/.auth/logout?post_logout_redirect_uri=/";
    }
  }

  async function boot() {
    configureAuthenticationLinks();

    try {
      const principal = await getAuthenticatedUser();

      if (!principal) {
        state.me = null;
        showLogin();
        return;
      }

      state.me = createProfile(principal);
      showApp();

      try {
        const profile = await api("/me");

        state.me = {
          ...state.me,
          ...profile
        };

        showApp();
      } catch (error) {
        console.warn(
          "La sesion funciona, pero /api/me no esta disponible:",
          error.message
        );

        showToast(
          "Sesion iniciada. La API todavia no esta disponible.",
          true
        );
      }

      await Promise.allSettled([
        loadTickets(),
        loadNotifications()
      ]);

      clearInterval(state.notificationTimer);

      state.notificationTimer = setInterval(
        loadNotifications,
        30000
      );
    } catch (error) {
      console.error("Error al comprobar la sesion:", error);

      showLogin();

      showToast(
        error.message || "No fue posible comprobar la sesion.",
        true
      );
    }
  }

  async function loadTickets() {
    const loadingState = $("#loadingState");

    if (loadingState) {
      loadingState.classList.remove("hidden");
    }

    try {
      const data = await api("/tickets");

      state.tickets = Array.isArray(data.tickets)
        ? data.tickets
        : [];

      renderMetrics();
      renderTickets();
    } catch (error) {
      state.tickets = [];
      renderMetrics();
      renderTickets();

      showToast(
        error.message || "No fue posible cargar los tickets.",
        true
      );
    } finally {
      if (loadingState) {
        loadingState.classList.add("hidden");
      }
    }
  }

  function renderMetrics() {
    const total = $("#metricTotal");
    const pending = $("#metricPending");
    const progress = $("#metricProgress");
    const complete = $("#metricComplete");

    if (total) {
      total.textContent = state.tickets.length;
    }

    if (pending) {
      pending.textContent = state.tickets.filter(
        (ticket) => ticket.status === "Pending"
      ).length;
    }

    if (progress) {
      progress.textContent = state.tickets.filter((ticket) =>
        ["Under Review", "Escalated"].includes(ticket.status)
      ).length;
    }

    if (complete) {
      complete.textContent = state.tickets.filter(
        (ticket) => ticket.status === "Complete"
      ).length;
    }
  }

  function getFilteredTickets() {
    const searchInput = $("#searchInput");
    const statusFilter = $("#statusFilter");
    const priorityFilter = $("#priorityFilter");

    const search = searchInput
      ? searchInput.value.trim().toLowerCase()
      : "";

    const status = statusFilter ? statusFilter.value : "";
    const priority = priorityFilter
      ? priorityFilter.value
      : "";

    return state.tickets.filter((ticket) => {
      const searchableText = [
        ticket.ticketNumber,
        ticket.title,
        ticket.customerName,
        ticket.customerTpid,
        ticket.creatorEmail,
        ticket.assigneeEmail
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      const matchesSearch =
        !search || searchableText.includes(search);

      const matchesStatus =
        !status || ticket.status === status;

      const matchesPriority =
        !priority || ticket.priority === priority;

      return (
        matchesSearch &&
        matchesStatus &&
        matchesPriority
      );
    });
  }

  function renderTickets() {
    const ticketList = $("#ticketList");
    const ticketCount = $("#ticketCount");
    const emptyState = $("#emptyState");

    if (!ticketList) {
      return;
    }

    const tickets = getFilteredTickets();

    if (ticketCount) {
      ticketCount.textContent =
        `${tickets.length} resultado${tickets.length === 1 ? "" : "s"}`;
    }

    if (emptyState) {
      emptyState.classList.toggle(
        "hidden",
        tickets.length > 0
      );
    }

    ticketList.innerHTML = tickets
      .map((ticket) => {
        const statusClass = String(
          ticket.status || "Pending"
        )
          .toLowerCase()
          .replaceAll(" ", "-");

        const priorityClass = String(
          ticket.priority || "Medium"
        ).toLowerCase();

        return `
          <button
            class="ticket-row"
            type="button"
            data-ticket-id="${escapeHtml(ticket.id)}"
          >
            <span class="ticket-main">
              <span class="ticket-id">
                ${escapeHtml(ticket.ticketNumber || "")}
              </span>

              <strong>
                ${escapeHtml(ticket.title || "Sin titulo")}
              </strong>

              <small>
                ${escapeHtml(ticket.customerName || "")}
                ${
                  ticket.customerTpid
                    ? ` - TPID ${escapeHtml(ticket.customerTpid)}`
                    : ""
                }
              </small>
            </span>

            <span class="ticket-meta">
              <span class="status status-${escapeHtml(statusClass)}">
                ${escapeHtml(
                  statusLabels[ticket.status] ||
                    ticket.status ||
                    "Pendiente"
                )}
              </span>

              <span class="priority priority-${escapeHtml(priorityClass)}">
                ${escapeHtml(
                  priorityLabels[ticket.priority] ||
                    ticket.priority ||
                    "Media"
                )}
              </span>
            </span>

            <span class="ticket-owner">
              <small>Creado por</small>
              <span>
                ${escapeHtml(
                  ticket.creatorName ||
                    ticket.creatorEmail ||
                    ""
                )}
              </span>
            </span>

            <span class="ticket-date">
              <small>Actualizado</small>
              <span>${escapeHtml(formatDate(ticket.updatedAt))}</span>
            </span>

            <span class="chevron" aria-hidden="true">&gt;</span>
          </button>
        `;
      })
      .join("");

    $$("[data-ticket-id]").forEach((button) => {
      button.addEventListener("click", () => {
        openTicket(button.dataset.ticketId);
      });
    });
  }

  async function openTicket(id) {
    try {
      const data = await api(
        `/tickets/${encodeURIComponent(id)}`
      );

      state.activeTicket = data.ticket;

      renderTicketDetail();

      if (detailDialog) {
        detailDialog.showModal();
      }
    } catch (error) {
      showToast(
        error.message || "No fue posible abrir el ticket.",
        true
      );
    }
  }

  function createOptions(values, current, labels = {}) {
    return values
      .map((value) => {
        const selected =
          value === current ? " selected" : "";

        return `
          <option
            value="${escapeHtml(value)}"
            ${selected}
          >
            ${escapeHtml(labels[value] || value)}
          </option>
        `;
      })
      .join("");
  }

  function getEvidenceText(ticket) {
    return Array.isArray(ticket.evidenceLinks)
      ? ticket.evidenceLinks.join("\n")
      : "";
  }

  function renderActivity(ticket) {
    const activities = Array.isArray(ticket.activities)
      ? [...ticket.activities].reverse()
      : [];

    if (!activities.length) {
      return `
        <div class="empty-state">
          <strong>Sin actividad.</strong>
        </div>
      `;
    }

    return activities
      .map((activity) => {
        const isInternal =
          activity.visibility === "internal";

        return `
          <article class="activity-item ${
            isInternal ? "internal" : ""
          }">
            <span class="activity-dot"></span>

            <div>
              <div class="activity-heading">
                <strong>
                  ${escapeHtml(
                    activity.byName ||
                      activity.byEmail ||
                      "Usuario"
                  )}
                </strong>

                <time>
                  ${escapeHtml(formatDate(activity.at))}
                </time>
              </div>

              <p>${escapeHtml(activity.text || "")}</p>

              ${
                isInternal
                  ? "<small>Nota visible solo para administracion</small>"
                  : ""
              }
            </div>
          </article>
        `;
      })
      .join("");
  }

  function renderTicketDetail() {
    const ticket = state.activeTicket;
    const ticketDetail = $("#ticketDetail");

    if (!ticket || !ticketDetail) {
      return;
    }

    const editable = Boolean(ticket.canEdit);
    const isAdmin = Boolean(state.me && state.me.isAdmin);

    const evidenceLinks = Array.isArray(
      ticket.evidenceLinks
    )
      ? ticket.evidenceLinks
      : [];

    const linksHtml = evidenceLinks
      .map(
        (url) => `
          <li>
            <a
              href="${escapeHtml(url)}"
              target="_blank"
              rel="noopener noreferrer"
            >
              ${escapeHtml(url)}
            </a>
          </li>
        `
      )
      .join("");

    ticketDetail.innerHTML = `
      <div class="modal-heading">
        <div>
          <p class="eyebrow">
            ${escapeHtml(ticket.ticketNumber || "")}
          </p>

          <h2>${escapeHtml(ticket.title || "Ticket")}</h2>

          <p>
            ${escapeHtml(ticket.customerName || "")}
            -
            ${escapeHtml(ticket.category || "")}
          </p>
        </div>

        <div class="heading-actions">
          <button
            id="printTicketButton"
            class="button ghost compact"
            type="button"
          >
            Imprimir / PDF
          </button>

          <button
            class="icon-button close-detail"
            type="button"
            aria-label="Cerrar"
          >
            X
          </button>
        </div>
      </div>

      <div class="detail-layout">
        <section>
          <form id="editTicketForm">
            <div class="form-grid">

              <label class="full">
                <span>Titulo</span>

                <input
                  name="title"
                  maxlength="120"
                  value="${escapeHtml(ticket.title || "")}"
                  ${editable ? "" : "disabled"}
                  required
                >
              </label>

              <label>
                <span>Cliente</span>

                <input
                  name="customerName"
                  maxlength="120"
                  value="${escapeHtml(ticket.customerName || "")}"
                  ${editable ? "" : "disabled"}
                  required
                >
              </label>

              <label>
                <span>TPID</span>

                <input
                  name="customerTpid"
                  maxlength="40"
                  value="${escapeHtml(ticket.customerTpid || "")}"
                  ${editable ? "" : "disabled"}
                >
              </label>

              <label>
                <span>Categoria</span>

                <select
                  name="category"
                  ${editable ? "" : "disabled"}
                >
                  ${createOptions(
                    [
                      "Azure",
                      "Microsoft 365",
                      "MSX / Opportunity",
                      "Partner / Nomination",
                      "Billing / Support",
                      "Compliance / Security",
                      "Other"
                    ],
                    ticket.category
                  )}
                </select>
              </label>

              <label>
                <span>Prioridad</span>

                <select
                  name="priority"
                  ${editable ? "" : "disabled"}
                >
                  ${createOptions(
                    ["Low", "Medium", "High", "Critical"],
                    ticket.priority,
                    priorityLabels
                  )}
                </select>
              </label>

              <label>
                <span>Estado</span>

                <select
                  name="status"
                  ${isAdmin ? "" : "disabled"}
                >
                  ${createOptions(
                    [
                      "Pending",
                      "Under Review",
                      "Escalated",
                      "Complete",
                      "Cancelled"
                    ],
                    ticket.status,
                    statusLabels
                  )}
                </select>
              </label>

              ${
                isAdmin
                  ? `
                    <label>
                      <span>Asignar a</span>

                      <input
                        name="assigneeEmail"
                        maxlength="160"
                        value="${escapeHtml(
                          ticket.assigneeEmail || ""
                        )}"
                        placeholder="v-alias@microsoft.com"
                      >
                    </label>
                  `
                  : `
                    <label>
                      <span>Asignado a</span>

                      <input
                        value="${escapeHtml(
                          ticket.assigneeEmail ||
                            "Sin asignar"
                        )}"
                        disabled
                      >
                    </label>
                  `
              }

              <label class="full">
                <span>Descripcion</span>

                <textarea
                  name="description"
                  rows="6"
                  maxlength="5000"
                  ${editable ? "" : "disabled"}
                  required
                >${escapeHtml(ticket.description || "")}</textarea>
              </label>

              <       name="evidenceLinks"
                  rows="3"
                  ${editable ? "" : "disabled"}
                >${escapeHtml(getEvidenceText(ticket))}</textarea>
              </label>

              ${
                isAdmin
                  ? `
                    <label class="full">
                      <span>Notas administrativas</span>

                      <textarea
                        name="adminNotes"
                        rows="4"
                        maxlength="5000"
                      >${escapeHtml(ticket.adminNotes || "")}</textarea>
                    </label>
                  `
                  : ""
              }

            </div>

            <input
              type="hidden"
              name="etag"
              value="${escapeHtml(ticket.etag || "")}"
            >

            ${
              editable
                ? `
                  <div class="form-actions">
                    <button
                      id="saveTicketButton"
                      class="button primary"
                      type="submit"
                    >
                      Guardar cambios
                    </button>
                  </div>
                `
                : `
                  <p class="permission-note">
                    Solo el creador o la administradora pueden modificar este ticket.
                  </p>
                `
            }
          </form>

          <div class="evidence-print">
            <h3>Evidencia</h3>

            ${
              linksHtml
                ? `<ul>${linksHtml}</ul>`
                : "<p>Sin enlaces.</p>"
            }
          </div>
        </section>

        <aside class="timeline">
          <div class="timeline-heading">
            <div>
              <h3>Actividad</h3>
              <p>Historial del ticket</p>
            </div>
          </div>

          ${
            editable
              ? `
                <form id="messageForm" class="message-form">
                  <label>
                    <span>Nueva interaccion</span>

                    <textarea
                      name="message"
                      rows="3"
                      maxlength="3000"
                      required
                      placeholder="Escribe una actualizacion clara"
                    ></textarea>
                  </label>

                  ${
                    isAdmin
                      ? `
                        <label class="check">
                          <input
                            type="checkbox"
                            name="internal"
                          >

                          <span>
                            Nota solo para administracion
                          </span>
                        </label>
                      `
                      : ""
                  }

                  <button
                    class="button secondary"
                    type="submit"
                  >
                    Agregar interaccion
                  </button>
                </form>
              `
              : ""
          }

          <div class="activity-list">
            ${renderActivity(ticket)}
          </div>
        </aside>
      </div>
    `;

    const closeButton = $(".close-detail");
    const printButton = $("#printTicketButton");
    const editForm = $("#editTicketForm");
    const messageForm = $("#messageForm");

    if (closeButton) {
      closeButton.addEventListener("click", () => {
        detailDialog.close();
      });
    }

    if (printButton) {
      printButton.addEventListener("click", () => {
        window.print();
      });
    }

    if (editForm && editable) {
      editForm.addEventListener("submit", saveTicket);
    }

    if (messageForm) {
      messageForm.addEventListener("submit", addMessage);
    }
  }

  async function saveTicket(event) {
    event.preventDefault();

    const form = new FormData(event.currentTarget);
    const button = $("#saveTicketButton");

    const payload = {
      etag: form.get("etag"),
      title: form.get("title"),
      customerName: form.get("customerName"),
      customerTpid: form.get("customerTpid"),
      category: form.get("category"),
      priority: form.get("priority"),
      description: form.get("description"),
      evidenceLinks: form.get("evidenceLinks")
    };

    if (state.me.isAdmin) {
      payload.status = form.get("status");
      payload.assigneeEmail = form.get("assigneeEmail");
      payload.adminNotes = form.get("adminNotes");
    }

    if (button) {
      button.disabled = true;
      button.textContent = "Guardando...";
    }

    try {
      const data = await api(
        `/tickets/${encodeURIComponent(
          state.activeTicket.id
        )}`,
        {
          method: "PUT",
          body: JSON.stringify(payload)
        }
      );

      state.activeTicket = data.ticket;

      showToast(
        data.unchanged
          ? "No habia cambios para guardar."
          : "Ticket actualizado."
      );

      renderTicketDetail();
      await loadTickets();
    } catch (error) {
      showToast(error.message, true);

      if (button) {
        button.disabled = false;
        button.textContent = "Guardar cambios";
      }
    }
  }

  async function addMessage(event) {
    event.preventDefault();

    const form = new FormData(event.currentTarget);
    const submitButton = event.currentTarget.querySelector(
      'button[type="submit"]'
    );

    if (submitButton) {
      submitButton.disabled = true;
    }

    try {
      const data = await api(
        `/tickets/${encodeURIComponent(
          state.activeTicket.id
        )}/messages`,
        {
          method: "POST",
          body: JSON.stringify({
            message: form.get("message"),
            visibility: form.get("internal")
              ? "internal"
              : "public"
          })
        }
      );

      state.activeTicket = data.ticket;

      showToast("Interaccion agregada.");

      renderTicketDetail();
      await loadTickets();
    } catch (error) {
      showToast(error.message, true);

      if (submitButton) {
        submitButton.disabled = false;
      }
    }
  }

  async function createTicket(event) {
    event.preventDefault();

    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const button = $("#createSubmit");

    if (button) {
      button.disabled = true;
      button.textContent = "Creando...";
    }

    try {
      const payload = Object.fromEntries(form.entries());

      const data = await api("/tickets", {
        method: "POST",
        body: JSON.stringify(payload)
      });

      formElement.reset();

      if (createDialog) {
        createDialog.close();
      }

      showToast(
        `Ticket ${data.ticket.ticketNumber} creado.`
      );

      await loadTickets();
      await openTicket(data.ticket.id);
    } catch (error) {
      showToast(error.message, true);
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = "Crear ticket";
      }
    }
  }

  async function loadNotifications() {
    if (!state.me) {
      return;
    }

    try {
      const data = await api("/notifications");

      state.notifications = Array.isArray(data.notifications)
        ? data.notifications
        : [];

      const badge = $("#notificationBadge");
      const unread = Number(data.unread || 0);

      if (badge) {
        badge.textContent = unread > 99 ? "99+" : unread;
        badge.classList.toggle("hidden", unread === 0);
      }

      renderNotifications();
    } catch (error) {
      console.warn(
        "No fue posible cargar las notificaciones:",
        error.message
      );
    }
  }

  function renderNotifications() {
    const list = $("#notificationList");

    if (!list) {
      return;
    }

    if (!state.notifications.length) {
      list.innerHTML = `
        <div class="empty-state">
          <strong>No tienes notificaciones.</strong>
        </div>
      `;

      return;
    }

    list.innerHTML = state.notifications
      .map(
        (notification) => `
          <button
            type="button"
            class="notification ${
              notification.read ? "" : "unread"
            }"
            data-notification-id="${escapeHtml(
              notification.id
            )}"
            data-notification-ticket="${escapeHtml(
              notification.ticketId
            )}"
          >
            <span class="notification-dot"></span>

            <span>
              <small>
                ${escapeHtml(
                  notification.ticketNumber || ""
                )}
              </small>

              <strong>
                ${escapeHtml(
                  notification.message ||
                    "Nueva actualizacion"
                )}
              </strong>

              <span>
                ${escapeHtml(notification.title || "")}
              </span>

              <time>
                ${escapeHtml(
                  formatDate(notification.createdAt)
                )}
              </time>
            </span>
          </button>
        `
      )
      .join("");

    $$("[data-notification-id]").forEach((button) => {
      button.addEventListener("click", async () => {
        try {
          await api(
            `/notifications/${encodeURIComponent(
              button.dataset.notificationId
            )}/read`,
            {
              method: "PATCH",
              body: "{}"
            }
          );

          if (notificationsDialog) {
            notificationsDialog.close();
          }

          await Promise.all([
            loadNotifications(),
            openTicket(
              button.dataset.notificationTicket
            )
          ]);
        } catch (error) {
          showToast(error.message, true);
        }
      });
    });
  }

  async function markAllRead() {
    try {
      await api("/notifications/read-all", {
        method: "PATCH",
        body: "{}"
      });

      await loadNotifications();
    } catch (error) {
      showToast(error.message, true);
    }
  }

  function wireEvents() {
    const newTicketButton = $("#newTicketButton");
    const createForm = $("#createForm");
    const refreshButton = $("#refreshButton");
    const searchInput = $("#searchInput");
    const statusFilter = $("#statusFilter");
    const priorityFilter = $("#priorityFilter");
    const notificationsButton = $("#notificationsButton");
    const markAllReadButton = $("#markAllReadButton");

    if (newTicketButton && createDialog) {
      newTicketButton.addEventListener("click", () => {
        createDialog.showModal();
      });
    }

    if (createForm) {
      createForm.addEventListener(
        "submit",
        createTicket
      );
    }

    if (refreshButton) {
      refreshButton.addEventListener(
        "click",
        loadTickets
      );
    }

    if (searchInput) {
      searchInput.addEventListener(
        "input",
        renderTickets
      );
    }

    if (statusFilter) {
      statusFilter.addEventListener(
        "change",
        renderTickets
      );
    }

    if (priorityFilter) {
      priorityFilter.addEventListener(
        "change",
        renderTickets
      );
    }

    if (notificationsButton && notificationsDialog) {
      notificationsButton.addEventListener(
        "click",
        () => {
          renderNotifications();
          notificationsDialog.showModal();
        }
      );
    }

    if (markAllReadButton) {
      markAllReadButton.addEventListener(
        "click",
        markAllRead
      );
    }

    $$(".close-dialog").forEach((button) => {
      button.addEventListener("click", () => {
        const dialog = button.closest("dialog");

        if (dialog) {
          dialog.close();
        }
      });
    });

    [
      createDialog,
      detailDialog,
      notificationsDialog
    ]
      .filter(Boolean)
      .forEach((dialog) => {
        dialog.addEventListener("click", (event) => {
          if (event.target === dialog) {
            dialog.close();
          }
        });
      });
  }

  wireEvents();
  boot();
})();
