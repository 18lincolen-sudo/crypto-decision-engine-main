/**
 * analyzeDecisions.ts — מנתח קבצי state של הבוטים ומפיק דוח פילוח לפי טווח confidence.
 *
 * הפעלה: npx tsx scripts/analyzeDecisions.ts [file1.json] [file2.json] ...
 *
 * סוגי קבצים נתמכים:
 *   - bot-state.json: decisions[] בשורש + orders[] + lastError
 *   - sim-state.json / legacy-sim-state.json / pro-sim-state.json:
 *     snapshot.trades[] + snapshot.evaluations[]
 */

import * as fs from 'fs';
import * as path from 'path';

// ============================================================
// טיפוסים
// ============================================================

/** רשומה מנורמלת — הפלט של כל פרסר */
interface UnifiedRecord {
  symbol: string;
  confidence: number;
  willExecute: boolean; // true = עסקה/החלטה לביצוע, false = HOLD/חסומה
  action: string; // SPOT, FUTURES, HOLD, buy, sell, long, short, close_long, close_short, partial_tp1
  reason: string; // סיבת החלטה / סיבת חסימה
  pnl?: number; // רווח/הפסד בדולרים (רק עסקאות סגורות)
  pnlPercent?: number; // רווח/הפסד באחוזים (רק עסקאות סגורות)
  at?: number; // timestamp
}

/** סטטיסטיקות ל-bucket אחד */
interface BucketStats {
  bucket: string;
  count: number;
  wins: number; // עסקאות עם pnl > 0
  tradesWithPnl: number; // סה"כ עסקאות עם pnl מדוד
  totalPnlPercent: number; // סכום pnl% לחישוב ממוצע
  executedCount: number; // willExecute === true
  blockedCount: number; // willExecute === false
  reasonCounts: Map<string, number>; // סיבות חסימה/החלטה
}

// ============================================================
// הגדרות
// ============================================================

/** טווחי confidence — גבולות תחתונים (העליון הוא הבא ברשימה) */
const BUCKET_BOUNDS = [0, 40, 52, 58, 60, 66, 70, 75, Infinity];
const BUCKET_LABELS = ['<40', '40-52', '52-58', '58-60', '60-66', '66-70', '70-75', '75+'];

function getBucketIndex(confidence: number): number {
  for (let i = 0; i < BUCKET_BOUNDS.length - 1; i++) {
    if (confidence >= BUCKET_BOUNDS[i] && confidence < BUCKET_BOUNDS[i + 1]) {
      return i;
    }
  }
  return BUCKET_BOUNDS.length - 2; // 75+
}

function getBucketLabel(index: number): string {
  return BUCKET_LABELS[Math.min(index, BUCKET_LABELS.length - 1)];
}

// ============================================================
// פרסרים
// ============================================================

/** פרסר לקובץ bot-state.json */
function parseBotState(filePath: string, data: unknown): { records: UnifiedRecord[]; warnings: string[] } {
  const warnings: string[] = [];
  const records: UnifiedRecord[] = [];

  if (typeof data !== 'object' || data === null) {
    warnings.push(`⚠️ ${filePath}: קובץ לא תקין (לא JSON object)`);
    return { records, warnings };
  }

  const state = data as Record<string, unknown>;

  // בדיקת lastError
  const lastError = state.lastError as string | null | undefined;
  const decisions = state.decisions as Array<Record<string, unknown>> | undefined;
  const orders = state.orders as Array<Record<string, unknown>> | undefined;

  if (decisions && decisions.length > 0 && (!orders || orders.length === 0)) {
    const errorText = lastError ? ` — lastError: ${lastError}` : '';
    warnings.push(`⚠️ 0 orders מתוך ${decisions.length} decisions${errorText}`);
  }

  if (lastError && (!decisions || decisions.length === 0)) {
    warnings.push(`⚠️ lastError קיים: ${lastError}`);
  }

  // פרסור decisions
  if (decisions && Array.isArray(decisions)) {
    for (const d of decisions) {
      const confidence = typeof d.confidence === 'number' ? d.confidence : 0;
      const action = (d.action as string) || 'HOLD';
      const willExecute = action !== 'HOLD' && action !== 'NONE';
      const reason = (d.reason as string) || (d.skipped as string) || '';
      const symbol = (d.symbol as string) || 'UNKNOWN';

      records.push({
        symbol,
        confidence,
        willExecute,
        action,
        reason,
        at: typeof d.at === 'number' ? d.at : undefined,
      });
    }
  }

  return { records, warnings };
}

