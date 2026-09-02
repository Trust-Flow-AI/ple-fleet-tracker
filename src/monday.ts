/** Monday.com GraphQL client, scoped to the three fleet boards. */

import { INTERVAL_COL, VEHICLE_COL, WO_COL, WO_GROUP, type Env } from './config';

const API = 'https://api.monday.com/v2';
const API_VERSION = '2024-10';

interface GqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
  error_message?: string;
}

export async function gql<T>(env: Env, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(API, {
    method: 'POST',
    headers: {
      Authorization: env.MONDAY_API_TOKEN,
      'Content-Type': 'application/json',
      'API-Version': API_VERSION,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = (await res.json()) as GqlResponse<T>;
  if (json.errors?.length) throw new Error(`Monday API: ${json.errors.map((e) => e.message).join('; ')}`);
  if (json.error_message) throw new Error(`Monday API: ${json.error_message}`);
  if (!json.data) throw new Error(`Monday API returned no data (HTTP ${res.status})`);
  return json.data;
}

// ---------------------------------------------------------------------------
// Column value readers. Monday returns everything as a JSON string in `value`
// plus a display string in `text`; which one is useful depends on the type.
// ---------------------------------------------------------------------------

export interface RawColumn { id: string; text: string | null; value: string | null }
export interface RawItem { id: string; name: string; group?: { id: string }; column_values: RawColumn[] }

function col(item: RawItem, id: string): RawColumn | undefined {
  return item.column_values.find((c) => c.id === id);
}

export function textOf(item: RawItem, id: string): string | null {
  const t = col(item, id)?.text;
  return t && t.trim() ? t.trim() : null;
}

export function numberOf(item: RawItem, id: string): number | null {
  const t = textOf(item, id);
  if (t === null) return null;
  const n = Number(t.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** Monday date columns render as YYYY-MM-DD (optionally with a time). */
export function dateOf(item: RawItem, id: string): string | null {
  const t = textOf(item, id);
  if (!t) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(t);
  return m ? m[1]! : null;
}

export function checkboxOf(item: RawItem, id: string): boolean {
  const raw = col(item, id)?.value;
  if (!raw) return false;
  try {
    return (JSON.parse(raw) as { checked?: string | boolean })?.checked === 'true' ||
      (JSON.parse(raw) as { checked?: string | boolean })?.checked === true;
  } catch { return false; }
}

export function peopleOf(item: RawItem, id: string): number[] {
  const raw = col(item, id)?.value;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { personsAndTeams?: Array<{ id: number; kind: string }> };
    return (parsed.personsAndTeams ?? []).filter((p) => p.kind === 'person').map((p) => p.id);
  } catch { return []; }
}

export function linkedIdsOf(item: RawItem, id: string): string[] {
  const raw = col(item, id)?.value;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { linkedPulseIds?: Array<{ linkedPulseId: number }> };
    return (parsed.linkedPulseIds ?? []).map((l) => String(l.linkedPulseId));
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// Board readers
// ---------------------------------------------------------------------------

const ITEMS_QUERY = `
  query Items($board: ID!, $cursor: String) {
    boards(ids: [$board]) {
      items_page(limit: 100, cursor: $cursor) {
        cursor
        items { id name group { id } column_values { id text value } }
      }
    }
  }`;

interface ItemsPage {
  cursor: string | null;
  items: RawItem[];
}
interface ItemsPageResponse {
  boards: Array<{ items_page: ItemsPage }>;
}

async function allItems(env: Env, boardId: string): Promise<RawItem[]> {
  const out: RawItem[] = [];
  let cursor: string | null = null;
  // Hard page cap: this fleet is under 10 vehicles and ~25 rules. If we ever
  // loop 50 times something is wrong and we should fail loudly, not forever.
  for (let page = 0; page < 50; page++) {
    const data: ItemsPageResponse = await gql<ItemsPageResponse>(env, ITEMS_QUERY, {
      board: boardId,
      cursor,
    });
    const pageData: ItemsPage | undefined = data.boards[0]?.items_page;
    if (!pageData) break;
    out.push(...pageData.items);
    cursor = pageData.cursor;
    if (!cursor) break;
  }
  return out;
}

export interface VehicleRow {
  mondayItemId: string;
  name: string;
  imei: string | null;
  vin: string | null;
  plate: string | null;
  status: string;
  driverIds: number[];
  driverPhone: string | null;
  odometer: number | null;
  tagExpires: string | null;
  insuranceExpires: string | null;
  inspectionDue: string | null;
}

export async function fetchVehicles(env: Env): Promise<VehicleRow[]> {
  const items = await allItems(env, env.MONDAY_BOARD_VEHICLES);
  return items.map((it) => ({
    mondayItemId: it.id,
    name: it.name,
    imei: textOf(it, VEHICLE_COL.imei),
    vin: textOf(it, VEHICLE_COL.vin),
    plate: textOf(it, VEHICLE_COL.plate),
    status: textOf(it, VEHICLE_COL.status) ?? 'Active',
    driverIds: peopleOf(it, VEHICLE_COL.driver),
    driverPhone: textOf(it, VEHICLE_COL.driverPhone),
    odometer: numberOf(it, VEHICLE_COL.odometer),
    tagExpires: dateOf(it, VEHICLE_COL.tagExpires),
    insuranceExpires: dateOf(it, VEHICLE_COL.insuranceExpires),
    inspectionDue: dateOf(it, VEHICLE_COL.inspectionDue),
  }));
}

export interface IntervalRow {
  id: string;
  name: string;
  category: string | null;
  triggerOn: string;
  miles: number | null;
  months: number | null;
  warnMiles: number;
  warnDays: number;
  appliesTo: string[];
  ownerIds: number[];
  estCost: number | null;
  active: boolean;
  watchDateCol: string | null;
  instructions: string | null;
}

export async function fetchIntervals(env: Env): Promise<IntervalRow[]> {
  const items = await allItems(env, env.MONDAY_BOARD_INTERVALS);
  return items.map((it) => ({
    id: it.id,
    name: it.name,
    category: textOf(it, INTERVAL_COL.category),
    triggerOn: textOf(it, INTERVAL_COL.triggerOn) ?? 'Whichever First',
    miles: numberOf(it, INTERVAL_COL.miles),
    months: numberOf(it, INTERVAL_COL.months),
    warnMiles: numberOf(it, INTERVAL_COL.warnMiles) ?? 0,
    warnDays: numberOf(it, INTERVAL_COL.warnDays) ?? 0,
    appliesTo: linkedIdsOf(it, INTERVAL_COL.appliesTo),
    ownerIds: peopleOf(it, INTERVAL_COL.defaultOwner),
    estCost: numberOf(it, INTERVAL_COL.estCost),
    active: checkboxOf(it, INTERVAL_COL.active),
    watchDateCol: textOf(it, INTERVAL_COL.watchDateCol),
    instructions: textOf(it, INTERVAL_COL.instructions),
  }));
}

export async function fetchItem(env: Env, itemId: string): Promise<RawItem | null> {
  const data = await gql<{ items: RawItem[] }>(
    env,
    `query One($id: ID!) { items(ids: [$id]) { id name group { id } column_values { id text value } } }`,
    { id: itemId },
  );
  return data.items[0] ?? null;
}

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------

export async function updateItem(
  env: Env,
  boardId: string,
  itemId: string,
  values: Record<string, unknown>,
): Promise<void> {
  await gql(
    env,
    `mutation Upd($board: ID!, $item: ID!, $vals: JSON!) {
       change_multiple_column_values(board_id: $board, item_id: $item, column_values: $vals) { id }
     }`,
    { board: boardId, item: itemId, vals: JSON.stringify(values) },
  );
}

export async function createWorkOrder(
  env: Env,
  opts: { name: string; groupId: string; values: Record<string, unknown> },
): Promise<string> {
  const data = await gql<{ create_item: { id: string } }>(
    env,
    `mutation New($board: ID!, $group: String!, $name: String!, $vals: JSON!) {
       create_item(board_id: $board, group_id: $group, item_name: $name,
                   column_values: $vals, create_labels_if_missing: false) { id }
     }`,
    { board: env.MONDAY_BOARD_WORKORDERS, group: opts.groupId, name: opts.name, vals: JSON.stringify(opts.values) },
  );
  return data.create_item.id;
}

export async function moveItemToGroup(env: Env, itemId: string, groupId: string): Promise<void> {
  await gql(
    env,
    `mutation Mv($item: ID!, $group: String!) {
       move_item_to_group(item_id: $item, group_id: $group) { id }
     }`,
    { item: itemId, group: groupId },
  );
}

export async function postUpdate(env: Env, itemId: string, body: string): Promise<void> {
  await gql(
    env,
    `mutation Note($item: ID!, $body: String!) { create_update(item_id: $item, body: $body) { id } }`,
    { item: itemId, body },
  );
}

/** Explicit in-product notification, on top of the one assignment already sends. */
export async function notifyUsers(env: Env, userIds: number[], itemId: string, text: string): Promise<void> {
  for (const uid of userIds) {
    try {
      await gql(
        env,
        `mutation N($user: ID!, $target: ID!, $text: String!) {
           create_notification(user_id: $user, target_id: $target, text: $text, target_type: Project) { id }
         }`,
        { user: String(uid), target: itemId, text: text.slice(0, 255) },
      );
    } catch {
      // A failed courtesy ping must never fail the work order that caused it.
    }
  }
}

export { WO_GROUP, WO_COL };
