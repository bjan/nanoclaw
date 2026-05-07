"""Multi-account storage and rotation with automatic token refresh."""
from __future__ import annotations

import json
import os
import threading
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

ACCOUNTS_FILE = Path(
    os.environ.get("CODEX_ACCOUNTS_FILE",
                    os.path.expanduser("~/.config/nanoclaw/codex_accounts.json"))
)


@dataclass
class Account:
    id: str
    label: str
    access_token: str
    refresh_token: str
    account_id: str
    expires_at: float = 0.0
    cooldown_until: float = 0.0

    @property
    def is_expired(self) -> bool:
        return time.time() >= self.expires_at - 60

    @property
    def is_cooled_down(self) -> bool:
        return time.time() >= self.cooldown_until


@dataclass
class AccountStore:
    accounts: list[Account] = field(default_factory=list)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def load(self) -> None:
        if not ACCOUNTS_FILE.exists():
            return
        data = json.loads(ACCOUNTS_FILE.read_text())
        self.accounts = [Account(**a) for a in data]

    def save(self) -> None:
        ACCOUNTS_FILE.parent.mkdir(parents=True, exist_ok=True)
        data = [asdict(a) for a in self.accounts]
        for d in data:
            d.pop("cooldown_until", None)
        ACCOUNTS_FILE.write_text(json.dumps(data, indent=2))
        os.chmod(ACCOUNTS_FILE, 0o600)

    def add(self, tokens: dict[str, Any]) -> Account:
        acct = Account(
            id=f"acct-{len(self.accounts) + 1}",
            label=tokens.get("label", ""),
            access_token=tokens["access_token"],
            refresh_token=tokens["refresh_token"],
            account_id=tokens["account_id"],
            expires_at=time.time() + tokens.get("expires_in", 3600),
        )
        self.accounts.append(acct)
        self.save()
        return acct

    def remove(self, account_id: str) -> bool:
        before = len(self.accounts)
        self.accounts = [a for a in self.accounts if a.id != account_id]
        if len(self.accounts) < before:
            self.save()
            return True
        return False

    def refresh(self, acct: Account) -> None:
        from .auth import refresh_access_token, extract_account_id
        tokens = refresh_access_token(acct.refresh_token)
        acct.access_token = tokens["access_token"]
        acct.refresh_token = tokens.get("refresh_token", acct.refresh_token)
        acct.expires_at = time.time() + tokens.get("expires_in", 3600)
        acct.account_id = extract_account_id(acct.access_token)
        self.save()

    def get_available(self) -> Account | None:
        with self._lock:
            for acct in self.accounts:
                if not acct.is_cooled_down:
                    continue
                if acct.is_expired:
                    try:
                        self.refresh(acct)
                    except Exception:
                        acct.cooldown_until = time.time() + 300
                        continue
                return acct
        return None

    def mark_rate_limited(self, acct: Account, cooldown: float = 600) -> None:
        with self._lock:
            acct.cooldown_until = time.time() + cooldown

    def get_next_available(self, exclude: Account) -> Account | None:
        with self._lock:
            for acct in self.accounts:
                if acct.id == exclude.id:
                    continue
                if not acct.is_cooled_down:
                    continue
                if acct.is_expired:
                    try:
                        self.refresh(acct)
                    except Exception:
                        acct.cooldown_until = time.time() + 300
                        continue
                return acct
        return None
