# Monday board reference

Board and column IDs, and what writes to what. The canonical copy of these IDs
lives in [`src/config.ts`](../src/config.ts) — this document explains them.

> **Before changing a board**, read [Board surgery](#board-surgery) at the bottom.

## Boards

| Board | Secret holding its ID |
|---|---|
| Fleet — Vehicles | `MONDAY_BOARD_VEHICLES` |
| Fleet — Service Intervals | `MONDAY_BOARD_INTERVALS` |
| Fleet — Maintenance & Renewals | `MONDAY_BOARD_WORKORDERS` |

Board IDs and the account URL (`MONDAY_ACCOUNT_URL`) are **deployment secrets**,
not repo contents — that is what allows this repository to be public. Set them
with `wrangler secret put`.

To find a board's ID, open it in Monday: it is the number in the URL,
`https://<account>.monday.com/boards/<board-id>`.

The **column** IDs below are not secrets — they are meaningless without the
board ID and an API token, and the code is unreadable without them.

---

## Fleet — Vehicles

One row per truck. **W** = who writes it.

| Column | ID | Type | W | Notes |
|---|---|---|---|---|
| Status | `color_mm6tvqqe` | status | 👤 | `Active` · `In Shop` · `Out of Service` · `Sold`. Only the first two are evaluated |
| Assigned Driver | `multiple_person_mm6tzyfc` | people | 👤 | Gets assigned every work order for this vehicle |
| Driver Phone | `phone_mm6tsjav` | phone | 👤 | For maintenance SMS |
| Year / Make / Model | `text_mm6tkz6t` | text | 👤 | |
| Plate | `text_mm6ta8bc` | text | 👤 | |
| VIN | `text_mm6ta1pr` | text | 👤 | Should match what Bouncie reports |
| **Bouncie IMEI** | `text_mm6t3cyb` | text | 👤 | **JOIN KEY.** 15 digits. Blank or wrong = no telematics for this truck |
| Odometer | `numeric_mm6txggp` | numbers | 🤖 | From `tripEnd`. Do not hand-edit |
| Odometer Updated | `date_mm6tcbhc` | date | 🤖 | Goes stale → device likely unplugged |
| Check Engine | `color_mm6t69nx` | status | 🤖 | `OK` · `CHECK ENGINE ON` |
| Fault Codes | `text_mm6tx5ff` | text | 🤖 | Active DTCs, comma separated |
| Vehicle Battery | `color_mm6twazn` | status | 🤖 | `Normal` · `Low` · `Critical` |
| Device Status | `color_mm6tm3qt` | status | 🤖 | `Connected` · `Disconnected` |
| Tag Expires | `date_mm6tbwj` | date | 👤 | Drives the Tag Renewal rule |
| Insurance Expires | `date_mm6tgnef` | date | 👤 | Drives the Insurance Renewal rule |
| Annual Inspection Due | `date_mm6t36pg` | date | 👤 | Drives the Safety Inspection rule |
| Notes | `long_text_mm6tt9ef` | long_text | 👤 | |
| Open Work Orders | `board_relation_mm6twn70` | board_relation | 🤖 | → Maintenance & Renewals |

---

## Fleet — Service Intervals

One row per maintenance type. 22 pre-loaded. The office owns this board
entirely; the Worker only reads it.

| Column | ID | Type | Notes |
|---|---|---|---|
| Category | `color_mm6tg2a3` | status | Engine & Fluids · Brakes · Tires & Wheels · Compliance · Inspection · Diagnostic · Other |
| Trigger On | `color_mm6t3x6` | status | `Whichever First` · `Mileage Only` · `Date Only` · `Fault Code` |
| Interval — Miles | `numeric_mm6tf6rj` | numbers | Blank for date-only items |
| Interval — Months | `numeric_mm6tsrfh` | numbers | Blank for mileage-only items |
| Warn Ahead — Miles | `numeric_mm6tj9j9` | numbers | Open the order this far ahead |
| Warn Ahead — Days | `numeric_mm6tn4hs` | numbers | Same, in days |
| Applies To | `board_relation_mm6tr971` | board_relation | **Empty = every active vehicle.** Link specific vehicles to restrict |
| Default Owner | `multiple_person_mm6tkf2y` | people | Fallback when the vehicle has no driver |
| Est. Cost | `numeric_mm6tfv62` | numbers | Budget estimate only |
| Active | `boolean_mm6t2200` | checkbox | Uncheck to pause without losing history |
| Instructions / Spec | `long_text_mm6tz8v3` | long_text | Copied into the work order's Notes |
| Watches Vehicle Date Column | `text_mm6tmd08` | text | **Mode switch.** Blank = recurring. A vehicle date column ID = fixed expiry |

### `Trigger On` semantics

| Value | Behaviour |
|---|---|
| `Whichever First` | Opens when **either** mileage or months is inside its warn window. The right default for nearly everything |
| `Mileage Only` | Ignores the date side entirely |
| `Date Only` | Ignores the mileage side entirely |
| `Fault Code` | **Never scheduled.** Fires from the `mil` webhook |

### `Watches Vehicle Date Column` values

Only three are meaningful — the date columns on Fleet — Vehicles:

| Value | Drives |
|---|---|
| `date_mm6tbwj` | Tag / registration renewal |
| `date_mm6tgnef` | Insurance renewal |
| `date_mm6t36pg` | Annual safety inspection |

A rule with this set gets **no mileage component and no interval arithmetic** —
the due date is read straight off the vehicle. This is what keeps compliance
items from double-booking.

### Pre-loaded rules

| Rule | Miles | Months | Warn |
|---|---|---|---|
| Oil & Filter Change | 5,000 | 6 | 500 mi / 14 d |
| Tire Rotation | 6,000 | 6 | 500 mi / 14 d |
| Brake Inspection | 12,000 | 12 | 1,000 mi / 21 d |
| Brake Pads & Rotors | 40,000 | — | 2,000 mi |
| Tire Replacement / Tread Check | 40,000 | — | 2,500 mi |
| Wheel Alignment | 30,000 | 24 | 1,500 mi / 30 d |
| Engine Air Filter | 20,000 | 24 | 1,000 mi / 30 d |
| Cabin Air Filter | 20,000 | 24 | 1,000 mi / 30 d |
| Transmission Fluid Service | 60,000 | 60 | 2,500 mi / 45 d |
| Coolant Flush | 60,000 | 60 | 2,500 mi / 45 d |
| Differential / Transfer Case Fluid | 50,000 | — | 2,500 mi |
| Spark Plugs | 100,000 | — | 5,000 mi |
| Serpentine Belt & Hoses | 60,000 | 60 | 2,500 mi / 45 d |
| Battery Test & Terminal Clean | 30,000 | 24 | 1,500 mi / 30 d |
| Wiper Blades | — | 12 | 14 d |
| Tag / Registration Renewal | — | expiry | 45 d |
| Insurance Renewal | — | expiry | 30 d |
| Annual Safety Inspection | — | expiry | 30 d |
| Check Engine Light — Diagnose | fault code | — | — |
| Ladder Rack & Load Tie-Down Inspection | — | 6 | 14 d |
| Fire Extinguisher & First Aid Kit Check | — | 12 | 21 d |
| Full Service Inspection (Multi-Point) | 15,000 | 12 | 1,000 mi / 21 d |

`POST /admin/baseline` needs a rule's Monday **item ID**. Find it by opening the
item — the ID is the last number in the URL — or list them all:

```bash
curl -s https://api.monday.com/v2 \
  -H "Authorization: $MONDAY_API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"query":"{boards(ids:[BOARD_ID]){items_page(limit:50){items{id name}}}}"}' | jq
```

---

## Fleet — Maintenance & Renewals

The working board. Work orders open themselves here.

| Column | ID | Type | W | Notes |
|---|---|---|---|---|
| Work Order Status | `color_mm6t1t7w` | status | both | **The trigger.** Setting `Done` or `Skipped` fires the Monday webhook |
| Vehicle | `board_relation_mm6txz3p` | board_relation | 🤖 | → Vehicles |
| Service Type | `board_relation_mm6tdkkw` | board_relation | 🤖 | → Service Intervals |
| Assigned To | `multiple_person_mm6tzcf0` | people | 🤖 | Vehicle's driver, else the rule's Default Owner |
| Priority | `color_mm6tk6v3` | status | 🤖 | `Critical — Do Not Drive` · `High` · `Normal` |
| Due Date | `date_mm6t8gyc` | date | 🤖 | Blank on pure-mileage items |
| Due At Odometer | `numeric_mm6t4nsz` | numbers | 🤖 | |
| Miles Remaining | `numeric_mm6ts1wh` | numbers | 🤖 | Recalculated on every odometer update. Negative = overdue |
| Scheduled For | `date_mm6ts7b8` | date | 👤 | The shop appointment |
| Completed Date | `date_mm6tw7te` | date | 👤 | **Read on completion** |
| Odometer at Service | `numeric_mm6ty1kt` | numbers | 👤 | **Read on completion.** Blank → uses live Bouncie reading and says so |
| Cost | `numeric_mm6tj9tf` | numbers | 👤 | |
| Vendor | `text_mm6tgemf` | text | 👤 | |
| Invoice / Receipt | `file_mm6t6g6d` | file | 👤 | |
| Opened By | `color_mm6t3qfg` | status | 🤖 | `Auto — Mileage` · `Auto — Date` · `Auto — Fault Code` · `Auto — Battery` · `Manual` |
| Notes | `long_text_mm6t3yvn` | long_text | both | Seeded from the rule's Instructions |

### Groups

| Group | ID | Filled by |
|---|---|---|
| 🔴 Overdue | `group_mm6trkw0` | Worker, when past the actual due point |
| 🟠 Due Soon | `group_mm6tva2t` | Worker, when inside the warn window |
| 🔵 Scheduled | `group_mm6t63e3` | You |
| 🟣 In Shop | `group_mm6t5e2w` | You |
| ✅ Service History | `group_mm6twp5x` | Worker, on completion. **Doubles as the cost/service log** |
| Unsorted / Manual | `topics` | Manually created orders |

### Status values

| Value | Meaning |
|---|---|
| `Overdue` | Past due. Priority raised |
| `Due Soon` | Inside the warn window |
| `Scheduled` | Appointment booked |
| `In Shop` | Being worked on |
| `Done` | **Resets the service clock** from Completed Date + Odometer at Service |
| `Skipped` | Resets the clock without recording a service, so it re-arms next interval |

---

## Board surgery

The Worker addresses columns by ID, not title, so:

- ✅ **Renaming a column is safe.** IDs don't change.
- ✅ **Adding columns is safe.** Unknown columns are ignored.
- ✅ **Reordering, adding views, adding groups** — all safe.
- ⚠️ **Adding a status label is safe**, but the Worker only ever writes the
  labels listed above (`create_labels_if_missing: false`, so a typo fails loudly
  rather than silently creating a junk label).
- ❌ **Deleting a column breaks that one field, silently.**
- ❌ **Rebuilding a board from scratch gives every column a new ID** and requires
  updating `src/config.ts`.

After any board change, run:

```bash
curl "https://<worker>/admin/verify?key=$ADMIN_KEY"
```

It reports every column the code expects that no longer exists, plus vehicle /
rule / open-order counts and your Bouncie webhook states.

CI cannot do this check — it has no Monday token. See
[CONTRIBUTING.md](../CONTRIBUTING.md#verifying-config-against-the-live-boards).
