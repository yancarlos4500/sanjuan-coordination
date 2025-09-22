import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { io, Socket } from "socket.io-client";
import { v4 as uuidv4 } from "uuid";

/* ===========================
   Types
=========================== */
interface VatsimPilot {
  callsign: string;
  altitude: number;
  groundspeed: number;
  heading: number | null;
  latitude: number;
  longitude: number;
  planned_depairport?: string | null;
  planned_destairport?: string | null;
  flight_plan?: {
    departure?: string | null;
    arrival?: string | null;
    altitude?: string | null;
    route?: string | null;
  } | null;
}

interface BoardItemFields {
  callsign: string;
  waypoint: string;
  estimate: string; // HHMM
  altitude: string; // FL###
  mach: string;     // M##
  squawk: string;  // transponder / squawk code
}

interface BoardItem extends BoardItemFields {
  id: string;
  source: "manual" | "vatsim";
  routeWaypoints: string[];
}

type LaneKey = "Unassigned" | "New York" | "Curacao" | "Piarco" | "Maiquetia";

interface BoardState {
  lanes: Record<LaneKey, string[]>;
  items: Record<string, BoardItem>;
  lastUpdated: number;
}

/* ===========================
   Config
=========================== */
const DEFAULT_LANES: Record<LaneKey, string[]> = {
  Unassigned: [],
  "New York": [],
  Curacao: [],
  Piarco: [],
  Maiquetia: [],
};

const LANE_FIXES: Partial<Record<LaneKey, string[]>> = {
  Curacao: ["SCAPA"],
  Maiquetia: ["ARMUR", "MILOK", "KIKER"],
  Piarco: ["ANADA", "GEECE", "ILURI", "MODUX", "GABAR", "ZPATA", "ELOPO", "LAMKN"],
  "New York": ["DAWIN", "OBIKE", "SOCCO", "OPAUL", "KEEKA", "CHEDR", "HANCY", "FERNA", "KINCH"],
};

const isLocal = location.hostname === "localhost" || location.hostname === "127.0.0.1";
const SOCKET_URL =
  isLocal
    ? (import.meta as any)?.env?.VITE_SOCKET_URL || "http://localhost:5175"
    : window.location.origin; // <-- prod uses same origin (Railway URL)

/* ===========================
   Helpers (formatting)
=========================== */
function parseWaypointsFromRoute(route?: string | null): string[] {
  if (!route) return [];
  const toks = route
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .filter((t) => /^[A-Z0-9]{2,7}$/.test(t));
  return Array.from(new Set(toks));
}

function callsignMatch(a: string, b: string) {
  return a.toLowerCase().includes(b.toLowerCase());
}

function getFixOptions(lane: LaneKey, item: BoardItem): string[] {
  const fixed = LANE_FIXES[lane];
  if (fixed && fixed.length) return fixed;
  return item.routeWaypoints?.length ? item.routeWaypoints : ["—"];
}

// Keep only digits
const digits = (s: string) => (s || "").replace(/\D+/g, "");

// HHMM (4 digits)
function fmtHHMM(input: string): string {
  return digits(input).slice(0, 4);
}

// FL + up to 3 digits (FL350)
function fmtFL(input: string): string {
  const d = digits(input).slice(0, 3);
  return d ? `FL${d}` : "";
}

// M + up to 2 digits (M82)
function fmtMach(input: string): string {
  const d = digits(input).slice(0, 2);
  return d ? `M${d}` : "";
}

