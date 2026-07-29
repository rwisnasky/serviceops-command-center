import React, { useState, useMemo, useCallback } from "react";

/* ============================================================
   Grounded Home Services Administrative Timesheet
   Weekly grid (Wed–Tue) matching the paper sheet, with live
   row/column totals and an auto-computed Comp Time tracker.
   Save Draft / Process Timesheet at the bottom. Multi-period
   ready: each week is its own sheet object with its own status.
   ============================================================ */

const GROUNDED = {
  redDeep: "#8A181A",
  blue: "#278CAE",
  navy: "#00354E",
  redBright: "#DD1F26",
  paper: "#FBFAF8",
  line: "#D8DEE3",
  lineStrong: "#B4BFC7",
  ink: "#00354E",
  inkSoft: "#4A5A66",
  fieldBg: "#FFFFFF",
  headerBg: "#00354E",
  compBg: "#F2F6F8",
};

// Row types, mirroring the paper sheet exactly.
const ROW_TYPES = [
  { key: "regular", label: "Regular" },
  { key: "overtime", label: "Overtime" },
  { key: "pto", label: "PTO Time" },
  { key: "plaw", label: "P-Law Time" },
  { key: "holiday", label: "Holiday" },
  { key: "comp", label: "Comp Time" },
];

// Wed–Tue, matching the sheet's column order.
const DAYS = [
  { key: "wed", label: "Wed" },
  { key: "thu", label: "Thurs" },
  { key: "fri", label: "Friday" },
  { key: "sat", label: "Saturday" },
  { key: "sun", label: "Sunday" },
  { key: "mon", label: "Monday" },
  { key: "tue", label: "Tuesday" },
];

const emptyGrid = () => {
  const g = {};
  ROW_TYPES.forEach((r) => {
    g[r.key] = {};
    DAYS.forEach((d) => (g[r.key][d.key] = ""));
  });
  return g;
};

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

const fmt = (n) => {
  if (n === 0) return "—";
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, "");
};

