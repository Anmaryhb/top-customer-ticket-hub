const $ = (selector) => document.querySelector(selector);

const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      })[character]
  );

const statusPill = (status) => {
  const className = String(status || "").replaceAll(" ", "");
  return `<span class="pill ${className}">${escapeHtml(status)}</span>`;
};

let currentUser = null;
let currentTickets = [];
let selectedTicketId = null;

const READ_NOTIFICATIONS_KEY = "ticketHubReadNotifications";

async function api(url, options) {
  const response = await fetch(url, options);

  let result = {};

  try {
    result = await response.json();
  } catch {
    result = {};
  }

  if (!response.ok) {
    throw new Error(
      result.error ||
        `No fue posible completar la operación. Código ${response.status}.`
    );
  }

  return result;
}

function getReadNotifications() {
  try {
    return JSON.parse(
      localStorage.getItem(READ_NOTIFICATIONS_KEY) || "{}"
    );
  } catch {
    return {};
  }
}

function saveReadNotifications(notifications) {
  localStorage.setItem(
    READ_NOTIFICATIONS_KEY,
    JSON.stringify(notifications)
  );
}

function notificationId(ticket) {
  return `${ticket.id}-${ticket.updatedAt}`;
}

function getNotifications() {
  const readNotifications = getReadNotifications();

  return currentTickets
    .map((ticket) => {
      const id = notificationId(ticket);
      const isRead = Boolean(readNotifications[id]);

      let title = "Ticket actualizado";
      let description = `${ticket.id} tiene una nueva actualización.`;

      if (ticket.status === "Pending") {
        title = "Ticket recibido";
        description = `${ticket.id} fue creado y está pendiente de revisión.`;
      }

      if (ticket.status === "Under Review") {
        title = "Ticket en revisión";
        description = `${ticket.id} está siendo revisado por el equipo.`;
      }

      if (ticket.status === "Escalated") {
        title = "Ticket escalado";
        description = `${ticket.id} fue escalado para recibir apoyo adicional.`;
      }

      if (ticket.status === "Complete") {
        title = "Ticket completado";
        description = `${ticket.id} tiene una solución o respuesta final.`;
      }

      if (ticket.status === "Cancelled") {
        title = "Ticket cancelado";
        description = `${ticket.id} fue cancelado.`;
      }

      return {
        id,
        ticketId: ticket.id,
        title,
        description,
        status: ticket.status,
        updatedAt: ticket.updatedAt,
        isRead,
      };
    })
    .sort(
      (first, second) =>
        new Date(second.updatedAt) - new Date(first.updatedAt)
    );
}

function drawNotifications() {
  const notificationList = $("#notificationList");
  const notificationCount = $("#notificationCount");

  if (!notificationList || !notificationCount) {
    return;
  }

  const notifications = getNotifications();
  const unreadNotifications = notifications.filter(
    (notification) => !notification.isRead
  );

  if (unreadNotifications.length > 0) {
    notificationCount.textContent = unreadNotifications.length;
    notificationCount.classList.remove("hidden");
  } else {
    notificationCount.textContent = "0";
    notificationCount.classList.add("hidden");
  }

  if (!notifications.length) {
    notificationList.innerHTML =
      '<p class="muted">No tienes notificaciones.</p>';
    return;
  }

  notificationList.innerHTML = notifications
    .map(
      (notification) => `
        <button
          type="button"
          class="notification-item ${
            notification.isRead ? "read" : "unread"
          }"
          onclick="openNotification(
            '${escapeHtml(notification.id)}',
            '${escapeHtml(notification.ticketId)}'
          )"
        >
          <div class="notification-title">
            ${notification.isRead ? "" : '<span class="unread-dot"></span>'}
            <strong>${escapeHtml(notification.title)}</strong>
          </div>

          <div>${escapeHtml(notification.description)}</div>

          <div class="meta">
            ${new Date(notification.updatedAt).toLocaleString()}
            · ${escapeHtml(notification.status)}
          </div>
        </button>
      `
    )
    .join("");
}

function markNotificationRead(id) {
  const readNotifications = getReadNotifications();
  readNotifications[id] = true;
  saveReadNotifications(readNotifications);
  drawNotifications();
}

