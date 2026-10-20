const { app } = require('@azure/functions');
const { CosmosClient } = require('@azure/cosmos');
const crypto = require('crypto');

const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
const db = client.database(process.env.COSMOS_DATABASE || 'TicketHub');
const c = db.container(process.env.COSMOS_CONTAINER || 'Tickets');
const ADMIN = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();

function principal(req) {
  try {
    const encoded = req.headers.get('x-ms-client-principal');
    if (!encoded) return null;
    return JSON.parse(Buffer.from(encoded, 'base64').toString());
  } catch {
    return null;
  }
}

function user(req) {
  const p = principal(req);
  if (!p) return null;

  const email = (p.userDetails || '').trim().toLowerCase();
  return {
    id: p.userId,
    email,
    admin: Boolean(ADMIN) && email === ADMIN,
  };
}

const json = (body, status = 200) => ({ status, jsonBody: body });

function normalizeExpertMeetingRequired(value) {
  if (typeof value === 'boolean') return value;

  if (typeof value === 'string') {
    const normalized = value
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');

    if (['si', 'yes', 'true', '1'].includes(normalized)) return true;
    if (['no', 'false', '0'].includes(normalized)) return false;
  }

  return null;
}

function sla(t) {
  const history = Array.isArray(t.history) ? t.history : [];
  const first = history.find((h) => h.role === 'Administrator');
  const due = new Date(new Date(t.createdAt).getTime() + 86400000);

  return {
    firstResponseAt: first?.at || null,
    firstResponseDue: due.toISOString(),
    firstResponseMet: first ? new Date(first.at) <= due : null,
    overdue: !first && new Date() > due,
    reopenedCount: history.filter((h) => h.type === 'Reopened').length,
  };
}

function ticketResponse(t) {
  return {
    ...t,
    expertMeetingRequired:
      normalizeExpertMeetingRequired(t.expertMeetingRequired) ?? false,
    sla: sla(t),
  };
}

async function all() {
  const query = {
    query:
      'SELECT * FROM c WHERE NOT IS_DEFINED(c.docType) OR c.docType = @ticketType',
    parameters: [{ name: '@ticketType', value: 'ticket' }],
  };
  return (await c.items.query(query).fetchAll()).resources;
}

async function get(id) {
  try {
    const resource = (await c.item(id, id).read()).resource;
    if (!resource || resource.docType === 'notification') return null;
    return resource;
  } catch {
    return null;
  }
}

async function save(t) {
  t.docType = 'ticket';
  await c.items.upsert(t);
  return t;
}

function notificationAccess(notification, currentUser) {
  if (!notification || notification.docType !== 'notification') return false;

  if (currentUser.admin) {
    return notification.recipientRole === 'Administrator';
  }

  return (
    notification.recipientRole === 'Agent' &&
    notification.recipientId === currentUser.id
  );
}