function GroundedTimesheet() {
  const [employee, setEmployee] = useState("");
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [grid, setGrid] = useState(emptyGrid);
  const [notes, setNotes] = useState("");
  const [bankedComp, setBankedComp] = useState(""); // carried-in balance
  const [status, setStatus] = useState("draft"); // draft | processed
  const [lastSaved, setLastSaved] = useState(null);

  const locked = status === "processed";

  const setCell = useCallback(
    (rowKey, dayKey, value) => {
      if (locked) return;
      if (value !== "" && !/^\d*\.?\d*$/.test(value)) return; // numeric only
      setGrid((prev) => ({
        ...prev,
        [rowKey]: { ...prev[rowKey], [dayKey]: value },
      }));
    },
    [locked]
  );

  // Row totals (per hour type across the week)
  const rowTotals = useMemo(() => {
    const t = {};
    ROW_TYPES.forEach((r) => {
      t[r.key] = DAYS.reduce((sum, d) => sum + num(grid[r.key][d.key]), 0);
    });
    return t;
  }, [grid]);

  // Column totals (per day across all types)
  const colTotals = useMemo(() => {
    const t = {};
    DAYS.forEach((d) => {
      t[d.key] = ROW_TYPES.reduce((sum, r) => sum + num(grid[r.key][d.key]), 0);
    });
    return t;
  }, [grid]);

  const grandTotal = useMemo(
    () => Object.values(rowTotals).reduce((a, b) => a + b, 0),
    [rowTotals]
  );

  // Comp tracker — 1:1. Earned this period = comp row total.
  // Used this period is tracked separately (comp taken as leave).
  const [compUsed, setCompUsed] = useState("");
  const comp = useMemo(() => {
    const banked = num(bankedComp);
    const earned = rowTotals.comp; // hours banked this week
    const used = num(compUsed);
    return { banked, earned, used, left: banked + earned - used };
  }, [bankedComp, rowTotals.comp, compUsed]);

  const handleSave = () => {
    setLastSaved(new Date());
    // In the real app: PATCH the draft timesheet to Railway.
  };

  const handleProcess = () => {
    if (!employee.trim()) {
      alert("Enter the employee name before processing.");
      return;
    }
    setStatus("processed");
    setLastSaved(new Date());
    // In the real app: POST -> status=Submitted -> manager approval queue.
  };

  const handleReopen = () => setStatus("draft");

  return (
    <div style={styles.shell}>
      <style>{css}</style>

      {/* Header */}
      <header style={styles.header}>
        <div style={styles.brandRow}>
          <FlameMark />
          <div>
            <div style={styles.brandName}>GROUNDED</div>
            <div style={styles.brandSub}>Plumbing · Heating · Cooling</div>
          </div>
        </div>
        <div style={styles.docTitleWrap}>
          <div style={styles.docTitle}>Administrative Time Sheet</div>
          <StatusPill status={status} />
        </div>
      </header>

      {/* Identity fields */}
      <section style={styles.idRow}>
        <Field label="Employee" flex={2}>
          <input
            className="ts-input"
            value={employee}
            disabled={locked}
            onChange={(e) => setEmployee(e.target.value)}
            placeholder="Full name"
          />
        </Field>
        <Field label="Pay Period Start">
          <input
            className="ts-input"
            type="date"
            value={periodStart}
            disabled={locked}
            onChange={(e) => setPeriodStart(e.target.value)}
          />
        </Field>
        <Field label="Pay Period End">
          <input
            className="ts-input"
            type="date"
            value={periodEnd}
            disabled={locked}
            onChange={(e) => setPeriodEnd(e.target.value)}
          />
        </Field>
      </section>

      {/* The grid */}
      <div style={styles.tableWrap}>
        <table style={styles.table} className="ts-table">
          <thead>
            <tr>
              <th style={{ ...styles.th, ...styles.thType }}>Hours</th>
              {DAYS.map((d) => (
                <th key={d.key} style={styles.th}>
                  {d.label}
                </th>
              ))}
              <th style={{ ...styles.th, ...styles.thTotal }}>Total</th>
            </tr>
          </thead>
          <tbody>
            {ROW_TYPES.map((r) => (
              <tr key={r.key}>
                <td style={styles.rowLabel}>{r.label}</td>
                {DAYS.map((d) => (
                  <td key={d.key} style={styles.cell}>
                    <input
                      className="ts-cell"
                      inputMode="decimal"
                      value={grid[r.key][d.key]}
                      disabled={locked}
                      onChange={(e) => setCell(r.key, d.key, e.target.value)}
                      aria-label={`${r.label} ${d.label}`}
                    />
                  </td>
                ))}
                <td style={styles.rowTotalCell}>{fmt(rowTotals[r.key])}</td>
              </tr>
            ))}
            {/* Column totals */}
            <tr>
              <td style={styles.totalsLabel}>Totals</td>
              {DAYS.map((d) => (
                <td key={d.key} style={styles.colTotalCell}>
                  {fmt(colTotals[d.key])}
                </td>
              ))}
              <td style={styles.grandTotalCell}>{fmt(grandTotal)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Comp tracker + notes */}
      <div style={styles.lowerGrid}>
        <section style={styles.compCard}>
          <div style={styles.compTitle}>Comp Time Tracking</div>
          <div style={styles.compGrid}>
            <CompStat label="Banked" editable disabled={locked}
              value={bankedComp} onChange={setBankedComp} placeholder="0" />
            <CompStat label="Earned" value={fmt(comp.earned)} readOnly hint="this week" />
            <CompStat label="Used" editable disabled={locked}
              value={compUsed} onChange={setCompUsed} placeholder="0" />
            <CompStat label="Left" value={fmt(comp.left)} readOnly emphasize
              negative={comp.left < 0} />
          </div>
          <div style={styles.compFormula}>
            Left = Banked + Earned − Used · tracked 1:1
          </div>
        </section>

        <section style={styles.notesCard}>
          <div style={styles.notesLabel}>Notes</div>
          <textarea
            className="ts-notes"
            value={notes}
            disabled={locked}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Anything payroll should know about this period…"
          />
        </section>
      </div>

      {/* Action bar */}
      <footer style={styles.actionBar}>
        <div style={styles.savedNote}>
          {lastSaved
            ? `${locked ? "Processed" : "Saved"} ${lastSaved.toLocaleString([], {
                month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
              })}`
            : "Not yet saved"}
        </div>
        <div style={styles.actionBtns}>
          {locked ? (
            <button className="ts-btn ts-btn-ghost" onClick={handleReopen}>
              Reopen for edits
            </button>
          ) : (
            <>
              <button className="ts-btn ts-btn-ghost" onClick={handleSave}>
                Save Draft
              </button>
              <button className="ts-btn ts-btn-primary" onClick={handleProcess}>
                Process Timesheet
              </button>
            </>
          )}
        </div>
      </footer>
    </div>
  );
}

