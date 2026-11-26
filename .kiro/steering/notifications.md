---
inclusion: fileMatch
fileMatchPattern: 'server/src/{notifications,inbox,push}*.ts'
---

# Notification rules

- The push is a hint; `inbox_items` is the source of truth. The app must be fully usable if every push is lost.
- Keep four facts separate: event created, push accepted by FCM, device acknowledged, user acted. Never infer one from another.
- Outbox rows are inserted in the same transaction as the business change.
- Payloads: generic title/body, `type`, opaque `inboxItemId`, `nid`. Never document names, recipients, extracted values or amounts. A test snapshots this.
- Never send for resolved or expired items. Approval requests are high priority with a short TTL; do not promise instant delivery in code, UI or docs.
- Deep links carry no authority; the server authorises every fetch.
