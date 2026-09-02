/**
 * Monday board + column identifiers.
 *
 * These were generated when the boards were created. If you add or delete a
 * column in Monday you do NOT need to touch this file — but if you DELETE one
 * of the columns named here, the integration will start failing silently on
 * that field. Run `GET /admin/verify` after any board surgery.
 */

export const VEHICLE_COL = {
  status: 'color_mm6tvqqe',
  driver: 'multiple_person_mm6tzyfc',
  driverPhone: 'phone_mm6tsjav',
  yearMakeModel: 'text_mm6tkz6t',
  plate: 'text_mm6ta8bc',
  vin: 'text_mm6ta1pr',
  imei: 'text_mm6t3cyb',
  odometer: 'numeric_mm6txggp',
  odometerUpdated: 'date_mm6tcbhc',
  checkEngine: 'color_mm6t69nx',
  faultCodes: 'text_mm6tx5ff',
  battery: 'color_mm6twazn',
  deviceStatus: 'color_mm6tm3qt',
  tagExpires: 'date_mm6tbwj',
  insuranceExpires: 'date_mm6tgnef',
  inspectionDue: 'date_mm6t36pg',
  notes: 'long_text_mm6tt9ef',
  openWorkOrders: 'board_relation_mm6twn70',
} as const;

export const INTERVAL_COL = {
  category: 'color_mm6tg2a3',
  triggerOn: 'color_mm6t3x6',
  miles: 'numeric_mm6tf6rj',
  months: 'numeric_mm6tsrfh',
  warnMiles: 'numeric_mm6tj9j9',
  warnDays: 'numeric_mm6tn4hs',
  defaultOwner: 'multiple_person_mm6tkf2y',
  estCost: 'numeric_mm6tfv62',
  active: 'boolean_mm6t2200',
  instructions: 'long_text_mm6tz8v3',
  appliesTo: 'board_relation_mm6tr971',
  watchDateCol: 'text_mm6tmd08',
} as const;

export const WO_COL = {
  status: 'color_mm6t1t7w',
  vehicle: 'board_relation_mm6txz3p',
  serviceType: 'board_relation_mm6tdkkw',
  assignedTo: 'multiple_person_mm6tzcf0',
  priority: 'color_mm6tk6v3',
  dueDate: 'date_mm6t8gyc',
  dueAtOdometer: 'numeric_mm6t4nsz',
  milesRemaining: 'numeric_mm6ts1wh',
  scheduledFor: 'date_mm6ts7b8',
  completedDate: 'date_mm6tw7te',
  odometerAtService: 'numeric_mm6ty1kt',
  cost: 'numeric_mm6tj9tf',
  vendor: 'text_mm6tgemf',
  invoice: 'file_mm6t6g6d',
  openedBy: 'color_mm6t3qfg',
  notes: 'long_text_mm6t3yvn',
} as const;

export const WO_GROUP = {
  overdue: 'group_mm6trkw0',
  dueSoon: 'group_mm6tva2t',
  scheduled: 'group_mm6t63e3',
  inShop: 'group_mm6t5e2w',
  history: 'group_mm6twp5x',
} as const;

export const WO_STATUS = {
  overdue: 'Overdue',
  dueSoon: 'Due Soon',
  scheduled: 'Scheduled',
  inShop: 'In Shop',
  done: 'Done',
  skipped: 'Skipped',
} as const;

export const PRIORITY = {
  critical: 'Critical — Do Not Drive',
  high: 'High',
  normal: 'Normal',
} as const;

export const OPENED_BY = {
  mileage: 'Auto — Mileage',
  date: 'Auto — Date',
  faultCode: 'Auto — Fault Code',
  battery: 'Auto — Battery',
  manual: 'Manual',
} as const;

/** Vehicle statuses the automation acts on. Sold / Out of Service are ignored. */
export const ACTIVE_VEHICLE_STATUSES = new Set(['Active', 'In Shop']);

/**
 * Fault codes we treat as park-the-truck-now rather than schedule-a-diagnosis.
 * Matched as a prefix against the reported DTC.
 */
export const CRITICAL_DTC_PREFIXES = [
  'P0A', // hybrid/EV high-voltage system
  'P0217', // engine overheating
  'P0300', 'P0301', 'P0302', 'P0303', 'P0304', 'P0305', 'P0306', 'P0307', 'P0308', // misfires
  'P0016', // crank/cam correlation
  'P0521', 'P0522', 'P0523', // oil pressure
  'P0562', 'P0563', // charging system voltage
  'U0100', // lost comms with ECM
];

export interface Env {
  DB: D1Database;

  /** e.g. https://acme.monday.com — no trailing slash. A secret, so that this
   *  repo can be public without naming a specific organisation's workspace. */
  MONDAY_ACCOUNT_URL: string;
  MONDAY_BOARD_VEHICLES: string;
  MONDAY_BOARD_INTERVALS: string;
  MONDAY_BOARD_WORKORDERS: string;

  DIGEST_TO: string;
  ALERT_TO: string;
  MAIL_FROM: string;
  TIMEZONE: string;
  DIGEST_HOUR: string;
  SEED_BASELINE_FROM_CURRENT: string;
  SMS_PRIORITIES: string;

  BOUNCIE_CLIENT_ID: string;
  BOUNCIE_CLIENT_SECRET: string;
  BOUNCIE_REDIRECT_URI: string;
  BOUNCIE_AUTH_CODE: string;
  BOUNCIE_WEBHOOK_KEY: string;

  MONDAY_API_TOKEN: string;
  RESEND_API_KEY?: string;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_FROM?: string;
  ADMIN_KEY: string;
}