/* ---------- small components ---------- */

function Field({ label, children, flex = 1 }) {
  return (
    <div style={{ ...styles.field, flex }}>
      <label style={styles.fieldLabel}>{label}</label>
      {children}
    </div>
  );
}

function CompStat({ label, value, onChange, editable, readOnly, emphasize, negative, hint, disabled, placeholder }) {
  return (
    <div style={styles.compStat}>
      <div style={styles.compStatLabel}>
        {label}
        {hint && <span style={styles.compStatHint}> · {hint}</span>}
      </div>
      {editable ? (
        <input
          className="ts-comp-input"
          inputMode="decimal"
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "" || /^\d*\.?\d*$/.test(v)) onChange(v);
          }}
        />
      ) : (
        <div
          style={{
            ...styles.compStatValue,
            ...(emphasize ? styles.compStatEmphasize : {}),
            ...(negative ? { color: GROUNDED.redBright } : {}),
          }}
        >
          {value}
        </div>
      )}
    </div>
  );
}

function StatusPill({ status }) {
  const processed = status === "processed";
  return (
    <span
      style={{
        ...styles.pill,
        background: processed ? "#E7F1EC" : "#FBF0E7",
        color: processed ? "#1C6B45" : "#9A5B1E",
        borderColor: processed ? "#BFE0CD" : "#EAD3B8",
      }}
    >
      <span
        style={{
          ...styles.pillDot,
          background: processed ? "#1C6B45" : "#C9821F",
        }}
      />
      {processed ? "Processed" : "Draft"}
    </span>
  );
}

function FlameMark() {
  // Simplified twin-flame mark echoing Grounded Home Services's red/blue logo.
  return (
    <svg width="34" height="46" viewBox="0 0 34 46" aria-hidden="true">
      <path
        d="M17 2C13 10 6 13 6 24a11 11 0 0 0 22 0C28 15 21 12 17 2Z"
        fill={GROUNDED.redBright}
      />
      <path
        d="M17 16c-2 4-6 6-6 11a6 6 0 0 0 12 0c0-5-4-7-6-11Z"
        fill={GROUNDED.blue}
      />
    </svg>
  );
}

/* ---------- styles ---------- */

