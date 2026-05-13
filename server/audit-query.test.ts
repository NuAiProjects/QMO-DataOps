import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AUDIT_DEFAULT_LOOKBACK_DAYS,
  AUDIT_DEFAULT_PAGE_SIZE,
  AUDIT_MAX_PAGE_SIZE,
  AUDIT_MAX_RANGE_DAYS,
  buildAuditVisibilityCondition,
  getMatchingAuditActions,
  getMatchingAuditEntityTypes,
  isPrivilegedAuditRole,
  parseAuditQueryParams,
} from "./audit-query";

const NOW = new Date("2026-05-13T12:00:00.000Z");
const USER_ID = "11111111-1111-4111-8111-111111111111";
const UNIT_ID = "22222222-2222-4222-8222-222222222222";

describe("audit query controls", () => {
  it("applies bounded defaults when no filters are provided", () => {
    const parsed = parseAuditQueryParams({}, NOW);

    assert.equal(parsed.success, true);
    if (!parsed.success) return;
    assert.equal(parsed.data.page, 1);
    assert.equal(parsed.data.pageSize, AUDIT_DEFAULT_PAGE_SIZE);
    assert.equal(parsed.data.offset, 0);
    assert.equal(parsed.data.to.toISOString(), NOW.toISOString());
    assert.equal(
      parsed.data.from.toISOString(),
      new Date(NOW.getTime() - AUDIT_DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString(),
    );
  });

  it("caps oversized page sizes to prevent excessive responses", () => {
    const parsed = parseAuditQueryParams({ page: "3", pageSize: "10000" }, NOW);

    assert.equal(parsed.success, true);
    if (!parsed.success) return;
    assert.equal(parsed.data.page, 3);
    assert.equal(parsed.data.pageSize, AUDIT_MAX_PAGE_SIZE);
    assert.equal(parsed.data.offset, AUDIT_MAX_PAGE_SIZE * 2);
  });

  it("rejects date ranges that are too broad", () => {
    const parsed = parseAuditQueryParams(
      {
        from: "2025-01-01",
        to: "2026-05-13",
      },
      NOW,
    );

    assert.equal(parsed.success, false);
    if (parsed.success) return;
    assert.deepEqual(parsed.errors.dateRange, [
      `Date range cannot exceed ${AUDIT_MAX_RANGE_DAYS} days.`,
    ]);
  });

  it("rejects invalid pagination and entity IDs", () => {
    const parsed = parseAuditQueryParams(
      {
        page: "0",
        pageSize: "abc",
        entityId: "not-a-uuid",
      },
      NOW,
    );

    assert.equal(parsed.success, false);
    if (parsed.success) return;
    assert.ok(parsed.errors.page);
    assert.ok(parsed.errors.pageSize);
    assert.ok(parsed.errors.entityId);
  });
});

describe("audit plain-language filters", () => {
  it("maps record type labels to audit entity types", () => {
    assert.deepEqual(getMatchingAuditEntityTypes("Attendance"), [
      "attendance_record",
      "attendance_import_batch",
    ]);
    assert.deepEqual(getMatchingAuditEntityTypes("authentication session"), ["auth_session"]);
    assert.deepEqual(getMatchingAuditEntityTypes("training event"), ["training_event"]);
  });

  it("maps displayed activity labels to stored audit actions", () => {
    assert.deepEqual(getMatchingAuditActions("signed in"), ["auth.login.success"]);
    assert.deepEqual(getMatchingAuditActions("attendance return"), [
      "attendance_record.return",
      "attendance.return",
    ]);
    assert.deepEqual(getMatchingAuditActions("submitted for approval"), [
      "training_event.submit",
      "attendance_record.submit",
      "attendance.submit",
    ]);
  });
});

describe("audit role visibility policy", () => {
  it("does not restrict privileged audit roles", () => {
    assert.equal(isPrivilegedAuditRole("super_admin"), true);
    assert.equal(isPrivilegedAuditRole("hr_qa_approver"), true);
    assert.equal(
      buildAuditVisibilityCondition({
        userId: USER_ID,
        role: "super_admin",
        scopeUnitIds: [],
      }),
      undefined,
    );
  });

  it("requires scoped visibility for Unit Head audit access", () => {
    assert.equal(isPrivilegedAuditRole("unit_head"), false);
    assert.ok(
      buildAuditVisibilityCondition({
        userId: USER_ID,
        role: "unit_head",
        scopeUnitIds: [UNIT_ID],
      }),
    );
  });

  it("still limits Unit Head without assigned units to their own audit rows", () => {
    assert.ok(
      buildAuditVisibilityCondition({
        userId: USER_ID,
        role: "unit_head",
        scopeUnitIds: [],
      }),
    );
  });
});
