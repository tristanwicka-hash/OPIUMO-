"""
Console + file logging setup. Uses `rich` for readable, colorized console
output (so you can watch the bot's decisions in real time) and a plain
rotating file handler so nothing is lost between runs.
"""
from __future__ import annotations

import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path

from rich.logging import RichHandler

LOG_FORMAT_FILE = "%(asctime)s | %(levelname)-8s | %(name)s | %(message)s"


def setup_logging(log_dir: str | Path, level: str = "INFO") -> logging.Logger:
    log_dir = Path(log_dir)
    log_dir.mkdir(parents=True, exist_ok=True)

    root = logging.getLogger("opiumo")
    root.setLevel(level)
    root.handlers.clear()

    console_handler = RichHandler(
        show_time=True,
        show_path=False,
        rich_tracebacks=True,
        markup=True,
    )
    console_handler.setLevel(level)

    file_handler = RotatingFileHandler(
        log_dir / "bot.log", maxBytes=10_000_000, backupCount=5
    )
    file_handler.setFormatter(logging.Formatter(LOG_FORMAT_FILE))
    file_handler.setLevel(level)

    root.addHandler(console_handler)
    root.addHandler(file_handler)
    root.propagate = False
    return root


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(f"opiumo.{name}")
