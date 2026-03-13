import React, { useState, useRef, useCallback, useEffect, useMemo } from "react";
import type { CSSProperties } from "react";
import {
  AreaChart,
  Area,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  type TooltipContentProps,
} from "recharts";

const API_BASE = "http://localhost:8000";

// ─── Types ───────────────────────────────────────────────────────────────────
interface Holding {
  id: number | string;
  code: string;
  name: string;
  shares: number;
  cost: number;
  price: number;
  sector: string;
  notes: string;
}

interface CurvePoint {
  date: string;
  value: number;
}

interface DiaryEntry {
  id: number;
  date: string;
  type: string;
  code: string;
  remark: string;
  mood: string;
}

interface AiHolding {
  code?: string;
  name?: string;
  shares?: number;
  cost?: number;
  price?: number;
  pnl_pct?: number;
  sector?: string;
}

interface AiResult {
  holdings?: AiHolding[];
  total_assets?: number;
  total_pnl?: number;
  date?: string | null;
  summary?: string;
  error?: string;
  raw?: string;
}

interface HoldingDiff {
  code: string;
  name: string;
  isNew: boolean;
  existing: Holding | null;
  incoming: AiHolding;
  accepted: boolean;
}

interface ImportRecord {
  id: number;
  created_at: string;
  label: string;
  holding_count: number;
}

interface Hs300Point {
  date: string;
  close: number;
}

// ─── Utility ─────────────────────────────────────────────────────────────────
const fmt = (n: number, digits = 2) =>
  typeof n === "number" ? n.toFixed(digits).replace(/\B(?=(\d{3})+(?!\d))/g, ",") : "—";
const fmtPct = (n: number | undefined) =>
  typeof n === "number" ? `${n >= 0 ? "+" : ""}${n.toFixed(2)}%` : "—";
const fmtMoney = (n: number) => (typeof n === "number" ? `¥${fmt(n)}` : "—");


// ─── Equity chart tooltip ────────────────────────────────────────────────────
function EquityTooltip({ active, payload, label, lineColor }: TooltipContentProps<number, string> & { lineColor: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: "#1a1a1a", border: "1px solid #2a2a2a", borderRadius: 3, padding: "6px 12px", fontSize: 11, color: "#d4c8b0" }}>
      <div style={{ color: "#666", marginBottom: 2 }}>{label}</div>
      <div style={{ color: lineColor }}>{fmtMoney(payload[0].value as number)}</div>
    </div>
  );
}

// ─── EquityCurve (Recharts) ───────────────────────────────────────────────────
function EquityCurve({ data }: { data: CurvePoint[] }) {
  if (!data || data.length < 2)
    return <div style={{ color: "#888", padding: 24 }}>暂无数据</div>;

  const vals = data.map((d) => d.value);
  const last = vals[vals.length - 1];
  const first = vals[0];
  const isUp = last >= first;
  const c = isUp ? "#6dbf8c" : "#e07070";
  const gradId = `cg-${isUp ? "up" : "dn"}`;

  const yMin = Math.min(...vals) * 0.99;
  const yMax = Math.max(...vals) * 1.01;

  const yFmt = (v: number) =>
    v >= 10000 ? `${(v / 10000).toFixed(1)}w` : String(Math.round(v));

  const xFmt = (d: string) => (typeof d === "string" ? d.slice(5) : d);

  return (
    <ResponsiveContainer width="100%" height={200}>
      <AreaChart data={data} margin={{ top: 12, right: 16, bottom: 8, left: 54 }}>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={c} stopOpacity={0.3} />
            <stop offset="100%" stopColor={c} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke="#2a2a2a" strokeWidth={1} vertical={false} />
        <XAxis
          dataKey="date"
          tickFormatter={xFmt}
          tick={{ fill: "#555", fontSize: 9 }}
          axisLine={false}
          tickLine={false}
          interval="preserveStartEnd"
        />
        <YAxis
          domain={[yMin, yMax]}
          tickFormatter={yFmt}
          tick={{ fill: "#666", fontSize: 10 }}
          axisLine={false}
          tickLine={false}
          tickCount={5}
          width={48}
        />
        <Tooltip content={(props: TooltipContentProps<number, string>) => <EquityTooltip {...props} lineColor={c} />} />
        <Area
          type="monotone"
          dataKey="value"
          stroke={c}
          strokeWidth={2}
          fill={`url(#${gradId})`}
          dot={false}
          activeDot={{ r: 4, fill: c }}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

// ─── Benchmark comparison tooltip ────────────────────────────────────────────
function BenchmarkTooltip({ active, payload, label }: TooltipContentProps<number, string>) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: "#1a1a1a", border: "1px solid #2a2a2a", borderRadius: 3, padding: "6px 12px", fontSize: 11, color: "#d4c8b0" }}>
      <div style={{ color: "#666", marginBottom: 4 }}>{label}</div>
      {payload.map((entry) => (
        <div key={entry.dataKey} style={{ color: entry.color as string, marginBottom: 2 }}>
          {entry.name}：{typeof entry.value === "number" ? `${entry.value >= 0 ? "+" : ""}${entry.value.toFixed(2)}%` : "—"}
        </div>
      ))}
    </div>
  );
}

// ─── BenchmarkChart (Recharts) ────────────────────────────────────────────────
interface BenchmarkChartProps {
  portfolioData: CurvePoint[];
  hs300Data: Hs300Point[];
}

function BenchmarkChart({ portfolioData, hs300Data }: BenchmarkChartProps) {
  if (portfolioData.length < 2 || hs300Data.length < 2) {
    return <div style={{ color: "#888", padding: 24 }}>暂无数据</div>;
  }

  // Build a date-indexed lookup for hs300
  const hs300Map = new Map(hs300Data.map((d) => [d.date, d.close]));

  // Align: keep only dates that exist in portfolio, find nearest hs300 value
  const hs300Dates = hs300Data.map((d) => d.date).sort();
  const portfolioFirst = portfolioData[0].value;
  const hs300FirstClose = hs300Data[0].close;

  const merged = portfolioData
    .map((pt) => {
      // Exact match first, otherwise find closest prior trading date
      let hs300Close = hs300Map.get(pt.date);
      if (hs300Close === undefined) {
        const prior = hs300Dates.filter((d) => d <= pt.date).at(-1);
        hs300Close = prior ? hs300Map.get(prior) : undefined;
      }
      if (hs300Close === undefined) return null;
      return {
        date: pt.date,
        portfolio: parseFloat(((pt.value / portfolioFirst - 1) * 100).toFixed(2)),
        hs300: parseFloat(((hs300Close / hs300FirstClose - 1) * 100).toFixed(2)),
      };
    })
    .filter((d): d is NonNullable<typeof d> => d !== null);

  if (merged.length < 2) {
    return <div style={{ color: "#888", padding: 24 }}>日期无法对齐，暂无对比数据</div>;
  }

  const xFmt = (d: string) => (typeof d === "string" ? d.slice(5) : d);
  const yFmt = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;

  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={merged} margin={{ top: 12, right: 16, bottom: 8, left: 54 }}>
        <CartesianGrid stroke="#2a2a2a" strokeWidth={1} vertical={false} />
        <XAxis
          dataKey="date"
          tickFormatter={xFmt}
          tick={{ fill: "#555", fontSize: 9 }}
          axisLine={false}
          tickLine={false}
          interval="preserveStartEnd"
        />
        <YAxis
          tickFormatter={yFmt}
          tick={{ fill: "#666", fontSize: 10 }}
          axisLine={false}
          tickLine={false}
          tickCount={5}
          width={52}
        />
        <Tooltip content={BenchmarkTooltip} />
        <Legend
          wrapperStyle={{ fontSize: 11, color: "#666", paddingTop: 8 }}
          formatter={(value) => <span style={{ color: "#888" }}>{value}</span>}
        />
        <Line
          type="monotone"
          dataKey="portfolio"
          name="我的组合"
          stroke="#c9a96e"
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4, fill: "#c9a96e" }}
          isAnimationActive={false}
        />
        <Line
          type="monotone"
          dataKey="hs300"
          name="沪深300"
          stroke="#7bb6d4"
          strokeWidth={1.5}
          strokeDasharray="4 3"
          dot={false}
          activeDot={{ r: 4, fill: "#7bb6d4" }}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

