
const $ = (s) => document.querySelector(s);

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (m) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[m]));

const pill = (status) =>
  `<span class="pill ${String(status ?? "").replace(/\s/g, "")}">${esc(status)}</span>`;

let tickets = [];

const states = [
  "Pending",
  "Under Review",
  "Escalated",
  "Complete",
  "Cancelled"
];

async function api(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "Error");
  }

  return data;
}

async function init() {
  try {
    const data = await api("/api/tickets");

    if (!data.admin) {
      document.body.innerHTML =
        '<main class="wrap"><div class="card"><h2>Acceso restringido</h2></div></main>';
      return;
    }

    tickets = data.tickets || [];

    $("#who").textContent = data.email || "";

    draw();
  } catch (error) {
    console.error("Error cargando tickets:", error);

    if ($("#list")) {
      $("#list").innerHTML =
        `<p class="muted">No se pudieron cargar los tickets: ${esc(error.message)}</p>`;
    }
  }
}

function draw() {
  const query = ($("#search")?.value || "").toLowerCase();
  const filter = $("#filter")?.value || "All";

  // KPI: cantidad de tickets que requieren reunión con experto
  const expertCount = tickets.filter(
    (ticket) => ticket.expertMeetingRequired === "Yes"
  ).length;

  // Tarjetas de estados + Expert Meetings
  $("#stats").innerHTML =
    states.map((state) => `
      <div class="card stat">
        <b>${tickets.filter((ticket) => ticket.status === state).length}</b>
        ${esc(state)}
      </div>
    `).join("") +
    `
      <div class="card stat ExpertMeetingCard">
        <b>${expertCount}</b>
        🎓 Expert Meetings
      </div>
    `;

  // Categorías recurrentes
  const recurringCategories = Object.entries(
    tickets.reduce((counts, ticket) => {
      const category = ticket.category || "Sin categoría";
      counts[category] = (counts[category] || 0) + 1;
      return counts;
    }, {})
  ).sort((a, b) => b[1] - a[1]);

  $("#recurring").innerHTML =
    recurringCategories.map(([category, count]) => `
      <p>
        <b>${esc(category)}</b>:
        ${count}
        (${tickets.length
          ? Math.round((count / tickets.length) * 100)
          : 0}%)
      </p>
    `).join("") || "<p>Sin datos</p>";

  // Buscar y filtrar tickets
  const rows = tickets.filter((ticket) =>
    (filter === "All" || ticket.status === filter) &&
    (!query || JSON.stringify(ticket).toLowerCase().includes(query))
  );

  // Tabla con columna Expert
  $("#list").innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Ticket</th>
          <th>Solicitante</th>
          <th>Cuenta</th>
          <th>Expert</th>
          <th>Estado</th>
          <th>Actualizado</th>
        </tr>
      </thead>

      <tbody>
        ${rows.map((ticket) => `
          <tr>
            <td>
              <b>${esc(ticket.id)}</b>
            </td>

            <td>
              ${esc(ticket.requesterName)}<br>
              ${esc(ticket.requesterEmail)}
            </td>

            <td>
              ${esc(ticket.accountName)}<br>
              ${esc(ticket.tpid)}
            </td>

            <td>
              ${
                ticket.expertMeetingRequired === "Yes"
                  ? '<span class="pill ExpertMeeting">🎓 Sí</span>'
                  : '<span class="muted">—</span>'
              }
            </td>

            <td>${pill(ticket.status)}</td>

            <td>
              ${ticket.updatedAt
                ? new Date(ticket.updatedAt).toLocaleString()
                : "—"}
            </td>

            <td>
              <button
                class="btn secondary"
                onclick="detail('${esc(ticket.id)}')"
              >
                Ver
              </button>
            </td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

async function detail(id) {
  try {
    const ticket = await api(
      "/api/tickets/" + encodeURIComponent(id)
    );

    $("#detail").classList.remove("hidden");

    $("#detail").innerHTML = `
      <h2>
        ${esc(ticket.id)}
        ${pill(ticket.status)}
      </h2>

      <button
        class="btn secondary"
        onclick="window.print()"
      >
        Imprimir / Guardar PDF
      </button>

      <p>
        <b>Solicitante:</b>
        ${esc(ticket.requesterName)}
        · ${esc(ticket.requesterEmail)}
      </p>

      <p>
        <b>Cuenta:</b>
        ${esc(ticket.accountName)}
        · ${esc(ticket.accountId)}
        · ${esc(ticket.tpid)}
      </p>

      <p>
        <b>Requerimiento:</b>
        ${esc(ticket.requirement)}
      </p>

      <p>
        <b>Información:</b>
        ${esc(ticket.generalInfo)}
      </p>

      <p>
        <b>Reunión con experto:</b>
        ${
          ticket.expertMeetingRequired === "Yes"
            ? '<span class="pill ExpertMeeting">🎓 Sí</span>'
            : '<span class="pill Complete">No</span>'
        }
      </p>

      <p>
        <b>SLA:</b>
        ${
          ticket.sla?.overdue
            ? "Vencido"
            : ticket.sla?.firstResponseMet === false
              ? "Incumplido"
              : "En curso/Cumplido"
        }
      </p>

      <label for="status">Estado</label>
      <select id="status">
        ${states.map((state) => `
          <option
            value="${esc(state)}"
            ${state === ticket.status ? "selected" : ""}
          >
            ${esc(state)}
          </option>
        `).join("")}
      </select>

      <label for="comments">Comentarios</label>
      <textarea id="comments"></textarea>

      <label for="next">Siguientes pasos</label>
      <textarea id="next"></textarea>

      <label for="rec">Recomendaciones</label>
      <textarea id="rec"></textarea>

      <button
        class="btn"
        onclick="save('${esc(ticket.id)}')"
      >
        Guardar interacción
      </button>

      <h3>Historial</h3>

      <div class="history">
        ${(ticket.history || []).map((event) => `
          <div class="event">
            <b>
              ${esc(event.type)}
              · ${pill(event.status)}
            </b>

            <div class="meta">
              ${event.at
                ? new Date(event.at).toLocaleString()
                : "—"}
              · ${esc(event.actor)}
            </div>

            <p>${esc(event.comments || "")}</p>
          </div>
        `).join("")}
      </div>
    `;

    $("#detail").scrollIntoView({
      behavior: "smooth"
    });

  } catch (error) {
    console.error("Error abriendo ticket:", error);
    alert("No se pudo abrir el ticket: " + error.message);
  }
}

async function save(id) {
  try {
    await api(
      "/api/tickets/" + encodeURIComponent(id) + "/admin",
      {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          status: $("#status").value,
          comments: $("#comments").value,
          nextSteps: $("#next").value,
          recommendations: $("#rec").value
        })
      }
    );

    await init();
    await detail(id);

  } catch (error) {
    console.error("Error guardando ticket:", error);
    alert("No se pudo guardar la interacción: " + error.message);
  }
}

$("#search").oninput = draw;
$("#filter").onchange = draw;

window.detail = detail;
window.save = save;

init();