/** פרסר לקובץ sim-state.json (וגרסאות legacy/pro) */
function parseSimState(filePath: string, data: unknown): { records: UnifiedRecord[]; warnings: string[] } {
  const warnings: string[] = [];
  const records: UnifiedRecord[] = [];

  if (typeof data !== 'object' || data === null) {
    warnings.push(`⚠️ ${filePath}: קובץ לא תקין (לא JSON object)`);
    return { records, warnings };
  }

  const state = data as Record<string, unknown>;
  const snapshot = state.snapshot as Record<string, unknown> | undefined;

  if (!snapshot) {
    warnings.push(`⚠️ ${filePath}: אין snapshot — אולי הבוט עדיין לא רץ`);
    return { records, warnings };
  }

  // פרסור trades (עסקאות סגורות עם pnl)
  const trades = snapshot.trades as Array<Record<string, unknown>> | undefined;
  if (trades && Array.isArray(trades)) {
    for (const t of trades) {
      const confidence = typeof t.confidence === 'number' ? t.confidence : 0;
      const pnl = typeof t.pnl === 'number' ? t.pnl : undefined;
      const pnlPercent = typeof t.pnlPercent === 'number' ? t.pnlPercent : undefined;
      const action = (t.side as string) || (t.type as string) || 'UNKNOWN';
      const symbol = (t.symbol as string) || 'UNKNOWN';
      const reason = (t.reason as string) || '';
      const at = typeof t.at === 'number' ? t.at : undefined;

      // עסקאות סגורות (close_long, close_short, partial_tp1) הן החלטות יציאה
      const isExit = action.startsWith('close_') || action === 'partial_tp1';

      records.push({
        symbol,
        confidence,
        willExecute: true, // עסקה שבוצעה
        action: isExit ? action : 'ENTRY',
        reason,
        pnl,
        pnlPercent,
        at,
      });
    }
  }

  // פרסור evaluations (החלטות שלא בוצעו בפועל)
  const evaluations = snapshot.evaluations as Array<Record<string, unknown>> | undefined;
  if (evaluations && Array.isArray(evaluations)) {
    for (const e of evaluations) {
      const confidence = typeof e.confidence === 'number' ? e.confidence : 0;
      const willExecute = e.willExecute === true;
      const action = (e.tradeType as string) || (e.action as string) || 'HOLD';
      const reason = (e.reasoning as string) || (e.status as string) || '';
      const symbol = (e.symbol as string) || 'UNKNOWN';

      records.push({
        symbol,
        confidence,
        willExecute,
        action,
        reason,
      });
    }
  }

  if (records.length === 0) {
    warnings.push(`ℹ️ ${filePath}: אין trades ואין evaluations ב-snapshot`);
  }

  return { records, warnings };
}

/** זיהוי אוטומטי של סוג הקובץ */
function parseFile(filePath: string): { records: UnifiedRecord[]; warnings: string[]; fileType: string } {
  const raw = fs.readFileSync(filePath, 'utf-8');
  let data: unknown;

  try {
    data = JSON.parse(raw);
  } catch {
    return { records: [], warnings: [`❌ ${filePath}: JSON לא תקין`], fileType: 'invalid' };
  }

  const fileName = path.basename(filePath).toLowerCase();

  // בדיקה לפי שם קובץ + מבנה
  if (fileName.includes('bot-state') || (typeof data === 'object' && data !== null && Array.isArray((data as Record<string, unknown>).decisions))) {
    const result = parseBotState(filePath, data);
    return { ...result, fileType: 'bot-state' };
  }

  if (fileName.includes('sim-state') || fileName.includes('sim-state') ||
      (typeof data === 'object' && data !== null && (data as Record<string, unknown>).snapshot)) {
    const result = parseSimState(filePath, data);
    return { ...result, fileType: 'sim-state' };
  }

  // ניסיון כללי — נבדוק מה יש
  if (typeof data === 'object' && data !== null) {
    const d = data as Record<string, unknown>;
    if (d.decisions) {
      const result = parseBotState(filePath, data);
      return { ...result, fileType: 'bot-state (inferred)' };
    }
    if (d.snapshot) {
      const result = parseSimState(filePath, data);
      return { ...result, fileType: 'sim-state (inferred)' };
    }
  }

  return { records: [], warnings: [`⚠️ ${filePath}: לא זוהה סוג קובץ מוכר`], fileType: 'unknown' };
}

// ============================================================
// חישוב סטטיסטיקות
// ============================================================

