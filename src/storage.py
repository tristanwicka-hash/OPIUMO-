"""
Core feature #7 + position tracking: a small local SQLite database
(`data/trades.db` by default) holding

  - `positions`: one row per open/closed position (mint, entry price,
    remaining size, which TP steps have already fired)
  - `trades`:    one row per executed fill — every buy and every partial
    or full sell — with entry price, exit price, reason, and P&L.

SQLite is used because it's a single local file (no server to run), is
trivially inspectable with any SQLite browser or `sqlite3 data/trades.db`,
and gives us basic querying for free. All calls are synchronous sqlite3
calls run off the event loop via `asyncio.to_thread` so they never block
the monitor/trader loops.
"""
from __future__ import annotations

import asyncio
import json
import sqlite3
import time
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class Position:
    id: int
    mint: str
    source: str
    creator: str | None
    entry_time: float
    entry_price_sol: float
    entry_amount_tokens: float
    sol_spent: float
    remaining_tokens: float
    decimals: int
    tp_hits: list[float] = field(default_factory=list)
    status: str = "open"
    buy_signature: str | None = None


_SCHEMA = """
CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mint TEXT NOT NULL,
    source TEXT NOT NULL,
    creator TEXT,
    entry_time REAL NOT NULL,
    entry_price_sol REAL NOT NULL,
    entry_amount_tokens REAL NOT NULL,
    sol_spent REAL NOT NULL,
    remaining_tokens REAL NOT NULL,
    decimals INTEGER NOT NULL DEFAULT 6,
    tp_hits TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'open',
    buy_signature TEXT
);

CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    position_id INTEGER,
    mint TEXT NOT NULL,
    side TEXT NOT NULL,             -- 'buy' | 'sell'
    reason TEXT,                    -- 'entry' | 'take_profit_1' | 'take_profit_2' | 'stop_loss' | 'timeout' | 'manual'
    amount_tokens REAL NOT NULL,
    price_sol REAL NOT NULL,        -- SOL per token for this fill
    sol_amount REAL NOT NULL,       -- total SOL in (buy) or out (sell)
    pnl_sol REAL,                   -- only set on sells
    pnl_pct REAL,                   -- only set on sells
    tx_signature TEXT,
    executed_at REAL NOT NULL,
    FOREIGN KEY (position_id) REFERENCES positions(id)
);
"""


class TradeStore:
    def __init__(self, db_path: str | Path):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = asyncio.Lock()
        self._conn = sqlite3.connect(self.db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.executescript(_SCHEMA)
        self._conn.commit()

    async def open_position(
        self,
        mint: str,
        source: str,
        creator: str | None,
        entry_price_sol: float,
        entry_amount_tokens: float,
        sol_spent: float,
        decimals: int,
        buy_signature: str | None,
    ) -> Position:
        async with self._lock:
            return await asyncio.to_thread(
                self._open_position_sync,
                mint, source, creator, entry_price_sol, entry_amount_tokens, sol_spent, decimals, buy_signature,
            )

    def _open_position_sync(
        self, mint, source, creator, entry_price_sol, entry_amount_tokens, sol_spent, decimals, buy_signature
    ) -> Position:
        now = time.time()
        cur = self._conn.execute(
            """INSERT INTO positions
               (mint, source, creator, entry_time, entry_price_sol, entry_amount_tokens,
                sol_spent, remaining_tokens, decimals, tp_hits, status, buy_signature)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 'open', ?)""",
            (mint, source, creator, now, entry_price_sol, entry_amount_tokens, sol_spent, entry_amount_tokens, decimals, buy_signature),
        )
        self._conn.execute(
            """INSERT INTO trades
               (position_id, mint, side, reason, amount_tokens, price_sol, sol_amount, tx_signature, executed_at)
               VALUES (?, ?, 'buy', 'entry', ?, ?, ?, ?, ?)""",
            (cur.lastrowid, mint, entry_amount_tokens, entry_price_sol, sol_spent, buy_signature, now),
        )
        self._conn.commit()
        return Position(
            id=cur.lastrowid, mint=mint, source=source, creator=creator, entry_time=now,
            entry_price_sol=entry_price_sol, entry_amount_tokens=entry_amount_tokens,
            sol_spent=sol_spent, remaining_tokens=entry_amount_tokens, decimals=decimals, tp_hits=[],
            status="open", buy_signature=buy_signature,
        )

    async def get_open_positions(self) -> list[Position]:
        async with self._lock:
            return await asyncio.to_thread(self._get_open_positions_sync)

    def _get_open_positions_sync(self) -> list[Position]:
        rows = self._conn.execute("SELECT * FROM positions WHERE status = 'open'").fetchall()
        return [self._row_to_position(r) for r in rows]

    @staticmethod
    def _row_to_position(row: sqlite3.Row) -> Position:
        return Position(
            id=row["id"], mint=row["mint"], source=row["source"], creator=row["creator"],
            entry_time=row["entry_time"], entry_price_sol=row["entry_price_sol"],
            entry_amount_tokens=row["entry_amount_tokens"], sol_spent=row["sol_spent"],
            remaining_tokens=row["remaining_tokens"], decimals=row["decimals"],
            tp_hits=json.loads(row["tp_hits"]),
            status=row["status"], buy_signature=row["buy_signature"],
        )

    async def record_sell(
        self,
        position: Position,
        amount_tokens: float,
        price_sol: float,
        sol_received: float,
        reason: str,
        tx_signature: str | None,
        tp_multiplier: float | None = None,
    ) -> None:
        async with self._lock:
            await asyncio.to_thread(
                self._record_sell_sync, position, amount_tokens, price_sol, sol_received,
                reason, tx_signature, tp_multiplier,
            )

    def _record_sell_sync(
        self, position: Position, amount_tokens: float, price_sol: float, sol_received: float,
        reason: str, tx_signature: str | None, tp_multiplier: float | None,
    ) -> None:
        cost_basis = amount_tokens * position.entry_price_sol
        pnl_sol = sol_received - cost_basis
        pnl_pct = (pnl_sol / cost_basis * 100) if cost_basis > 0 else 0.0
        now = time.time()

        self._conn.execute(
            """INSERT INTO trades
               (position_id, mint, side, reason, amount_tokens, price_sol, sol_amount,
                pnl_sol, pnl_pct, tx_signature, executed_at)
               VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, ?, ?, ?)""",
            (position.id, position.mint, reason, amount_tokens, price_sol, sol_received,
             pnl_sol, pnl_pct, tx_signature, now),
        )

        remaining = max(0.0, position.remaining_tokens - amount_tokens)
        tp_hits = list(position.tp_hits)
        if tp_multiplier is not None:
            tp_hits.append(tp_multiplier)
        status = "closed" if remaining <= 1e-9 else "open"

        self._conn.execute(
            "UPDATE positions SET remaining_tokens = ?, tp_hits = ?, status = ? WHERE id = ?",
            (remaining, json.dumps(tp_hits), status, position.id),
        )
        self._conn.commit()

        position.remaining_tokens = remaining
        position.tp_hits = tp_hits
        position.status = status

    def close(self) -> None:
        self._conn.close()