function markAllNotificationsRead() {
  const readNotifications = getReadNotifications();

  getNotifications().forEach((notification) => {
    readNotifications[notification.id] = true;
  });

  saveReadNotifications(readNotifications);
  drawNotifications();
}

async function openNotification(notificationIdValue, ticketId) {
  markNotificationRead(notificationIdValue);

  const notificationPanel = $("#notificationPanel");

  if (notificationPanel) {
    notificationPanel.classList.add("hidden");
  }

  await openTicket(ticketId);
}

function toggleNotifications() {
  const notificationPanel = $("#notificationPanel");

  if (!notificationPanel) {
    return;
  }

  notificationPanel.classList.toggle("hidden");
}

function history(ticket) {
  const ticketHistory = Array.isArray(ticket.history)
    ? ticket.history
    : [];

  if (!ticketHistory.length) {
    return '<p class="muted">Este ticket todavía no tiene interacciones.</p>';
  }

  return `
    <div class="history">
      ${ticketHistory
        .map(
          (item) => `
            <div class="event">
              <b>
                ${escapeHtml(item.type)}
                · ${statusPill(item.status)}
              </b>

              <div class="meta">
                ${new Date(item.at).toLocaleString()}
                · ${escapeHtml(item.actor)}
              </div>

              ${
                item.comments
                  ? `<p>${escapeHtml(item.comments)}</p>`
                  : ""
              }

              ${
                item.nextSteps
                  ? `
                    <p>
                      <b>Siguientes pasos:</b>
                      ${escapeHtml(item.nextSteps)}
                    </p>
                  `
                  : ""
              }

              ${
                item.recommendations
                  ? `
                    <p>
                      <b>Recomendaciones:</b>
                      ${escapeHtml(item.recommendations)}
                    </p>
                  `
                  : ""
              }
            </div>
          `
        )
        .join("")}
    </div>
  `;
}

async function init() {
  try {
    const authentication = await fetch("/.auth/me").then((response) =>
      response.json()
    );

    currentUser = authentication.clientPrincipal;

    if (!currentUser) {
      return;
    }

    $("#who").textContent = currentUser.userDetails;
    $("#email").value = currentUser.userDetails;

    const response = await api("/api/tickets");

    currentTickets = response.tickets || [];

    if (response.admin) {
      $("#admin").classList.remove("hidden");
    }

    draw(currentTickets);
    drawNotifications();
  } catch (error) {
    console.error(error);

    $("#list").innerHTML = `
      <p class="muted">
        No fue posible cargar las solicitudes:
        ${escapeHtml(error.message)}
      </p>
    `;
  }
}

function draw(tickets) {
  currentTickets = tickets || [];

  $("#list").innerHTML = currentTickets.length
    ? currentTickets
        .map(
          (ticket) => `
            <div
              class="ticket"
              onclick="openTicket('${escapeHtml(ticket.id)}')"
            >
              <b>
                ${escapeHtml(ticket.id)}
                · ${escapeHtml(ticket.accountName)}
              </b>

              ${statusPill(ticket.status)}

              ${
                ticket.expertMeetingRequired === "Yes"
                  ? '<span class="pill Escalated">Expert meeting</span>'
                  : ""
              }

              <div class="meta">
                ${new Date(ticket.updatedAt).toLocaleString()}
                · ${escapeHtml(ticket.category)}
              </div>
            </div>
          `
        )
        .join("")
    : '<p class="muted">Todavía no tienes solicitudes.</p>';

  drawNotifications();
}

