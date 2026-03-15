import base64
import json
import os
import re
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path
from typing import List

import yfinance as yf
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from openai import OpenAI
from pydantic import BaseModel

from prompts import ANALYZE_PROMPT

load_dotenv(Path(__file__).parent / ".env")

_AI_BASE_URL = os.getenv("AI_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1")
_AI_MODEL = os.getenv("AI_MODEL", "qwen3.5-plus")

_qwen_client = OpenAI(
    api_key=os.getenv("DASHSCOPE_API_KEY", ""),
    base_url=_AI_BASE_URL,
)

# ─── Database setup ───────────────────────────────────────────────────────────

DB_PATH = Path(__file__).parent / "investment.db"


@contextmanager
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    with get_db() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS holdings (
                id TEXT PRIMARY KEY,
                code TEXT NOT NULL,
                name TEXT NOT NULL,
                shares REAL NOT NULL,
                cost REAL NOT NULL,
                price REAL NOT NULL,
                sector TEXT NOT NULL DEFAULT '',
                notes TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS diary (
                id INTEGER PRIMARY KEY,
                date TEXT NOT NULL,
                type TEXT NOT NULL,
                code TEXT NOT NULL DEFAULT '',
                remark TEXT NOT NULL DEFAULT '',
                mood TEXT NOT NULL DEFAULT '理性'
            );
            CREATE TABLE IF NOT EXISTS curve (
                date TEXT PRIMARY KEY,
                value REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS import_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT NOT NULL,
                label TEXT NOT NULL DEFAULT '',
                snapshot TEXT NOT NULL
            );
        """)

        conn.execute("""
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
        """)


# ─── Pydantic models ──────────────────────────────────────────────────────────

class Holding(BaseModel):
    id: str
    code: str
    name: str
    shares: float
    cost: float
    price: float
    sector: str = ""
    notes: str = ""


class DiaryEntryIn(BaseModel):
    date: str
    type: str
    code: str = ""
    remark: str = ""
    mood: str = "理性"


class DiaryEntry(DiaryEntryIn):
    id: int


class CurvePoint(BaseModel):
    date: str
    value: float


class AnalyzeRequest(BaseModel):
    # New multi-image fields
    base64_images: list[str] = []
    media_types: list[str] = []
    description: str = ""
    portfolio_date: str = ""
    current_holdings: list[dict] = []
    # Legacy single-image fields (kept for backward compatibility)
    base64_image: str = ""
    media_type: str = "image/jpeg"


class CashUpdate(BaseModel):
    amount: float


class BulkHoldingsRequest(BaseModel):
    holdings: List[Holding]
    label: str = ""


class ImportRecordSummary(BaseModel):
    id: int
    created_at: str
    label: str
    holding_count: int


# ─── App ──────────────────────────────────────────────────────────────────────

app = FastAPI(title="Investment Tracker API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

init_db()


# ─── System reset endpoint ────────────────────────────────────────────────────

@app.delete("/api/reset")
def reset_all_data(confirm: bool = Query(False)):
    """Clear all data from every table. Requires ?confirm=true to prevent accidents."""
    if not confirm:
        raise HTTPException(status_code=400, detail="Pass ?confirm=true to reset all data")
    tables = ["holdings", "diary", "curve", "import_history", "settings"]
    deleted: dict[str, int] = {}
    with get_db() as conn:
        for table in tables:
            cur = conn.execute(f"DELETE FROM {table}")
            deleted[table] = cur.rowcount
    return {"status": "cleared", "deleted": deleted}


# ─── Holdings endpoints ───────────────────────────────────────────────────────

@app.get("/api/holdings", response_model=List[Holding])
def list_holdings():
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM holdings").fetchall()
        return [dict(r) for r in rows]


@app.post("/api/holdings/bulk", response_model=List[Holding])
def bulk_replace_holdings(req: BulkHoldingsRequest):
    """Replace all holdings atomically (used after AI import). Saves a rollback snapshot first."""
    label = req.label or datetime.now().strftime("%Y-%m-%d %H:%M 导入")
    with get_db() as conn:
        current_rows = conn.execute("SELECT * FROM holdings").fetchall()
        snapshot = json.dumps([dict(r) for r in current_rows], ensure_ascii=False)
        conn.execute(
            "INSERT INTO import_history (created_at, label, snapshot) VALUES (?, ?, ?)",
            (datetime.now().isoformat(), label, snapshot),
        )
        conn.execute("DELETE FROM holdings")
        conn.executemany(
            "INSERT INTO holdings (id, code, name, shares, cost, price, sector, notes) VALUES (:id, :code, :name, :shares, :cost, :price, :sector, :notes)",
            [h.model_dump() for h in req.holdings],
        )
        rows = conn.execute("SELECT * FROM holdings").fetchall()
        return [dict(r) for r in rows]


# ─── Diary endpoints ──────────────────────────────────────────────────────────

@app.get("/api/diary", response_model=List[DiaryEntry])
def list_diary():
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM diary ORDER BY date DESC, id DESC").fetchall()
        return [dict(r) for r in rows]


@app.post("/api/diary", response_model=DiaryEntry)
def add_diary_entry(entry: DiaryEntryIn):
    with get_db() as conn:
        cur = conn.execute(
            "INSERT INTO diary (date, type, code, remark, mood) VALUES (?, ?, ?, ?, ?)",
            (entry.date, entry.type, entry.code, entry.remark, entry.mood),
        )
        row = conn.execute("SELECT * FROM diary WHERE id = ?", (cur.lastrowid,)).fetchone()
        return dict(row)


@app.delete("/api/diary/{entry_id}")
def delete_diary_entry(entry_id: int):
    with get_db() as conn:
        conn.execute("DELETE FROM diary WHERE id = ?", (entry_id,))
    return {"ok": True}


# ─── Import history endpoints ─────────────────────────────────────────────────

@app.get("/api/imports", response_model=List[ImportRecordSummary])
def list_imports():
    """List all import history records (newest first)."""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, created_at, label, snapshot FROM import_history ORDER BY created_at DESC"
        ).fetchall()
        result = []
        for r in rows:
            snapshot = json.loads(r["snapshot"])
            result.append({
                "id": r["id"],
                "created_at": r["created_at"],
                "label": r["label"],
                "holding_count": len(snapshot),
            })
        return result


@app.post("/api/imports/rollback/{import_id}", response_model=List[Holding])
def rollback_import(import_id: int):
    """Restore holdings to the state captured in the given import snapshot."""
    with get_db() as conn:
        row = conn.execute(
            "SELECT snapshot FROM import_history WHERE id = ?", (import_id,)
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Import record not found")

        snapshot_holdings = json.loads(row["snapshot"])

        # Save current state as a backup snapshot before rolling back
        current_rows = conn.execute("SELECT * FROM holdings").fetchall()
        current_snapshot = json.dumps([dict(r) for r in current_rows], ensure_ascii=False)
        conn.execute(
            "INSERT INTO import_history (created_at, label, snapshot) VALUES (?, ?, ?)",
            (datetime.now().isoformat(), "回滚前自动备份", current_snapshot),
        )

        conn.execute("DELETE FROM holdings")
        if snapshot_holdings:
            conn.executemany(
                "INSERT INTO holdings (id, code, name, shares, cost, price, sector, notes) VALUES (:id, :code, :name, :shares, :cost, :price, :sector, :notes)",
                snapshot_holdings,
            )
        rows = conn.execute("SELECT * FROM holdings").fetchall()
        return [dict(r) for r in rows]


@app.delete("/api/imports/{import_id}")
def delete_import(import_id: int):
    """Delete an import history record."""
    with get_db() as conn:
        conn.execute("DELETE FROM import_history WHERE id = ?", (import_id,))
        return {"ok": True}


# ─── Curve endpoints ──────────────────────────────────────────────────────────

@app.get("/api/curve", response_model=List[CurvePoint])
def list_curve():
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM curve ORDER BY date ASC").fetchall()
        return [dict(r) for r in rows]


@app.post("/api/curve/point", response_model=CurvePoint)
def add_curve_point(point: CurvePoint):
    """Upsert a curve point for the given date."""
    with get_db() as conn:
        conn.execute(
            "INSERT INTO curve (date, value) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET value = excluded.value",
            (point.date, point.value),
        )
        row = conn.execute("SELECT * FROM curve WHERE date = ?", (point.date,)).fetchone()
        return dict(row)


# ─── HS300 endpoint ───────────────────────────────────────────────────────────

@app.get("/api/hs300")
def get_hs300(days: int = Query(default=180, ge=7, le=1000)):
    """
    Return daily close prices for CSI 300 (沪深300) for the past `days` days.
    Response: [{"date": "YYYY-MM-DD", "close": float}, ...]
    """
    end_date = datetime.today()
    start_date = end_date - timedelta(days=days + 10)  # buffer for holidays

    try:
        ticker = yf.Ticker("000300.SS")
        df = ticker.history(
            start=start_date.strftime("%Y-%m-%d"),
            end=end_date.strftime("%Y-%m-%d"),
            auto_adjust=True,
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"yfinance error: {e}")

    if df is None or df.empty:
        raise HTTPException(status_code=404, detail="No data returned from Yahoo Finance")

    df = df.tail(days)
    return [
        {"date": str(idx.date()), "close": round(float(close), 2)}
        for idx, close in zip(df.index, df["Close"])
    ]


# ─── Cash endpoints ───────────────────────────────────────────────────────────

@app.get("/api/cash")
def get_cash():
    with get_db() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key = 'cash'").fetchone()
        return {"amount": float(row["value"]) if row else 0.0}


@app.post("/api/cash")
def set_cash(body: CashUpdate):
    with get_db() as conn:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('cash', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (str(body.amount),),
        )
        return {"amount": body.amount}


# ─── AI analyze endpoint ──────────────────────────────────────────────────────

@app.post("/api/analyze")
def analyze_image(req: AnalyzeRequest):
    """Analyze one or more portfolio screenshots using Qwen3.5-plus vision."""
    api_key = os.getenv("DASHSCOPE_API_KEY", "")
    if not api_key or api_key.startswith("sk-xxx"):
        raise HTTPException(status_code=503, detail="DASHSCOPE_API_KEY not configured")

    # Normalize to multi-image format (support legacy single-image requests)
    images: list[tuple[str, str]] = []  # list of (base64, media_type)
    if req.base64_images:
        mt_list = req.media_types if len(req.media_types) == len(req.base64_images) else ["image/jpeg"] * len(req.base64_images)
        images = list(zip(req.base64_images, mt_list))
    elif req.base64_image:
        images = [(req.base64_image, req.media_type or "image/jpeg")]

    if not images:
        raise HTTPException(status_code=400, detail="No image provided")

    # Build dynamic context suffix for prompt
    context_parts: list[str] = []
    if req.portfolio_date:
        context_parts.append(f"用户指定的持仓日期为：{req.portfolio_date}，若截图中无日期请使用此日期填写 date 字段。")
    if req.description:
        context_parts.append(f"用户补充说明：{req.description}")
    if req.current_holdings:
        holdings_json = json.dumps(req.current_holdings, ensure_ascii=False)
        context_parts.append(
            f"以下是当前系统中已有的持仓记录，请对照这些数据进行识别，"
            f"对于截图中已存在的股票尽量补全缺失字段，"
            f"股票代码以系统记录为准（避免产生歧义）\n{holdings_json}"
        )
    context_suffix = "\n\n" + "\n".join(context_parts) if context_parts else ""

    # Build content list: all images first, then the prompt text
    content: list[dict] = [
        {"type": "image_url", "image_url": {"url": f"data:{mt};base64,{b64}"}}
        for b64, mt in images
    ]
    content.append({"type": "text", "text": ANALYZE_PROMPT + context_suffix})

    try:
        completion = _qwen_client.chat.completions.create(
            model=_AI_MODEL,
            max_tokens=2000,
            messages=[{"role": "user", "content": content}],
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Qwen API error: {e}")

    raw = completion.choices[0].message.content or ""
    # Strip markdown fences if the model wraps the JSON anyway
    cleaned = re.sub(r"```(?:json)?|```", "", raw).strip()
    return {"result": cleaned}


# ─── Diff helper ──────────────────────────────────────────────────────────────

def compute_diff(current: list[dict], new_holdings: list[dict]) -> dict:
    """Compare current DB holdings against newly analyzed holdings and return a change summary."""
    current_map = {h["code"]: h for h in current}
    new_map = {h["code"]: h for h in new_holdings}

    added = [h for code, h in new_map.items() if code not in current_map]
    removed = [
        {"code": code, "name": h.get("name", ""), "shares": h.get("shares", 0)}
        for code, h in current_map.items()
        if code not in new_map
    ]
    modified = []
    unchanged_count = 0

    for code, new_h in new_map.items():
        if code in current_map:
            curr_h = current_map[code]
            if (
                new_h.get("shares") != curr_h.get("shares")
                or new_h.get("cost") != curr_h.get("cost")
                or new_h.get("price") != curr_h.get("price")
            ):
                modified.append({
                    "code": code,
                    "name": new_h.get("name") or curr_h.get("name", ""),
                    "before": {
                        "shares": curr_h.get("shares"),
                        "cost": curr_h.get("cost"),
                        "price": curr_h.get("price"),
                    },
                    "after": {
                        "shares": new_h.get("shares"),
                        "cost": new_h.get("cost"),
                        "price": new_h.get("price"),
                    },
                })
            else:
                unchanged_count += 1

    return {
        "added": added,
        "removed": removed,
        "modified": modified,
        "unchanged_count": unchanged_count,
    }


# ─── External upload endpoint ─────────────────────────────────────────────────

@app.post("/api/external/upload")
async def external_upload(
    images: List[UploadFile] = File(..., description="一张或多张持仓截图（jpg/png/webp）"),
    notes: str = Form("", description="补充说明，帮助 AI 理解截图内容"),
    portfolio_date: str = Form("", description="持仓日期，格式 YYYY-MM-DD，截图中无日期时使用"),
):
    """
    外部持仓更新接口：上传截图 → AI 解析 → 与当前持仓对比 → 返回变动记录。

    调用方无需了解底层 AI 接口细节，只需上传图片文件即可获取结构化的持仓变动信息，
    由用户或外部应用在确认后决定是否调用 /api/holdings/bulk 提交更新。
    """
    api_key = os.getenv("DASHSCOPE_API_KEY", "")
    if not api_key or api_key.startswith("sk-xxx"):
        raise HTTPException(status_code=503, detail="DASHSCOPE_API_KEY not configured")

    if not images:
        raise HTTPException(status_code=400, detail="No image provided")

    # Convert uploaded files to base64
    b64_images: list[str] = []
    media_types: list[str] = []
    for img in images:
        data = await img.read()
        b64_images.append(base64.b64encode(data).decode())
        media_types.append(img.content_type or "image/jpeg")

    # Fetch current holdings for AI context and diff baseline
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM holdings").fetchall()
        current_holdings = [dict(r) for r in rows]

    # Reuse existing analyze logic
    req = AnalyzeRequest(
        base64_images=b64_images,
        media_types=media_types,
        description=notes,
        portfolio_date=portfolio_date,
        current_holdings=current_holdings,
    )
    analyze_result = analyze_image(req)

    # Parse the JSON string returned by the LLM
    try:
        parsed = json.loads(analyze_result["result"])
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=502, detail=f"Failed to parse AI response: {e}")

    new_holdings = parsed.get("holdings", [])
    diff = compute_diff(current_holdings, new_holdings)

    return {
        "analyzed_holdings": new_holdings,
        "summary": parsed.get("summary", ""),
        "date": parsed.get("date", ""),
        "total_assets": parsed.get("total_assets"),
        "total_pnl": parsed.get("total_pnl"),
        "diff": diff,
    }


# ─── Stock info streaming endpoint ───────────────────────────────────────────

def _yf_code(code: str) -> str:
    """Convert a bare A-share code to its Yahoo Finance ticker symbol."""
    code = code.strip()
    if code.startswith("6"):
        return code + ".SS"
    elif code.startswith(("0", "3")):
        return code + ".SZ"
    return code + ".BJ"


@app.get("/api/stock-info")
def stream_stock_info(code: str):
    """
    Stream basic stock information for an A-share code.
    Emits SSE events:
      {"type":"price","price":float|null,"name":string}
      {"type":"text","delta":string}   (multiple, from Qwen)
      [DONE]
    """
    api_key = os.getenv("DASHSCOPE_API_KEY", "")

    def generate():
        # 1. Try yfinance for real-time price
        price_event: dict = {"type": "price", "price": None, "name": ""}
        try:
            info = yf.Ticker(_yf_code(code)).info
            price = info.get("regularMarketPrice") or info.get("currentPrice")
            price_event["price"] = round(float(price), 2) if price else None
            price_event["name"] = info.get("shortName") or info.get("longName") or ""
        except Exception:
            pass
        yield f"data: {json.dumps(price_event, ensure_ascii=False)}\n\n"

        # 2. Stream AI description (skip if no API key)
        if not api_key or api_key.startswith("sk-xxx"):
            yield "data: [DONE]\n\n"
            return

        prompt = (
            f"你是一名专业的投资研究助手。请用中文简要介绍A股上市公司（代码：{code}）。"
            f"输出内容应简洁清晰，重点向投资者介快速理解公司的主营业务"
            f"语言简洁，总字数不超过 300 字"
        )
        try:
            stream = _qwen_client.chat.completions.create(
                model="qwen3.5-flash",
                stream=True,
                messages=[{"role": "user", "content": prompt}],
            )
            for chunk in stream:
                delta = chunk.choices[0].delta.content or ""
                if delta:
                    yield f"data: {json.dumps({'type': 'text', 'delta': delta}, ensure_ascii=False)}\n\n"
        except Exception as e:
            err = {"type": "text", "delta": f"（简介获取失败：{e}）"}
            yield f"data: {json.dumps(err, ensure_ascii=False)}\n\n"

        yield "data: [DONE]\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
