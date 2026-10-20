
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
          } ${notification.status.replace(/\s/g, '')}"
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
