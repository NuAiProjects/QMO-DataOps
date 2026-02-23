import { eq, inArray } from "drizzle-orm";
import { db } from "./db";
import { units, userUnits } from "@shared/schema";
import type { User } from "@shared/schema";

export async function getAssignedUnitIds(userId: string) {
  const rows = await db
    .select({ unitId: userUnits.unitId })
    .from(userUnits)
    .where(eq(userUnits.userId, userId));
  return rows.map((row) => row.unitId);
}

export async function getAllUnitIds() {
  const rows = await db.select({ id: units.id }).from(units);
  return rows.map((row) => row.id);
}

export async function getScopedUnitIds(user: User) {
  if (user.role === "super_admin") {
    return getAllUnitIds();
  }

  const assigned = await getAssignedUnitIds(user.id);
  if (assigned.length === 0) {
    return [];
  }

  const allUnits = await db
    .select({ id: units.id, parentUnitId: units.parentUnitId })
    .from(units);

  const childrenMap = new Map<string, string[]>();
  for (const unit of allUnits) {
    if (!unit.parentUnitId) continue;
    const list = childrenMap.get(unit.parentUnitId) || [];
    list.push(unit.id);
    childrenMap.set(unit.parentUnitId, list);
  }

  const scoped = new Set<string>();
  const stack = [...assigned];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || scoped.has(current)) continue;
    scoped.add(current);
    const children = childrenMap.get(current) || [];
    for (const child of children) {
      stack.push(child);
    }
  }

  return Array.from(scoped);
}

export function requireUnitScopeFilter(
  unitId: string | null | undefined,
  scopeUnitIds: string[],
) {
  if (!unitId) return true;
  return scopeUnitIds.includes(unitId);
}

export function scopedUnitFilter(
  unitIds: string[] | null | undefined,
  scopeUnitIds: string[],
) {
  if (!unitIds || unitIds.length === 0) return scopeUnitIds;
  return unitIds.filter((unitId) => scopeUnitIds.includes(unitId));
}

export async function getUnitsInScopeForUser(user: User) {
  const scopeUnitIds = await getScopedUnitIds(user);
  if (scopeUnitIds.length === 0) return [];
  return db
    .select()
    .from(units)
    .where(inArray(units.id, scopeUnitIds));
}