async function openTicket(id) {
  try {
    selectedTicketId = id;

    const ticket = await api(`/api/tickets/${id}`);
    const expertMeeting =
      ticket.expertMeetingRequired === "Yes" ? "Sí" : "No";

    $("#detail").classList.remove("hidden");

    $("#detail").innerHTML = `
      <h2>
        ${escapeHtml(ticket.id)}
        ${statusPill(ticket.status)}
      </h2>

      <div class="ticket-details">
        <p>
          <b>Cuenta:</b>
          ${escapeHtml(ticket.accountName)}
          · ${escapeHtml(ticket.accountId)}
          · TPID ${escapeHtml(ticket.tpid)}
        </p>

        <p>
          <b>Categoría:</b>
          ${escapeHtml(ticket.category)}
        </p>

        <p>
          <b>¿Mencionaron correo?</b>
          ${escapeHtml(ticket.emailMentioned || "No")}
        </p>

        <p>
          <b>¿Requiere reunión de Teams con un experto?</b>
          ${
            expertMeeting === "Sí"
              ? '<span class="pill Escalated">Sí</span>'
              : '<span class="pill Complete">No</span>'
          }
        </p>

        <p>
          <b>Requerimiento:</b>
          ${escapeHtml(ticket.requirement)}
        </p>

        <p>
          <b>Información general:</b>
          ${escapeHtml(ticket.generalInfo)}
        </p>
      </div>

      <h3>Historial</h3>
      ${history(ticket)}

      <h3>Agregar comentario</h3>

      <textarea
        id="comment"
        placeholder="Agrega información adicional o responde a la administración."
      ></textarea>

      <button
        class="btn"
        onclick="comment('${escapeHtml(id)}')"
      >
        Enviar comentario
      </button>

      <h3>Adjuntar evidencias pequeñas</h3>

      <input
        id="files"
        type="file"
        multiple
        accept=".png,.jpg,.jpeg,.pdf,.txt"
      >

      <p class="muted">
        Máximo 3 archivos de 500 KB cada uno en la versión gratuita.
      </p>

      <button
        class="btn secondary"
        onclick="upload('${escapeHtml(id)}')"
      >
        Subir archivos
      </button>
    `;

    const ticketFromList = currentTickets.find(
      (currentTicket) => currentTicket.id === id
    );

    if (ticketFromList) {
      markNotificationRead(notificationId(ticketFromList));
    }

    $("#detail").scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  } catch (error) {
    alert(error.message);
  }
}

async function comment(id) {
  const commentField = $("#comment");
  const comments = commentField.value.trim();

  if (!comments) {
    alert("Escribe un comentario antes de enviarlo.");
    return;
  }

  try {
    await api(`/api/tickets/${id}/comment`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        comments,
      }),
    });

    commentField.value = "";

    await init();
    await openTicket(id);
  } catch (error) {
    alert(error.message);
  }
}

async function upload(id) {
  const fileInput = $("#files");
  const selectedFiles = [...fileInput.files];

  if (!selectedFiles.length) {
    alert("Selecciona por lo menos un archivo.");
    return;
  }

  if (selectedFiles.length > 3) {
    alert("Puedes subir máximo 3 archivos por interacción.");
    return;
  }

  for (const file of selectedFiles) {
    if (file.size > 500000) {
      alert(
        `El archivo ${file.name} supera el máximo permitido de 500 KB.`
      );
      return;
    }
  }

  try {
    const files = await Promise.all(
      selectedFiles.map(
        (file) =>
          new Promise((resolve, reject) => {
            const reader = new FileReader();

            reader.onload = () =>
              resolve({
                name: file.name,
                type: file.type,
                data: reader.result,
              });

            reader.onerror = reject;
            reader.readAsDataURL(file);
          })
      )
    );

    await api(`/api/tickets/${id}/attachments`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        files,
      }),
    });

    alert("Archivos guardados correctamente.");

    fileInput.value = "";

    await init();
    await openTicket(id);
  } catch (error) {
    alert(error.message);
  }
}

$("#notificationButton")?.addEventListener(
  "click",
  toggleNotifications
);

$("#markAllRead")?.addEventListener(
  "click",
  markAllNotificationsRead
);

$("#form").onsubmit = async (event) => {
  event.preventDefault();

  const submitButton = event.target.querySelector(
    'button[type="submit"], button:not([type])'
  );

  try {
    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = "Creando...";
    }

    const formData = Object.fromEntries(
      new FormData(event.target)
    );

    const ticket = await api("/api/tickets", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(formData),
    });

    $("#msg").innerHTML = `
      <p>
        <b>${escapeHtml(ticket.id)}</b>
        creado correctamente.
      </p>
    `;

    event.target.reset();
    $("#email").value = currentUser.userDetails;

    await init();
  } catch (error) {
    alert(error.message);
  } finally {
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = "Crear ticket";
    }
  }
};

window.openTicket = openTicket;
window.openNotification = openNotification;
window.comment = comment;
window.upload = upload;

init();