const styles = {
  shell: {
    maxWidth: 940,
    margin: "0 auto",
    background: GROUNDED.paper,
    border: `1px solid ${GROUNDED.line}`,
    borderRadius: 14,
    overflow: "hidden",
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    color: GROUNDED.ink,
    boxShadow: "0 1px 3px rgba(0,53,78,0.06), 0 8px 28px rgba(0,53,78,0.06)",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "20px 24px",
    background: GROUNDED.headerBg,
    color: "#fff",
    gap: 16,
    flexWrap: "wrap",
  },
  brandRow: { display: "flex", alignItems: "center", gap: 12 },
  brandName: { fontSize: 22, fontWeight: 800, letterSpacing: 3, lineHeight: 1 },
  brandSub: { fontSize: 11, letterSpacing: 1.5, opacity: 0.72, marginTop: 3, textTransform: "uppercase" },
  docTitleWrap: { display: "flex", alignItems: "center", gap: 14 },
  docTitle: { fontSize: 15, fontWeight: 600, opacity: 0.92 },
  idRow: {
    display: "flex",
    gap: 16,
    padding: "18px 24px 8px",
    flexWrap: "wrap",
  },
  field: { display: "flex", flexDirection: "column", gap: 6, minWidth: 150 },
  fieldLabel: {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: 0.8,
    textTransform: "uppercase",
    color: GROUNDED.inkSoft,
  },
  tableWrap: { padding: "8px 24px 4px", overflowX: "auto" },
  table: { width: "100%", borderCollapse: "separate", borderSpacing: 0, minWidth: 640 },
  th: {
    background: GROUNDED.navy,
    color: "#fff",
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: 0.5,
    textTransform: "uppercase",
    padding: "9px 6px",
    textAlign: "center",
    borderRight: "1px solid rgba(255,255,255,0.12)",
  },
  thType: { textAlign: "left", paddingLeft: 14, borderTopLeftRadius: 8, minWidth: 108 },
  thTotal: { background: GROUNDED.redDeep, borderTopRightRadius: 8, borderRight: "none" },
  rowLabel: {
    fontSize: 13,
    fontWeight: 600,
    color: GROUNDED.navy,
    padding: "0 14px",
    background: "#fff",
    borderBottom: `1px solid ${GROUNDED.line}`,
    borderLeft: `1px solid ${GROUNDED.line}`,
    whiteSpace: "nowrap",
  },
  cell: {
    padding: 0,
    borderBottom: `1px solid ${GROUNDED.line}`,
    borderLeft: `1px solid ${GROUNDED.line}`,
    background: "#fff",
  },
  rowTotalCell: {
    textAlign: "center",
    fontWeight: 700,
    fontSize: 14,
    color: GROUNDED.redDeep,
    background: "#FCF6F6",
    borderBottom: `1px solid ${GROUNDED.line}`,
    borderLeft: `1px solid ${GROUNDED.lineStrong}`,
    borderRight: `1px solid ${GROUNDED.line}`,
    minWidth: 62,
  },
  totalsLabel: {
    fontSize: 12,
    fontWeight: 800,
    letterSpacing: 0.5,
    textTransform: "uppercase",
    color: "#fff",
    background: GROUNDED.navy,
    padding: "10px 14px",
    borderBottomLeftRadius: 8,
  },
  colTotalCell: {
    textAlign: "center",
    fontWeight: 700,
    fontSize: 14,
    color: GROUNDED.navy,
    background: "#EEF3F6",
    borderLeft: `1px solid ${GROUNDED.lineStrong}`,
  },
  grandTotalCell: {
    textAlign: "center",
    fontWeight: 800,
    fontSize: 15,
    color: "#fff",
    background: GROUNDED.redDeep,
    borderBottomRightRadius: 8,
  },
  lowerGrid: {
    display: "grid",
    gridTemplateColumns: "minmax(300px, 1.1fr) minmax(240px, 1fr)",
    gap: 16,
    padding: "16px 24px 4px",
  },
  compCard: {
    background: GROUNDED.compBg,
    border: `1px solid ${GROUNDED.line}`,
    borderRadius: 10,
    padding: "14px 16px 12px",
  },
  compTitle: {
    fontSize: 12,
    fontWeight: 800,
    letterSpacing: 0.8,
    textTransform: "uppercase",
    color: GROUNDED.navy,
    marginBottom: 12,
  },
  compGrid: { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 },
  compStat: { display: "flex", flexDirection: "column", gap: 5 },
  compStatLabel: {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: 0.6,
    textTransform: "uppercase",
    color: GROUNDED.inkSoft,
  },
  compStatHint: { fontWeight: 500, textTransform: "none", letterSpacing: 0, opacity: 0.7 },
  compStatValue: {
    fontSize: 20,
    fontWeight: 700,
    color: GROUNDED.navy,
    background: "#fff",
    border: `1px solid ${GROUNDED.line}`,
    borderRadius: 7,
    padding: "6px 8px",
    textAlign: "center",
  },
  compStatEmphasize: {
    color: GROUNDED.redDeep,
    borderColor: GROUNDED.redDeep,
    background: "#FCF6F6",
  },
  compFormula: {
    fontSize: 11,
    color: GROUNDED.inkSoft,
    marginTop: 10,
    fontStyle: "italic",
  },
  notesCard: {
    background: "#fff",
    border: `1px solid ${GROUNDED.line}`,
    borderRadius: 10,
    padding: "14px 16px",
    display: "flex",
    flexDirection: "column",
  },
  notesLabel: {
    fontSize: 12,
    fontWeight: 800,
    letterSpacing: 0.8,
    textTransform: "uppercase",
    color: GROUNDED.navy,
    marginBottom: 8,
  },
  actionBar: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "16px 24px 20px",
    marginTop: 8,
    borderTop: `1px solid ${GROUNDED.line}`,
    flexWrap: "wrap",
    gap: 12,
  },
  savedNote: { fontSize: 12, color: GROUNDED.inkSoft },
  actionBtns: { display: "flex", gap: 10 },
  pill: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: 0.5,
    textTransform: "uppercase",
    padding: "4px 10px",
    borderRadius: 20,
    border: "1px solid",
  },
  pillDot: { width: 7, height: 7, borderRadius: "50%" },
};