function computeBuckets(records: UnifiedRecord[]): BucketStats[] {
  const buckets: BucketStats[] = BUCKET_LABELS.map((label) => ({
    bucket: label,
    count: 0,
    wins: 0,
    tradesWithPnl: 0,
    totalPnlPercent: 0,
    executedCount: 0,
    blockedCount: 0,
    reasonCounts: new Map<string, number>(),
  }));

  for (const r of records) {
    const idx = getBucketIndex(r.confidence);
    const bucket = buckets[idx];
    bucket.count++;

    if (r.willExecute) {
      bucket.executedCount++;
    } else {
      bucket.blockedCount++;
      // ספירת סיבות חסימה
      const reason = r.reason || '(ללא סיבה)';
      bucket.reasonCounts.set(reason, (bucket.reasonCounts.get(reason) || 0) + 1);
    }

    // חישוב win-rate ו-pnl% רק לעסקאות עם pnl מדוד
    if (typeof r.pnlPercent === 'number') {
      bucket.tradesWithPnl++;
      if (r.pnlPercent > 0) bucket.wins++;
      bucket.totalPnlPercent += r.pnlPercent;
    }
  }

  return buckets;
}

// ============================================================
// תצוגה
// ============================================================

function formatPercent(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function getTopReason(bucket: BucketStats): string {
  if (bucket.reasonCounts.size === 0) return '—';
  let topReason = '';
  let topCount = 0;
  for (const [reason, count] of bucket.reasonCounts) {
    if (count > topCount) {
      topCount = count;
      topReason = reason;
    }
  }
  // קיצור סיבות ארוכות
  const truncated = topReason.length > 40 ? topReason.slice(0, 37) + '...' : topReason;
  return `${truncated} (${topCount})`;
}

function printReport(filePath: string, fileType: string, records: UnifiedRecord[], buckets: BucketStats[]): void {
  console.log('\n' + '='.repeat(100));
  console.log(`📄 ${filePath}`);
  console.log(`   סוג: ${fileType} | סה"כ רשומות: ${records.length}`);
  console.log('='.repeat(100));

  if (records.length === 0) {
    console.log('   אין נתונים להצגה.');
    return;
  }

  // טבלה
  const header = `${'Bucket'.padEnd(10)} | ${'Count'.padEnd(7)} | ${'Win Rate'.padEnd(10)} | ${'Avg PnL%'.padEnd(12)} | ${'Executed'.padEnd(10)} | ${'Blocked'.padEnd(10)} | Top Block Reason`;
  console.log(header);
  console.log('-'.repeat(100));

  for (const b of buckets) {
    if (b.count === 0) continue; // דילוג על buckets ריקים

    const winRate = b.tradesWithPnl > 0 ? `${((b.wins / b.tradesWithPnl) * 100).toFixed(0)}%` : '—';
    const avgPnl = b.tradesWithPnl > 0 ? formatPercent(b.totalPnlPercent / b.tradesWithPnl) : '—';

    const row = `${b.bucket.padEnd(10)} | ${String(b.count).padEnd(7)} | ${winRate.padEnd(10)} | ${avgPnl.padEnd(12)} | ${String(b.executedCount).padEnd(10)} | ${String(b.blockedCount).padEnd(10)} | ${getTopReason(b)}`;
    console.log(row);
  }

  // סיכום
  const totalExecuted = buckets.reduce((s, b) => s + b.executedCount, 0);
  const totalBlocked = buckets.reduce((s, b) => s + b.blockedCount, 0);
  console.log('-'.repeat(100));
  console.log(`סיכום: ${totalExecuted} לביצוע | ${totalBlocked} חסומים`);
}

// ============================================================
// תוכנית ראשית
// ============================================================

function main(): void {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('שימוש: npx tsx scripts/analyzeDecisions.ts <file1.json> [file2.json] ...');
    console.log('');
    console.log('דוגמה:');
    console.log('  npx tsx scripts/analyzeDecisions.ts bot-state.json sim-state.json legacy-sim-state.json pro-sim-state.json');
    process.exit(1);
  }

  console.log('🔍 מנתח קבצי state...');
  console.log(`   ${args.length} קבצים נמצאו בארגומנטים`);

  const allWarnings: string[] = [];
  let totalRecords = 0;

  for (const filePath of args) {
    const fullPath = path.resolve(filePath);

    if (!fs.existsSync(fullPath)) {
      console.log(`\n❌ ${filePath}: קובץ לא קיים — מדלג`);
      continue;
    }

    const { records, warnings, fileType } = parseFile(fullPath);
    allWarnings.push(...warnings);

    if (records.length > 0) {
      const buckets = computeBuckets(records);
      printReport(filePath, fileType, records, buckets);
      totalRecords += records.length;
    } else {
      console.log(`\n📄 ${filePath} — אין רשומות לניתוח`);
    }
  }

  // הדפסת אזהרות
  if (allWarnings.length > 0) {
    console.log('\n' + '!'.repeat(100));
    console.log('⚠️  אזהרות:');
    console.log('!'.repeat(100));
    for (const w of allWarnings) {
      console.log(`   ${w}`);
    }
  }

  console.log(`\n✅ סיום — ${totalRecords} רשומות נותחו בסך הכל`);
}

main();