// ─── Allocation Pie Chart ─────────────────────────────────────────────────────
const PIE_COLORS = ["#c9a96e", "#6dbf8c", "#7bb6d4", "#e07070", "#9988cc", "#e0b070", "#a8956a", "#5aada8", "#d4936e", "#88c98e"];
const CASH_COLOR = "#4a8fa8";

interface PieSlice {
  name: string;
  value: number;
  pct: number;
}

interface AllocationPieChartProps {
  slices: PieSlice[];
  totalAssets: number;
}

function AllocationPieChart({ slices, totalAssets }: AllocationPieChartProps) {
  if (!slices.length || totalAssets <= 0) {
    return <div style={{ color: "#555", padding: "24px 0", fontSize: 12 }}>暂无持仓数据</div>;
  }

  const renderCustomLabel = ({ cx, cy, midAngle, innerRadius, outerRadius, pct }: {
    cx: number; cy: number; midAngle: number;
    innerRadius: number; outerRadius: number; pct: number;
  }) => {
    if (pct < 4) return null;
    const RADIAN = Math.PI / 180;
    const r = innerRadius + (outerRadius - innerRadius) * 0.55;
    const x = cx + r * Math.cos(-midAngle * RADIAN);
    const y = cy + r * Math.sin(-midAngle * RADIAN);
    return (
      <text x={x} y={y} fill="#fff" textAnchor="middle" dominantBaseline="central"
        style={{ fontSize: 10, fontFamily: "Georgia, serif", fontWeight: 600 }}>
        {pct.toFixed(1)}%
      </text>
    );
  };

  const CustomTooltip = ({ active, payload }: TooltipContentProps<number, string>) => {
    if (!active || !payload?.length) return null;
    const d = payload[0].payload as PieSlice;
    return (
      <div style={{ background: "#1a1a1a", border: "1px solid #2a2a2a", borderRadius: 3, padding: "8px 14px", fontSize: 11, color: "#d4c8b0" }}>
        <div style={{ color: "#888", marginBottom: 3 }}>{d.name}</div>
        <div style={{ color: "#c9a96e" }}>{fmtMoney(d.value)}</div>
        <div style={{ color: "#666", marginTop: 2 }}>{d.pct.toFixed(2)}%</div>
      </div>
    );
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
      <ResponsiveContainer width={260} height={240}>
        <PieChart>
          <Pie
            data={slices}
            cx="50%"
            cy="50%"
            innerRadius={62}
            outerRadius={110}
            dataKey="value"
            labelLine={false}
            label={renderCustomLabel as (props: unknown) => React.ReactElement | null}
            isAnimationActive={false}
          >
            {slices.map((_, i) => (
              <Cell
                key={i}
                fill={_.name === "现金" ? CASH_COLOR : PIE_COLORS[i % PIE_COLORS.length]}
              />
            ))}
          </Pie>
          <Tooltip content={CustomTooltip} />
        </PieChart>
      </ResponsiveContainer>

      {/* donut center label */}
      <div style={{ minWidth: 0, flex: 1 }}>
        {slices.map((s, i) => (
          <div key={s.name} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 7 }}>
            <div style={{
              width: 10, height: 10, borderRadius: 2, flexShrink: 0,
              background: s.name === "现金" ? CASH_COLOR : PIE_COLORS[i % PIE_COLORS.length],
            }} />
            <div style={{ fontSize: 12, color: "#a09880", flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {s.name}
            </div>
            <div style={{ fontSize: 11, color: "#666", minWidth: 38, textAlign: "right" }}>
              {s.pct.toFixed(1)}%
            </div>
            <div style={{ fontSize: 11, color: "#888", minWidth: 80, textAlign: "right", fontVariant: "tabular-nums" }}>
              {fmtMoney(s.value)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Diary Heatmap ────────────────────────────────────────────────────────────
function DiaryHeatmap({
  diary,
  selectedDate,
  onDateClick,
}: {
  diary: DiaryEntry[];
  selectedDate: string | null;
  onDateClick: (date: string | null) => void;
}) {
  const [tooltip, setTooltip] = useState<{ x: number; y: number; text: string } | null>(null);

  const { weeks, monthLabels, yearCount } = useMemo(() => {
    const countMap: Record<string, number> = {};
    diary.forEach((e) => { countMap[e.date] = (countMap[e.date] ?? 0) + 1; });

    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

    // Start from the Sunday of the week containing (today - 365 days)
    const startD = new Date(now);
    startD.setFullYear(now.getFullYear() - 1);
    startD.setDate(startD.getDate() - startD.getDay());

    const weeksArr: { date: string; count: number }[][] = [];
    const monthLbls: { label: string; col: number }[] = [];
    const cur = new Date(startD);
    let col = 0;

    while (cur.toISOString().slice(0, 10) <= todayStr) {
      const week: { date: string; count: number }[] = [];
      for (let d = 0; d < 7; d++) {
        const dateStr = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}-${String(cur.getDate()).padStart(2, "0")}`;
        week.push({ date: dateStr, count: countMap[dateStr] ?? 0 });
        cur.setDate(cur.getDate() + 1);
      }
      // Month label: show at the week that first contains the 1st of a month
      const firstDay = week.find((day) => day.date.slice(8) === "01");
      if (firstDay) {
        monthLbls.push({ label: `${parseInt(firstDay.date.slice(5, 7))}月`, col });
      }
      weeksArr.push(week);
      col++;
    }

    const oneYearAgo = new Date(now);
    oneYearAgo.setFullYear(now.getFullYear() - 1);
    const oneYearAgoStr = `${oneYearAgo.getFullYear()}-${String(oneYearAgo.getMonth() + 1).padStart(2, "0")}-${String(oneYearAgo.getDate()).padStart(2, "0")}`;
    const total = diary.filter((e) => e.date >= oneYearAgoStr).length;

    return { weeks: weeksArr, monthLabels: monthLbls, yearCount: total };
  }, [diary]);

  const CELL = 11;
  const GAP = 2;
  const STEP = CELL + GAP;
  const LEFT = 22;
  const TOP = 20;
  const DAY_LABELS = ["", "一", "", "三", "", "五", ""];

  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

  const colorFor = (count: number, date: string, isSelected: boolean): string => {
    if (isSelected) return "#c9a96e";
    if (date > todayStr) return "transparent";
    if (count === 0) return "#1c1c1c";
    if (count === 1) return "#2d4a3e";
    if (count <= 3) return "#3d7a5e";
    if (count <= 5) return "#5aab84";
    return "#6dbf8c";
  };

  const svgW = LEFT + weeks.length * STEP;
  const svgH = TOP + 7 * STEP + 2;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <span style={{ fontSize: 11, color: "#555", fontFamily: "Georgia, serif", letterSpacing: "0.08em" }}>
          过去一年共 <span style={{ color: "#c9a96e" }}>{yearCount}</span> 条记录
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ fontSize: 9, color: "#444", fontFamily: "Georgia, serif" }}>少</span>
          {["#1c1c1c", "#2d4a3e", "#3d7a5e", "#5aab84", "#6dbf8c"].map((c) => (
            <div key={c} style={{ width: CELL, height: CELL, borderRadius: 2, background: c, border: "1px solid #2a2a2a" }} />
          ))}
          <span style={{ fontSize: 9, color: "#444", fontFamily: "Georgia, serif" }}>多</span>
        </div>
      </div>
      <div style={{ position: "relative", overflowX: "auto" }}>
        <svg width={svgW} height={svgH} style={{ display: "block" }}>
          {/* Month labels */}
          {monthLabels.map(({ label, col }) => (
            <text key={`m-${col}`} x={LEFT + col * STEP} y={13} fontSize={9} fill="#555" fontFamily="Georgia, serif">
              {label}
            </text>
          ))}
          {/* Day labels */}
          {DAY_LABELS.map((label, di) =>
            label ? (
              <text
                key={`d-${di}`}
                x={LEFT - 4}
                y={TOP + di * STEP + CELL - 1}
                fontSize={8}
                fill="#444"
                fontFamily="Georgia, serif"
                textAnchor="end"
              >
                {label}
              </text>
            ) : null
          )}
          {/* Cells */}
          {weeks.map((week, wi) =>
            week.map((day, di) => {
              if (day.date > todayStr) return null;
              const isSelected = day.date === selectedDate;
              return (
                <rect
                  key={`${wi}-${di}`}
                  x={LEFT + wi * STEP}
                  y={TOP + di * STEP}
                  width={CELL}
                  height={CELL}
                  rx={2}
                  fill={colorFor(day.count, day.date, isSelected)}
                  stroke={isSelected ? "#c9a96e" : "#1a1a1a"}
                  strokeWidth={isSelected ? 1.5 : 0.5}
                  style={{ cursor: "pointer" }}
                  onClick={() => onDateClick(isSelected ? null : day.date)}
                  onMouseEnter={(e) => {
                    const svgEl = (e.target as SVGRectElement).ownerSVGElement!;
                    const svgRect = svgEl.getBoundingClientRect();
                    const rEl = (e.target as SVGRectElement).getBoundingClientRect();
                    setTooltip({
                      x: rEl.left - svgRect.left + CELL / 2,
                      y: rEl.top - svgRect.top,
                      text: day.count > 0 ? `${day.date}  ·  ${day.count} 条记录` : `${day.date}  ·  暂无记录`,
                    });
                  }}
                  onMouseLeave={() => setTooltip(null)}
                />
              );
            })
          )}
        </svg>
        {tooltip && (
          <div
            style={{
              position: "absolute",
              left: tooltip.x,
              top: tooltip.y,
              transform: "translate(-50%, calc(-100% - 6px))",
              background: "#1e1e1e",
              color: "#d4c8b0",
              fontSize: 10,
              padding: "4px 10px",
              borderRadius: 3,
              border: "1px solid #333",
              pointerEvents: "none",
              whiteSpace: "nowrap",
              zIndex: 10,
              fontFamily: "Georgia, serif",
              letterSpacing: "0.05em",
            }}
          >
            {tooltip.text}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function InvestmentTracker() {
  const [tab, setTab] = useState<"portfolio" | "curve" | "diary" | "upload">("portfolio");
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [curve, setCurve] = useState<CurvePoint[]>([]);
  const [diary, setDiary] = useState<DiaryEntry[]>([]);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [uploadText, setUploadText] = useState<string>("");
  const [uploadDate, setUploadDate] = useState<string>(new Date().toISOString().slice(0, 10));
  const [uploading, setUploading] = useState(false);
  const [aiResult, setAiResult] = useState<AiResult | null>(null);
  const [newEntry, setNewEntry] = useState<Omit<DiaryEntry, "id">>({
    date: new Date().toISOString().slice(0, 10),
    type: "观察",
    code: "",
    remark: "",
    mood: "理性",
  });
  const [cash, setCash] = useState<number>(0);
  const [cashInput, setCashInput] = useState<string>("");
  const [cashEditing, setCashEditing] = useState(false);
  const [pieMode, setPieMode] = useState<"sector" | "stock">("sector");
  const [dragOver, setDragOver] = useState(false);
  const [hs300Data, setHs300Data] = useState<Hs300Point[]>([]);
  const [hs300Loading, setHs300Loading] = useState(false);
  const [hs300Error, setHs300Error] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);

  // ── diff view & import history state
  const [showDiff, setShowDiff] = useState(false);
  const [diffItems, setDiffItems] = useState<HoldingDiff[]>([]);
  const [importHistory, setImportHistory] = useState<ImportRecord[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [rollbackConfirm, setRollbackConfirm] = useState<number | null>(null);

  // ── load persisted data on mount
  useEffect(() => {
    Promise.all([
      fetch(`${API_BASE}/api/holdings`).then((r) => r.json()),
      fetch(`${API_BASE}/api/diary`).then((r) => r.json()),
      fetch(`${API_BASE}/api/curve`).then((r) => r.json()),
      fetch(`${API_BASE}/api/cash`).then((r) => r.json()),
    ])
      .then(([h, d, c, cashData]: [Holding[], DiaryEntry[], CurvePoint[], { amount: number }]) => {
        setHoldings(h);
        setDiary(d);
        setCurve(c);
        setCash(cashData.amount ?? 0);
      })
      .catch(() => {
        setHoldings([]);
        setDiary([]);
        setCurve([]);
        setCash(0);
      });
  }, []);

  useEffect(() => {
    if (tab !== "curve" || hs300Data.length > 0 || hs300Loading) return;

    const doFetch = async () => {
      setHs300Loading(true);
      setHs300Error(null);
      try {
        const r = await fetch(`${API_BASE}/api/hs300?days=180`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = (await r.json()) as Hs300Point[];
        setHs300Data(data);
      } catch (err: unknown) {
        setHs300Error(
          err instanceof Error ? err.message : "无法连接后端，请先启动 Python 后端服务"
        );
      } finally {
        setHs300Loading(false);
      }
    };

    void doFetch();
  }, [tab, hs300Data.length, hs300Loading]);

  // ── derived stats
  const totalCost    = holdings.reduce((s, h) => s + h.cost * h.shares, 0);
  const totalValue   = holdings.reduce((s, h) => s + h.price * h.shares, 0);
  const totalPnl     = totalValue - totalCost;
  const totalPct     = (totalPnl / totalCost) * 100;
  const totalAssets  = totalValue + cash;
  const stockPct     = totalAssets > 0 ? (totalValue / totalAssets) * 100 : 0;

  // ── pie slices
  const buildSlices = (mode: "sector" | "stock"): PieSlice[] => {
    const slices: PieSlice[] = [];
    if (mode === "sector") {
      const map = new Map<string, number>();
      holdings.forEach((h) => {
        const key = h.sector || "其他";
        map.set(key, (map.get(key) ?? 0) + h.price * h.shares);
      });
      map.forEach((value, name) => slices.push({ name, value, pct: totalAssets > 0 ? (value / totalAssets) * 100 : 0 }));
    } else {
      holdings.forEach((h) => {
        const value = h.price * h.shares;
        slices.push({ name: h.name, value, pct: totalAssets > 0 ? (value / totalAssets) * 100 : 0 });
      });
    }
    slices.sort((a, b) => b.value - a.value);
    if (cash > 0) slices.push({ name: "现金", value: cash, pct: totalAssets > 0 ? (cash / totalAssets) * 100 : 0 });
    return slices;
  };

  // ── save cash
  const saveCash = async () => {
    const amount = parseFloat(cashInput);
    if (isNaN(amount) || amount < 0) return;
    try {
      await fetch(`${API_BASE}/api/cash`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount }),
      });
    } catch { /* ignore, update local state anyway */ }
    setCash(amount);
    setCashEditing(false);
  };

  // ── stock code normalization: strip .SH / .SZ / .BJ / .HK suffix
  const normalizeCode = (code: string) =>
    code.trim().replace(/\.(SH|SZ|BJ|HK)$/i, "");

  // ── merge AI holding into existing holding per defined rules
  const mergeHolding = (existing: Holding, incoming: AiHolding): Holding => ({
    id: existing.id,
    code: existing.code,
    name: incoming.name?.trim() ? incoming.name.trim() : existing.name,
    shares: incoming.shares != null && incoming.shares !== 0 ? incoming.shares : existing.shares,
    cost: incoming.cost != null && incoming.cost !== 0 ? incoming.cost : existing.cost,
    price: incoming.price != null && incoming.price !== 0 ? incoming.price : existing.price,
    sector: incoming.sector?.trim() ? incoming.sector.trim() : existing.sector,
    notes: existing.notes,
  });

  // ── build per-holding diff list comparing AI result against current holdings
  const buildDiff = (aiHoldings: AiHolding[], current: Holding[]): HoldingDiff[] =>
    aiHoldings
      .filter((h) => h.code)
      .map((incoming) => {
        const normCode = normalizeCode(incoming.code!);
        const existing = current.find((u) => normalizeCode(u.code) === normCode) ?? null;
        return { code: incoming.code!, name: incoming.name ?? existing?.name ?? "", isNew: existing === null, existing, incoming, accepted: true };
      });

  // ── drag drop
  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const newFiles = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/"));
    if (newFiles.length > 0) setUploadFiles((prev) => [...prev, ...newFiles]);
  }, []);

  // ── call backend /api/analyze (Qwen3.5-plus vision)
  const analyzeImage = async () => {
    if (!uploadFiles.length) return;
    setUploading(true);
    setAiResult(null);
    try {
      const toBase64 = (file: File) =>
        new Promise<string>((res, rej) => {
          const r = new FileReader();
          r.onload = () => res((r.result as string).split(",")[1]);
          r.onerror = rej;
          r.readAsDataURL(file);
        });

      const base64List = await Promise.all(uploadFiles.map(toBase64));
      const mediaTypes = uploadFiles.map((f) => f.type || "image/jpeg");

      const resp = await fetch(`${API_BASE}/api/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          base64_images: base64List,
          media_types: mediaTypes,
          description: uploadText,
          portfolio_date: uploadDate,
          current_holdings: holdings.map((h) => ({
            code: h.code,
            name: h.name,
            shares: h.shares,
            cost: h.cost,
            price: h.price,
            sector: h.sector,
          })),
        }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ detail: resp.statusText })) as { detail?: string };
        throw new Error(err.detail ?? `HTTP ${resp.status}`);
      }

      const data = await resp.json() as { result: string };
      let parsed: AiResult;
      try {
        parsed = JSON.parse(data.result.replace(/```json|```/g, "").trim()) as AiResult;
      } catch {
        parsed = { error: "无法解析返回内容", raw: data.result };
      }
      setAiResult(parsed);
    } catch (err) {
      setAiResult({ error: String(err) });
    }
    setUploading(false);
  };

  // ── step 1: show diff confirmation view before applying
  const prepareDiff = () => {
    if (!aiResult?.holdings?.length) return;
    setDiffItems(buildDiff(aiResult.holdings, holdings));
    setShowDiff(true);
  };

  // ── step 2: apply only the accepted diff items
  const confirmApply = async () => {
    const accepted = diffItems.filter((d) => d.accepted);
    if (!accepted.length) return;

    const updated = [...holdings];
    accepted.forEach((d) => {
      const normCode = normalizeCode(d.code);
      const idx = updated.findIndex((u) => normalizeCode(u.code) === normCode);
      if (idx >= 0) {
        updated[idx] = mergeHolding(updated[idx], d.incoming);
      } else {
        updated.push({
          id: String(Date.now() + Math.random()),
          code: d.code,
          name: d.name,
          shares: d.incoming.shares ?? 0,
          cost: d.incoming.cost ?? 0,
          price: d.incoming.price ?? 0,
          sector: d.incoming.sector ?? "",
          notes: "",
        });
      }
    });

    try {
      const saved = await fetch(`${API_BASE}/api/holdings/bulk`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ holdings: updated, label: `${uploadDate} 截图导入` }),
      }).then((r) => r.json()) as Holding[];
      setHoldings(saved);
    } catch {
      setHoldings(updated);
    }

    if (aiResult?.total_assets) {
      const targetDate = uploadDate || new Date().toISOString().slice(0, 10);
      const point: CurvePoint = { date: targetDate, value: aiResult.total_assets };
      try {
        await fetch(`${API_BASE}/api/curve/point`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(point),
        });
      } catch { /* ignore */ }
      setCurve((prev) => {
        const filtered = prev.filter((p) => p.date !== targetDate);
        return [...filtered, point].sort((a, b) => a.date.localeCompare(b.date));
      });
    }

    setShowDiff(false);
    setDiffItems([]);
    setTab("portfolio");
  };

  // ── load import history from backend
  const loadImportHistory = async () => {
    setHistoryLoading(true);
    try {
      const data = await fetch(`${API_BASE}/api/imports`).then((r) => r.json()) as ImportRecord[];
      setImportHistory(data);
    } catch { /* ignore */ }
    setHistoryLoading(false);
  };

  // ── restore holdings to a previous import snapshot
  const doRollback = async (id: number) => {
    try {
      const saved = await fetch(`${API_BASE}/api/imports/rollback/${id}`, { method: "POST" })
        .then((r) => r.json()) as Holding[];
      setHoldings(saved);
      setRollbackConfirm(null);
      await loadImportHistory();
    } catch { /* ignore */ }
  };

  const addDiaryEntry = async () => {
    if (!newEntry.remark) return;
    try {
      const saved = await fetch(`${API_BASE}/api/diary`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newEntry),
      }).then((r) => r.json()) as DiaryEntry;
      setDiary((prev) => [saved, ...prev]);
    } catch {
      setDiary((prev) => [{ ...newEntry, id: Date.now() }, ...prev]);
    }
    setNewEntry({ date: new Date().toISOString().slice(0, 10), type: "观察", code: "", remark: "", mood: "理性" });
  };

  // ─── styles
  const S: Record<string, CSSProperties | ((...args: unknown[]) => CSSProperties)> = {
    root: {
      minHeight: "100vh",
      background: "#0d0d0d",
      color: "#d4c8b0",
      fontFamily: "'Georgia', 'Noto Serif SC', serif",
    },
    header: {
      borderBottom: "1px solid #222",
      padding: "20px 32px 16px",
      display: "flex",
      alignItems: "baseline",
      gap: 20,
      background: "linear-gradient(180deg,#111 0%,#0d0d0d 100%)",
    },
    logo: {
      fontSize: 22,
      fontWeight: 700,
      letterSpacing: "0.08em",
      color: "#c9a96e",
      fontFamily: "'Georgia', serif",
    },
    sub: { fontSize: 11, color: "#555", letterSpacing: "0.15em", textTransform: "uppercase" },
    nav: {
      display: "flex",
      gap: 2,
      padding: "0 32px",
      borderBottom: "1px solid #1a1a1a",
      background: "#0d0d0d",
    },
    body: { padding: "28px 32px", maxWidth: 900, margin: "0 auto" },
    card: {
      background: "#141414",
      border: "1px solid #222",
      borderRadius: 4,
      padding: 20,
      marginBottom: 16,
    },
    cardTitle: { fontSize: 11, color: "#666", letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: 12 },
    stat: { fontSize: 28, fontWeight: 700, color: "#e8dcc8", letterSpacing: "-0.01em" },
    statSm: { fontSize: 13, color: "#888", marginTop: 2 },
    grid4: { display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, marginBottom: 20 },
    grid2: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 },
    table: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
    th: { textAlign: "left", color: "#555", fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", padding: "6px 10px", borderBottom: "1px solid #1e1e1e" },
    td: { padding: "10px 10px", borderBottom: "1px solid #181818", verticalAlign: "middle" },
    up: { color: "#6dbf8c" },
    dn: { color: "#e07070" },
  };

  const navBtn = (active: boolean): CSSProperties => ({
    padding: "12px 20px",
    border: "none",
    background: "none",
    color: active ? "#c9a96e" : "#555",
    fontSize: 13,
    letterSpacing: "0.06em",
    cursor: "pointer",
    borderBottom: active ? "2px solid #c9a96e" : "2px solid transparent",
    fontFamily: "'Georgia', serif",
    transition: "color 0.2s",
  });

  const badge = (color: string): CSSProperties => ({
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: 2,
    fontSize: 10,
    letterSpacing: "0.08em",
    background: color + "22",
    color,
  });

  const btn = (primary: boolean): CSSProperties => ({
    padding: "9px 20px",
    border: primary ? "none" : "1px solid #333",
    borderRadius: 3,
    background: primary ? "#c9a96e" : "transparent",
    color: primary ? "#0d0d0d" : "#888",
    fontSize: 12,
    letterSpacing: "0.08em",
    cursor: "pointer",
    fontFamily: "'Georgia', serif",
    fontWeight: primary ? 700 : 400,
    transition: "opacity 0.2s",
  });

  const dropzone = (active: boolean): CSSProperties => ({
    border: `2px dashed ${active ? "#c9a96e" : "#2a2a2a"}`,
    borderRadius: 6,
    padding: "48px 24px",
    textAlign: "center",
    cursor: "pointer",
    transition: "border-color 0.2s, background 0.2s",
    background: active ? "#1a160e" : "#111",
  });

  const pnlColor = (v: number): CSSProperties => (v >= 0 ? (S.up as CSSProperties) : (S.dn as CSSProperties));

  // ─── TAB: Portfolio
  const PortfolioTab = () => {
    const pieModeToggle: CSSProperties = {
      display: "inline-flex",
      border: "1px solid #2a2a2a",
      borderRadius: 3,
      overflow: "hidden",
    };
    const pieModeBtn = (active: boolean): CSSProperties => ({
      padding: "4px 14px",
      border: "none",
      background: active ? "#c9a96e22" : "transparent",
      color: active ? "#c9a96e" : "#555",
      fontSize: 11,
      letterSpacing: "0.06em",
      cursor: "pointer",
      fontFamily: "'Georgia', serif",
    });

    return (
      <>
        {/* ── Stats row */}
        <div style={S.grid4 as CSSProperties}>
          {/* Total market value */}
          <div style={S.card as CSSProperties}>
            <div style={S.cardTitle as CSSProperties}>总市值</div>
            <div style={S.stat as CSSProperties}>{fmtMoney(totalValue)}</div>
          </div>

          {/* Cash — editable inline */}
          <div style={S.card as CSSProperties}>
            <div style={{ ...(S.cardTitle as CSSProperties), display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span>现金</span>
              {!cashEditing && (
                <button
                  onClick={() => { setCashInput(String(cash)); setCashEditing(true); }}
                  style={{ background: "none", border: "none", color: "#555", cursor: "pointer", fontSize: 11, padding: 0, fontFamily: "'Georgia', serif" }}
                >
                  编辑
                </button>
              )}
            </div>
            {cashEditing ? (
              <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 4 }}>
                <input
                  style={{ ...inputStyle, fontSize: 14, padding: "4px 8px", flex: 1 }}
                  type="number"
                  min={0}
                  value={cashInput}
                  onChange={(e) => setCashInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void saveCash(); if (e.key === "Escape") setCashEditing(false); }}
                  autoFocus
                />
                <button style={{ background: "#c9a96e", border: "none", borderRadius: 3, color: "#0d0d0d", fontSize: 11, fontWeight: 700, padding: "4px 10px", cursor: "pointer", fontFamily: "'Georgia', serif" }}
                  onClick={() => void saveCash()}>
                  确认
                </button>
              </div>
            ) : (
              <div style={S.stat as CSSProperties}>{fmtMoney(cash)}</div>
            )}
          </div>

          {/* Stock position % */}
          <div style={S.card as CSSProperties}>
            <div style={S.cardTitle as CSSProperties}>股票仓位</div>
            <div style={S.stat as CSSProperties}>{totalAssets > 0 ? `${stockPct.toFixed(1)}%` : "—"}</div>
            <div style={S.statSm as CSSProperties}>总资产 {fmtMoney(totalAssets)}</div>
          </div>

          {/* Overall return */}
          <div style={S.card as CSSProperties}>
            <div style={S.cardTitle as CSSProperties}>整体收益</div>
            <div style={{ ...(S.stat as CSSProperties), ...pnlColor(totalPct) }}>{fmtPct(totalPct)}</div>
            <div style={{ ...(S.statSm as CSSProperties), ...pnlColor(totalPnl) }}>{fmtMoney(totalPnl)}</div>
          </div>
        </div>

        {/* ── Asset allocation pie chart */}
        <div style={S.card as CSSProperties}>
          <div style={{ ...(S.cardTitle as CSSProperties), display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span>资产配置</span>
            <div style={pieModeToggle}>
              <button style={pieModeBtn(pieMode === "sector")} onClick={() => setPieMode("sector")}>按行业</button>
              <button style={pieModeBtn(pieMode === "stock")} onClick={() => setPieMode("stock")}>按个股</button>
            </div>
          </div>
          <AllocationPieChart slices={buildSlices(pieMode)} totalAssets={totalAssets} />
        </div>

        {/* ── Holdings table */}
        <div style={S.card as CSSProperties}>
          <div style={S.cardTitle as CSSProperties}>持仓明细</div>
          <table style={S.table as CSSProperties}>
            <thead>
              <tr>
                {["代码", "名称", "行业", "持仓", "成本", "现价", "市值", "占总资产", "盈亏%", "备注"].map((h) => (
                  <th key={h} style={S.th as CSSProperties}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {holdings.map((h) => {
                const mkt = h.price * h.shares;
                const pnl = ((h.price - h.cost) / h.cost) * 100;
                const assetPct = totalAssets > 0 ? (mkt / totalAssets) * 100 : 0;
                return (
                  <tr key={h.id}>
                    <td style={{ ...(S.td as CSSProperties), color: "#c9a96e", fontVariant: "tabular-nums" }}>{h.code}</td>
                    <td style={S.td as CSSProperties}>{h.name}</td>
                    <td style={S.td as CSSProperties}><span style={badge("#a8956a")}>{h.sector}</span></td>
                    <td style={{ ...(S.td as CSSProperties), fontVariant: "tabular-nums" }}>{h.shares}</td>
                    <td style={{ ...(S.td as CSSProperties), fontVariant: "tabular-nums" }}>¥{fmt(h.cost)}</td>
                    <td style={{ ...(S.td as CSSProperties), fontVariant: "tabular-nums" }}>¥{fmt(h.price)}</td>
                    <td style={{ ...(S.td as CSSProperties), fontVariant: "tabular-nums" }}>¥{fmt(mkt)}</td>
                    <td style={{ ...(S.td as CSSProperties), color: "#888", fontVariant: "tabular-nums" }}>{assetPct.toFixed(1)}%</td>
                    <td style={{ ...(S.td as CSSProperties), ...pnlColor(pnl), fontVariant: "tabular-nums" }}>{fmtPct(pnl)}</td>
                    <td style={{ ...(S.td as CSSProperties), color: "#555", fontSize: 11 }}>{h.notes}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </>
    );
  };

  // ─── TAB: Curve
  const CurveTab = () => {
    const last  = curve[curve.length - 1]?.value ?? 0;
    const first = curve[0]?.value ?? 0;
    const totalReturn = ((last - first) / first) * 100;
    const maxVal = Math.max(...curve.map((d) => d.value));
    const minAfterMax = curve.slice(curve.findIndex((d) => d.value === maxVal)).map((d) => d.value);
    const maxDD = curve.length > 1 ? ((Math.min(...minAfterMax) - maxVal) / maxVal) * 100 : 0;

    return (
      <>
        <div style={S.grid4 as CSSProperties}>
          {[
            { label: "总收益率", value: fmtPct(totalReturn), color: totalReturn >= 0 ? S.up as CSSProperties : S.dn as CSSProperties },
            { label: "当前总资产", value: fmtMoney(last) },
            { label: "最大回撤", value: fmtPct(maxDD),       color: S.dn as CSSProperties },
            { label: "记录天数", value: `${curve.length} 天` },
          ].map((item) => (
            <div key={item.label} style={S.card as CSSProperties}>
              <div style={S.cardTitle as CSSProperties}>{item.label}</div>
              <div style={{ ...(S.stat as CSSProperties), ...(item.color ?? {}) }}>{item.value}</div>
            </div>
          ))}
        </div>
        <div style={S.card as CSSProperties}>
          <div style={{ ...(S.cardTitle as CSSProperties), display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span>收益率对比 · 组合 vs 沪深300</span>
            {hs300Loading && <span style={{ color: "#555", fontSize: 10, letterSpacing: "0.08em" }}>加载中…</span>}
          </div>
          {hs300Error ? (
            <div style={{ padding: "16px 0", color: "#666", fontSize: 12, lineHeight: 1.7 }}>
              <span style={{ color: "#e07070" }}>✕</span>
              &nbsp;无法获取沪深300数据：{hs300Error}
              <br />
              <span style={{ color: "#444", fontSize: 11 }}>
                请先在终端运行：<code style={{ background: "#1e1e1e", padding: "1px 6px", borderRadius: 2, color: "#a8956a" }}>
                  cd backend &amp;&amp; uvicorn main:app --reload --port 8000
                </code>
              </span>
            </div>
          ) : hs300Loading ? (
            <div style={{ padding: "16px 0", color: "#555", fontSize: 12 }}>正在从 AkShare 获取沪深300数据…</div>
          ) : (
            <BenchmarkChart portfolioData={curve.slice(-180)} hs300Data={hs300Data} />
          )}
        </div>
        <div style={S.card as CSSProperties}>
          <div style={S.cardTitle as CSSProperties}>资产曲线（近 180 天）</div>
          <EquityCurve data={curve.slice(-180)} />
        </div>
        <div style={S.card as CSSProperties}>
          <div style={S.cardTitle as CSSProperties}>近期走势（近 30 天）</div>
          <EquityCurve data={curve.slice(-30)} />
        </div>
      </>
    );
  };

  // ─── TAB: Diary
  const DiaryTab = () => {
    const filteredDiary = selectedDate
      ? diary.filter((e) => e.date === selectedDate)
      : diary;

    const typeColor: Record<string, string> = {
      买入: "#6dbf8c", 卖出: "#e07070", 加仓: "#8dbfdf",
      减仓: "#e0b070", 观察: "#a8956a", 复盘: "#9988cc",
    };

    return (
      <>
        {/* Heatmap card */}
        <div style={S.card as CSSProperties}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
            <div style={S.cardTitle as CSSProperties}>记录频率</div>
            {selectedDate && (
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 11, color: "#c9a96e", fontFamily: "Georgia, serif" }}>
                  {selectedDate}
                </span>
                <button
                  style={{
                    padding: "2px 10px",
                    border: "1px solid #333",
                    borderRadius: 3,
                    background: "transparent",
                    color: "#888",
                    fontSize: 10,
                    letterSpacing: "0.06em",
                    cursor: "pointer",
                    fontFamily: "Georgia, serif",
                  }}
                  onClick={() => setSelectedDate(null)}
                >
                  清除筛选
                </button>
              </div>
            )}
          </div>
          <DiaryHeatmap diary={diary} selectedDate={selectedDate} onDateClick={setSelectedDate} />
        </div>

        {/* New entry form */}
        <div style={S.card as CSSProperties}>
          <div style={S.cardTitle as CSSProperties}>新增记录</div>
          <div style={{ display: "grid", gridTemplateColumns: "120px 90px 100px 1fr 90px", gap: 8, alignItems: "end" }}>
            <div>
              <div style={{ fontSize: 10, color: "#555", marginBottom: 4 }}>日期</div>
              <input style={inputStyle} type="date" value={newEntry.date}
                onChange={(e) => setNewEntry((p) => ({ ...p, date: e.target.value }))} />
            </div>
            <div>
              <div style={{ fontSize: 10, color: "#555", marginBottom: 4 }}>类型</div>
              <select style={inputStyle} value={newEntry.type}
                onChange={(e) => setNewEntry((p) => ({ ...p, type: e.target.value }))}>
                {["买入", "卖出", "加仓", "减仓", "观察", "复盘"].map((t) => <option key={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <div style={{ fontSize: 10, color: "#555", marginBottom: 4 }}>代码</div>
              <input style={inputStyle} placeholder="可选" value={newEntry.code}
                onChange={(e) => setNewEntry((p) => ({ ...p, code: e.target.value }))} />
            </div>
            <div>
              <div style={{ fontSize: 10, color: "#555", marginBottom: 4 }}>备注 / 投资逻辑</div>
              <input style={inputStyle} placeholder="记录决策依据…" value={newEntry.remark}
                onChange={(e) => setNewEntry((p) => ({ ...p, remark: e.target.value }))} />
            </div>
            <button style={btn(true)} onClick={addDiaryEntry}>添加</button>
          </div>
        </div>

        {/* Journal table */}
        <div style={S.card as CSSProperties}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <div style={{ ...S.cardTitle as CSSProperties, marginBottom: 0 }}>
              交易日志
              {selectedDate && (
                <span style={{ color: "#c9a96e", marginLeft: 8, fontWeight: 400, textTransform: "none" }}>
                  · {selectedDate}
                </span>
              )}
            </div>
            {selectedDate && (
              <span style={{ fontSize: 11, color: "#555" }}>
                {filteredDiary.length} 条
              </span>
            )}
          </div>
          <table style={S.table as CSSProperties}>
            <thead>
              <tr>
                {["日期", "类型", "标的", "记录", "心态"].map((h) => (
                  <th key={h} style={S.th as CSSProperties}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredDiary.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ ...(S.td as CSSProperties), color: "#444", textAlign: "center", padding: "24px 0", fontSize: 12 }}>
                    {selectedDate ? `${selectedDate} 暂无记录` : "暂无日志"}
                  </td>
                </tr>
              ) : (
                filteredDiary.map((entry) => (
                  <tr key={entry.id}>
                    <td style={{ ...(S.td as CSSProperties), color: "#666", fontSize: 12 }}>{entry.date}</td>
                    <td style={S.td as CSSProperties}><span style={badge(typeColor[entry.type] ?? "#888")}>{entry.type}</span></td>
                    <td style={{ ...(S.td as CSSProperties), color: "#c9a96e" }}>{entry.code || "—"}</td>
                    <td style={{ ...(S.td as CSSProperties), color: "#b8ac98", fontSize: 13 }}>{entry.remark}</td>
                    <td style={{ ...(S.td as CSSProperties), color: "#666", fontSize: 11 }}>{entry.mood}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </>
    );
  };

  // ─── TAB: Upload
  const UploadTab = () => {
    const addFiles = (files: FileList | null) => {
      if (!files) return;
      const imgs = Array.from(files).filter((f) => f.type.startsWith("image/"));
      if (imgs.length > 0) setUploadFiles((prev) => [...prev, ...imgs]);
    };
    const removeFile = (idx: number) => {
      setUploadFiles((prev) => prev.filter((_, i) => i !== idx));
    };

    // helper: render a numeric diff cell (old → new, or just new for additions)
    const numDiffCell = (
      oldVal: number | undefined,
      newVal: number | undefined,
      isNew: boolean,
      fmtFn: (n: number) => string = (n) => String(n),
    ) => {
      if (isNew) return <span style={{ color: "#d4c8b0" }}>{newVal != null ? fmtFn(newVal) : "—"}</span>;
      if (newVal == null) return <span style={{ color: "#555" }}>{oldVal != null ? fmtFn(oldVal) : "—"}</span>;
      if (oldVal === newVal) return <span style={{ color: "#666" }}>{fmtFn(newVal)}</span>;
      return (
        <span>
          <span style={{ color: "#444", textDecoration: "line-through", fontSize: 11 }}>{oldVal != null ? fmtFn(oldVal) : "—"}</span>
          <span style={{ color: "#c9a96e", marginLeft: 6 }}>→ {fmtFn(newVal)}</span>
        </span>
      );
    };

    // helper: render a string diff cell
    const strDiffCell = (oldVal: string | undefined, newVal: string | undefined, isNew: boolean) => {
      if (isNew) return <span style={{ color: "#d4c8b0" }}>{newVal || "—"}</span>;
      const effective = newVal?.trim() ? newVal.trim() : oldVal;
      if (!effective) return <span style={{ color: "#444" }}>—</span>;
      if (effective === oldVal) return <span style={{ color: "#666" }}>{effective}</span>;
      return (
        <span>
          <span style={{ color: "#444", textDecoration: "line-through", fontSize: 11 }}>{oldVal || "—"}</span>
          <span style={{ color: "#c9a96e", marginLeft: 6 }}>→ {effective}</span>
        </span>
      );
    };

    return (
      <>
        {/* ── Upload & analyze card */}
        <div style={S.card as CSSProperties}>
          <div style={S.cardTitle as CSSProperties}>上传持仓截图 · AI 识别</div>

          {/* Drop zone */}
          <div
            style={dropzone(dragOver)}
            ref={dropRef}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { onDrop(e); setDragOver(false); }}
            onClick={() => fileRef.current?.click()}
          >
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              style={{ display: "none" }}
              onChange={(e) => addFiles(e.target.files)}
            />
            <div style={{ fontSize: 28, marginBottom: 10, color: "#333" }}>⬆</div>
            <div style={{ color: "#666", fontSize: 13, lineHeight: 1.6 }}>
              拖拽或点击上传持仓截图（可多选）<br />
              <span style={{ color: "#444", fontSize: 11 }}>支持 PNG / JPG · 可上传多张不同页面的截图</span>
            </div>
          </div>

          {/* Thumbnail previews */}
          {uploadFiles.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 12 }}>
              {uploadFiles.map((f, i) => (
                <div key={i} style={{ position: "relative", display: "inline-block" }}>
                  <img
                    src={URL.createObjectURL(f)}
                    alt={f.name}
                    style={{ width: 100, height: 80, objectFit: "cover", borderRadius: 4, border: "1px solid #2a2a2a", display: "block" }}
                  />
                  <button
                    onClick={(e) => { e.stopPropagation(); removeFile(i); }}
                    style={{
                      position: "absolute", top: -6, right: -6,
                      width: 18, height: 18, borderRadius: "50%",
                      background: "#e07070", border: "none", color: "#fff",
                      fontSize: 10, cursor: "pointer", lineHeight: "18px",
                      textAlign: "center", padding: 0, fontWeight: 700,
                    }}
                  >✕</button>
                  <div style={{ fontSize: 9, color: "#555", marginTop: 3, maxWidth: 100, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {f.name}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Date picker + text description */}
          <div style={{ display: "grid", gridTemplateColumns: "160px 1fr", gap: 12, marginTop: 14 }}>
            <div>
              <div style={{ fontSize: 10, color: "#555", marginBottom: 4, letterSpacing: "0.1em", textTransform: "uppercase" }}>持仓日期</div>
              <input style={inputStyle} type="date" value={uploadDate} onChange={(e) => setUploadDate(e.target.value)} />
            </div>
            <div>
              <div style={{ fontSize: 10, color: "#555", marginBottom: 4, letterSpacing: "0.1em", textTransform: "uppercase" }}>补充说明（可选）</div>
              <input
                style={inputStyle}
                type="text"
                placeholder="如：东方财富账户，港股不含在内…"
                value={uploadText}
                onChange={(e) => setUploadText(e.target.value)}
              />
            </div>
          </div>

          {/* Action buttons */}
          <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
            <button
              style={{ ...btn(true), opacity: uploadFiles.length === 0 || uploading ? 0.5 : 1 }}
              onClick={() => void analyzeImage()}
              disabled={uploadFiles.length === 0 || uploading}
            >
              {uploading ? "识别中…" : `✦ AI 识别持仓${uploadFiles.length > 1 ? `（${uploadFiles.length} 张）` : ""}`}
            </button>
            <button style={btn(false)} onClick={() => { setUploadFiles([]); setUploadText(""); setAiResult(null); setShowDiff(false); setDiffItems([]); }}>
              清除全部
            </button>
          </div>
        </div>

        {/* ── Analyzing indicator */}
        {uploading && (
          <div style={{ ...(S.card as CSSProperties), textAlign: "center", color: "#666", padding: 40 }}>
            <div style={{ fontSize: 20, marginBottom: 8, color: "#c9a96e" }}>◌</div>
            正在调用视觉模型分析持仓…
          </div>
        )}

        {/* ── AI recognition results */}
        {aiResult && !uploading && !showDiff && (
          <div style={S.card as CSSProperties}>
            <div style={S.cardTitle as CSSProperties}>识别结果</div>
            {aiResult.error ? (
              <div style={{ color: "#e07070", fontSize: 13 }}>识别失败：{aiResult.error}</div>
            ) : (
              <>
                {aiResult.summary && (
                  <div style={{ background: "#1a160e", border: "1px solid #2e2618", borderRadius: 4, padding: "12px 16px", marginBottom: 16, fontSize: 13, color: "#c9a96e", lineHeight: 1.7 }}>
                    <span style={{ fontSize: 10, color: "#665", letterSpacing: "0.1em", textTransform: "uppercase", display: "block", marginBottom: 4 }}>价值投资分析</span>
                    {aiResult.summary}
                  </div>
                )}
                {aiResult.holdings && aiResult.holdings.length > 0 && (
                  <>
                    <table style={S.table as CSSProperties}>
                      <thead>
                        <tr>
                          {["代码", "名称", "持仓", "成本", "现价", "盈亏%", "行业"].map((h) => (
                            <th key={h} style={S.th as CSSProperties}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {aiResult.holdings.map((h, i) => (
                          <tr key={i}>
                            <td style={{ ...(S.td as CSSProperties), color: "#c9a96e" }}>{h.code ?? "—"}</td>
                            <td style={S.td as CSSProperties}>{h.name ?? "—"}</td>
                            <td style={S.td as CSSProperties}>{h.shares ?? "—"}</td>
                            <td style={S.td as CSSProperties}>{h.cost ? `¥${fmt(h.cost)}` : "—"}</td>
                            <td style={S.td as CSSProperties}>{h.price ? `¥${fmt(h.price)}` : "—"}</td>
                            <td style={{ ...(S.td as CSSProperties), ...pnlColor(h.pnl_pct ?? 0) }}>{fmtPct(h.pnl_pct)}</td>
                            <td style={S.td as CSSProperties}>{h.sector ?? "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {aiResult.total_assets && (
                      <div style={{ marginTop: 10, fontSize: 12, color: "#666" }}>
                        总资产：<span style={{ color: "#c9a96e" }}>{fmtMoney(aiResult.total_assets)}</span>
                        <span style={{ marginLeft: 16 }}>记录日期：<span style={{ color: "#888" }}>{uploadDate}</span></span>
                      </div>
                    )}
                    <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
                      <button style={btn(true)} onClick={prepareDiff}>
                        ✦ 差异对比 & 确认导入
                      </button>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        )}

        {/* ── Diff confirmation view */}
        {showDiff && (
          <div style={S.card as CSSProperties}>
            <div style={{ ...(S.cardTitle as CSSProperties), display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span>差异对比确认</span>
              <span style={{ fontSize: 11, color: "#555", fontWeight: 400 }}>
                旧值 vs 新值 · 勾选要应用的项目
              </span>
            </div>

            {/* Batch select */}
            <div style={{ display: "flex", gap: 8, marginBottom: 14, alignItems: "center" }}>
              <button style={{ ...btn(false), padding: "5px 14px", fontSize: 11 }}
                onClick={() => setDiffItems((p) => p.map((d) => ({ ...d, accepted: true })))}>
                全选
              </button>
              <button style={{ ...btn(false), padding: "5px 14px", fontSize: 11 }}
                onClick={() => setDiffItems((p) => p.map((d) => ({ ...d, accepted: false })))}>
                全不选
              </button>
              <span style={{ fontSize: 11, color: "#555" }}>
                已选 <span style={{ color: "#c9a96e" }}>{diffItems.filter((d) => d.accepted).length}</span> / {diffItems.length} 项
              </span>
              <span style={{ marginLeft: 8, fontSize: 11, color: "#444" }}>
                {diffItems.filter((d) => d.isNew).length} 新增 · {diffItems.filter((d) => !d.isNew).length} 更新
              </span>
            </div>

            <div style={{ overflowX: "auto" }}>
              <table style={S.table as CSSProperties}>
                <thead>
                  <tr>
                    {["操作", "代码", "名称", "持仓股数", "成本价", "现价", "盈亏%", "行业", "✓"].map((h) => (
                      <th key={h} style={S.th as CSSProperties}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {diffItems.map((d, i) => {
                    const opColor = d.isNew ? "#6dbf8c" : "#c9a96e";
                    return (
                      <tr
                        key={d.code}
                        style={{ opacity: d.accepted ? 1 : 0.3, transition: "opacity 0.15s", cursor: "pointer" }}
                        onClick={() => setDiffItems((prev) => prev.map((x, j) => j === i ? { ...x, accepted: !x.accepted } : x))}
                      >
                        <td style={S.td as CSSProperties}>
                          <span style={badge(opColor)}>{d.isNew ? "新增" : "更新"}</span>
                        </td>
                        <td style={{ ...(S.td as CSSProperties), color: "#c9a96e", fontVariant: "tabular-nums" }}>{d.code}</td>
                        <td style={S.td as CSSProperties}>{strDiffCell(d.existing?.name, d.incoming.name, d.isNew)}</td>
                        <td style={{ ...(S.td as CSSProperties), fontVariant: "tabular-nums" }}>
                          {numDiffCell(d.existing?.shares, d.incoming.shares, d.isNew)}
                        </td>
                        <td style={{ ...(S.td as CSSProperties), fontVariant: "tabular-nums" }}>
                          {numDiffCell(d.existing?.cost, d.incoming.cost, d.isNew, (n) => `¥${fmt(n)}`)}
                        </td>
                        <td style={{ ...(S.td as CSSProperties), fontVariant: "tabular-nums" }}>
                          {numDiffCell(d.existing?.price, d.incoming.price, d.isNew, (n) => `¥${fmt(n)}`)}
                        </td>
                        <td style={{ ...(S.td as CSSProperties), fontVariant: "tabular-nums" }}>
                          <span style={{ color: (d.incoming.pnl_pct ?? 0) >= 0 ? "#6dbf8c" : "#e07070" }}>
                            {fmtPct(d.incoming.pnl_pct)}
                          </span>
                        </td>
                        <td style={S.td as CSSProperties}>
                          {strDiffCell(d.existing?.sector, d.incoming.sector, d.isNew)}
                        </td>
                        <td style={{ ...(S.td as CSSProperties), textAlign: "center" }}>
                          <input
                            type="checkbox"
                            checked={d.accepted}
                            onChange={() => setDiffItems((prev) => prev.map((x, j) => j === i ? { ...x, accepted: !x.accepted } : x))}
                            onClick={(e) => e.stopPropagation()}
                            style={{ cursor: "pointer", accentColor: "#c9a96e" }}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {aiResult?.total_assets && (
              <div style={{ marginTop: 10, fontSize: 12, color: "#666" }}>
                识别总资产：<span style={{ color: "#c9a96e" }}>{fmtMoney(aiResult.total_assets)}</span>
                <span style={{ marginLeft: 16 }}>持仓日期：<span style={{ color: "#888" }}>{uploadDate}</span></span>
              </div>
            )}

            <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
              <button
                style={{ ...btn(true), opacity: diffItems.filter((d) => d.accepted).length === 0 ? 0.5 : 1 }}
                onClick={() => void confirmApply()}
                disabled={diffItems.filter((d) => d.accepted).length === 0}
              >
                ✓ 确认应用（{diffItems.filter((d) => d.accepted).length} 项）& 更新收益曲线
              </button>
              <button style={btn(false)} onClick={() => { setShowDiff(false); setDiffItems([]); }}>
                返回
              </button>
            </div>
          </div>
        )}

        {/* ── Import history */}
        <div style={S.card as CSSProperties}>
          <div style={{ ...(S.cardTitle as CSSProperties), display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span>导入历史</span>
            <button
              style={{ ...btn(false), padding: "5px 14px", fontSize: 11 }}
              onClick={() => {
                const next = !showHistory;
                setShowHistory(next);
                if (next) void loadImportHistory();
              }}
            >
              {showHistory ? "收起" : "查看历史"}
            </button>
          </div>
          {showHistory && (
            historyLoading ? (
              <div style={{ color: "#555", fontSize: 12, padding: "8px 0" }}>加载中…</div>
            ) : importHistory.length === 0 ? (
              <div style={{ color: "#444", fontSize: 12, padding: "8px 0" }}>暂无导入记录</div>
            ) : (
              <table style={S.table as CSSProperties}>
                <thead>
                  <tr>
                    {["时间", "标签", "持仓数", "操作"].map((h) => (
                      <th key={h} style={S.th as CSSProperties}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {importHistory.map((rec) => (
                    <tr key={rec.id}>
                      <td style={{ ...(S.td as CSSProperties), color: "#666", fontSize: 12, fontVariant: "tabular-nums" }}>
                        {rec.created_at.slice(0, 16).replace("T", " ")}
                      </td>
                      <td style={{ ...(S.td as CSSProperties), color: "#b8ac98", fontSize: 13 }}>{rec.label || "—"}</td>
                      <td style={{ ...(S.td as CSSProperties), color: "#888", fontVariant: "tabular-nums" }}>{rec.holding_count} 只</td>
                      <td style={S.td as CSSProperties}>
                        {rollbackConfirm === rec.id ? (
                          <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                            <span style={{ fontSize: 11, color: "#e07070", marginRight: 4 }}>确认回滚到此快照？</span>
                            <button
                              style={{ ...btn(true), padding: "3px 12px", fontSize: 11, background: "#e07070" }}
                              onClick={() => void doRollback(rec.id)}
                            >确认</button>
                            <button
                              style={{ ...btn(false), padding: "3px 12px", fontSize: 11 }}
                              onClick={() => setRollbackConfirm(null)}
                            >取消</button>
                          </span>
                        ) : (
                          <button
                            style={{ ...btn(false), padding: "3px 12px", fontSize: 11 }}
                            onClick={() => setRollbackConfirm(rec.id)}
                          >回滚</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          )}
        </div>
      </>
    );
  };

  const TABS = [
    { id: "portfolio" as const, label: "持仓总览" },
    { id: "curve"     as const, label: "收益曲线" },
    { id: "diary"     as const, label: "投资日志" },
    { id: "upload"    as const, label: "上传截图" },
  ];

  return (
    <div style={S.root as CSSProperties}>
      {/* header */}
      <div style={S.header as CSSProperties}>
        <div style={S.logo as CSSProperties}>值·录</div>
        <div style={S.sub as CSSProperties}>Personal Value Investment Tracker</div>
        <div style={{ marginLeft: "auto", fontSize: 11, color: "#444" }}>
          {new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" })}
        </div>
      </div>

      {/* nav */}
      <div style={S.nav as CSSProperties}>
        {TABS.map((t) => (
          <button key={t.id} style={navBtn(tab === t.id)} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {/* body */}
      <div style={S.body as CSSProperties}>
        {tab === "portfolio" && PortfolioTab()}
        {tab === "curve"     && CurveTab()}
        {tab === "diary"     && DiaryTab()}
        {tab === "upload"    && UploadTab()}
      </div>
    </div>
  );
}

// shared input style (extracted to avoid repetition in JSX)
const inputStyle: CSSProperties = {
  background: "#1a1a1a",
  border: "1px solid #2a2a2a",
  borderRadius: 3,
  color: "#d4c8b0",
  padding: "8px 12px",
  fontSize: 13,
  fontFamily: "'Georgia', serif",
  width: "100%",
  boxSizing: "border-box",
};