async function notificationsFor(currentUser) {
  const query = currentUser.admin
    ? {
        query:
          'SELECT * FROM c WHERE c.docType = @docType AND c.recipientRole = @recipientRole',
        parameters: [
          { name: '@docType', value: 'notification' },
          { name: '@recipientRole', value: 'Administrator' },
        ],
      }
    : {
        query:
          'SELECT * FROM c WHERE c.docType = @docType AND c.recipientRole = @recipientRole AND c.recipientId = @recipientId',
        parameters: [
          { name: '@docType', value: 'notification' },
          { name: '@recipientRole', value: 'Agent' },
          { name: '@recipientId', value: currentUser.id },
        ],
      };

  const resources = (await c.items.query(query).fetchAll()).resources;
  return resources.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function getNotification(id) {
  try {
    const resource = (await c.item(id, id).read()).resource;
    return resource?.docType === 'notification' ? resource : null;
  } catch {
    return null;
  }
}

async function createNotification({
  recipientRole,
  recipientId = null,
  recipientEmail = null,
  ticket,
  type,
  title,
  message,
  actor,
}) {
  const createdAt = new Date().toISOString();
  const notification = {
    id: `NTF-${crypto.randomUUID()}`,
    docType: 'notification',
    recipientRole,
    recipientId,
    recipientEmail,
    ticketId: ticket.id,
    type,
    title,
    message,
    actor,
    expertMeetingRequired:
      normalizeExpertMeetingRequired(ticket.expertMeetingRequired) ?? false,
    status: ticket.status,
    isRead: false,
    createdAt,
    readAt: null,
    actionUrl: `/tickets/${ticket.id}`,
  };

  await c.items.upsert(notification);
  return notification;
}

async function notify(ctx, data) {
  try {
    return await createNotification(data);
  } catch (error) {
    // A notification failure must not undo a valid ticket operation.
    ctx.error('Internal notification could not be created', error);
    return null;
  }
}

async function notifyAdmin(ctx, ticket, details) {
  return notify(ctx, {
    recipientRole: 'Administrator',
    recipientEmail: ADMIN || null,
    ticket,
    ...details,
  });
}

async function notifyAgent(ctx, ticket, details) {
  return notify(ctx, {
    recipientRole: 'Agent',
    recipientId: ticket.ownerId,
    recipientEmail: ticket.requesterEmail,
    ticket,
    ...details,
  });
}

async function notificationRequest(req, ctx, currentUser, action) {
  if (req.method === 'GET') {
    const notifications = await notificationsFor(currentUser);
    const unreadCount = notifications.filter((n) => !n.isRead).length;

    if (action === 'unread-count') return json({ unreadCount });
    if (action) return json({ error: 'AcciÃ³n de notificaciÃ³n invÃ¡lida' }, 400);

    return json({ notifications, unreadCount });
  }

  if (req.method !== 'POST') {
    return json({ error: 'MÃ©todo no permitido' }, 405);
  }

  if (action === 'read-all') {
    const notifications = await notificationsFor(currentUser);
    const at = new Date().toISOString();
    const unread = notifications.filter((n) => !n.isRead);

    await Promise.all(
      unread.map((notification) =>
        c.items.upsert({ ...notification, isRead: true, readAt: at }),
      ),
    );

    return json({ updated: unread.length, unreadCount: 0 });
  }

  if (!action) {
    return json({ error: 'Identificador de notificaciÃ³n requerido' }, 400);
  }

  const notification = await getNotification(action);
  if (!notification) return json({ error: 'NotificaciÃ³n no encontrada' }, 404);
  if (!notificationAccess(notification, currentUser)) {
    return json({ error: 'Sin acceso' }, 403);
  }

  if (!notification.isRead) {
    notification.isRead = true;
    notification.readAt = new Date().toISOString();
    await c.items.upsert(notification);
  }

  return json(notification);
}

app.http('ticketApi', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'tickets/{id?}/{action?}',
  handler: async (req, ctx) => {
    try {
      const u = user(req);
      if (!u) return json({ error: 'Authentication required' }, 401);

      const id = req.params.id;
      const action = req.params.action;

      // Notification endpoints:
      // GET  /api/tickets/notifications
      // GET  /api/tickets/notifications/unread-count
      // POST /api/tickets/notifications/read-all
      // POST /api/tickets/notifications/{notificationId}
      if (id === 'notifications') {
        return notificationRequest(req, ctx, u, action);
      }

      if (req.method === 'GET' && !id) {
        let tickets = await all();
        if (!u.admin) tickets = tickets.filter((t) => t.ownerId === u.id);

        return json({
          admin: u.admin,
          email: u.email,
          tickets: tickets
            .map(ticketResponse)
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
        });
      }

      if (req.method === 'POST' && !id) {
        const b = await req.json();

        for (const k of [
          'requesterName',
          'accountName',
          'accountId',
          'tpid',
          'category',
          'requirement',
          'generalInfo',
        ]) {
          if (!String(b[k] || '').trim()) {
            return json({ error: 'Campos obligatorios incompletos' }, 400);
          }
        }

        const expertMeetingRequired = normalizeExpertMeetingRequired(
          b.expertMeetingRequired,
        );
        if (expertMeetingRequired === null) {
          return json(
            {
              error:
                'El campo expertMeetingRequired es obligatorio y debe ser SÃ­ o No',
            },
            400,
          );
        }

        const created = new Date().toISOString();
        const seq = crypto.randomBytes(3).toString('hex').toUpperCase();
        const ticketId = `TC-${new Date().getFullYear()}-${seq}`;

        // Keep the existing payload fields, but protected server fields cannot be
        // overridden from the request body.
        const t = {
          ...b,
          id: ticketId,
          docType: 'ticket',
          ownerId: u.id,
          requesterEmail: u.email,
          expertMeetingRequired,
          status: 'Pending',
          createdAt: created,
          updatedAt: created,
          attachments: [],
          history: [
            {
              at: created,
              actor: b.requesterName,
              role: 'Agent',
              type: 'Created',
              status: 'Pending',
              comments: 'Ticket created',
            },
          ],
        };

        await save(t);

        await notifyAdmin(ctx, t, {
          type: expertMeetingRequired
            ? 'expert_meeting_requested'
            : 'ticket_created',
          title: expertMeetingRequired
            ? 'ReuniÃ³n con experto requerida'
            : 'Nuevo ticket creado',
          message: expertMeetingRequired
            ? `${b.requesterName} creÃ³ ${ticketId} para ${b.accountName} y solicitÃ³ una reuniÃ³n de Teams con un experto.`
            : `${b.requesterName} creÃ³ ${ticketId} para ${b.accountName}.`,
          actor: b.requesterName,
        });

        return json(ticketResponse(t), 201);
      }

      const t = await get(id);
      if (!t) return json({ error: 'No encontrado' }, 404);
      if (!u.admin && t.ownerId !== u.id) {
        return json({ error: 'Sin acceso' }, 403);
      }

      if (req.method === 'GET') return json(ticketResponse(t));

      const b = await req.json();
      const at = new Date().toISOString();
      t.history = Array.isArray(t.history) ? t.history : [];
      t.attachments = Array.isArray(t.attachments) ? t.attachments : [];

      let pendingNotification = null;

      if (action === 'comment') {
        if (t.ownerId !== u.id) {
          return json({ error: 'Solo el creador puede comentar' }, 403);
        }
        if (!b.comments?.trim()) {
          return json({ error: 'Comentario requerido' }, 400);
        }

        const closed = ['Complete', 'Cancelled'].includes(t.status);
        if (closed) t.status = 'Pending';

        t.history.push({
          at,
          actor: t.requesterName,
          role: 'Agent',
          type: closed ? 'Reopened' : 'Follow-up',
          status: t.status,
          comments: b.comments,
        });

        pendingNotification = {
          recipient: 'admin',
          type: closed ? 'ticket_reopened' : 'agent_comment',
          title: closed ? 'Ticket reabierto' : 'Nuevo comentario del agente',
          message: closed
            ? `${t.requesterName} reabriÃ³ ${t.id}: ${b.comments}`
            : `${t.requesterName} comentÃ³ en ${t.id}: ${b.comments}`,
          actor: t.requesterName,
        };
      } else if (action === 'attachments') {
        if (t.ownerId !== u.id) {
          return json({ error: 'Solo el creador puede adjuntar' }, 403);
        }
        if (!Array.isArray(b.files) || b.files.length > 3) {
          return json({ error: 'MÃ¡ximo 3 archivos' }, 400);
        }

        for (const f of b.files) {
          if (String(f.data).length > 700000) {
            return json({ error: 'Archivo demasiado grande' }, 400);
          }

          t.attachments.push({
            id: crypto.randomUUID(),
            name: f.name,
            type: f.type,
            data: f.data,
            uploadedAt: at,
          });
        }

        t.history.push({
          at,
          actor: t.requesterName,
          role: 'Agent',
          type: 'Attachments added',
          status: t.status,
          comments: `${b.files.length} attachment(s) added`,
        });

        pendingNotification = {
          recipient: 'admin',
          type: 'attachments_added',
          title: 'Nuevos adjuntos',
          message: `${t.requesterName} agregÃ³ ${b.files.length} archivo(s) a ${t.id}.`,
          actor: t.requesterName,
        };
      } else if (action === 'admin') {
        if (!u.admin) return json({ error: 'Solo administrador' }, 403);
        if (
          ![
            'Pending',
            'Under Review',
            'Escalated',
            'Complete',
            'Cancelled',
          ].includes(b.status) ||
          !b.comments?.trim()
        ) {
          return json({ error: 'Estado y comentario requeridos' }, 400);
        }

        t.status = b.status;
        t.history.push({
          at,
          actor: u.email,
          role: 'Administrator',
          type: 'Response',
          status: b.status,
          comments: b.comments,
          nextSteps: b.nextSteps || '',
          recommendations: b.recommendations || '',
        });

        pendingNotification = {
          recipient: 'agent',
          type: 'admin_response',
          title: 'ActualizaciÃ³n del administrador',
          message: `El administrador actualizÃ³ ${t.id} a "${b.status}": ${b.comments}`,
          actor: u.email,
        };
      } else {
        return json({ error: 'AcciÃ³n invÃ¡lida' }, 400);
      }

      t.updatedAt = at;
      await save(t);

      if (pendingNotification?.recipient === 'admin') {
        await notifyAdmin(ctx, t, pendingNotification);
      } else if (pendingNotification?.recipient === 'agent') {
        await notifyAgent(ctx, t, pendingNotification);
      }

      return json(ticketResponse(t));
    } catch (error) {
      ctx.error('Ticket API error', error);
      return json({ error: 'Error interno del servidor' }, 500);
    }
  },
});