/* ===========================
   VATSIM data hook (15s)
=========================== */
function useVatsimPilots() {
  const [pilots, setPilots] = useState<VatsimPilot[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function fetchPilots() {
    try {
      setLoading(true);
      setErr(null);
      const res = await fetch("https://data.vatsim.net/v3/vatsim-data.json", {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      console.log(data);
      
      const list: VatsimPilot[] = (data?.pilots || []).map((p: any) => ({
        callsign: p.callsign,
        altitude: p.altitude ?? 0,
        groundspeed: p.groundspeed ?? 0,
        heading: p.heading ?? null,
        latitude: p.latitude,
        longitude: p.longitude,
        planned_depairport: p.planned_depairport ?? p.flight_plan?.departure ?? null,
        planned_destairport: p.planned_destairport ?? p.flight_plan?.arrival ?? null,
        flight_plan: p.flight_plan ?? null,
      }));
      setPilots(list);
    } catch (e: any) {
      setErr(e?.message || "Failed to load VATSIM data");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchPilots();
    const id = setInterval(fetchPilots, 15_000); // 15 seconds
    return () => clearInterval(id);
  }, []);

  return { pilots, loading, err };
}

/* ===========================
   Realtime sync (Socket.IO)
=========================== */
function useRealtimeSync(
  state: BoardState,
  setState: (updater: (s: BoardState) => BoardState) => void
) {
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    const socket = io(SOCKET_URL, { transports: ["websocket"] });
    socketRef.current = socket;

    socket.on("connect", () => {
      socket.emit("board:pull");
    });

    socket.on("board:state", (incoming: BoardState) => {
      setState(() => incoming);
    });

    socket.on("item:patch:apply", ({ id, patch, mtime }: any) => {
      setState((prev) => ({
        ...prev,
        items: { ...prev.items, [id]: { ...prev.items[id], ...patch } },
        lastUpdated: mtime || Date.now(),
      }));
    });

    socket.on("lanes:move:apply", ({ id, from, to, index, mtime }: any) => {
      setState((prev) => {
        const fromArr = prev.lanes[from].filter((x) => x !== id);
        const toArr = [...prev.lanes[to]];
        if (typeof index === "number") toArr.splice(index, 0, id);
        else toArr.unshift(id);
        return {
          ...prev,
          lanes: { ...prev.lanes, [from]: fromArr, [to]: toArr },
          lastUpdated: mtime || Date.now(),
        };
      });
    });

    return () => socket.disconnect();
  }, [setState]);

  // broadcast whole state (coarse sync) whenever it changes
  useEffect(() => {
    if (!socketRef.current) return;
    socketRef.current.emit("board:update", state);
  }, [state]);

  // helpers to send fine-grained patches
  function sendItemPatch(id: string, patch: Partial<BoardItemFields>) {
    socketRef.current?.emit("item:patch", { id, patch, mtime: Date.now() });
  }
  function sendMove(id: string, from: LaneKey, to: LaneKey, index?: number) {
    socketRef.current?.emit("lanes:move", { id, from, to, index, mtime: Date.now() });
  }

  return { sendItemPatch, sendMove };
}

/* ===========================
   Sortable Card
=========================== */
type SortableCardProps = {
  id: string;
  laneKey: LaneKey;
  item: BoardItem;
  onChange: (patch: Partial<BoardItemFields>) => void;
  onDelete: () => void;
  [key: string]: any; // allow extra props like `key` from JSX
};

function SortableCard({ id, laneKey, item, onChange, onDelete }: SortableCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.85 : 1,
  };

  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    const fix = item.waypoint || "—";
    const estimate = item.estimate || "—";
    const altitude = item.altitude || "—";
    const squawk = item.squawk || "—";
    const text = `${item.callsign} ${fix} ${estimate} ${altitude} ${squawk}`;

    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        // fallback for older browsers
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      // ignore copy errors silently
      console.error("copy failed", e);
    }
  }

  // Waypoint choices (hidden entirely on Unassigned)
  const showFix = laneKey !== "Unassigned";
  const options = getFixOptions(laneKey, item);
  const valid = options.includes(item.waypoint) || item.waypoint === "";

  useEffect(() => {
    if (!valid && showFix) onChange({ waypoint: "" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [laneKey]);

  return (
    <div ref={setNodeRef} style={style} className="card dark-card">
      <div className="card-top" {...attributes} {...listeners}>
        <div className="callsign">{item.callsign}</div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button className="copy" onClick={handleCopy}>{copied ? "Copied!" : "Copy"}</button>
          <button className="remove" onClick={onDelete}>
            Remove
          </button>
        </div>
      </div>

      <div className="grid">
        {showFix && (
          <div>
            <label className="label">Fix</label>
            <select
              className="input-sm"
              value={valid ? item.waypoint : ""}
              onChange={(e) => onChange({ waypoint: e.target.value })}
            >
              {options.map((w) => (
                <option key={w} value={w === "—" ? "" : w}>
                  {w}
                </option>
              ))}
            </select>
          </div>
        )}

        <div>
          <label className="label">Estimate (HHMM)</label>
          <input
            className="input-sm"
            placeholder="HHMM"
            value={item.estimate}
            onChange={(e) => onChange({ estimate: fmtHHMM(e.target.value) })}
          />
        </div>

        <div>
          <label className="label">Altitude</label>
          <input
            className="input-sm"
            placeholder="FL350"
            value={item.altitude}
            onChange={(e) => onChange({ altitude: fmtFL(e.target.value) })}
          />
        </div>

        <div>
          <label className="label">Mach</label>
          <input
            className="input-sm"
            placeholder="M82"
            value={item.mach}
            onChange={(e) => onChange({ mach: fmtMach(e.target.value) })}
          />
        </div>

        {/* Callsign is NOT editable per your request */}
        {/* <div>
          <label className="label">Callsign</label>
          <input className="input-sm" value={item.callsign} disabled />
        </div> */}
      </div>
    </div>
  );
}

/* ===========================
   Lane (droppable)
=========================== */
type LaneProps = {
  laneKey: LaneKey;
  ids: string[];
  items: Record<string, BoardItem>;
  onPatch: (id: string, patch: Partial<BoardItemFields>) => void;
  onDelete: (id: string) => void;
  [key: string]: any;
};

function Lane({ laneKey, ids, items, onPatch, onDelete }: LaneProps) {
  const { setNodeRef, isOver } = useDroppable({ id: laneKey });

  return (
    <div className="lane dark-lane">
      <div className="lane-head">
        <div className="brand">{laneKey}</div>
        <div className="count">{ids.length}</div>
      </div>

      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <div
          ref={setNodeRef}
          className="lane-dropzone"
          style={{
            minHeight: 60,
            outline: isOver ? "2px dashed var(--accent)" : "none",
            outlineOffset: 4,
            borderRadius: 10,
            padding: 2,
          }}
        >
          {ids.map((id) => (
            <SortableCard
              key={id}
              id={id}
              laneKey={laneKey}
              item={items[id]}
              onChange={(patch) => onPatch(id, patch)}
              onDelete={() => onDelete(id)}
            />
          ))}
        </div>
      </SortableContext>
    </div>
  );
}

/* ===========================
   Main App
=========================== */
export default function App() {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const { pilots, loading, err } = useVatsimPilots();

  const [query, setQuery] = useState("");
  const filtered = useMemo(
    () => pilots.filter((p) => callsignMatch(p.callsign, query)).slice(0, 50),
    [pilots, query]
  );

  const [state, setState] = useState<BoardState>({
    lanes: { ...DEFAULT_LANES },
    items: {},
    lastUpdated: Date.now(),
  });

  const { sendItemPatch, sendMove } = useRealtimeSync(state, (updater) =>
    setState((prev) => updater(prev))
  );

  // ---- CRUD ----
  function addPilotToUnassigned(p: VatsimPilot) {
    // Only one card per callsign across all lanes
    const exists = (Object.values(state.items) as BoardItem[]).some(
      (x) => x.callsign.toLowerCase() === p.callsign.toLowerCase()
    );
    if (exists) return;

    const id = uuidv4();
    const item: BoardItem = {
      id,
      source: "vatsim",
      callsign: p.callsign,
      waypoint: "",
      estimate: "",
      altitude: fmtFL(p.flight_plan?.altitude || String(p.altitude || "")),
      mach: "",
  squawk: (p as any)?.flight_plan?.assigned_transponder || "",
      routeWaypoints: parseWaypointsFromRoute(p.flight_plan?.route ?? ""),
    };

    setState((prev) => ({
      ...prev,
      items: { ...prev.items, [id]: item },
      lanes: { ...prev.lanes, Unassigned: [id, ...prev.lanes.Unassigned] },
      lastUpdated: Date.now(),
    }));
  }

  function patchItem(id: string, patch: Partial<BoardItemFields>) {
    setState((prev) => ({
      ...prev,
      items: { ...prev.items, [id]: { ...prev.items[id], ...patch } },
      lastUpdated: Date.now(),
    }));
    sendItemPatch(id, patch); // realtime fine-grained sync
  }

  function deleteItem(id: string) {
    setState((prev) => {
      const items = { ...prev.items };
      delete items[id];
      const lanes: Record<LaneKey, string[]> = { ...prev.lanes } as any;
      (Object.keys(lanes) as LaneKey[]).forEach((k) => {
        lanes[k] = lanes[k].filter((x) => x !== id);
      });
      return { ...prev, items, lanes, lastUpdated: Date.now() };
    });
  }

  // ---- DnD: cross-lane + reorder ----
  const [dragOrigin, setDragOrigin] = useState<LaneKey | null>(null);

  function moveItem(id: string, from: LaneKey, to: LaneKey, index?: number) {
    setState((prev) => {
      const fromArr = prev.lanes[from].filter((x) => x !== id);
      const toArr = [...prev.lanes[to]];
      if (typeof index === "number") toArr.splice(index, 0, id);
      else toArr.unshift(id);
      return {
        ...prev,
        lanes: { ...prev.lanes, [from]: fromArr, [to]: toArr },
        lastUpdated: Date.now(),
      };
    });
    sendMove(id, from, to, index); // realtime move
  }

  function reorderInLane(lane: LaneKey, oldIndex: number, newIndex: number) {
    setState((prev) => ({
      ...prev,
      lanes: { ...prev.lanes, [lane]: arrayMove(prev.lanes[lane], oldIndex, newIndex) },
      lastUpdated: Date.now(),
    }));
  }

  function handleDragStart(event: any) {
    const lane = (Object.keys(state.lanes) as LaneKey[]).find((l) =>
      state.lanes[l].includes(event.active.id)
    );
    setDragOrigin(lane || null);
  }

  function handleDragEnd(event: any) {
    const { active, over } = event;
    if (!over) return;
    const laneKeys = Object.keys(state.lanes) as LaneKey[];
    const overLane = laneKeys.find((k) => k === over.id || state.lanes[k].includes(over.id));
    const origin = dragOrigin as LaneKey | null;
    if (!overLane || !origin) return;

    if (origin === overLane) {
      const oldIndex = state.lanes[origin].indexOf(active.id);
      const newIndex = state.lanes[overLane].indexOf(over.id);
      if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
        reorderInLane(origin, oldIndex, newIndex);
      }
    } else {
      moveItem(active.id, origin, overLane);
    }
  }

  /* ===========================
     UI
  =========================== */
  return (
    <div className="dark-root">
      {/* Top bar */}
      <div className="top dark-top">
        <div className="inner container">
          <div className="brand">Coordination Board</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              className="input dark-input"
              placeholder="Search callsign (e.g., JBU123)"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="muted">
              {loading ? "Loading…"
                : err ? `Error: ${err}`
                : `${pilots.length.toLocaleString()} pilots online`}
            </div>
          </div>
        </div>
      </div>

      {/* Search results */}
      <div className="container" style={{ marginTop: 12 }}>
        {!!query && (
          <div className="search-card dark-panel">
            <div style={{ marginBottom: 6 }} className="muted">Search Results</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {filtered.map((p) => (
                <button
                  key={p.callsign}
                  className="pill dark-pill"
                  onClick={() => addPilotToUnassigned(p)}
                  title={`${p.planned_depairport || p.flight_plan?.departure || "?"} → ${p.planned_destairport || p.flight_plan?.arrival || "?"}`}
                >
                  {p.callsign}
                </button>
              ))}
              {!filtered.length && <div className="muted">No matches</div>}
            </div>
          </div>
        )}

        {/* Vertical lanes */}
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <div className="board">
            {(Object.keys(state.lanes) as LaneKey[]).map((laneKey) => (
              <Lane
                key={laneKey}
                laneKey={laneKey}
                ids={state.lanes[laneKey]}
                items={state.items}
                onPatch={patchItem}
                onDelete={deleteItem}
              />
            ))}
          </div>
        </DndContext>
      </div>
    </div>
  );
}

/* ===========================
   Dark theme styles (inline)
   Move these into styles.css if you prefer.
=========================== */
const styleId = "coord-board-dark-styles";
if (!document.getElementById(styleId)) {
  const el = document.createElement("style");
  el.id = styleId;
  el.innerHTML = `
:root{
  --bg:#0b1020; --panel:#0e162b; --panel2:#0b1426; --card:#101a33;
  --text:#e7efff; --muted:#94a3b8; --accent:#60a5fa; --danger:#ef4444; --border:rgba(255,255,255,.10);
}
*{box-sizing:border-box}
body{margin:0}
.dark-root{min-height:100vh;background:linear-gradient(180deg,#0b1020,#0a1224 30%,#091228 100%);color:var(--text);font-family:Inter,system-ui,Arial,Helvetica}
.container{max-width:960px;margin:0 auto;padding:16px}
.muted{color:var(--muted);font-size:12px}
.top{position:sticky;top:0;z-index:10}
.dark-top{background:rgba(9,14,28,.65);backdrop-filter:blur(12px);border-bottom:1px solid var(--border)}
.top .inner{display:flex;gap:12px;align-items:center;justify-content:space-between;padding:12px 16px}
.brand{font-weight:800;color:#cfe1ff}
.input{border:1px solid var(--border);border-radius:12px;padding:10px 12px;min-width:280px}
.dark-input{background:#0a1222;color:var(--text)}
.search-card{border:1px solid var(--border);border-radius:14px;padding:12px}
.dark-panel{background:linear-gradient(180deg,var(--panel),var(--panel2))}
.pill{border:1px solid var(--border);border-radius:999px;padding:8px 12px;cursor:pointer}
.dark-pill{background:#0b1a36;color:var(--text)}
.board{display:flex;flex-direction:column;gap:16px;margin-top:16px}
.lane{border:1px solid var(--border);border-radius:16px;padding:14px}
.dark-lane{background:linear-gradient(180deg,var(--panel),var(--panel2))}
.lane-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
.count{font-size:12px;color:var(--muted);border:1px solid var(--border);border-radius:999px;padding:2px 8px}
.card{border:1px solid var(--border);border-radius:14px;padding:12px;margin-bottom:12px;box-shadow:0 10px 22px rgba(0,0,0,.25)}
.dark-card{background:linear-gradient(180deg,var(--card),#0d1730)}
.card-top{display:flex;align-items:center;justify-content:space-between}
.callsign{font-weight:800;letter-spacing:.2px;cursor:grab}
.remove{font-size:11px;border:1px solid rgba(239,68,68,.35);color:#fecaca;background:rgba(239,68,68,.12);padding:6px 10px;border-radius:999px;cursor:pointer}
.copy{font-size:11px;border:1px solid rgba(96,165,250,.25);color:#cfe1ff;background:rgba(96,165,250,.08);padding:6px 10px;border-radius:999px;cursor:pointer}
.grid{display:grid;gap:10px;margin-top:10px}
@media(min-width:740px){.grid{grid-template-columns:repeat(4,1fr)}}
.label{display:block;font-size:11px;color:#b7c6e0;margin-bottom:4px}
.input-sm,select{width:100%;border:1px solid var(--border);border-radius:10px;padding:8px 10px;background:#0a1324;color:var(--text)}
`;
  document.head.appendChild(el);
}