const css = `
  .ts-input {
    font: inherit;
    color: ${GROUNDED.navy};
    background: ${GROUNDED.fieldBg};
    border: 1px solid ${GROUNDED.line};
    border-radius: 8px;
    padding: 9px 11px;
    outline: none;
    transition: border-color .12s, box-shadow .12s;
    width: 100%;
    box-sizing: border-box;
  }
  .ts-input:focus {
    border-color: ${GROUNDED.blue};
    box-shadow: 0 0 0 3px rgba(39,140,174,0.15);
  }
  .ts-input:disabled { background: #F4F5F6; color: ${GROUNDED.inkSoft}; }

  .ts-cell {
    font: inherit;
    font-weight: 600;
    text-align: center;
    color: ${GROUNDED.navy};
    width: 100%;
    box-sizing: border-box;
    border: none;
    outline: none;
    padding: 11px 4px;
    background: transparent;
  }
  .ts-cell:focus {
    background: rgba(39,140,174,0.10);
    box-shadow: inset 0 0 0 2px ${GROUNDED.blue};
  }
  .ts-cell:disabled { color: ${GROUNDED.inkSoft}; }

  .ts-comp-input {
    font: inherit;
    font-size: 20px;
    font-weight: 700;
    text-align: center;
    color: ${GROUNDED.navy};
    background: #fff;
    border: 1px solid ${GROUNDED.line};
    border-radius: 7px;
    padding: 6px 8px;
    outline: none;
    width: 100%;
    box-sizing: border-box;
  }
  .ts-comp-input:focus {
    border-color: ${GROUNDED.blue};
    box-shadow: 0 0 0 3px rgba(39,140,174,0.15);
  }
  .ts-comp-input:disabled { background: #F4F5F6; }

  .ts-notes {
    font: inherit;
    color: ${GROUNDED.navy};
    border: 1px solid ${GROUNDED.line};
    border-radius: 8px;
    padding: 10px 12px;
    outline: none;
    resize: vertical;
    min-height: 84px;
    flex: 1;
    box-sizing: border-box;
  }
  .ts-notes:focus {
    border-color: ${GROUNDED.blue};
    box-shadow: 0 0 0 3px rgba(39,140,174,0.15);
  }
  .ts-notes:disabled { background: #F4F5F6; }

  .ts-btn {
    font: inherit;
    font-weight: 700;
    font-size: 14px;
    padding: 10px 20px;
    border-radius: 9px;
    cursor: pointer;
    border: 1px solid transparent;
    transition: transform .06s, filter .12s, background .12s;
  }
  .ts-btn:active { transform: translateY(1px); }
  .ts-btn-primary {
    background: ${GROUNDED.redBright};
    color: #fff;
  }
  .ts-btn-primary:hover { filter: brightness(1.06); }
  .ts-btn-ghost {
    background: #fff;
    color: ${GROUNDED.navy};
    border-color: ${GROUNDED.lineStrong};
  }
  .ts-btn-ghost:hover { background: #F4F7F9; }

  @media (max-width: 720px) {
    .ts-table { font-size: 13px; }
  }
`;

export default GroundedTimesheet;
