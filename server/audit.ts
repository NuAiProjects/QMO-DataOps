import { db } from "./db";
import { auditLogs, workflowActions } from "@shared/schema";

export async function logAudit(params: {
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  beforeJson?: unknown;
  afterJson?: unknown;
  ip?: string | null;
}) {
  await db.insert(auditLogs).values({
    actorUserId: params.actorUserId,
    action: params.action,
    entityType: params.entityType,
    entityId: params.entityId || undefined,
    beforeJson: params.beforeJson ?? null,
    afterJson: params.afterJson ?? null,
    ip: params.ip || null,
  });
}

export async function logWorkflowAction(params: {
  entityType: "training_event" | "attendance_record" | "attendance_import_batch";
  entityId: string;
  action: "submit" | "return" | "approve" | "lock" | "reopen";
  actorUserId: string;
  notes?: string | null;
}) {
  await db.insert(workflowActions).values({
    entityType: params.entityType,
    entityId: params.entityId,
    action: params.action,
    actorUserId: params.actorUserId,
    notes: params.notes || null,
  });
}
