const { app } = require("@azure/functions");
const { getPrincipal, getAdminEmails } = require("../lib/auth");
const { getResources } = require("../lib/cosmos");
const { createTicket, cleanTicket } = require("../lib/validation");
const { createNotifications } = require("../lib/notifications");
const { json, readJson, withApi } = require("../lib/http");

app.http("tickets-list-create", {
  methods: ["GET", "POST"],
  authLevel: "anonymous",
  route: "tickets",

  handler: withApi(async request => {
    const principal = getPrincipal(request);
    const { tickets } = await getResources();

    if (request.method === "POST") {
      const ticket = createTicket(
        await readJson(request),
        principal
      );

      const { resource } = await tickets.items.create(ticket);

      await createNotifications(
        getAdminEmails(),
        resource,
        "TICKET_CREATED",
        `${principal.displayName} creó un ticket.`,
        principal.email
      );

      return json(201, {
        ticket: cleanTicket(resource, principal)
      });
    }

    const query = principal.isAdmin
      ? {
          query:
            "SELECT TOP 500 * FROM c WHERE c.kind = @kind ORDER BY c.updatedAt DESC",
          parameters: [
            {
              name: "@kind",
              value: "ticket"
            }
          ]
        }
      : {
          query:
            "SELECT TOP 500 * FROM c WHERE c.kind = @kind AND (c.creatorEmail = @email OR c.assigneeEmail = @email) ORDER BY c.updatedAt DESC",
          parameters: [
            {
              name: "@kind",
              value: "ticket"
            },
            {
              name: "@email",
              value: principal.email
            }
          ]
        };

    const { resources } = await tickets.items
      .query(query, {
        enableCrossPartitionQuery: true
      })
      .fetchAll();

    return json(200, {
      tickets: resources.map(item =>
        cleanTicket(item, principal)
      )
    });
  })
});
